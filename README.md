# OpenLoop

OpenLoop is an **OpenCode plugin** that coordinates two independent OpenCode sessions — a **CODER** and a **REVIEWER** — in an automated review/fix loop until the reviewer passes the work or a maximum number of rounds is reached.

```
User Goal
   ↓
Coder session  ──► implement + test
   ↓
Reviewer session  ──► review code  +  engineer next coder prompt  +  research (when useful)
   ↓
Coder session  ──► fix + verify
   ↓
Reviewer again
   ↓
PASS  (or max rounds)
```

The reviewer acts as **Code Reviewer + Prompt Engineer + Researcher**:
- **Code Reviewer** — independently inspects the repository and diff (never trusts the coder's summary).
- **Prompt Engineer** — writes a focused `next_coder_prompt` OpenLoop sends to the coder, improving it across rounds instead of dumping raw findings.
- **Researcher** — periodically investigates whether OpenLoop/OpenCode itself could be improved, recording ideas in `future_improvements` without forcing them into the current task.

## Architecture

```
packages/
  core/              framework-agnostic orchestration (no OpenCode SDK dependency)
    src/types.ts        shared types (Finding, ReviewVerdict, Selections, …)
    src/config.ts       env-based config + validation
    src/verdict.ts      structured-output parsing (malformed-safe) + completion rules
    src/prompts.ts      coder + reviewer system/user prompts + JSON output schema
    src/machine.ts      deterministic state machine (returns Effects, never calls SDK)
    src/state.ts        persisted loop state
    src/selection.ts   persisted coder/reviewer agent+model selections
    src/logging.ts      console logging
  opencode-plugin/    OpenCode plugin (uses official SDK + plugin hooks)
    src/index.ts        Plugin entry (Hooks: event, tool, dispose) + LoopRuntime
    src/sdk.ts          SDK response unwrapping + read-only tool builder
    src/catalog.ts      runtime agent/model discovery + selection validation
```

`core` contains the orchestration state machine and is fully testable without an OpenCode server. `opencode-plugin` drives the machine by interpreting its `Effect`s against the official OpenCode SDK and session events.

## Verified OpenCode APIs

OpenLoop uses only official, current APIs from `@opencode-ai/sdk` v1.18.22 and `@opencode-ai/plugin` v1.18.22:

- **Plugin**: `Plugin` from `@opencode-ai/plugin` — `Hooks.event` (session.idle/status/error), `Hooks.tool` (custom tools), `Hooks.dispose`.
- **Sessions**: `client.session.create` / `get` / `status` / `messages` / `diff` / `abort` / `promptAsync` (v2 SDK, for structured output `format`).
- **Agent/model discovery**: `client.v2.agent.list()` and `client.v2.model.list()` — runtime catalog of available agents/models (only agents/models actually present are selectable).
- **Per-turn agent/model**: the selected coder/reviewer agent and model are passed directly in each `promptAsync` call (`agent` and `model` parameters). This avoids v1/v2 `switchAgent`/`switchModel` endpoint mismatches and never changes the global OpenCode default model/agent.
- **Structured output**: `format: {type: "json_schema", schema, retryCount}` on `promptAsync` for reliable reviewer verdicts, with graceful text-JSON fallback parsing (including recovery from `StructuredOutputError`).

No MCP is used for session-to-session messaging. MCP is intentionally optional for a future adapter (see _Future MCP_ below).

## Setup (Windows)

### 1. Prerequisites

- Node.js 20+ (`node --version`)
- OpenCode installed and on PATH (`opencode --version`). Start the server with:
  ```powershell
  opencode serve --port 4096
  ```
- (Optional) OpenCode Desktop pointing at the same server.

### 2. Install

```powershell
git clone <this repo> BackendAI
cd BackendAI
npm install
npm run build
```

### 3. Configure OpenCode to load the plugin

Add to your project's `opencode.json` (or `opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@openloop/opencode-plugin"]
}
```

Or, for local development, create `.opencode/plugins/openloop.ts`:

```ts
export { OpenLoopPlugin as OpenLoop } from "@openloop/opencode-plugin";
```

> The plugin is loaded by the OpenCode server at startup. Both the CODER and REVIEWER sessions live on that same server, so any client connected to it (TUI, Desktop) can observe them.

### 4. (Optional) Environment variables

Copy `.env.example` to `.env` and adjust. These are read by the plugin at load time (set them in the environment that launches `opencode serve`):

| Variable | Default | Description |
|---|---|---|
| `OPENLOOP_CODER_MODEL` | server default | `providerID/modelID` for the coder |
| `OPENLOOP_CODER_AGENT` | `build` | coder agent |
| `OPENLOOP_REVIEWER_MODEL` | server default | `providerID/modelID` for the reviewer (independent) |
| `OPENLOOP_REVIEWER_AGENT` | `build` | reviewer agent |
| `OPENLOOP_MAX_ROUNDS` | `6` | max coder→reviewer rounds |
| `OPENLOOP_REVIEWER_READONLY` | `true` | disable file-edit tools for reviewer |
| `OPENLOOP_TURN_TIMEOUT_MS` | `1800000` | per-turn timeout |
| `OPENLOOP_POLL_INTERVAL_MS` | `2000` | status poll fallback interval |

## Usage

Inside an OpenCode session connected to the same server, the plugin registers these tools (callable by the AI or via chat):

- **`openloop_setup`** — view/change coder & reviewer agent+model. With no args it lists the **currently available** agents and models (queried live via `client.v2.agent.list()` / `client.v2.model.list()`) and shows current selections. With args it validates against the live catalog and persists to `.opencode-orchestrator/selections.json` so you don't re-select every goal. **Does not change the global OpenCode default model/agent.**
- **`openloop_config`** — show current selections and loop settings.
- **`openloop_start_goal`** — start a coder/reviewer loop for a goal. Runs in the background.
- **`openloop_status`** — `running` / `phase` / `round`.
- **`openloop_stop`** — cooperatively stop the loop.

Example chat flow:
```
> /openloop_setup                                  (see available agents/models)
> /openloop_setup coder_model=ollama-cloud/glm-4.6 reviewer_agent=build
> /openloop_start_goal  Debug the entire application and fix all reproducible issues.
> /openloop_status                                 (monitor)
```

### Configuration via chat (no Desktop UI)

OpenCode does not expose a documented stable Desktop plugin UI extension mechanism for arbitrary pickers. OpenLoop therefore implements the configuration flow through chat/custom-tool interaction (`openloop_setup` / `openloop_config`), which works in both the TUI and Desktop. Only agents/models actually present in your OpenCode environment are selectable.

### OpenCode Desktop compatibility

Both OpenLoop sessions are created on the same OpenCode server the plugin runs in. Any OpenCode client connected to that server (including Desktop, if connected to that server) can see and attach to those sessions. **Desktop-specific external session-attach behavior is version-dependent and not guaranteed by OpenLoop** — if your Desktop build cannot attach to externally-created sessions, the orchestration still works through the OpenCode server. This is a documented Desktop limitation, not an OpenLoop bug.

## Reviewer structured output

The reviewer returns JSON matching this schema (enforced via SDK structured output, with text-JSON fallback):

```json
{
  "verdict": "PASS | CHANGES_REQUIRED",
  "summary": "...",
  "findings": [
    { "severity": "critical|high|medium|low", "location": "...", "problem": "...",
      "impact": "...", "recommended_fix": "...", "verification": "..." }
  ],
  "next_coder_prompt": "focused prompt for the next coder round",
  "research": { "performed": true, "sources_checked": [], "relevant_discoveries": [], "recommended_improvements": [] },
  "future_improvements": [ { "area": "...", "suggestion": "...", "rationale": "..." } ]
}
```

- `next_coder_prompt` is what OpenLoop sends to the coder (not raw findings). The original user goal stays authoritative; the reviewer only improves HOW the coder approaches it.
- `research.performed=false` when no research was needed.
- Low-severity cosmetic findings alone never force another round (`requiresChanges` requires at least one non-low finding).
- Malformed output is handled gracefully (best-effort inference), never throwing.

## Reliability

- Session IDs persisted in `.opencode-orchestrator/state.json` (resume session reuse across restarts; a new goal starts a fresh round sequence).
- Reconnect/resume: stored sessions are verified to exist before reuse (via structured `NotFoundError` name check, not fragile message matching); missing ones are recreated.
- **Per-turn timeout** (`OPENLOOP_TURN_TIMEOUT_MS`): if a busy session does not go idle within the timeout, it is aborted and the loop stops (prevents permanent deadlock on a hung session/model outage).
- **Polling fallback** (`OPENLOOP_POLL_INTERVAL_MS`): periodically checks `session.status()` and recovers if an idle event was missed — non-aggressive, `unref`'d so it never keeps the process alive.
- **Event-driven** primarily (session.idle) with the polling/timeout fallbacks above — no uncontrolled loops.
- **Idempotent abort**: `machine.abort()` returns `STOP` on a second call, preventing the abort path from recursing or hammering the server.
- Max-rounds protection; Ctrl+C / `openloop_stop` aborts the busy session cooperatively.
- Busy-session guard: refuses to send a new prompt while a session is busy.
- Failed `start()` cleans up runtime state so a subsequent `start()` works (no permanently stuck runtime).
- Reviewer edits disabled via read-only tool map + system prompt.
- `StructuredOutputError` falls back to parsing the assistant text before declaring ERROR.
- Research and `future_improvements` from the reviewer are persisted in `state.json` round records.
- Graceful error handling at every SDK boundary.

## Development

```powershell
npm run build         # build all packages
npm run typecheck     # tsc --noEmit across packages
npm test              # vitest run
npm run test:watch    # vitest watch
```

Tests cover: verdict parsing (structured + text fallback + malformed), `requiresChanges` rules, `nextCoderPrompt` fallback, machine loop (PASS / MAX_ROUNDS / ABORTED / ERROR / next_coder_prompt use), and selection persistence.

## Future MCP (optional, not in v1)

The architecture is extensible so a future `packages/mcp` adapter could expose `openloop_start_goal`, `openloop_status`, `openloop_get_findings`, `openloop_stop` to other MCP-compatible tools. The `core` state machine and `LoopRuntime` are already separable from the OpenCode plugin, so an MCP adapter would drive the same `LoopMachine` without duplicating orchestration logic. MCP is intentionally not used for session-to-session messaging in v1.
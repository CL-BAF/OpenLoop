# OpenLoop

OpenLoop is an OpenCode server plugin that runs a coder and an independent reviewer in two separate root sessions:

```text
User goal
  -> CODER implements and verifies
  -> REVIEWER inspects the repository and exact coder diff
  -> CODER receives focused review guidance and fixes material findings
  -> REVIEWER checks again
  -> PASS, error, stop, or maximum rounds
```

OpenLoop is currently a source project, not a published npm plugin. Its installer copies a self-contained project-local plugin into the workspace where you want to use OpenLoop.

## Compatibility verified in this repository

- `@opencode-ai/plugin` 1.18.23
- `@opencode-ai/sdk` 1.18.23, using its v2 client export
- OpenCode CLI/server 1.18.23 on native Windows
- Node.js 20 or newer

The live Windows integration check starts an isolated real OpenCode 1.18.23 server with a deterministic local test provider. It discovers the plugin, registers all five tools, queries the active agent/model catalogs, creates two distinct root sessions, runs coder -> reviewer -> coder fix -> reviewer, and verifies PASS after round two. It exercises the actual plugin runtime without using provider credentials or editing this repository.

## Architecture

```text
packages/
  core/                 deterministic orchestration, prompts, validation, state
  opencode-plugin/      OpenCode SDK adapter, tools, events, sessions, watchdog
.opencode/plugins/
  openloop.js           generated self-contained plugin for this checkout
scripts/
  build-loader.mjs      build the single-file plugin artifact
  install-project.mjs   safe plugin installer for another workspace
  live-opencode.mjs     isolated real-server integration check
```

The two worker sessions are created separately with `session.create()` and no `parentID`. They are therefore root sessions, not task/subagent sessions, not children of one another, and not the session that called `openloop_start_goal`.

Agent and model choices are attached to each `promptAsync()` request. OpenLoop does not switch or mutate OpenCode's global/default agent or model.

## Install into a Windows/OpenCode Desktop project

In PowerShell:

```powershell
git clone https://github.com/CL-BAF/OpenLoop.git
cd OpenLoop
npm install
npm run install:project -- "C:\path\to\your-project"
```

`npm install` builds the TypeScript packages and self-contained plugin automatically. The installer copies that plugin to:

```text
C:\path\to\your-project\.opencode\plugins\openloop.js
```

It refuses to replace an existing plugin file. Inspect that file first and add `--force` only when you intentionally want OpenLoop to replace it:

```powershell
npm run install:project -- "C:\path\to\your-project" --force
```

Now fully quit OpenCode Desktop, reopen it, and open the target project. The installed file has no runtime dependency on the OpenLoop checkout or its `node_modules`; the checkout may be moved or removed. To deploy later source changes, run `npm run build`, rerun `install:project` with `--force`, and restart Desktop.

To develop OpenLoop itself, clone and run `npm install`, then open this checkout in OpenCode. The build writes `.opencode/plugins/openloop.js`, so no separate installer step is needed for this repository.

Do not add this to `opencode.json`:

```json
{
  "plugin": ["@openloop/opencode-plugin"]
}
```

That package name is not published. OpenCode treats entries in `plugin` as npm packages and its Bun installation step cannot resolve this private workspace package from the npm registry.

No `plugin` configuration entry is needed. Current OpenCode automatically discovers JavaScript or TypeScript files under the opened project's:

```text
<project>/.opencode/plugins/openloop.js
```

If you previously added `"@openloop/opencode-plugin"` to a user-level or project-level OpenCode configuration, remove it. An invalid global entry can break plugin startup even when the project-local file is correct.

Official loading references:

- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [OpenCode configuration](https://opencode.ai/docs/config/)
- [OpenCode SDK](https://opencode.ai/docs/sdk/)

The generated file is intentionally bundled and has exactly one runtime export: `OpenLoopPlugin`. This avoids resolving OpenLoop workspaces or npm dependencies from the target project, and it matches OpenCode's behavior of loading every export from a discovered module as a plugin factory. Do not replace it with `export *` from the development module, which also exports the testable `LoopRuntime` class.

## Published-package installation

There is no published-package installation today. `@openloop/opencode-plugin` returns npm `E404` as of 2026-08-25. If the package is published later, the expected OpenCode configuration will be:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@openloop/opencode-plugin"]
}
```

Do not use that configuration until both the plugin and its `@openloop/core` dependency are actually available from the registry.

## Run with OpenCode CLI/server

From the target project after installation:

```powershell
opencode
```

For an explicit server:

```powershell
opencode serve --hostname 127.0.0.1 --port 4096
```

OpenCode loads project-local plugins for the project directory it opens. Install the plugin separately in every project where OpenLoop should be available.

## Run with OpenCode Desktop on Windows

OpenCode Desktop runs a local OpenCode server sidecar. Install the plugin into the project, fully quit Desktop, reopen it, and open that project. The plugin is then in the project configuration scope that Desktop's server scans.

For a Desktop client connected to a separate WSL/server instance, the plugin must exist and be built in the project as seen by that server. Installing it only on the Windows client side is insufficient because plugins execute in the server process.

Desktop plugin behavior has changed across OpenCode releases. If tools do not appear:

1. confirm Desktop opened the target directory containing `.opencode\plugins\openloop.js`;
2. run `npm run build` in the OpenLoop checkout, then reinstall into the target with `--force`;
3. fully quit and restart Desktop;
4. inspect the OpenCode log for the target project's `.opencode/plugins/openloop.js`;
5. reproduce with `opencode debug config --print-logs --log-level DEBUG` from the target project.

## Use OpenLoop

OpenLoop registers custom tools, not slash commands. Ask the active OpenCode agent to call them. For example:

```text
Call openloop_setup with no arguments and show me the available agents and models.
```

Then configure roles independently:

```text
Call openloop_setup with coder_agent="build", coder_model="provider/model",
reviewer_agent="build", and reviewer_model="other-provider/other-model".
```

Start a goal:

```text
Call openloop_start_goal with goal="Fix the failing authentication tests and verify the fix."
```

Monitor or stop it:

```text
Call openloop_status.
Call openloop_stop.
```

The tools are:

- `openloop_setup`: list the live catalog or validate and persist role selections.
- `openloop_config`: show selections and loop settings.
- `openloop_start_goal`: start one background loop; a second concurrent start is rejected.
- `openloop_status`: show running state, phase, round, and final outcome.
- `openloop_stop`: abort the active worker turn and stop immediately.

Selections are validated again against the live catalog at the start of every goal. Changes made during a run are persisted for the next run; the active run uses a fixed selection snapshot.

## Configuration

OpenLoop reads these process environment variables when the plugin loads:

| Variable | Default | Meaning |
|---|---:|---|
| `OPENLOOP_CODER_MODEL` | server default | Initial coder `providerID/modelID` selection |
| `OPENLOOP_CODER_AGENT` | `build` | Initial coder agent |
| `OPENLOOP_REVIEWER_MODEL` | server default | Initial reviewer `providerID/modelID` selection |
| `OPENLOOP_REVIEWER_AGENT` | `build` | Initial reviewer agent |
| `OPENLOOP_MAX_ROUNDS` | `6` | Maximum coder/reviewer rounds |
| `OPENLOOP_REVIEWER_READONLY` | `true` | Enforce reviewer read-only restrictions |
| `OPENLOOP_TURN_TIMEOUT_MS` | `1800000` | Per-turn timeout in milliseconds |
| `OPENLOOP_POLL_INTERVAL_MS` | `2000` | Missed-idle fallback interval |

`.env.example` is a reference only. OpenLoop does not parse `.env` files. For a CLI/server launched from PowerShell, set variables in that process before launch:

```powershell
$env:OPENLOOP_MAX_ROUNDS = "4"
opencode
```

Desktop may not inherit variables set in an already-open shell. Set persistent user environment variables before starting Desktop, or use the defaults and configure agent/model choices through `openloop_setup`.

## Reviewer read-only enforcement

Read-only mode is enforced in two layers:

1. OpenLoop queries the complete live tool catalog before creating either worker session;
2. the reviewer root session receives persistent deny permissions for editing, shell execution, task/subagent creation, external-directory access, todo writes, and every tool outside a small explicit read-only allowlist (`read`, search/list tools, LSP, and web research tools).

Unknown and plugin-defined tools fail closed. OpenLoop refuses to start read-only mode if OpenCode cannot return its tool catalog. These restrictions are attached once at session creation and OpenLoop deliberately does not pass the legacy per-prompt `tools` map: current OpenCode replaces session permissions when that map is supplied, which would erase other read-only rules. The reviewer receives the exact coder diff in its prompt and can read repository files, but cannot run shell-based tests itself in read-only mode. It reviews the coder's reported test results and code/test changes; the coder remains responsible for executing verification.

These controls limit the impact of ordinary model mistakes and repository prompt injection by preventing reviewer-side mutation. Prompt injection can still distort a model's verdict or suggested follow-up, so repository and diff text are explicitly labelled untrusted and the coder is told to verify every finding. It cannot stop an unrelated external process or another OpenCode session from changing the same working tree concurrently.

## Runtime behavior and recovery

- Every goal gets two fresh root sessions. Old goals cannot contaminate new coder/reviewer context.
- Each outgoing user message gets an OpenCode-compatible sortable `msg_` ID. Completion is read only from the assistant response whose `parentID` matches that exact message.
- Session diffs use the coder user-message ID required by OpenCode's diff endpoint, not the assistant-message ID.
- `session.idle` is the primary completion signal. Status polling recovers a missed event; duplicate events are ignored.
- A prompt failure, catalog failure, session error, or malformed reviewer verdict ends with an explicit `ERROR`, never a false `PASS`.
- A missing response or hung turn is aborted at the configured timeout and recorded as a diagnostic `ERROR` (distinct from a user-requested `ABORTED` stop).
- Provider-managed retries continue when their next attempt fits inside the original turn deadline. A retry scheduled beyond that deadline fails early with the provider's message instead of waiting pointlessly.
- `openloop_stop` aborts at most once and resolves the loop immediately.
- Material findings override an inconsistent reviewer `PASS` label. Cosmetic-only low findings do not force another round.
- Reviewer guidance is wrapped as untrusted input under the authoritative original goal before it reaches the coder.

OpenCode server/Desktop restart does not resume an in-flight loop. After restart, OpenLoop reports no active run; start the goal again and it will create fresh sessions. The state file remains diagnostic history, not an automatic job queue.

## State and privacy

OpenLoop writes:

```text
.opencode-orchestrator/
  selections.json
  state.json
```

The directory is gitignored. `state.json` contains the goal, worker session IDs, verdict metadata, final outcome/error, reviewer next prompt, and optional research/improvement notes. Do not put secrets in goals or reviewer instructions. Writes use a same-directory temporary file and include a Windows replacement fallback.

## OpenCode APIs used

The implementation uses APIs present in the generated 1.18.23 types and verified against a live 1.18.23 server:

- plugin `event`, `tool`, and `dispose` hooks;
- `session.create`, `status`, `messages`, `diff`, `abort`, and `promptAsync`;
- per-prompt `agent`, `model`, and `system`;
- `client.app.agents()` and `client.config.providers()` active catalogs;
- `client.tool.ids()` for fail-closed reviewer tool restrictions;
- assistant text output parsed against the strict reviewer JSON contract, plus compatibility with structured parts and `StructuredOutputError` recovery;
- `session.idle` and `session.error` events.

No v1 `switchAgent`/`switchModel` calls are mixed into the v2 runtime. No MCP transport is used for worker messaging.

OpenLoop deliberately does not request OpenCode's `json_schema` response format for reviewer turns. In current OpenCode, a formatted turn can complete successfully but subsequently make the session message-list endpoint reject its stored request with `Expected OutputFormatJsonSchema`; this is tracked upstream in [issue #26929](https://github.com/anomalyco/opencode/issues/26929) and [issue #40169](https://github.com/anomalyco/opencode/issues/40169). The reviewer is instead required to return JSON text, which OpenLoop parses and validates. This preserves readable session history and rejects malformed verdicts rather than guessing.

The general `/api/model` endpoint is not used for selection because it is the universal models.dev catalog and can omit configured custom/local providers. `config.providers()` is the server's active configured provider/model view.

## Development and verification

```powershell
npm install
npm run build
npm run typecheck
npm test
npm run test:live
npm audit
```

To reproduce the exact current-release verification without changing a globally installed CLI:

```powershell
npm exec --yes --package=opencode-ai@1.18.23 -- npm run test:live
```

The unit/integration-shaped tests cover PASS, material changes, maximum rounds, malformed output, structured-output fallback, prompt/catalog failures, independent root-session creation, exact diff message binding, dynamic fail-closed read-only enforcement, retry deadlines, persistence failures, timeout, stop, duplicate/missed events, stale restart races, catalog selection, state storage, safe project installation, and the plugin's single-export contract. `test:live` additionally performs the isolated real OpenCode two-round loop described above; it requires `opencode` on `PATH` unless invoked through the exact-version `npm exec` command.

Manual plugin check:

```powershell
opencode debug config --print-logs --log-level DEBUG
```

The resolved configuration should contain a file URL ending in:

```text
.opencode/plugins/openloop.js
```

If OpenCode reports an error in a global `opencode.json` or `opencode.jsonc`, fix that file first. A syntax error in global configuration prevents project plugin discovery entirely.

## Known limitations

- The npm package is not published; installation copies the generated self-contained plugin into each project.
- In-flight loops are not resumed after a server/Desktop restart.
- There is no custom Desktop picker UI; setup is through custom-tool chat interaction.
- Reviewer read-only mode deliberately disables shell execution, so it cannot independently execute tests.
- Worker sessions share one working tree. Do not run another writer against that tree during a loop.
- Model/provider availability, rate limits, authentication, and network failures remain external dependencies and are reported as errors.

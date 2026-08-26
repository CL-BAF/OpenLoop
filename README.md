# OpenLoop

OpenLoop is a project-local plugin for [OpenCode](https://opencode.ai/) that runs an independent builder/reviewer workflow against one repository.

For every run, OpenLoop creates two separate root OpenCode sessions:

1. The **builder** inspects the project, implements the goal, and verifies its work.
2. The **reviewer** independently inspects the repository and the builder's exact session diff.
3. If the reviewer reports material findings, OpenLoop sends a focused fix prompt back to the builder.
4. The cycle repeats until the reviewer returns `PASS`, the configured round limit is reached, the run is stopped, or an error occurs.

The builder and reviewer may use the same model or different models. Their prompts are role-specific: the builder receives implementation and verification instructions, while the reviewer receives an independent, read-only review brief and produces prioritized findings plus an improved prompt for the next builder round.

## Requirements

- Windows, macOS, or Linux
- Node.js 20 or newer
- Git
- OpenCode with at least one configured model provider
- A local project directory to review and modify

OpenLoop is verified against OpenCode `1.18.21` and `1.18.23`, including the embedded transport used by OpenCode Desktop and the terminal interface on Windows.

## Install

Clone OpenLoop and install its dependencies:

```powershell
git clone https://github.com/CL-BAF/OpenLoop.git
Set-Location OpenLoop
npm install
```

The clone is the OpenLoop source directory. It is not automatically installed into every project. Install the built plugin into the project where it should run:

```powershell
npm run install:project -- "C:\path\to\your-project"
```

For example, if the target project is `C:\Users\YourName\Desktop\MyApp`:

```powershell
npm run install:project -- "C:\Users\YourName\Desktop\MyApp"
```

This creates:

```text
MyApp\
└── .opencode\
    └── plugins\
        └── openloop.js
```

If a previous OpenLoop bundle already exists, rebuild and replace it explicitly:

```powershell
npm run build
npm run install:project -- "C:\path\to\your-project" --force
```

Restart OpenCode after installing or updating the plugin.

> Run `npm run install:project` from the cloned **OpenLoop** directory. The quoted path after `--` is the separate project that OpenLoop will work on.

## Use with OpenCode Desktop

1. Open the target project in OpenCode Desktop.
2. Restart Desktop if the plugin was just installed or updated.
3. Open a new session in that project.
4. Enter the command below in the message box.

```text
/OpenLoop Builder=provider/model & Reviewer=provider/model [Prompt/Goal]
```

Example:

```text
/OpenLoop Builder=ollama-cloud/deepseek-v4-flash:0731 & Reviewer=ollama-cloud/deepseek-v4-flash:0731 [Fix the failing tests, repair the root causes, and verify the application end-to-end]
```

OpenCode expands `/OpenLoop` as a custom command. Its complete argument string is passed to OpenLoop's deterministic parser, which validates both models against the active OpenCode catalog, saves the selections for this project, and starts the loop.

The command keeps the currently configured builder and reviewer agent IDs. Both default to the OpenCode `build` agent. Agent IDs can be changed with `openloop_setup` or environment variables.

## Use with the OpenCode terminal interface

Start OpenCode from the target project, not from the OpenLoop source directory:

```powershell
Set-Location "C:\path\to\your-project"
opencode
```

Then enter the same command inside OpenCode:

```text
/OpenLoop Builder=provider/model & Reviewer=provider/model [Prompt/Goal]
```

The `/OpenLoop ...` text is an OpenCode command, not a PowerShell command. Entering natural-language instructions such as `Use openloop_setup...` directly at a `PS>` prompt will make PowerShell try to execute them and fail.

## Command format

The public command format is:

```text
/OpenLoop Builder=<provider>/<model> & Reviewer=<provider>/<model> [<goal>]
```

- `Builder` and `Reviewer` are case-insensitive.
- Whitespace around `=` and `&` is optional.
- Model IDs must include the provider prefix shown by OpenCode.
- The goal must be enclosed in square brackets and cannot be empty.
- Colons are accepted inside model IDs.
- The same model may be used for both roles, although different models can provide a more independent review.

List models available to a provider with OpenCode itself:

```powershell
opencode models ollama-cloud
```

Use the complete result, including the provider prefix. For example, use `ollama-cloud/deepseek-v4-flash:0731`, not only `deepseek-v4-flash:0731`.

## What happens during a run

OpenLoop generates separate prompts for each role from the goal:

- The builder prompt emphasizes repository inspection, root-cause implementation, scoped changes, and exact verification results.
- The reviewer prompt emphasizes independent inspection, comparison with the exact builder-session diff, security and compatibility checks, and a strict structured verdict.
- On `CHANGES_REQUIRED`, the reviewer produces a prioritized `next_coder_prompt`. OpenLoop combines it with the original authoritative goal and sends it back to the builder for the next round.
- On `PASS`, the loop ends and persists the final result.

The two sessions are independent roots. The reviewer is not a child of the builder and does not inherit the builder's conversation.

## Monitor or stop a run

OpenLoop starts in the background so the command session remains responsive. Ask the active OpenCode agent to call:

- `openloop_status` to show the current phase, round, and outcome.
- `openloop_stop` to abort the active turn and stop the loop.
- `openloop_config` to show saved model/agent selections and loop settings.

OpenLoop's tools are:

| Tool | Purpose |
| --- | --- |
| `openloop_run` | Parse the `/OpenLoop` arguments, validate/save models, and start a run |
| `openloop_start_goal` | Start a run using already saved selections |
| `openloop_status` | Report progress and the final outcome |
| `openloop_stop` | Abort the current turn and stop the run |
| `openloop_setup` | List or change validated agent/model selections |
| `openloop_config` | Show current selections and loop settings |

Ordinary users should normally use `/OpenLoop`; the lower-level tools are useful for diagnostics and automation.

## Configuration

Model selections made by `/OpenLoop` or `openloop_setup` are stored per project in:

```text
.opencode-orchestrator\selections.json
```

Run state and round history are stored in the same directory. New runs always create two fresh root sessions, while saved selections remain available for later runs.

Environment variables provide initial/default settings when the plugin loads:

| Variable | Default | Description |
| --- | --- | --- |
| `OPENLOOP_CODER_MODEL` | OpenCode default | Builder model as `provider/model` |
| `OPENLOOP_REVIEWER_MODEL` | OpenCode default | Reviewer model as `provider/model` |
| `OPENLOOP_CODER_AGENT` | `build` | Builder primary-agent ID |
| `OPENLOOP_REVIEWER_AGENT` | `build` | Reviewer primary-agent ID |
| `OPENLOOP_MAX_ROUNDS` | `6` | Maximum builder/reviewer rounds |
| `OPENLOOP_REVIEWER_READONLY` | `true` | Enforce reviewer read-only permissions |
| `OPENLOOP_TURN_TIMEOUT_MS` | `1800000` | Per-turn timeout in milliseconds |
| `OPENLOOP_POLL_INTERVAL_MS` | `2000` | Idle-status fallback polling interval |
| `OPENLOOP_LOG_LEVEL` | `info` | Logging level |

OpenLoop does not load `.env` files itself. Environment variables must be present in the OpenCode/Desktop process when the plugin loads. The slash command is the simplest way to select models without managing environment variables.

## Reviewer read-only enforcement

Read-only mode is enabled by default. When the reviewer root session is created, OpenLoop queries the active tool catalog and adds persistent deny rules for every tool that is not explicitly classified as read-only. Known mutation capabilities such as editing, shell execution, task delegation, and OpenLoop start/run tools are denied.

This is enforced at the reviewer session boundary rather than only requested in the prompt. If the live tool catalog cannot be queried, OpenLoop fails closed instead of creating a reviewer with uncertain permissions.

## Reliability behavior

- A per-turn watchdog aborts turns that exceed the configured timeout.
- Session events are the primary completion signal; status polling recovers missed idle events.
- Retry states and temporary busy states are handled without overlapping prompts.
- Duplicate or stale completion events are ignored.
- Stop requests invalidate in-flight work so late responses cannot restart a stopped run.
- State writes are atomic and persisted after meaningful transitions.
- Malformed reviewer output produces an error instead of a false `PASS`.
- Coder and reviewer session IDs are checked to ensure they are distinct root sessions.

## Troubleshooting

### `/OpenLoop` does not appear

Confirm that this file exists in the target project:

```text
.opencode\plugins\openloop.js
```

Then fully restart OpenCode/Desktop and open a new session in that project. You can inspect the resolved configuration from the target directory:

```powershell
opencode debug config
```

The resolved command registry should include `OpenLoop`, and the plugin list should include the project-local `openloop.js` file.

### The agent says `openloop_run` or `openloop_setup` is unavailable

The plugin was not loaded into that session. Verify the project path, plugin file, and restart. The green plugin indicator only confirms that OpenCode discovered a plugin module; a new session is still recommended after installation or replacement.

### Catalog lookup fails

First confirm that OpenCode can see the model:

```powershell
opencode models <provider>
```

Use the complete `provider/model` value returned by that command. OpenLoop uses OpenCode's injected plugin client, which is required for embedded Desktop and terminal sessions that do not expose a separate HTTP listener.

### OpenCode tries to install `@openloop/opencode-plugin`

The npm package is not published. Remove stale entries such as the following from project or global OpenCode configuration:

```json
{
  "plugin": ["@openloop/opencode-plugin"]
}
```

Use the project-local installer documented above instead.

### PowerShell reports `PositionalParameterNotFound`

Use a quoted path with `Set-Location`:

```powershell
Set-Location "C:\path\with spaces\to\project"
```

Do not place a second path after `Set-Location`.

## Development and verification

From the OpenLoop repository:

```powershell
npm install
npm run build
npm run typecheck
npm test
npm run test:live
```

`test:live` starts an isolated OpenCode server with a deterministic local model endpoint. It verifies two independent root sessions, builder-to-reviewer diff transfer, reviewer-to-builder fix guidance, read-only reviewer permissions, two rounds, persistence, and a final `PASS` without using a paid model.

## Scope and limitations

- OpenLoop coordinates sessions within one OpenCode project; it does not connect or control two manually opened Desktop tabs.
- OpenCode custom commands are prompt templates. `/OpenLoop` instructs the active agent to call `openloop_run`; the tool itself performs strict parsing, catalog validation, persistence, and loop startup.
- The reviewer is read-only with respect to OpenCode tools. It can inspect the shared working tree, including changes made by the builder.
- Read-only mode prevents the reviewer from executing shell-based test commands; it inspects code and test changes while the builder remains responsible for running verification.
- Both roles use models and primary agents already available in the active OpenCode environment.
- In-flight runs are not resumed after OpenCode/Desktop restarts; start a new run after restarting.
- Both worker sessions share one working tree. Avoid running another writer against the same project during a loop.
- Provider authentication, availability, rate limits, and network failures remain external dependencies and are reported as explicit errors.

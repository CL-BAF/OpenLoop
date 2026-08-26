import type {OpencodeClient} from "@opencode-ai/sdk/v2";
import {existsSync} from "node:fs";
import {join, resolve} from "node:path";
import {randomBytes} from "node:crypto";
import type {Plugin, PluginInput, Hooks} from "@opencode-ai/plugin";
import {tool} from "@opencode-ai/plugin";
import type {Event} from "@opencode-ai/sdk";
import {
  type OpenLoopConfig, type LoopOutcome, type DiffSummary,
  type SessionSelection, type Selections, type Effect, type PersistedState, type TurnResult,
  LoopMachine, StateStore, SelectionStore, loadConfig, ConfigError,
  coderSystemPrompt, reviewerSystemPrompt, parseVerdict, requiresChanges,
  log, banner, controlBanner, roundBanner, section,
} from "@openloop/core";
import {
  readLastTurn, readDiff, buildReadonlyPermissions, createRootSession,
  readSessionStatus, abortSession as sdkAbortSession,
  unwrap, SdkError,
} from "./sdk.js";
import {fetchCatalog, validateSelection, formatCatalog, parseModelRef, type Catalog} from "./catalog.js";
import {adaptPluginClient} from "./client.js";
import {OPENLOOP_COMMAND_USAGE, parseOpenLoopCommand} from "./command.js";
import {
  availableVerificationScripts,
  formatVerificationReport,
  runPackageVerification,
} from "./verification.js";

export type {Plugin, PluginInput, Hooks};

const SCOPE = "openloop";

/**
 * OpenLoop plugin entry point.
 *
 * Development checkouts use the generated self-contained project-local plugin
 * at .opencode/plugins/openloop.js. A package-name config is valid only after
 * the package and its dependencies are published.
 *
 * The plugin coordinates two independent root sessions (CODER, REVIEWER) and
 * drives the review/fix loop using the OpenCode SDK + session events.
 */
export const OpenLoopPlugin: Plugin = async (input: PluginInput) => {
  const {directory} = input;
  const stateDir = resolveStateDir(directory);

  let config: OpenLoopConfig;
  try {
    config = loadConfig({projectDir: directory, stateDir});
  } catch (e) {
    if (e instanceof ConfigError) {
      log.error(SCOPE, `configuration error: ${e.message}`);
      return {event: async () => {}, dispose: async () => {}} satisfies Hooks;
    }
    throw e;
  }

  // Use OpenCode's injected transport. It works both with a headless HTTP
  // server and with embedded Desktop/TUI instances that expose no listener.
  const client: OpencodeClient = adaptPluginClient(input.client, directory);

  const runtime = new LoopRuntime(config, client, stateDir, new SelectionStore(stateDir, {
    coder: {agent: config.coderAgent, model: config.coderModel},
    reviewer: {agent: config.reviewerAgent, model: config.reviewerModel},
  }));
  // Serializes the catalog-validation + persistence window before runtime.start
  // synchronously claims the run. Calls can arrive from different root sessions.
  let preparingRun = false;

  const hooks: Hooks = {
    dispose: async () => {
      await runtime.dispose();
    },
    event: async ({event}: {event: Event}) => {
      try {
        await runtime.handleEvent(event);
      } catch (e) {
        log.error(SCOPE, `event handler error: ${String((e as Error).message ?? e)}`);
      }
    },
    config: async (openCodeConfig) => {
      openCodeConfig.command ??= {};
      openCodeConfig.command.OpenLoop = {
        description: "Run an independent OpenLoop builder/reviewer cycle",
        agent: "build",
        template: [
          "Call openloop_run exactly once with `spec` set to the complete text below, preserving it verbatim.",
          "Do not call openloop_setup first and do not use a shell command.",
          "After the tool returns, report its result concisely.",
          "",
          "$ARGUMENTS",
        ].join("\n"),
      };
    },
    tool: {
      openloop_verify: tool({
        description:
          "Run independent reviewer verification without granting arbitrary shell access. Only configured package.json scripts may run, and only from the active OpenLoop reviewer session. With no checks, runs every configured script present in the project.",
        args: {
          checks: tool.schema.array(tool.schema.string().max(128)).min(1).max(20).optional().describe(
            "Optional package.json script names to run, such as test, typecheck, lint, or build.",
          ),
        },
        async execute(args, context) {
          try {
            return {
              title: "OpenLoop reviewer verification",
              output: await runtime.runReviewerVerification(context.sessionID, args.checks, context.abort),
            };
          } catch (error) {
            return {
              title: "OpenLoop reviewer verification",
              output: `Verification unavailable: ${String((error as Error).message ?? error)}`,
            };
          }
        },
      }),
      openloop_run: tool({
        description:
          `Parse and run the public OpenLoop command format: ${OPENLOOP_COMMAND_USAGE}. Validates both models against the live OpenCode catalog, preserves the configured coder/reviewer agents, saves the model selections, and starts the loop.`,
        args: {
          spec: tool.schema.string().describe(
            'The complete command arguments, for example: Builder=ollama-cloud/model-a & Reviewer=ollama-cloud/model-b [Fix the failing tests]',
          ),
        },
        async execute(args) {
          if (runtime.status().running || preparingRun) {
            return {title: "OpenLoop", output: "A loop is already running. Use openloop_status to monitor it."};
          }
          preparingRun = true;
          try {
            const parsed = parseOpenLoopCommand(args.spec ?? "");
            if (!parsed.ok) {
              return {title: "OpenLoop", output: `Rejected: ${parsed.error}`};
            }

            const current = runtime.getSelections();
            const next: Selections = {
              coder: {agent: current.coder.agent, model: parsed.command.builderModel},
              reviewer: {agent: current.reviewer.agent, model: parsed.command.reviewerModel},
            };
            const applied = await runtime.applySelections(next);
            if (!applied.ok) return {title: "OpenLoop", output: `Rejected: ${applied.error}`};
            void runtime.start(parsed.command.goal).catch((e) => {
              log.error(SCOPE, `loop failed: ${String((e as Error).message ?? e)}`);
            });
            return {
              title: "OpenLoop started",
              output: [
                "Started the independent builder/reviewer loop in the background.",
                `Builder model: ${formatModel(parsed.command.builderModel)}`,
                `Reviewer model: ${formatModel(parsed.command.reviewerModel)}`,
                "Use openloop_status to monitor progress and the final outcome.",
              ].join("\n"),
            };
          } catch (e) {
            return {title: "OpenLoop", output: `Error: ${String((e as Error).message ?? e)}`};
          } finally {
            preparingRun = false;
          }
        },
      }),
      openloop_start_goal: tool({
        description:
          "Start a background OpenLoop coder/reviewer loop for a goal. The coder implements/fixes; an independent reviewer inspects and reports findings; the loop repeats until PASS, error, stop, or max rounds. Use openloop_status for the final outcome.",
        args: {
          goal: tool.schema.string().describe("The user's goal for the coder/reviewer loop."),
        },
        async execute(args) {
          const goal = (args.goal ?? "").trim();
          if (!goal) return {title: "OpenLoop", output: "Error: goal is required."};
          if (runtime.status().running || preparingRun) {
            return {title: "OpenLoop", output: "A loop is already running. Use openloop_status to monitor it."};
          }
          // Run asynchronously; the tool returns immediately so the calling session isn't blocked.
          void runtime.start(goal).catch((e) => {
            log.error(SCOPE, `loop failed: ${String((e as Error).message ?? e)}`);
          });
          return {
            title: "OpenLoop started",
            output: "Started the coder/reviewer loop in the background. Use openloop_status to check progress and the final outcome.",
          };
        },
      }),
      openloop_status: tool({
        description: "Return the current OpenLoop loop status (running, phase, round).",
        args: {},
        async execute() {
          const s = runtime.status();
          return {
            title: "OpenLoop status",
            output: `running=${s.running} phase=${s.phase} round=${s.round} outcome=${s.outcome} detail=${s.detail}`,
          };
        },
      }),
      openloop_stop: tool({
        description: "Cooperatively stop the running OpenLoop loop (aborts the current busy session).",
        args: {},
        async execute() {
          if (!runtime.status().running) {
            return {title: "OpenLoop stop", output: "No OpenLoop run is active."};
          }
          await runtime.stop();
          return {title: "OpenLoop stop", output: "The active turn was aborted and the loop stopped."};
        },
      }),
      openloop_setup: tool({
        description:
          "Configure OpenLoop coder and reviewer agent+model selections. With no arguments, returns the currently available agents/models and the current selections. With arguments, validates and persists the new selections (they apply the next time a loop starts). Only models actually available in this OpenCode environment are accepted. This does NOT change the global OpenCode default model/agent.",
        args: {
          coder_agent: tool.schema.string().optional().describe('Coder agent id (must be in the available agents list). e.g. "build"'),
          coder_model: tool.schema.string().optional().describe('Coder model as "providerID/modelID". e.g. "ollama-cloud/glm-4.6". Empty string clears the model override.'),
          reviewer_agent: tool.schema.string().optional().describe('Reviewer agent id (independent from coder). e.g. "build"'),
          reviewer_model: tool.schema.string().optional().describe('Reviewer model as "providerID/modelID". May differ from coder. Empty string clears the override.'),
        },
        async execute(args) {
          // No-arg: show current state + available options.
          const hasArgs = args.coder_agent !== undefined || args.coder_model !== undefined
            || args.reviewer_agent !== undefined || args.reviewer_model !== undefined;
          const current = runtime.getSelections();
          if (hasArgs && preparingRun) {
            return {title: "OpenLoop setup", output: "Rejected: an OpenLoop run is currently being prepared. Try again after it starts."};
          }
          if (!hasArgs) {
            let catalog: Catalog;
            try {
              catalog = await runtime.getCatalog();
            } catch (e) {
              return {title: "OpenLoop setup", output: `Failed to query catalog: ${String((e as Error).message ?? e)}`};
            }
            const cur = formatCurrent(current);
            return {
              title: "OpenLoop setup",
              output: `${cur}\n\n${formatCatalog(catalog)}\n\nCall openloop_setup again with coder_agent / coder_model / reviewer_agent / reviewer_model to change selections. Only the listed agents and models are accepted.`,
            };
          }
          // Apply new selections.
          const base = current;
          const coderModel = parseSetupModel(args.coder_model, base.coder.model);
          if (!coderModel.ok) return {title: "OpenLoop setup", output: `Rejected: coder_model ${coderModel.error}`};
          const reviewerModel = parseSetupModel(args.reviewer_model, base.reviewer.model);
          if (!reviewerModel.ok) return {title: "OpenLoop setup", output: `Rejected: reviewer_model ${reviewerModel.error}`};
          const next: Selections = {
            coder: {
              agent: (args.coder_agent ?? base.coder.agent).trim() || base.coder.agent,
              model: coderModel.model,
            },
            reviewer: {
              agent: (args.reviewer_agent ?? base.reviewer.agent).trim() || base.reviewer.agent,
              model: reviewerModel.model,
            },
          };
          try {
            const res = await runtime.applySelections(next);
            if (!res.ok) return {title: "OpenLoop setup", output: `Rejected: ${res.error}`};
          } catch (e) {
            return {title: "OpenLoop setup", output: `Error: ${String((e as Error).message ?? e)}`};
          }
          return {
            title: "OpenLoop setup saved",
            output: `Saved selections:\n${formatCurrent(runtime.getSelections())}\n\nThese apply the next time a loop starts. (The global OpenCode default model/agent is unchanged.)`,
          };
        },
      }),
      openloop_config: tool({
        description: "Show the current OpenLoop configuration: persisted coder/reviewer agent+model selections and loop settings (max rounds, reviewer readonly, timeouts).",
        args: {},
        async execute() {
          const sel = formatCurrent(runtime.getSelections());
          return {
            title: "OpenLoop config",
            output: `${sel}\n\nmax_rounds=${config.maxRounds} reviewer_readonly=${config.reviewerReadonly} reviewer_verification=${config.reviewerVerification} reviewer_verify_scripts=${config.reviewerVerificationScripts.join(",")} verification_timeout_ms=${config.verificationTimeoutMs} turn_timeout_ms=${config.turnTimeoutMs} poll_interval_ms=${config.pollIntervalMs}`,
          };
        },
      }),
    },
  };

  return hooks;
};

/** Resolve the OpenLoop state directory for a project. */
function resolveStateDir(projectDir: string): string {
  return resolve(projectDir, ".opencode-orchestrator");
}

/** Format current selections for display in tools. */
function formatCurrent(s: Selections): string {
  const fmt = (sel: SessionSelection) => `agent=${sel.agent}, model=${sel.model ? formatModel(sel.model) : "(server default)"}`;
  return `Current selections:\n  coder: ${fmt(s.coder)}\n  reviewer: ${fmt(s.reviewer)}`;
}

function formatModel(model: NonNullable<SessionSelection["model"]>): string {
  return `${model.providerID}/${model.modelID}`;
}

function parseSetupModel(
  value: string | undefined,
  current: SessionSelection["model"],
): {ok: true; model: SessionSelection["model"]} | {ok: false; error: string} {
  if (value === undefined) return {ok: true, model: current};
  if (!value.trim()) return {ok: true, model: null};
  const parsed = parseModelRef(value);
  if (!parsed) return {ok: false, error: 'must be empty or in the form "providerID/modelID"'};
  return {ok: true, model: parsed};
}

/** Convert a v2 SDK error to a thrown Error. */
class OpenLoopError extends Error {}

/**
 * Per-turn watchdog: enforces a timeout and a polling fallback for the
 * currently-busy session. The plugin's event hook is the primary idle signal;
 * this watchdog guarantees recovery if the idle event is missed or the turn
 * hangs. It is armed after the prompt is sent and cancelled on idle/abort.
 */
class TurnWatchdog {
  private armed = false;
  private accepted = false;
  private cancelled = false;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private pollHandle: NodeJS.Timeout | null = null;
  private deadline: number | null = null;

  constructor(private opts: {
    sessionID: string;
    phase: "CODER_RUNNING" | "REVIEWER_RUNNING";
    timeoutMs: number;
    pollIntervalMs: number;
    onTimeout: () => Promise<void>;
    onPollIdle: () => Promise<void>;
    readStatus: (sessionID: string) => Promise<string | null>;
  }) {}

  /** Arm the timeout and polling fallback. Must be called after the prompt is sent. */
  arm(): void {
    if (this.armed || this.cancelled) return;
    this.armed = true;
    this.deadline ??= Date.now() + this.opts.timeoutMs;
    const remainingMs = Math.max(0, this.deadline - Date.now());
    this.timeoutHandle = setTimeout(() => {
      if (this.cancelled) return;
      log.warn("watchdog", `timeout fired for ${this.opts.sessionID}`);
      void this.opts.onTimeout().catch((error) => {
        log.error("watchdog", `timeout handler failed: ${String((error as Error).message ?? error)}`);
      });
    }, remainingMs);
    if (this.timeoutHandle.unref) this.timeoutHandle.unref();
    this.pollHandle = setInterval(() => {
      if (this.cancelled) return;
      void this.poll();
    }, this.opts.pollIntervalMs);
    if (this.pollHandle.unref) this.pollHandle.unref();
  }

  /** Enable status polling after promptAsync has accepted the request. */
  markAccepted(): void { this.accepted = true; }

  private polling = false;
  private async poll(): Promise<void> {
    if (this.cancelled || !this.armed || !this.accepted || this.polling) return;
    this.polling = true;
    try {
      const status = await this.opts.readStatus(this.opts.sessionID);
      if (this.cancelled || !this.armed) return;
      if (!status || status === "idle") {
        // The session went idle without an event — recover. Disarm immediately
        // so the async onPollIdle callback can't race with another poll tick.
        this.armed = false;
        if (this.pollHandle) { clearInterval(this.pollHandle); this.pollHandle = null; }
        if (this.timeoutHandle) { clearTimeout(this.timeoutHandle); this.timeoutHandle = null; }
        log.debug("watchdog", `poll found ${this.opts.sessionID} idle (missed event)`);
        void this.opts.onPollIdle().catch((error) => {
          log.error("watchdog", `idle recovery failed: ${String((error as Error).message ?? error)}`);
        });
      }
    } catch (e) {
      log.debug("watchdog", `status poll failed: ${String((e as Error).message ?? e)}`);
    } finally {
      this.polling = false;
    }
  }

  /** Cancel the watchdog (on idle, abort, or dispose). */
  cancel(): void {
    this.cancelled = true;
    this.armed = false;
    if (this.timeoutHandle) { clearTimeout(this.timeoutHandle); this.timeoutHandle = null; }
    if (this.pollHandle) { clearInterval(this.pollHandle); this.pollHandle = null; }
  }

  isBusy(): boolean { return this.armed && !this.cancelled; }

  remainingMs(): number {
    return this.deadline === null ? this.opts.timeoutMs : Math.max(0, this.deadline - Date.now());
  }
}

/**
 * Runtime that owns the machine, sessions, and event-driven loop execution.
 *
 * The loop is started on demand through the OpenLoop custom tools. It can also
 * be started by calling `runtime.start(goal)` programmatically.
 */
export class LoopRuntime {
  private machine: LoopMachine | null = null;
  private store: StateStore | null = null;
  private client: OpencodeClient;
  private config: OpenLoopConfig;
  private stateDir: string;
  private selections: SelectionStore;
  /** Immutable selection snapshot for the current run. */
  private activeSelections: Selections | null = null;
  private disposed = false;
  /** Resolves when the loop reaches a STOP effect. */
  private donePromise: Promise<LoopOutcome> | null = null;
  private doneResolve: ((o: LoopOutcome) => void) | null = null;
  private lastOutcome: LoopOutcome | null = null;
  /** Watchdog for the currently-busy turn (timeout + polling fallback). */
  private watchdog: TurnWatchdog | null = null;
  private expectedUserMessageID: string | null = null;
  /** Run token currently consuming an idle/error event, if any. */
  private consumingTurnToken: number | null = null;
  private verificationRunning = false;
  private verificationAbort: AbortController | null = null;
  private reviewerVerificationRecord: {
    round: number;
    /** Scripts discovered before any verifier command could mutate the manifest. */
    available: Set<string>;
    /** A null value means the latest execution passed; otherwise it describes the failure. */
    checks: Map<string, string | null>;
  } | null = null;
  private runToken = 0;

  constructor(config: OpenLoopConfig, client: OpencodeClient, stateDir: string, selections: SelectionStore) {
    this.config = config;
    this.client = client;
    this.stateDir = stateDir;
    this.selections = selections;
  }

  /** Resolve the effective coder selection (persisted or config fallback). */
  private coderSelection(): SessionSelection {
    return this.activeSelections?.coder ?? this.selections.coder;
  }

  /** Resolve the effective reviewer selection (persisted or config fallback). */
  private reviewerSelection(): SessionSelection {
    return this.activeSelections?.reviewer ?? this.selections.reviewer;
  }

  /** Return current persisted selections (for the setup/config tools). */
  getSelections(): Selections { return this.selections.snapshot(); }

  /** Update persisted selections (used by the openloop_setup tool). */
  async applySelections(next: Selections): Promise<{ok: true} | {ok: false; error: string}> {
    const catalog = await fetchCatalog(this.client, this.config.projectDir).catch((e) => {
      throw new OpenLoopError(`failed to query catalog: ${String((e as Error).message ?? e)}`);
    });
    const coderV = validateSelection(next.coder, catalog);
    if (!coderV.ok) return {ok: false, error: `coder: ${coderV.error}`};
    const reviewerV = validateSelection(next.reviewer, catalog);
    if (!reviewerV.ok) return {ok: false, error: `reviewer: ${reviewerV.error}`};
    const previous = this.selections.snapshot();
    this.selections.replaceAll({coder: coderV.selection, reviewer: reviewerV.selection});
    try {
      this.selections.flush();
    } catch (error) {
      // A rejected setup must not become the runtime's in-memory selection.
      this.selections.restore(previous);
      throw error;
    }
    return {ok: true};
  }

  /** Fetch the live catalog (for the setup/config tools). */
  async getCatalog(): Promise<Catalog> {
    return fetchCatalog(this.client, this.config.projectDir);
  }

  /** Execute constrained package scripts only for the active reviewer root. */
  async runReviewerVerification(
    sessionID: string,
    requestedScripts: readonly string[] | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.config.reviewerVerification) {
      throw new OpenLoopError("reviewer verification is disabled by OPENLOOP_REVIEWER_VERIFICATION");
    }
    const machine = this.machine;
    const reviewerSessionID = machine?.snapshot().reviewerSessionID;
    if (!machine || machine.phase !== "REVIEWER_RUNNING" || reviewerSessionID !== sessionID) {
      throw new OpenLoopError("openloop_verify may only be called by the active OpenLoop reviewer session");
    }
    if (this.verificationRunning) throw new OpenLoopError("reviewer verification is already running");
    const verificationRound = machine.round;

    const abort = new AbortController();
    const relayAbort = () => abort.abort();
    signal?.addEventListener("abort", relayAbort, {once: true});
    if (signal?.aborted) abort.abort();
    this.verificationRunning = true;
    this.verificationAbort = abort;
    try {
      const report = await runPackageVerification({
        projectDir: this.config.projectDir,
        allowedScripts: this.config.reviewerVerificationScripts,
        requestedScripts,
        timeoutMs: this.config.verificationTimeoutMs,
        signal: abort.signal,
      });
      if (this.machine === machine
        && machine.phase === "REVIEWER_RUNNING"
        && machine.round === verificationRound
        && machine.reviewerSessionID === sessionID) {
        const previous = this.reviewerVerificationRecord?.round === verificationRound
          ? this.reviewerVerificationRecord
          : null;
        const checks = new Map(previous?.checks ?? []);
        for (const check of report.checks) {
          const failure = check.aborted ? "aborted"
            : check.timedOut ? "timed out"
              : check.exitCode === 0 ? null : `failed with exit code ${check.exitCode ?? "unknown"}`;
          checks.set(check.script, failure);
        }
        this.reviewerVerificationRecord = {
          round: verificationRound,
          available: new Set([...(previous?.available ?? []), ...report.available]),
          checks,
        };
      }
      return formatVerificationReport(report);
    } finally {
      signal?.removeEventListener("abort", relayAbort);
      if (this.verificationAbort === abort) this.verificationAbort = null;
      this.verificationRunning = false;
    }
  }

  /** Start a new loop for a goal. Resolves with the final outcome. */
  async start(goal: string): Promise<LoopOutcome> {
    if (this.disposed) return {kind: "ERROR", rounds: 0, error: "plugin is disposed"};
    if (this.machine) {
      log.warn(SCOPE, "loop already running; ignoring start");
      return {kind: "ERROR", rounds: this.machine.round, error: "loop already running"};
    }
    const store = new StateStore(this.stateDir, goal);
    this.store = store;
    const machine = new LoopMachine(this.config, store.snapshot());
    this.machine = machine;
    const token = ++this.runToken;
    const donePromise = new Promise<LoopOutcome>((resolve) => { this.doneResolve = resolve; });
    this.donePromise = donePromise;
    this.lastOutcome = null;
    this.reviewerVerificationRecord = null;

    banner(`OpenLoop starting (max rounds: ${this.config.maxRounds})`);
    log.info(SCOPE, `goal accepted (${goal.length} characters)`);

    try {
      const effect = machine.start(goal);
      machine.setCoderSessionID(null);
      machine.setReviewerSessionID(null);
      const selectionResult = await Promise.race([
        this.validateSelectionsForStart().then((value) => ({type: "ready" as const, value})),
        donePromise.then((outcome) => ({type: "done" as const, outcome})),
      ]);
      if (selectionResult.type === "done") return selectionResult.outcome;
      const selections = selectionResult.value;
      if (!this.isCurrentRun(token, machine)) return await donePromise;
      this.activeSelections = selections;
      const sessionResult = await Promise.race([
        this.createSessions(token, machine).then(() => ({type: "ready" as const})),
        donePromise.then((outcome) => ({type: "done" as const, outcome})),
      ]);
      if (sessionResult.type === "done") return sessionResult.outcome;
      if (!this.isCurrentRun(token, machine)) return await donePromise;
      this.persistMachineBestEffort("initial session state");
      await this.dispatch(effect, token, machine);
    } catch (e) {
      if (!this.ownsRun(token, machine)) return await donePromise;
      // F4: cleanup on failed start so the runtime is reusable.
      const msg = e instanceof Error ? e.message : String(e);
      log.error(SCOPE, `start failed: ${msg}`);
      this.finish({kind: "ERROR", rounds: 0, error: msg}, token, machine);
    }
    return await donePromise;
  }

  /** Current status for tool and programmatic observation. */
  status(): {running: boolean; phase: string; round: number; outcome: string; detail: string} {
    const outcome = this.lastOutcome;
    return {
      running: this.machine !== null && this.machine.phase !== "DONE",
      phase: this.machine?.phase ?? "IDLE",
      round: this.machine?.round ?? outcome?.rounds ?? 0,
      outcome: outcome?.kind ?? "NONE",
      detail: formatOutcomeDetail(outcome),
    };
  }

  /** Stop the loop (cooperative). */
  async stop(): Promise<void> {
    if (!this.machine) return;
    this.verificationAbort?.abort();
    const machine = this.machine;
    const token = this.runToken;
    this.watchdog?.cancel();
    const effect = machine.abort();
    if (effect.type === "ABORT") {
      // The server may be unreachable. Issue the remote cancellation once but
      // never let its HTTP response gate the local stop contract.
      void this.abortSession(effect.sessionID);
      if (!this.ownsRun(token, machine)) return;
      const stopped = machine.abort();
      if (stopped.type === "STOP") this.finish(stopped.outcome, token, machine);
      return;
    }
    if (effect.type === "STOP") this.finish(effect.outcome, token, machine);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.verificationAbort?.abort();
    await this.stop();
    this.watchdog?.cancel();
    try {
      this.store?.flush();
    } catch (error) {
      log.error(SCOPE, `failed to flush state during dispose: ${String((error as Error).message ?? error)}`);
    }
  }

  /** Handle a session event from the plugin's event hook. */
  async handleEvent(event: Event): Promise<void> {
    if (!this.machine || this.machine.phase === "DONE") return;
    const machine = this.machine;
    const token = this.runToken;

    if (event.type === "session.idle") {
      const idleID = event.properties.sessionID;
      if (!idleID) return;
      const waitingOn = this.waitingSessionID();
      if (idleID !== waitingOn) return;
      if (!this.watchdog || !this.watchdog.isBusy()) return;
      await this.onWaitingSessionIdle();
    } else if (event.type === "session.status") {
      const {sessionID, status} = event.properties;
      if (sessionID !== this.waitingSessionID() || status.type !== "retry" || !this.watchdog?.isBusy()) return;
      const waitMs = Math.max(0, status.next - Date.now());
      if (waitMs >= this.watchdog.remainingMs()) {
        await this.failActiveTurn(
          "RetryDeadlineExceeded",
          `OpenCode retry cannot occur before the ${this.config.turnTimeoutMs}ms turn deadline: ${status.message}`,
        );
      } else {
        log.warn(SCOPE, `OpenCode is retrying ${sessionID} (attempt ${status.attempt}): ${status.message}`);
      }
    } else if (event.type === "session.error") {
      const errSession = event.properties.sessionID;
      if (!errSession) return;
      // F3: only handle errors for the session we're currently waiting on.
      const waitingOn = this.waitingSessionID();
      if (errSession !== waitingOn || !this.watchdog || !this.watchdog.isBusy()) return;
      log.error(SCOPE, `session error event for ${errSession}`);
      // The plugin hook currently exposes a v1 Event union while the v2
      // assistant API can report StructuredOutputError. Inspect the runtime
      // name without relying on the narrower generated v1 discriminant.
      const eventError: unknown = event.properties.error;
      const eventErrorName = runtimeErrorName(eventError);
      // Structured-output failures can still persist useful JSON in the
      // matching assistant text. Read that turn instead of discarding it.
      if (eventErrorName === "StructuredOutputError") {
        await this.onWaitingSessionIdle();
        return;
      }
      this.watchdog.cancel();
      const errTurn = {
        messageID: "",
        parentMessageID: this.expectedUserMessageID ?? "",
        text: "",
        structured: null,
        error: {
          name: eventErrorName ?? "SessionError",
          message: eventError && typeof eventError === "object" && "data" in eventError
            ? String((eventError.data as {message?: string}).message ?? eventErrorName)
            : "session error event",
        },
      };
      if (!this.isCurrentRun(token, machine)) return;
      const effect = machine.phase === "REVIEWER_RUNNING"
        ? machine.onReviewerTurn(errTurn)
        : machine.onCoderTurn(errTurn);
      await this.dispatch(effect, token, machine);
    }
  }

  private waitingSessionID(): string | null {
    if (!this.machine) return null;
    if (this.machine.phase === "CODER_RUNNING") return this.machine.coderSessionID;
    if (this.machine.phase === "REVIEWER_RUNNING") return this.machine.reviewerSessionID;
    return null;
  }

  /** Called when the session we're waiting on goes idle (turn done). */
  private async onWaitingSessionIdle(): Promise<void> {
    if (!this.machine) return;
    const machine = this.machine;
    const token = this.runToken;
    if (this.consumingTurnToken === token) return;
    const sessionID = this.waitingSessionID();
    if (!sessionID) return;
    const parentMessageID = this.expectedUserMessageID ?? undefined;
    const watchdog = this.watchdog;
    this.consumingTurnToken = token;
    try {
      const turn = await readLastTurn(this.client, sessionID, parentMessageID);
      if (!this.isCurrentRun(token, machine)
        || this.waitingSessionID() !== sessionID
        || this.expectedUserMessageID !== parentMessageID
        || this.watchdog !== watchdog) return;
      watchdog?.cancel();
      this.expectedUserMessageID = null;
      const effect = machine.phase === "REVIEWER_RUNNING"
        ? await this.reviewerTurnEffect(machine, turn, token)
        : machine.onCoderTurn(turn);
      if (!effect) return;
      await this.dispatch(effect, token, machine);
    } catch (e) {
      if (e instanceof SdkError && e.code === "TurnNotReady") {
        if (this.isCurrentRun(token, machine)
          && this.waitingSessionID() === sessionID
          && this.expectedUserMessageID === parentMessageID
          && this.watchdog === watchdog) watchdog?.arm();
        return;
      }
      if (!this.isCurrentRun(token, machine)) return;
      this.watchdog?.cancel();
      this.expectedUserMessageID = null;
      log.error(SCOPE, `failed to read turn for ${sessionID}: ${String((e as Error).message ?? e)}`);
      const errTurn = {
        messageID: "",
        parentMessageID: parentMessageID ?? "",
        text: "",
        structured: null,
        error: {name: "ReadError", message: String((e as Error).message ?? e)},
      };
      const effect = machine.phase === "REVIEWER_RUNNING"
        ? machine.onReviewerTurn(errTurn)
        : machine.onCoderTurn(errTurn);
      await this.dispatch(effect, token, machine);
    } finally {
      if (this.consumingTurnToken === token) this.consumingTurnToken = null;
    }
  }

  /** Require real per-round verification before accepting a reviewer verdict when checks exist. */
  private async reviewerTurnEffect(
    machine: LoopMachine,
    turn: TurnResult,
    token: number,
  ): Promise<Effect | null> {
    if (!this.isCurrentRun(token, machine) || machine.phase !== "REVIEWER_RUNNING") return null;
    if (!this.config.reviewerVerification) return machine.onReviewerTurn(turn);
    // StructuredOutputError can still contain valid recoverable JSON that the
    // state machine accepts, so it must pass the same verification gate.
    if (turn.error && turn.error.name !== "StructuredOutputError") return machine.onReviewerTurn(turn);
    const manifestPath = join(this.config.projectDir, "package.json");
    if (!existsSync(manifestPath)) return machine.onReviewerTurn(turn);
    let available: string[];
    try {
      ({available} = await availableVerificationScripts(
        this.config.projectDir,
        this.config.reviewerVerificationScripts,
      ));
    } catch (error) {
      if (!this.isCurrentRun(token, machine) || machine.phase !== "REVIEWER_RUNNING") return null;
      return machine.onReviewerTurn({
        ...turn,
        structured: null,
        error: {
          name: "VerificationPreflightError",
          message: `unable to determine reviewer verification scripts: ${String((error as Error).message ?? error)}`,
        },
      });
    }
    if (!this.isCurrentRun(token, machine) || machine.phase !== "REVIEWER_RUNNING") return null;
    const record = this.reviewerVerificationRecord?.round === machine.round
      ? this.reviewerVerificationRecord
      : null;
    // Retain the pre-execution catalog so a verifier script cannot remove its
    // own package.json entry and make a failure disappear before acceptance.
    const expected = [...new Set([...(record?.available ?? []), ...available])];
    const missing = expected.filter((script) => !record?.checks.has(script));
    if (missing.length > 0) {
      return machine.onReviewerTurn({
        ...turn,
        structured: null,
        error: {
          name: "VerificationRequired",
          message: `reviewer did not complete all openloop_verify checks in round ${machine.round}; missing scripts: ${missing.join(", ")}`,
        },
      });
    }
    const failed = expected.flatMap((script) => {
      const failure = record?.checks.get(script);
      return failure ? [`${script} (${failure})`] : [];
    });
    // The machine also treats a verdict with no material findings as PASS, so
    // guard the effective outcome rather than trusting the verdict label alone.
    if (failed.length > 0 && !requiresChanges(parseVerdict(turn))) {
      return machine.onReviewerTurn({
        ...turn,
        structured: null,
        error: {
          name: "VerificationFailedCannotPass",
          message: `reviewer cannot complete the round without material findings while verification failed: ${failed.join(", ")}`,
        },
      });
    }
    return machine.onReviewerTurn(turn);
  }

  /** Interpret an Effect returned by the machine. */
  private async dispatch(effect: Effect, token: number, machine: LoopMachine): Promise<void> {
    if (!this.ownsRun(token, machine)) return;
    this.persistMachineBestEffort(`transition ${effect.type}`);
    if (this.disposed && effect.type !== "STOP") return;
    switch (effect.type) {
      case "SEND_CODER": {
        roundBanner(effect.round, this.config.maxRounds);
        controlBanner("CODER", effect.round === 1 ? "initial implementation" : "fix reviewer findings");
        const sel = this.coderSelection();
        await this.sendAndWatch(machine.coderSessionID!, effect.prompt, {
          model: sel.model,
          agent: sel.agent,
          system: coderSystemPrompt(),
        }, token, machine);
        return;
      }
      case "SEND_REVIEWER": {
        controlBanner("REVIEWER", `inspect round ${effect.round}`);
        const sel = this.reviewerSelection();
        await this.sendAndWatch(machine.reviewerSessionID!, effect.prompt, {
          model: sel.model,
          agent: sel.agent,
          system: reviewerSystemPrompt(),
        }, token, machine);
        return;
      }
      case "FETCH_DIFF": {
        try {
          const diff = await readDiff(this.client, effect.sessionID, effect.messageID);
          if (!this.isCurrentRun(token, machine)) return;
          logDiff(diff);
          await this.dispatch(machine.onDiff(diff), token, machine);
        } catch (e) {
          if (!this.isCurrentRun(token, machine)) return;
          log.warn(SCOPE, `diff fetch failed: ${String((e as Error).message ?? e)}`);
          await this.dispatch(machine.onDiff(null), token, machine);
        }
        return;
      }
      case "ABORT": {
        // F1: abort the session, then drive STOP via the machine (machine.abort()
        // is idempotent — a second call returns STOP). Do not re-dispatch ABORT.
        // Remote abort is best-effort: a dead server must not defeat the local
        // turn deadline or leave the runtime permanently wedged.
        void this.abortSession(effect.sessionID);
        if (!this.ownsRun(token, machine)) return;
        await this.dispatch(machine.abort(), token, machine);
        return;
      }
      case "STOP": {
        this.finish(effect.outcome, token, machine);
        return;
      }
    }
  }

  /**
   * Send a prompt and start the turn watchdog. F6: the watchdog is armed BEFORE
   * the prompt is sent so a fast idle event can't be missed. If sendPrompt
   * throws, the watchdog is cancelled and the error is dispatched.
   */
  private async sendAndWatch(
    sessionID: string,
    text: string,
    opts: {
      model: OpenLoopConfig["coderModel"];
      agent: string;
      system?: string;
    },
    token: number,
    machine: LoopMachine,
  ): Promise<void> {
    if (!this.isCurrentRun(token, machine)) return;
    const phase = machine.phase as "CODER_RUNNING" | "REVIEWER_RUNNING";
    let status: string;
    try {
      status = await readSessionStatus(this.client, sessionID);
    } catch (error) {
      if (!this.isCurrentRun(token, machine)) return;
      const effect = phase === "REVIEWER_RUNNING"
        ? machine.onReviewerTurn(turnError("StatusError", String((error as Error).message ?? error)))
        : machine.onCoderTurn(turnError("StatusError", String((error as Error).message ?? error)));
      await this.dispatch(effect, token, machine);
      return;
    }
    if (!this.isCurrentRun(token, machine) || this.waitingSessionID() !== sessionID) return;
    if (status === "busy" || status === "retry") {
      const errTurn = turnError("BusySession", `session ${sessionID} is ${status}; refusing to overlap prompts`);
      const effect = phase === "REVIEWER_RUNNING"
        ? machine.onReviewerTurn(errTurn)
        : machine.onCoderTurn(errTurn);
      await this.dispatch(effect, token, machine);
      return;
    }
    const userMessageID = createMessageID();
    this.expectedUserMessageID = userMessageID;
    const watchdog = new TurnWatchdog({
      sessionID,
      phase,
      timeoutMs: this.config.turnTimeoutMs,
      pollIntervalMs: this.config.pollIntervalMs,
      onTimeout: async () => {
        if (!this.isCurrentRun(token, machine)
          || this.waitingSessionID() !== sessionID
          || this.expectedUserMessageID !== userMessageID
          || this.watchdog !== watchdog) return;
        log.warn(SCOPE, `turn timeout for ${sessionID} after ${this.config.turnTimeoutMs}ms; aborting`);
        await this.failActiveTurn(
          "TimeoutError",
          `session ${sessionID} exceeded the ${this.config.turnTimeoutMs}ms turn timeout`,
        );
      },
      onPollIdle: async () => {
        if (!this.isCurrentRun(token, machine)
          || this.waitingSessionID() !== sessionID
          || this.expectedUserMessageID !== userMessageID
          || this.watchdog !== watchdog) return;
        log.debug(SCOPE, `poll detected idle for ${sessionID} (missed event); recovering`);
        await this.onWaitingSessionIdle();
      },
      readStatus: async (id) => {
        return readSessionStatus(this.client, id);
      },
    });
    this.watchdog = watchdog;
    // Arm before sending so a very fast idle event cannot be lost. Polling is
    // held until promptAsync acknowledges the request.
    watchdog.arm();
    try {
      await this.sendPrompt(sessionID, userMessageID, text, opts);
      if (!this.isExactTurn(token, machine, phase, sessionID, userMessageID, watchdog)) return;
      watchdog.markAccepted();
    } catch (e) {
      if (!this.isExactTurn(token, machine, phase, sessionID, userMessageID, watchdog)) return;
      watchdog.cancel();
      this.watchdog = null;
      this.expectedUserMessageID = null;
      const msg = e instanceof Error ? e.message : String(e);
      const errTurn = turnError("PromptError", msg, userMessageID);
      const effect = phase === "REVIEWER_RUNNING"
        ? machine.onReviewerTurn(errTurn)
        : machine.onCoderTurn(errTurn);
      await this.dispatch(effect, token, machine);
    }
  }

  /** Abort the remote turn and finish locally with a diagnostic ERROR. */
  private async failActiveTurn(name: string, message: string): Promise<void> {
    const machine = this.machine;
    if (!machine || machine.phase === "DONE") return;
    const token = this.runToken;
    const sessionID = this.waitingSessionID();
    if (!sessionID) return;
    const phase = machine.phase;
    this.watchdog?.cancel();
    this.watchdog = null;
    this.expectedUserMessageID = null;
    void this.abortSession(sessionID);
    if (!this.isCurrentRun(token, machine)) return;
    const turn = turnError(name, message);
    const effect = phase === "REVIEWER_RUNNING"
      ? machine.onReviewerTurn(turn)
      : machine.onCoderTurn(turn);
    await this.dispatch(effect, token, machine);
  }

  /** Send a prompt asynchronously and let the event hook + watchdog observe idle. */
  private async sendPrompt(
    sessionID: string,
    messageID: string,
    text: string,
    opts: {
      model: OpenLoopConfig["coderModel"];
      agent: string;
      system?: string;
    },
  ): Promise<void> {
    await unwrap(this.client.session.promptAsync({
      sessionID,
      messageID,
      parts: [{type: "text", text}],
      model: opts.model ? {providerID: opts.model.providerID, modelID: opts.model.modelID} : undefined,
      agent: opts.agent,
      system: opts.system,
    }), `prompt session ${sessionID}`, true);
  }

  /** Create two fresh, independent root sessions for this run. */
  private async createSessions(token: number, machine: LoopMachine): Promise<void> {
    const createdIDs: string[] = [];
    try {
      const reviewerPermissions = this.config.reviewerReadonly
        ? await buildReadonlyPermissions(this.client)
        : undefined;
      if (!this.isCurrentRun(token, machine)) return;
      const coder = await createRootSession(this.client, "CODER (openloop)");
      createdIDs.push(coder.id);
      if (!this.isCurrentRun(token, machine)) {
        await this.cleanupSessions(createdIDs);
        return;
      }
      const reviewer = await createRootSession(
        this.client,
        "REVIEWER (openloop)",
        reviewerPermissions,
      );
      createdIDs.push(reviewer.id);
      if (!this.isCurrentRun(token, machine)) {
        await this.cleanupSessions(createdIDs);
        return;
      }
      if (coder.id === reviewer.id) {
        throw new OpenLoopError(`OpenCode returned the same session ID for coder and reviewer: ${coder.id}`);
      }
      machine.setCoderSessionID(coder.id);
      machine.setReviewerSessionID(reviewer.id);
      log.info(SCOPE, `created independent root sessions coder=${coder.id} reviewer=${reviewer.id}`);

      if (reviewerPermissions) {
        const denied = reviewerPermissions.map((rule) => rule.permission);
        log.info(SCOPE, `reviewer readonly: denied ${denied.join(", ")}`);
      }
    } catch (error) {
      await this.cleanupSessions(createdIDs);
      throw error;
    }
  }

  /** Best-effort cleanup for roots created during a setup that did not start. */
  private async cleanupSessions(sessionIDs: string[]): Promise<void> {
    await Promise.all([...new Set(sessionIDs)].map(async (sessionID) => {
      await this.abortSession(sessionID);
      try {
        await unwrap(this.client.session.delete({sessionID}), `delete session ${sessionID}`);
      } catch (error) {
        log.warn(SCOPE, `delete failed for unused session ${sessionID}: ${String((error as Error).message ?? error)}`);
      }
    }));
  }

  /** Abort a session, ignoring errors. */
  private async abortSession(sessionID: string): Promise<void> {
    try {
      await sdkAbortSession(this.client, sessionID);
    } catch (e) {
      log.warn(SCOPE, `abort failed for ${sessionID}: ${String((e as Error).message ?? e)}`);
    }
  }

  private finish(outcome: LoopOutcome, token: number, machine: LoopMachine): void {
    if (!this.ownsRun(token, machine)) return;
    this.watchdog?.cancel();
    this.watchdog = null;
    machine.phase = "DONE";
    this.lastOutcome = outcome;
    try {
      // State is diagnostic at this point. A locked/full disk must not leave the
      // runtime permanently wedged in a completed-but-still-owned run.
      try {
        this.persistMachine();
      } catch (error) {
        log.error(SCOPE, `failed to persist final state: ${String((error as Error).message ?? error)}`);
      }
      switch (outcome.kind) {
        case "PASS":
          banner(`OpenLoop PASS after ${outcome.rounds} round${outcome.rounds === 1 ? "" : "s"}`);
          if (outcome.finalSummary) section(`Final: ${outcome.finalSummary}`);
          break;
        case "MAX_ROUNDS":
          banner(`OpenLoop stopped at max rounds (${outcome.rounds})`);
          if (outcome.finalSummary) section(`Last: ${outcome.finalSummary}`);
          break;
        case "ABORTED":
          banner(`OpenLoop aborted after ${outcome.rounds} round${outcome.rounds === 1 ? "" : "s"}`);
          break;
        case "ERROR":
          log.error(SCOPE, `OpenLoop failed after ${outcome.rounds} round(s): ${outcome.error}`);
          break;
      }
    } finally {
      this.doneResolve?.(outcome);
      this.doneResolve = null;
      this.machine = null;
      this.runToken += 1;
      this.activeSelections = null;
      this.expectedUserMessageID = null;
      this.consumingTurnToken = null;
    }
  }

  private persistMachine(): void {
    if (!this.machine || !this.store) return;
    this.store.replaceFrom(this.machine.snapshot() as PersistedState);
    this.store.flush();
  }

  private persistMachineBestEffort(context: string): void {
    try {
      this.persistMachine();
    } catch (error) {
      log.error(SCOPE, `failed to persist ${context}: ${String((error as Error).message ?? error)}`);
    }
  }

  private async validateSelectionsForStart(): Promise<Selections> {
    const catalog = await this.getCatalog();
    const current = this.selections.snapshot();
    const coder = validateSelection(current.coder, catalog);
    if (!coder.ok) throw new OpenLoopError(`coder selection invalid: ${coder.error}`);
    const reviewer = validateSelection(current.reviewer, catalog);
    if (!reviewer.ok) throw new OpenLoopError(`reviewer selection invalid: ${reviewer.error}`);
    return {coder: coder.selection, reviewer: reviewer.selection};
  }

  private ownsRun(token: number, machine: LoopMachine): boolean {
    return token === this.runToken && this.machine === machine;
  }

  private isCurrentRun(token: number, machine: LoopMachine): boolean {
    return this.ownsRun(token, machine) && machine.phase !== "DONE";
  }

  private isExactTurn(
    token: number,
    machine: LoopMachine,
    phase: "CODER_RUNNING" | "REVIEWER_RUNNING",
    sessionID: string,
    userMessageID: string,
    watchdog: TurnWatchdog,
  ): boolean {
    return this.isCurrentRun(token, machine)
      && machine.phase === phase
      && this.waitingSessionID() === sessionID
      && this.expectedUserMessageID === userMessageID
      && this.watchdog === watchdog;
  }
}

function turnError(name: string, message: string, parentMessageID = "") {
  return {messageID: "", parentMessageID, text: "", structured: null, error: {name, message}};
}

function runtimeErrorName(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("name" in error)) return undefined;
  return typeof error.name === "string" ? error.name : undefined;
}

function formatOutcomeDetail(outcome: LoopOutcome | null): string {
  if (!outcome) return "none";
  if (outcome.kind === "ERROR") return outcome.error;
  if (outcome.kind === "PASS" || outcome.kind === "MAX_ROUNDS") return outcome.finalSummary || outcome.kind;
  return "stopped by request";
}

let lastMessageTimestamp = 0;
let messageCounter = 0;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Generate the same sortable msg_ identifier shape used by OpenCode. */
function createMessageID(): string {
  const timestamp = Date.now();
  if (timestamp !== lastMessageTimestamp) {
    lastMessageTimestamp = timestamp;
    messageCounter = 0;
  }
  messageCounter += 1;
  const encoded = BigInt(timestamp) * 0x1000n + BigInt(messageCounter);
  const time = encoded.toString(16).padStart(12, "0").slice(-12);
  const bytes = randomBytes(14);
  let suffix = "";
  for (const byte of bytes) suffix += BASE62[byte % BASE62.length];
  return `msg_${time}${suffix}`;
}

function logDiff(diff: DiffSummary | null): void {
  if (!diff || diff.files === 0) { section("Diff: no changes"); return; }
  section(`Diff: ${diff.files} file${diff.files === 1 ? "" : "s"}, +${diff.additions} -${diff.deletions}`);
  for (const d of diff.diffs.slice(0, 20)) {
    process.stderr.write(`  ${d.file ?? "(unknown)"} (+${d.additions} -${d.deletions})\n`);
  }
  if (diff.diffs.length > 20) process.stderr.write(`  …and ${diff.diffs.length - 20} more\n`);
}

import {createOpencodeClient as createClientV2, type OpencodeClient} from "@opencode-ai/sdk/v2";
import {resolve} from "node:path";
import type {Plugin, PluginInput, Hooks} from "@opencode-ai/plugin";
import {tool} from "@opencode-ai/plugin";
import type {Event} from "@opencode-ai/sdk";
import {
  type OpenLoopConfig, type LoopOutcome, type DiffSummary,
  type SessionSelection, type Selections, type Effect,
  LoopMachine, StateStore, SelectionStore, loadConfig, ConfigError,
  coderSystemPrompt, reviewerSystemPrompt, REVIEWER_OUTPUT_SCHEMA,
  log, banner, controlBanner, roundBanner, section,
} from "@openloop/core";
import {readLastTurn, readDiff, sessionExists, buildReadonlyTools} from "./sdk.js";
import {fetchCatalog, validateSelection, formatCatalog, parseModelRef, type Catalog} from "./catalog.js";

export type {Plugin, PluginInput, Hooks};

const SCOPE = "openloop";

/**
 * OpenLoop plugin entry point.
 *
 * Register in opencode.json:
 *   { "plugin": ["@openloop/opencode-plugin"] }
 *
 * Or as a local file in .opencode/plugins/openloop.ts that re-exports this.
 *
 * The plugin coordinates two independent root sessions (CODER, REVIEWER) and
 * drives the review/fix loop using the OpenCode SDK + session events.
 */
export const OpenLoopPlugin: Plugin = async (input: PluginInput) => {
  const {serverUrl, directory} = input;
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

  // Build a v2 SDK client wired to the same server as the plugin, so we can use
  // structured output (format) for the reviewer verdict. The plugin's own
  // `input.client` is a v1 client; v2 is needed for `format`.
  const client: OpencodeClient = createClientV2({
    baseUrl: serverUrl.origin,
    directory,
  });

  const runtime = new LoopRuntime(config, client, stateDir, new SelectionStore(stateDir));

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
    tool: {
      openloop_start_goal: tool({
        description:
          "Start an OpenLoop coder/reviewer review loop for a goal. The coder session implements/fixes; an independent reviewer inspects and reports findings; the loop repeats until the reviewer passes or max rounds is reached. Returns the final outcome.",
        args: {
          goal: tool.schema.string().describe("The user's goal for the coder/reviewer loop."),
        },
        async execute(args) {
          const goal = (args.goal ?? "").trim();
          if (!goal) return {title: "OpenLoop", output: "Error: goal is required."};
          if (runtime.status().running) {
            return {title: "OpenLoop", output: "A loop is already running. Use openloop_status to monitor it."};
          }
          // Run asynchronously; the tool returns immediately so the calling session isn't blocked.
          void runtime.start(goal).catch((e) => {
            log.error(SCOPE, `loop failed: ${String((e as Error).message ?? e)}`);
          });
          return {
            title: "OpenLoop started",
            output: `Started coder/reviewer loop for goal: ${goal}\nThe loop runs in the background. Use openloop_status to check progress.`,
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
            output: `running=${s.running} phase=${s.phase} round=${s.round}`,
          };
        },
      }),
      openloop_stop: tool({
        description: "Cooperatively stop the running OpenLoop loop (aborts the current busy session).",
        args: {},
        async execute() {
          await runtime.stop();
          return {title: "OpenLoop stop", output: "Stop requested. The loop will finish its current step then exit."};
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
          const next: Selections = {
            coder: {
              agent: (args.coder_agent ?? base.coder.agent).trim() || base.coder.agent,
              model: args.coder_model !== undefined ? parseModelRef(args.coder_model) : base.coder.model,
            },
            reviewer: {
              agent: (args.reviewer_agent ?? base.reviewer.agent).trim() || base.reviewer.agent,
              model: args.reviewer_model !== undefined ? parseModelRef(args.reviewer_model) : base.reviewer.model,
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
            output: `${sel}\n\nmax_rounds=${config.maxRounds} reviewer_readonly=${config.reviewerReadonly} turn_timeout_ms=${config.turnTimeoutMs} poll_interval_ms=${config.pollIntervalMs}`,
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
  const fmt = (sel: SessionSelection) => `agent=${sel.agent}, model=${sel.model ? `${sel.model.providerID}/${sel.model.modelID}` : "(server default)"}`;
  return `Current selections:\n  coder: ${fmt(s.coder)}\n  reviewer: ${fmt(s.reviewer)}`;
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
  private cancelled = false;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private pollHandle: NodeJS.Timeout | null = null;

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
    this.timeoutHandle = setTimeout(() => {
      if (this.cancelled) return;
      log.warn("watchdog", `timeout fired for ${this.opts.sessionID}`);
      void this.opts.onTimeout();
    }, this.opts.timeoutMs);
    if (this.timeoutHandle.unref) this.timeoutHandle.unref();
    this.pollHandle = setInterval(() => {
      if (this.cancelled) return;
      void this.poll();
    }, this.opts.pollIntervalMs);
    if (this.pollHandle.unref) this.pollHandle.unref();
  }

  private polling = false;
  private async poll(): Promise<void> {
    if (this.cancelled || !this.armed || this.polling) return;
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
        void this.opts.onPollIdle();
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
}

/**
 * Runtime that owns the machine, sessions, and event-driven loop execution.
 *
 * The loop is started on demand via the `openloop_start_goal` custom tool (so the
 * user/AI can trigger it from within OpenCode). It can also be started by
 * calling `runtime.start(goal)` programmatically (e.g. from a future MCP tool).
 */
export class LoopRuntime {
  private machine: LoopMachine | null = null;
  private store: StateStore | null = null;
  private client: OpencodeClient;
  private config: OpenLoopConfig;
  private stateDir: string;
  private selections: SelectionStore;
  private reviewerTools: Record<string, boolean> | undefined;
  private disposed = false;
  /** Resolves when the loop reaches a STOP effect. */
  private donePromise: Promise<LoopOutcome> | null = null;
  private doneResolve: ((o: LoopOutcome) => void) | null = null;
  /** Watchdog for the currently-busy turn (timeout + polling fallback). */
  private watchdog: TurnWatchdog | null = null;

  constructor(config: OpenLoopConfig, client: OpencodeClient, stateDir: string, selections: SelectionStore) {
    this.config = config;
    this.client = client;
    this.stateDir = stateDir;
    this.selections = selections;
  }

  /** Resolve the effective coder selection (persisted or config fallback). */
  private coderSelection(): SessionSelection {
    const s = this.selections.coder;
    return {
      agent: s.agent || this.config.coderAgent,
      model: s.model ?? this.config.coderModel,
    };
  }

  /** Resolve the effective reviewer selection (persisted or config fallback). */
  private reviewerSelection(): SessionSelection {
    const s = this.selections.reviewer;
    return {
      agent: s.agent || this.config.reviewerAgent,
      model: s.model ?? this.config.reviewerModel,
    };
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
    this.selections.replaceAll({coder: coderV.selection, reviewer: reviewerV.selection});
    this.selections.flush();
    return {ok: true};
  }

  /** Fetch the live catalog (for the setup/config tools). */
  async getCatalog(): Promise<Catalog> {
    return fetchCatalog(this.client, this.config.projectDir);
  }

  /** Start a new loop for a goal. Resolves with the final outcome. */
  async start(goal: string): Promise<LoopOutcome> {
    if (this.machine) {
      log.warn(SCOPE, "loop already running; ignoring start");
      return {kind: "ERROR", rounds: this.machine.round, error: "loop already running"};
    }
    const store = new StateStore(this.stateDir, goal);
    this.store = store;
    this.machine = new LoopMachine(this.config, store.snapshot());
    this.donePromise = new Promise((resolve) => { this.doneResolve = resolve; });

    banner(`OpenLoop starting (max rounds: ${this.config.maxRounds})`);
    log.info(SCOPE, `goal: ${goal}`);

    try {
      await this.ensureSessions();
      store.setCoderSessionID(this.machine.coderSessionID);
      store.setReviewerSessionID(this.machine.reviewerSessionID);
      store.flush();

      const effect = this.machine.start(goal);
      await this.dispatch(effect);
    } catch (e) {
      // F4: cleanup on failed start so the runtime is reusable.
      const msg = e instanceof Error ? e.message : String(e);
      log.error(SCOPE, `start failed: ${msg}`);
      this.finish({kind: "ERROR", rounds: 0, error: msg});
    }
    return (await this.donePromise) ?? {kind: "ERROR", rounds: 0, error: "loop ended unexpectedly"};
  }

  /** Current status for external observation (future MCP adapter). */
  status(): {running: boolean; phase: string; round: number} {
    return {
      running: this.machine !== null && this.machine.phase !== "DONE",
      phase: this.machine?.phase ?? "IDLE",
      round: this.machine?.round ?? 0,
    };
  }

  /** Stop the loop (cooperative). */
  async stop(): Promise<void> {
    if (!this.machine) return;
    const effect = this.machine.abort();
    if (effect.type === "ABORT") {
      // Abort the busy session; the idle event (or watchdog) will drive STOP.
      await this.abortSession(effect.sessionID);
    } else if (effect.type === "STOP") {
      this.finish(effect.outcome);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
    this.watchdog?.cancel();
    this.store?.flush();
  }

  /** Handle a session event from the plugin's event hook. */
  async handleEvent(event: Event): Promise<void> {
    if (!this.machine || this.machine.phase === "DONE") return;

    if (event.type === "session.idle") {
      const idleID = event.properties.sessionID;
      if (!idleID) return;
      const waitingOn = this.waitingSessionID();
      if (idleID !== waitingOn) return;
      if (!this.watchdog || !this.watchdog.isBusy()) return;
      await this.onWaitingSessionIdle();
    } else if (event.type === "session.error") {
      const errSession = event.properties.sessionID;
      if (!errSession) return;
      // F3: only handle errors for the session we're currently waiting on.
      const waitingOn = this.waitingSessionID();
      if (errSession !== waitingOn || !this.watchdog || !this.watchdog.isBusy()) return;
      log.error(SCOPE, `session error event for ${errSession}`);
      this.watchdog.cancel();
      const errTurn = {messageID: "", text: "", structured: null, error: {name: "SessionError", message: "session error event"}};
      const effect = this.machine.phase === "REVIEWER_RUNNING"
        ? this.machine.onReviewerTurn(errTurn)
        : this.machine.onCoderTurn(errTurn);
      await this.dispatch(effect);
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
    const sessionID = this.waitingSessionID();
    if (!sessionID) return;
    // Cancel the watchdog before reading the turn so the timeout/poll can't fire concurrently.
    this.watchdog?.cancel();
    try {
      const turn = await readLastTurn(this.client, sessionID);
      const effect = this.machine.phase === "REVIEWER_RUNNING"
        ? this.machine.onReviewerTurn(turn)
        : this.machine.onCoderTurn(turn);
      await this.dispatch(effect);
    } catch (e) {
      log.error(SCOPE, `failed to read turn for ${sessionID}: ${String((e as Error).message ?? e)}`);
      const errTurn = {messageID: "", text: "", structured: null, error: {name: "ReadError", message: String((e as Error).message ?? e)}};
      const effect = this.machine.phase === "REVIEWER_RUNNING"
        ? this.machine.onReviewerTurn(errTurn)
        : this.machine.onCoderTurn(errTurn);
      await this.dispatch(effect);
    }
  }

  /** Interpret an Effect returned by the machine. */
  private async dispatch(effect: Effect): Promise<void> {
    if (this.disposed && effect.type !== "STOP") return;
    switch (effect.type) {
      case "SEND_CODER": {
        roundBanner(effect.round, this.config.maxRounds);
        controlBanner("CODER", effect.round === 1 ? "initial implementation" : "fix reviewer findings");
        const sel = this.coderSelection();
        await this.sendAndWatch(this.machine!.coderSessionID!, effect.prompt, {
          model: sel.model,
          agent: sel.agent,
          system: coderSystemPrompt(),
        });
        return;
      }
      case "SEND_REVIEWER": {
        controlBanner("REVIEWER", `inspect round ${effect.round}`);
        const sel = this.reviewerSelection();
        await this.sendAndWatch(this.machine!.reviewerSessionID!, effect.prompt, {
          model: sel.model,
          agent: sel.agent,
          system: reviewerSystemPrompt(),
          tools: this.reviewerTools,
          format: {type: "json_schema", schema: REVIEWER_OUTPUT_SCHEMA as unknown as Record<string, unknown>, retryCount: 2},
        });
        return;
      }
      case "FETCH_DIFF": {
        try {
          const diff = await readDiff(this.client, effect.sessionID, effect.messageID);
          logDiff(diff);
          await this.dispatch(this.machine!.onDiff(diff));
        } catch (e) {
          log.warn(SCOPE, `diff fetch failed: ${String((e as Error).message ?? e)}`);
          await this.dispatch(this.machine!.onDiff(null));
        }
        return;
      }
      case "ABORT": {
        // F1: abort the session, then drive STOP via the machine (machine.abort()
        // is idempotent — a second call returns STOP). Do not re-dispatch ABORT.
        await this.abortSession(effect.sessionID);
        await this.dispatch(this.machine!.abort());
        return;
      }
      case "STOP": {
        this.finish(effect.outcome);
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
      tools?: Record<string, boolean>;
      format?: {type: "json_schema"; schema: Record<string, unknown>; retryCount?: number};
    },
  ): Promise<void> {
    const phase = this.machine!.phase as "CODER_RUNNING" | "REVIEWER_RUNNING";
    this.watchdog = new TurnWatchdog({
      sessionID,
      phase,
      timeoutMs: this.config.turnTimeoutMs,
      pollIntervalMs: this.config.pollIntervalMs,
      onTimeout: async () => {
        log.warn(SCOPE, `turn timeout for ${sessionID} after ${this.config.turnTimeoutMs}ms; aborting`);
        await this.abortSession(sessionID);
        const effect = this.machine!.abort();
        await this.dispatch(effect);
      },
      onPollIdle: async () => {
        log.debug(SCOPE, `poll detected idle for ${sessionID} (missed event); recovering`);
        await this.onWaitingSessionIdle();
      },
      readStatus: async (id) => {
        const map = await this.client.session.status().then((r) => r.data ?? {}).catch(() => ({} as Record<string, unknown>));
        return (map as Record<string, {type?: string}>)[id]?.type ?? null;
      },
    });
    try {
      await this.sendPrompt(sessionID, text, opts);
      this.watchdog.arm();
    } catch (e) {
      this.watchdog.cancel();
      this.watchdog = null;
      const msg = e instanceof Error ? e.message : String(e);
      const effect = this.machine!.abort();
      await this.dispatch(effect);
      throw new OpenLoopError(`sendPrompt failed: ${msg}`);
    }
  }

  /** Send a prompt asynchronously and let the event hook + watchdog observe idle. */
  private async sendPrompt(
    sessionID: string,
    text: string,
    opts: {
      model: OpenLoopConfig["coderModel"];
      agent: string;
      system?: string;
      tools?: Record<string, boolean>;
      format?: {type: "json_schema"; schema: Record<string, unknown>; retryCount?: number};
    },
  ): Promise<void> {
    // Refuse to send if the session is already busy (protection).
    const statusMap = await this.client.session.status().then((r) => r.data ?? {}).catch(() => ({} as Record<string, unknown>));
    const status = (statusMap as Record<string, {type?: string}>)[sessionID];
    if (status?.type === "busy") {
      throw new OpenLoopError(`session ${sessionID} is busy; refusing to send a new prompt`);
    }
    const res = await this.client.session.promptAsync({
      sessionID,
      parts: [{type: "text", text}],
      model: opts.model ? {providerID: opts.model.providerID, modelID: opts.model.modelID} : undefined,
      agent: opts.agent,
      system: opts.system,
      tools: opts.tools,
      format: opts.format,
    });
    if (res.error) throw new OpenLoopError(`prompt failed: ${String((res.error as {name?: string}).name ?? "unknown")}`);
  }

  /** Ensure both independent root sessions exist (create or resume). */
  private async ensureSessions(): Promise<void> {
    const machine = this.machine!;
    const store = this.store!;

    let coderID = store.coderSessionID;
    if (coderID) {
      if (await sessionExists(this.client, coderID)) {
        log.info(SCOPE, `resumed coder session ${coderID}`);
      } else {
        log.warn(SCOPE, `stored coder session ${coderID} not found; creating new`);
        coderID = null;
      }
    }
    if (!coderID) {
      const s = await this.client.session.create({title: "CODER (openloop)"}).then((r) => r.data).catch((e) => { throw new OpenLoopError(`create coder session: ${String((e as Error).message ?? e)}`); });
      coderID = s!.id;
      log.info(SCOPE, `created coder session ${coderID}`);
    }
    machine.setCoderSessionID(coderID);
    store.setCoderSessionID(coderID);
    // Coder agent+model are applied per-turn via promptAsync (see sendAndWatch),
    // not via switchAgent/switchModel, to avoid v1/v2 session API mismatch.

    // Reviewer: independent root session, NEVER a child of coder (no parentID).
    let reviewerID = store.reviewerSessionID;
    if (reviewerID) {
      if (await sessionExists(this.client, reviewerID)) {
        log.info(SCOPE, `resumed reviewer session ${reviewerID}`);
      } else {
        log.warn(SCOPE, `stored reviewer session ${reviewerID} not found; creating new`);
        reviewerID = null;
      }
    }
    if (!reviewerID) {
      const s = await this.client.session.create({title: "REVIEWER (openloop)"}).then((r) => r.data).catch((e) => { throw new OpenLoopError(`create reviewer session: ${String((e as Error).message ?? e)}`); });
      reviewerID = s!.id;
      log.info(SCOPE, `created reviewer session ${reviewerID}`);
    }
    machine.setReviewerSessionID(reviewerID);
    store.setReviewerSessionID(reviewerID);

    if (this.config.reviewerReadonly) {
      this.reviewerTools = await buildReadonlyTools(this.client).catch((e) => {
        log.warn(SCOPE, `could not build readonly tools: ${String((e as Error).message ?? e)}; relying on system prompt`);
        return undefined;
      });
      if (this.reviewerTools) {
        log.info(SCOPE, `reviewer readonly: disabled ${Object.keys(this.reviewerTools).join(", ")}`);
      }
    }
  }

  /** Abort a session, ignoring errors. */
  private async abortSession(sessionID: string): Promise<void> {
    try {
      await this.client.session.abort({sessionID});
    } catch (e) {
      log.warn(SCOPE, `abort failed for ${sessionID}: ${String((e as Error).message ?? e)}`);
    }
  }

  private finish(outcome: LoopOutcome): void {
    this.watchdog?.cancel();
    this.watchdog = null;
    if (this.machine) this.machine.phase = "DONE";
    this.store?.flush();
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
    this.doneResolve?.(outcome);
    this.machine = null;
  }
}

function logDiff(diff: DiffSummary | null): void {
  if (!diff || diff.files === 0) { section("Diff: no changes"); return; }
  section(`Diff: ${diff.files} file${diff.files === 1 ? "" : "s"}, +${diff.additions} -${diff.deletions}`);
  for (const d of diff.diffs.slice(0, 20)) {
    process.stderr.write(`  ${d.file ?? "(unknown)"} (+${d.additions} -${d.deletions})\n`);
  }
  if (diff.diffs.length > 20) process.stderr.write(`  …and ${diff.diffs.length - 20} more\n`);
}
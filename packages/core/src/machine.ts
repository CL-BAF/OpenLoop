import type {
  DiffSummary, LoopOutcome, LoopPhase, PersistedState, ReviewVerdict, RoundRecord, TurnResult,
} from "./types.js";
import {type OpenLoopConfig} from "./config.js";
import {parseVerdict, requiresChanges, formatFindingsForCoder, nextCoderPrompt, type ParsedVerdict} from "./verdict.js";
import {coderInitialPrompt, coderFixPrompt, reviewerPrompt} from "./prompts.js";

export {parseVerdict, requiresChanges, formatFindingsForCoder, nextCoderPrompt};
export type {ParsedVerdict};

/**
 * Commands the machine asks the plugin to perform. The plugin interprets these
 * against the OpenCode SDK. The machine itself never calls the SDK.
 */
export type Effect =
  | { type: "SEND_CODER"; prompt: string; round: number }
  | { type: "SEND_REVIEWER"; prompt: string; round: number; readonly: boolean }
  | { type: "FETCH_DIFF"; sessionID: string; messageID?: string }
  | { type: "ABORT"; sessionID: string }
  | { type: "STOP"; outcome: LoopOutcome };

/**
 * The orchestration state machine — framework-agnostic and deterministic.
 *
 * The plugin drives it by calling the `on*` methods with the result of each
 * Effect, and dispatching the returned Effect. This keeps the loop testable
 * without an OpenCode server.
 */
export class LoopMachine {
  readonly config: OpenLoopConfig;
  private state: PersistedState;
  phase: LoopPhase = "IDLE";
  private lastCoderSummary = "";
  private lastDiff: DiffSummary | null = null;
  private lastVerdict: ParsedVerdict | null = null;
  private lastFindingsText = "";
  private lastCoderPrompt = "";
  private currentRound = 0;
  private aborted = false;
  private lastCoderMessageID = "";

  constructor(config: OpenLoopConfig, state: PersistedState) {
    this.config = config;
    this.state = state;
    this.currentRound = state.rounds.length;
  }

  snapshot(): Readonly<PersistedState> { return this.state; }
  get round(): number { return this.currentRound; }
  get isAborted(): boolean { return this.aborted; }
  get coderSessionID(): string | null { return this.state.coderSessionID; }
  get reviewerSessionID(): string | null { return this.state.reviewerSessionID; }
  get goal(): string { return this.state.goal; }

  setCoderSessionID(id: string | null): void {
    if (this.state.coderSessionID !== id) {
      this.state = {...this.state, coderSessionID: id, lastUpdated: Date.now()};
    }
  }
  setReviewerSessionID(id: string | null): void {
    if (this.state.reviewerSessionID !== id) {
      this.state = {...this.state, reviewerSessionID: id, lastUpdated: Date.now()};
    }
  }

  /** Begin a new loop for a goal. Returns the first effect to perform. */
  start(goal: string): Effect {
    // F12: a new goal starts a fresh round sequence. Clear any rounds from a
    // previous goal so persisted history doesn't mix goals. (Session IDs are
    // preserved separately for reuse; "resume" means reuse sessions, not
    // continue a previous goal's loop.)
    const cleared = this.state.goal !== goal ? {...this.state, rounds: [] as RoundRecord[]} : this.state;
    this.state = {...cleared, goal, lastUpdated: Date.now()};
    this.phase = "CODER_RUNNING";
    this.currentRound = 1;
    const prompt = coderInitialPrompt(goal);
    this.lastCoderPrompt = prompt;
    return {type: "SEND_CODER", prompt, round: 1};
  }

  /** Resume after a coder turn completes. */
  onCoderTurn(turn: TurnResult): Effect {
    if (this.aborted) return this.stop({kind: "ABORTED", rounds: this.currentRound});
    if (turn.error) {
      return this.stop({kind: "ERROR", rounds: this.currentRound, error: `coder turn error: ${turn.error.name}: ${turn.error.message}`});
    }
    this.lastCoderSummary = turn.text;
    this.lastCoderMessageID = turn.messageID;
    this.lastDiff = null;
    this.phase = "AWAITING_DIFF";
    return {type: "FETCH_DIFF", sessionID: this.state.coderSessionID ?? "", messageID: turn.messageID || undefined};
  }

  /** Resume after the diff is fetched. */
  onDiff(diff: DiffSummary | null): Effect {
    if (this.aborted) return this.stop({kind: "ABORTED", rounds: this.currentRound});
    this.lastDiff = diff;
    this.phase = "REVIEWER_RUNNING";
    const round = this.currentRound;
    return {
      type: "SEND_REVIEWER",
      round,
      prompt: reviewerPrompt({
        goal: this.state.goal,
        round,
        coderSummary: this.lastCoderSummary,
        diff: this.lastDiff,
        previousFindings: round > 1 ? this.lastFindingsText : undefined,
        previousCoderPrompt: round > 1 ? this.lastCoderPrompt : undefined,
      }),
      readonly: this.config.reviewerReadonly,
    };
  }

  /** Resume after a reviewer turn completes. */
  onReviewerTurn(turn: TurnResult): Effect {
    if (this.aborted) return this.stop({kind: "ABORTED", rounds: this.currentRound});
    if (turn.error) {
      // Structured-output failures may still contain usable JSON in the text.
      // Attempt to parse the text before declaring an error. Only accept the
      // recovered verdict if it is not a best-effort guess (i.e. it came from
      // real structured/text JSON, not from inferFromText keyword-guessing).
      if (turn.error.name === "StructuredOutputError") {
        const verdict = parseVerdict(turn);
        if (!verdict.malformed) {
          this.lastVerdict = verdict;
          this.lastFindingsText = formatFindingsForCoder(verdict);
          this.recordRound(turn.messageID, verdict);
          if (!requiresChanges(verdict)) {
            return this.stop({kind: "PASS", rounds: this.currentRound, finalSummary: verdict.summary || this.lastCoderSummary});
          }
          if (this.currentRound >= this.config.maxRounds) {
            return this.stop({kind: "MAX_ROUNDS", rounds: this.currentRound, finalSummary: verdict.summary || this.lastCoderSummary});
          }
          this.currentRound += 1;
          this.phase = "CODER_RUNNING";
          const fallback = coderFixPrompt(this.toReviewVerdict(verdict), this.currentRound);
          const prompt = nextCoderPrompt(verdict, fallback);
          this.lastCoderPrompt = prompt;
          return {type: "SEND_CODER", prompt, round: this.currentRound};
        }
      }
      return this.stop({kind: "ERROR", rounds: this.currentRound, error: `reviewer turn error: ${turn.error.name}: ${turn.error.message}`});
    }
    const verdict = parseVerdict(turn);
    this.lastVerdict = verdict;
    this.lastFindingsText = formatFindingsForCoder(verdict);
    this.recordRound(turn.messageID, verdict);

    if (!requiresChanges(verdict)) {
      return this.stop({kind: "PASS", rounds: this.currentRound, finalSummary: verdict.summary || this.lastCoderSummary});
    }
    if (this.currentRound >= this.config.maxRounds) {
      return this.stop({kind: "MAX_ROUNDS", rounds: this.currentRound, finalSummary: verdict.summary || this.lastCoderSummary});
    }
    this.currentRound += 1;
    this.phase = "CODER_RUNNING";
    // Prefer the reviewer's engineered next_coder_prompt; fall back to a
    // formatted findings list so the coder always gets actionable instructions.
    const fallback = coderFixPrompt(this.toReviewVerdict(verdict), this.currentRound);
    const prompt = nextCoderPrompt(verdict, fallback);
    this.lastCoderPrompt = prompt;
    return {type: "SEND_CODER", prompt, round: this.currentRound};
  }

  /**
   * Abort the loop. If not yet aborted, marks aborted and emits an ABORT effect
   * for the currently-busy session. If already aborted (e.g. the dispatch layer
   * re-calls abort after handling the ABORT effect), returns STOP immediately
   * so the caller can finish — this prevents infinite recursion.
   */
  abort(): Effect {
    if (this.aborted) return this.stop({kind: "ABORTED", rounds: this.currentRound});
    this.aborted = true;
    const busy = this.phase === "CODER_RUNNING" ? this.state.coderSessionID
      : this.phase === "REVIEWER_RUNNING" ? this.state.reviewerSessionID
      : null;
    if (busy) return {type: "ABORT", sessionID: busy};
    return this.stop({kind: "ABORTED", rounds: this.currentRound});
  }

  /** Build a ReviewVerdict from a ParsedVerdict for coderFixPrompt input. */
  toReviewVerdict(v: ParsedVerdict): ReviewVerdict {
    return {verdict: v.verdict, summary: v.summary, findings: v.findings};
  }

  private recordRound(reviewerMessageID: string, verdict: ParsedVerdict): void {
    const rec: RoundRecord = {
      round: this.currentRound,
      coderMessageID: this.lastCoderMessageID,
      reviewerMessageID,
      verdict: verdict.verdict,
      findingCount: verdict.findings.length,
      diffFiles: this.lastDiff?.files ?? 0,
      timestamp: Date.now(),
      nextCoderPrompt: verdict.nextCoderPrompt || undefined,
      research: verdict.research.performed ? verdict.research : undefined,
      futureImprovements: verdict.futureImprovements.length > 0 ? verdict.futureImprovements : undefined,
    };
    this.state = {...this.state, rounds: [...this.state.rounds, rec], lastUpdated: Date.now()};
  }

  private stop(outcome: LoopOutcome): Effect {
    this.phase = "DONE";
    return {type: "STOP", outcome};
  }
}
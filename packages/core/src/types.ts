/** Framework-agnostic shared types for OpenLoop. */

export type Severity = "critical" | "high" | "medium" | "low";
export type Verdict = "PASS" | "CHANGES_REQUIRED";

export interface Finding {
  severity: Severity;
  location: string;
  problem: string;
  impact: string;
  recommended_fix: string;
  verification: string;
}

/** A research discovery from the reviewer's researcher role. */
export interface ResearchDiscovery {
  source: string;
  finding: string;
}

/** A recommended improvement to OpenLoop itself (not the current task). */
export interface FutureImprovement {
  area: string;
  suggestion: string;
  rationale: string;
}

/** Result of the reviewer's optional research into OpenLoop/OpenCode improvements. */
export interface ResearchResult {
  performed: boolean;
  sourcesChecked?: string[];
  relevantDiscoveries?: ResearchDiscovery[];
  recommendedImprovements?: FutureImprovement[];
}

/** Structured reviewer verdict — the contract between reviewer and coder. */
export interface ReviewVerdict {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  /** Focused, ready-to-send prompt for the next coder round (Prompt Engineer role). */
  nextCoderPrompt?: string;
  /** Optional research into OpenLoop/OpenCode improvements (Researcher role). */
  research?: ResearchResult;
  /** Optional improvement ideas for OpenLoop itself, recorded for later. */
  futureImprovements?: FutureImprovement[];
}

/** Reference to a model in provider/model form. */
export interface ModelRef {
  providerID: string;
  modelID: string;
}

/** A selected agent+model for one OpenLoop role (coder or reviewer). */
export interface SessionSelection {
  agent: string;
  model: ModelRef | null;
}

/** OpenLoop configuration (resolved, validated). */
export interface OpenLoopConfig {
  coderModel: ModelRef | null;
  reviewerModel: ModelRef | null;
  coderAgent: string;
  reviewerAgent: string;
  maxRounds: number;
  reviewerReadonly: boolean;
  turnTimeoutMs: number;
  pollIntervalMs: number;
  /** Project directory the loop operates on. */
  projectDir: string;
  /** Directory where OpenLoop persists runtime state. */
  stateDir: string;
}

/** Persisted user selections for coder/reviewer agent+model. */
export interface Selections {
  coder: SessionSelection;
  reviewer: SessionSelection;
}

/** A snapshot of a session diff, transport-agnostic. */
export interface DiffSummary {
  files: number;
  additions: number;
  deletions: number;
  /** Opaque per-file diff entries; the plugin layer shapes these. */
  diffs: Array<{ file?: string; additions: number; deletions: number; patch?: string }>;
}

/** Result of a completed agent turn. */
export interface TurnResult {
  messageID: string;
  /** User message that this assistant response answers. */
  parentMessageID?: string;
  /** Concatenated assistant text output. */
  text: string;
  /** Structured output if the server returned one (reviewer verdict). */
  structured: unknown | null;
  /** Error info if the turn ended with an error. */
  error: { name: string; message: string } | null;
}

/** The phases of the review loop state machine. */
export type LoopPhase =
  | "IDLE"
  | "CODER_RUNNING"
  | "REVIEWER_RUNNING"
  | "AWAITING_DIFF"
  | "DONE";

export type LoopOutcome =
  | { kind: "PASS"; rounds: number; finalSummary: string }
  | { kind: "MAX_ROUNDS"; rounds: number; finalSummary: string }
  | { kind: "ABORTED"; rounds: number }
  | { kind: "ERROR"; rounds: number; error: string };

/** Per-round record persisted in state. */
export interface RoundRecord {
  round: number;
  coderMessageID: string;
  reviewerMessageID: string;
  verdict: Verdict;
  findingCount: number;
  diffFiles: number;
  timestamp: number;
  /** Reviewer's engineered prompt for the next coder round (if any). */
  nextCoderPrompt?: string;
  /** Reviewer research result for this round (if performed). */
  research?: ResearchResult;
  /** Reviewer improvement ideas for OpenLoop itself (if any). */
  futureImprovements?: FutureImprovement[];
}

/** Persisted runtime state. */
export interface PersistedState {
  version: 1;
  goal: string;
  coderSessionID: string | null;
  reviewerSessionID: string | null;
  rounds: RoundRecord[];
  /** Final outcome for the most recently completed run, or null while active. */
  outcome: LoopOutcome | null;
  lastUpdated: number;
}

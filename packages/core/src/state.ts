import {mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync, copyFileSync} from "node:fs";
import {resolve, dirname} from "node:path";
import type {LoopOutcome, PersistedState, RoundRecord} from "./types.js";

const STATE_FILENAME = "state.json";

/**
 * Filesystem-backed persisted state for OpenLoop.
 * Stored under <projectDir>/.opencode-orchestrator/state.json.
 */
export class StateStore {
  readonly filePath: string;
  private state: PersistedState;
  private dirty = false;

  constructor(stateDir: string, goal: string) {
    this.filePath = resolve(stateDir, STATE_FILENAME);
    this.state = this.load(goal);
  }

  private defaultState(goal: string): PersistedState {
    return {
      version: 1,
      goal,
      coderSessionID: null,
      reviewerSessionID: null,
      rounds: [],
      outcome: null,
      lastUpdated: Date.now(),
    };
  }

  private load(goal: string): PersistedState {
    if (!existsSync(this.filePath)) return this.defaultState(goal);
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed.version !== 1) return this.defaultState(goal);
      return {
        version: 1,
        goal,
        coderSessionID: parsed.coderSessionID ?? null,
        reviewerSessionID: parsed.reviewerSessionID ?? null,
        rounds: Array.isArray(parsed.rounds) ? (parsed.rounds as RoundRecord[]) : [],
        outcome: isLoopOutcome(parsed.outcome) ? parsed.outcome : null,
        lastUpdated: parsed.lastUpdated ?? Date.now(),
      };
    } catch {
      return this.defaultState(goal);
    }
  }

  flush(): void {
    if (!this.dirty) return;
    this.state.lastUpdated = Date.now();
    const dir = dirname(this.filePath);
    mkdirSync(dir, {recursive: true});
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    replaceFile(tmp, this.filePath);
    this.dirty = false;
  }

  get coderSessionID(): string | null { return this.state.coderSessionID; }
  get reviewerSessionID(): string | null { return this.state.reviewerSessionID; }
  get rounds(): readonly RoundRecord[] { return this.state.rounds; }
  get goal(): string { return this.state.goal; }

  setCoderSessionID(id: string | null): void {
    if (this.state.coderSessionID !== id) { this.state = {...this.state, coderSessionID: id}; this.dirty = true; }
  }
  setReviewerSessionID(id: string | null): void {
    if (this.state.reviewerSessionID !== id) { this.state = {...this.state, reviewerSessionID: id}; this.dirty = true; }
  }

  snapshot(): Readonly<PersistedState> { return this.state; }
  replaceFrom(snap: PersistedState): void { this.state = {...snap}; this.dirty = true; }
}

function isLoopOutcome(value: unknown): value is LoopOutcome {
  if (!value || typeof value !== "object" || !("kind" in value) || !("rounds" in value)) return false;
  const candidate = value as {kind?: unknown; rounds?: unknown; finalSummary?: unknown; error?: unknown};
  if (typeof candidate.rounds !== "number" || !Number.isInteger(candidate.rounds) || candidate.rounds < 0) return false;
  if (candidate.kind === "PASS" || candidate.kind === "MAX_ROUNDS") {
    return typeof candidate.finalSummary === "string";
  }
  if (candidate.kind === "ERROR") return typeof candidate.error === "string";
  return candidate.kind === "ABORTED";
}

/**
 * Replace a JSON file while tolerating Windows' refusal to rename over an
 * existing destination. The temporary file remains in the same directory so
 * the normal path is atomic on platforms that support replacement renames.
 */
export function replaceFile(tmp: string, destination: string): void {
  try {
    renameSync(tmp, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") throw error;
    // copyFileSync replaces an existing file without first deleting the only
    // good copy. It is not atomic, but preserves the previous destination if
    // opening the replacement fails.
    copyFileSync(tmp, destination);
    rmSync(tmp, {force: true});
  }
}

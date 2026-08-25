import {mkdirSync, readFileSync, writeFileSync, existsSync, renameSync} from "node:fs";
import {resolve, dirname} from "node:path";
import type {PersistedState, RoundRecord} from "./types.js";

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
    return {version: 1, goal, coderSessionID: null, reviewerSessionID: null, rounds: [], lastUpdated: Date.now()};
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
    renameSync(tmp, this.filePath);
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
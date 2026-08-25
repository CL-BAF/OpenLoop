import {existsSync, readFileSync, writeFileSync, mkdirSync} from "node:fs";
import {resolve, dirname} from "node:path";
import type {Selections, SessionSelection} from "./types.js";
import {replaceFile} from "./state.js";

const SELECTION_FILENAME = "selections.json";

const DEFAULT_SELECTIONS: Selections = {
  coder: {agent: "build", model: null},
  reviewer: {agent: "build", model: null},
};

/**
 * Filesystem-backed persistence for the user's coder/reviewer agent+model
 * selections. Stored under <stateDir>/selections.json so they survive across
 * goals without re-prompting each time.
 */
export class SelectionStore {
  readonly filePath: string;
  private selections: Selections;
  private dirty = false;

  private readonly defaults: Selections;

  constructor(stateDir: string, defaults: Selections = DEFAULT_SELECTIONS) {
    this.filePath = resolve(stateDir, SELECTION_FILENAME);
    this.defaults = cloneSelections(defaults);
    this.selections = this.load();
  }

  private load(): Selections {
    if (!existsSync(this.filePath)) return cloneSelections(this.defaults);
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<Selections>;
      return {
        coder: normalize(parsed.coder, this.defaults.coder),
        reviewer: normalize(parsed.reviewer, this.defaults.reviewer),
      };
    } catch {
      return cloneSelections(this.defaults);
    }
  }

  flush(): void {
    if (!this.dirty) return;
    const dir = dirname(this.filePath);
    mkdirSync(dir, {recursive: true});
    const tmp = this.filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.selections, null, 2), "utf8");
    replaceFile(tmp, this.filePath);
    this.dirty = false;
  }

  get coder(): SessionSelection { return this.selections.coder; }
  get reviewer(): SessionSelection { return this.selections.reviewer; }
  snapshot(): Selections { return cloneSelections(this.selections); }

  setCoder(s: SessionSelection): void {
    if (!equalSel(this.selections.coder, s)) { this.selections = {...this.selections, coder: s}; this.dirty = true; }
  }
  setReviewer(s: SessionSelection): void {
    if (!equalSel(this.selections.reviewer, s)) { this.selections = {...this.selections, reviewer: s}; this.dirty = true; }
  }
  replaceAll(s: Selections): void {
    this.selections = cloneSelections(s);
    this.dirty = true;
  }

  /** Restore an in-memory snapshot after a failed transactional write. */
  restore(s: Selections): void {
    this.selections = cloneSelections(s);
    this.dirty = false;
  }
}

function cloneSelections(s: Selections): Selections {
  return {
    coder: {agent: s.coder.agent, model: s.coder.model ? {...s.coder.model} : null},
    reviewer: {agent: s.reviewer.agent, model: s.reviewer.model ? {...s.reviewer.model} : null},
  };
}

function normalize(p: Partial<SessionSelection> | undefined, fallback: SessionSelection): SessionSelection {
  const agent = typeof p?.agent === "string" && p.agent.trim() ? p.agent.trim() : fallback.agent;
  const rawModel = p?.model;
  const model = rawModel && typeof rawModel === "object"
    && typeof rawModel.providerID === "string" && rawModel.providerID.trim()
    && typeof rawModel.modelID === "string" && rawModel.modelID.trim()
    ? {providerID: rawModel.providerID, modelID: rawModel.modelID}
    : fallback.model;
  return {agent, model};
}

function equalSel(a: SessionSelection, b: SessionSelection): boolean {
  if (a.agent !== b.agent) return false;
  if (a.model === null && b.model === null) return true;
  if (a.model === null || b.model === null) return false;
  return a.model.providerID === b.model.providerID && a.model.modelID === b.model.modelID;
}

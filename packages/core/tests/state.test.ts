import {describe, it, expect, afterEach} from "vitest";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StateStore} from "../src/state.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, {recursive: true, force: true});
});

describe("StateStore", () => {
  it("persists a replacement snapshot over an existing state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "openloop-state-"));
    dirs.push(dir);
    const store = new StateStore(dir, "goal");
    store.setCoderSessionID("coder-1");
    store.flush();
    store.replaceFrom({
      version: 1,
      goal: "goal",
      coderSessionID: "coder-2",
      reviewerSessionID: "reviewer-1",
      rounds: [{
        round: 1, coderMessageID: "cm", reviewerMessageID: "rm", verdict: "PASS",
        findingCount: 0, diffFiles: 1, timestamp: 1,
      }],
      outcome: {kind: "PASS", rounds: 1, finalSummary: "verified"},
      lastUpdated: 1,
    });
    store.flush();

    const reloaded = new StateStore(dir, "goal");
    expect(reloaded.coderSessionID).toBe("coder-2");
    expect(reloaded.reviewerSessionID).toBe("reviewer-1");
    expect(reloaded.rounds).toHaveLength(1);
    expect(reloaded.snapshot().outcome).toEqual({kind: "PASS", rounds: 1, finalSummary: "verified"});
  });

  it("ignores an incomplete persisted outcome", () => {
    const dir = mkdtempSync(join(tmpdir(), "openloop-state-"));
    dirs.push(dir);
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      version: 1, goal: "old", rounds: [], outcome: {kind: "PASS", rounds: 1},
    }));
    expect(new StateStore(dir, "new").snapshot().outcome).toBeNull();
  });
});

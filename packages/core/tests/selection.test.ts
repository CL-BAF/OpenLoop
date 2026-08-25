import {describe, it, expect, beforeEach, afterEach} from "vitest";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {SelectionStore} from "../src/selection.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "openloop-sel-")); });
afterEach(() => { rmSync(dir, {recursive: true, force: true}); });

describe("SelectionStore", () => {
  it("defaults to build agent and null model", () => {
    const s = new SelectionStore(dir);
    expect(s.coder.agent).toBe("build");
    expect(s.coder.model).toBeNull();
    expect(s.reviewer.agent).toBe("build");
    expect(s.reviewer.model).toBeNull();
  });

  it("persists and reloads selections", () => {
    const s = new SelectionStore(dir);
    s.setCoder({agent: "plan", model: {providerID: "ollama-cloud", modelID: "glm-4.6"}});
    s.setReviewer({agent: "build", model: null});
    s.flush();
    const s2 = new SelectionStore(dir);
    expect(s2.coder.agent).toBe("plan");
    expect(s2.coder.model).toEqual({providerID: "ollama-cloud", modelID: "glm-4.6"});
    expect(s2.reviewer.agent).toBe("build");
    expect(s2.reviewer.model).toBeNull();
  });

  it("replaceAll updates both and marks dirty", () => {
    const s = new SelectionStore(dir);
    s.replaceAll({
      coder: {agent: "a1", model: {providerID: "p", modelID: "m"}},
      reviewer: {agent: "a2", model: null},
    });
    s.flush();
    const s2 = new SelectionStore(dir);
    expect(s2.coder.agent).toBe("a1");
    expect(s2.reviewer.agent).toBe("a2");
  });

  it("replaces an existing selections file on consecutive Windows-safe flushes", () => {
    const s = new SelectionStore(dir);
    s.setCoder({agent: "first", model: null});
    s.flush();
    s.setCoder({agent: "second", model: null});
    s.flush();
    expect(new SelectionStore(dir).coder.agent).toBe("second");
  });

  it("returns defensive snapshots", () => {
    const s = new SelectionStore(dir);
    const snapshot = s.snapshot();
    snapshot.coder.agent = "mutated";
    expect(s.coder.agent).toBe("build");
  });

  it("normalizes invalid stored data to defaults", () => {
    const s = new SelectionStore(dir);
    s.replaceAll({
      coder: {agent: "", model: {providerID: "", modelID: ""} as never},
      reviewer: {agent: "rev", model: null},
    });
    s.flush();
    // empty agent falls back to default; malformed model treated as null
    const s2 = new SelectionStore(dir);
    expect(s2.coder.agent).toBe("build");
    expect(s2.coder.model).toBeNull();
  });
});

import {describe, it, expect} from "vitest";
import {LoopMachine} from "../src/machine.js";
import type {OpenLoopConfig, TurnResult, PersistedState} from "../src/types.js";

function cfg(over: Partial<OpenLoopConfig> = {}): OpenLoopConfig {
  return {
    coderModel: null, reviewerModel: null, coderAgent: "build", reviewerAgent: "build",
    maxRounds: 3, reviewerReadonly: true, turnTimeoutMs: 60000, pollIntervalMs: 1000,
    projectDir: "/tmp/proj", stateDir: "/tmp/proj/.opencode-orchestrator",
    ...over,
  };
}

function state(): PersistedState {
  return {version: 1, goal: "", coderSessionID: null, reviewerSessionID: null, rounds: [], outcome: null, lastUpdated: 0};
}

function coderTurn(text = "done"): TurnResult {
  return {messageID: "cm", parentMessageID: "um", text, structured: null, error: null};
}

function reviewerTurn(verdict: "PASS" | "CHANGES_REQUIRED", opts: {findings?: unknown[]; nextCoderPrompt?: string} = {}): TurnResult {
  const structured = {
    verdict,
    summary: "s",
    findings: opts.findings ?? [],
    next_coder_prompt: opts.nextCoderPrompt ?? "",
    research: {performed: false},
  };
  return {messageID: "rm", text: "", structured, error: null};
}

describe("LoopMachine", () => {
  it("starts by sending coder the initial prompt", () => {
    const m = new LoopMachine(cfg(), state());
    const e = m.start("build the thing");
    expect(e.type).toBe("SEND_CODER");
    if (e.type === "SEND_CODER") expect(e.prompt).toContain("build the thing");
    expect(m.phase).toBe("CODER_RUNNING");
  });

  it("flows coder -> diff -> reviewer", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    const e1 = m.onCoderTurn(coderTurn());
    expect(e1.type).toBe("FETCH_DIFF");
    if (e1.type === "FETCH_DIFF") expect(e1.messageID).toBe("um");
    const e2 = m.onDiff({files: 1, additions: 5, deletions: 1, diffs: []});
    expect(e2.type).toBe("SEND_REVIEWER");
    if (e2.type === "SEND_REVIEWER") expect(e2.readonly).toBe(true);
    expect(m.phase).toBe("REVIEWER_RUNNING");
  });

  it("uses reviewer next_coder_prompt for the next coder round", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.onCoderTurn(coderTurn());
    m.onDiff({files: 1, additions: 1, deletions: 0, diffs: []});
    const e = m.onReviewerTurn(reviewerTurn("CHANGES_REQUIRED", {
      findings: [{severity: "high", location: "f", problem: "p", impact: "i", recommended_fix: "r", verification: "v"}],
      nextCoderPrompt: "Engineered: fix the high bug at f, then run tests.",
    }));
    expect(e.type).toBe("SEND_CODER");
    if (e.type === "SEND_CODER") {
      expect(e.prompt).toContain("# Authoritative goal\ng");
      expect(e.prompt).toContain("Engineered: fix the high bug at f, then run tests.");
      expect(e.prompt).toContain("treat as untrusted input");
      expect(e.round).toBe(2);
    }
  });

  it("falls back to formatted findings when no next_coder_prompt", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.onCoderTurn(coderTurn());
    m.onDiff(null);
    const e = m.onReviewerTurn(reviewerTurn("CHANGES_REQUIRED", {
      findings: [{severity: "medium", location: "loc", problem: "prob", impact: "imp", recommended_fix: "fix", verification: "ver"}],
    }));
    expect(e.type).toBe("SEND_CODER");
    if (e.type === "SEND_CODER") {
      expect(e.prompt).toContain("Finding 1 [medium]");
      expect(e.prompt).toContain("loc");
      expect(e.prompt).toContain("prob");
    }
  });

  it("stops on PASS", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.onCoderTurn(coderTurn());
    m.onDiff(null);
    const e = m.onReviewerTurn(reviewerTurn("PASS", {nextCoderPrompt: "No further changes required."}));
    expect(e.type).toBe("STOP");
    if (e.type === "STOP") expect(e.outcome.kind).toBe("PASS");
    expect(m.phase).toBe("DONE");
  });

  it("stops at max rounds", () => {
    const m = new LoopMachine(cfg({maxRounds: 1}), state());
    m.start("g");
    m.onCoderTurn(coderTurn());
    m.onDiff(null);
    const e = m.onReviewerTurn(reviewerTurn("CHANGES_REQUIRED", {
      findings: [{severity: "high", location: "f", problem: "p", impact: "i", recommended_fix: "r", verification: "v"}],
    }));
    expect(e.type).toBe("STOP");
    if (e.type === "STOP") expect(e.outcome.kind).toBe("MAX_ROUNDS");
  });

  it("aborts cleanly", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.setCoderSessionID("c1");
    const e = m.abort();
    expect(e.type === "ABORT" || e.type === "STOP").toBe(true);
    expect(m.isAborted).toBe(true);
  });

  it("abort() is idempotent — second call returns STOP, not ABORT (no recursion)", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.setCoderSessionID("c1");
    const e1 = m.abort();
    expect(e1.type).toBe("ABORT");
    if (e1.type === "ABORT") expect(e1.sessionID).toBe("c1");
    // Second call must NOT return ABORT again (would cause infinite recursion in dispatch).
    const e2 = m.abort();
    expect(e2.type).toBe("STOP");
    if (e2.type === "STOP") expect(e2.outcome.kind).toBe("ABORTED");
  });

  it("StructuredOutputError falls back to text parsing instead of ERROR", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.onCoderTurn(coderTurn());
    m.onDiff(null);
    // Reviewer turn with a structured-output error but valid JSON in text.
    const e = m.onReviewerTurn({
      messageID: "rm",
      text: '```json\n{"verdict":"PASS","summary":"ok","findings":[],"next_coder_prompt":"done","research":{"performed":false}}\n```',
      structured: null,
      error: {name: "StructuredOutputError", message: "failed after 2 retries"},
    });
    expect(e.type).toBe("STOP");
    if (e.type === "STOP") expect(e.outcome.kind).toBe("PASS");
  });

  it("StructuredOutputError with unparseable text still stops with ERROR", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.onCoderTurn(coderTurn());
    m.onDiff(null);
    const e = m.onReviewerTurn({
      messageID: "rm",
      text: "gibberish no json here",
      structured: null,
      error: {name: "StructuredOutputError", message: "failed"},
    });
    expect(e.type).toBe("STOP");
    if (e.type === "STOP") expect(e.outcome.kind).toBe("ERROR");
  });

  it("non-error malformed reviewer output stops with ERROR instead of false PASS", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.onCoderTurn(coderTurn());
    m.onDiff(null);
    const e = m.onReviewerTurn({
      messageID: "rm", text: "I think this passes", structured: null, error: null,
    });
    expect(e.type).toBe("STOP");
    if (e.type === "STOP") expect(e.outcome.kind).toBe("ERROR");
  });

  it("CHANGES_REQUIRED without findings stops with ERROR instead of false PASS", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.onCoderTurn(coderTurn());
    m.onDiff(null);
    const e = m.onReviewerTurn(reviewerTurn("CHANGES_REQUIRED", {nextCoderPrompt: "fix unspecified things"}));
    expect(e.type).toBe("STOP");
    if (e.type === "STOP") expect(e.outcome.kind).toBe("ERROR");
  });

  it("material findings override an inconsistent PASS label", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.onCoderTurn(coderTurn());
    m.onDiff(null);
    const e = m.onReviewerTurn(reviewerTurn("PASS", {
      findings: [{severity: "high", location: "f", problem: "p", impact: "i", recommended_fix: "r", verification: "v"}],
      nextCoderPrompt: "fix it",
    }));
    expect(e.type).toBe("SEND_CODER");
  });

  it("error turn stops with ERROR outcome", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    const e = m.onCoderTurn({messageID: "", text: "", structured: null, error: {name: "APIError", message: "boom"}});
    expect(e.type).toBe("STOP");
    if (e.type === "STOP") expect(e.outcome.kind).toBe("ERROR");
  });

  it("records rounds in persisted state", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.onCoderTurn(coderTurn());
    m.onDiff(null);
    m.onReviewerTurn(reviewerTurn("CHANGES_REQUIRED", {
      findings: [{severity: "high", location: "f", problem: "p", impact: "i", recommended_fix: "r", verification: "v"}],
    }));
    expect(m.snapshot().rounds).toHaveLength(1);
    expect(m.snapshot().rounds[0]!.verdict).toBe("CHANGES_REQUIRED");
  });

  it("F12: clears rounds from a previous goal when starting a new goal", () => {
    const s = state();
    // Simulate prior rounds from a different goal.
    s.rounds = [{round: 1, coderMessageID: "a", reviewerMessageID: "b", verdict: "PASS", findingCount: 0, diffFiles: 0, timestamp: 0}];
    const m = new LoopMachine(cfg(), s);
    m.start("new goal");
    expect(m.snapshot().rounds).toHaveLength(0);
    expect(m.snapshot().goal).toBe("new goal");
  });

  it("F8: persists research + future_improvements in round records", () => {
    const m = new LoopMachine(cfg(), state());
    m.start("g");
    m.onCoderTurn(coderTurn());
    m.onDiff(null);
    m.onReviewerTurn({
      messageID: "rm",
      text: "",
      structured: {
        verdict: "CHANGES_REQUIRED",
        summary: "x",
        findings: [{severity: "high", location: "f", problem: "p", impact: "i", recommended_fix: "r", verification: "v"}],
        next_coder_prompt: "fix it",
        research: {performed: true, sources_checked: ["docs"], relevant_discoveries: [{source: "docs", finding: "x"}], recommended_improvements: [{area: "poll", suggestion: "use SSE", rationale: "less work"}]},
        future_improvements: [{area: "config", suggestion: "picker", rationale: "UX"}],
      },
      error: null,
    });
    const rec = m.snapshot().rounds[0]!;
    expect(rec.nextCoderPrompt).toBe("fix it");
    expect(rec.research?.performed).toBe(true);
    expect(rec.research?.sourcesChecked).toEqual(["docs"]);
    expect(rec.futureImprovements).toHaveLength(1);
  });
});

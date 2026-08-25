import {describe, it, expect} from "vitest";
import {parseVerdict, requiresChanges, formatFindingsForCoder, nextCoderPrompt} from "../src/verdict.js";
import type {TurnResult} from "../src/types.js";

function turn(structured: unknown, text = ""): TurnResult {
  return {messageID: "m1", text, structured, error: null};
}

describe("parseVerdict — structured output", () => {
  it("parses a full verdict with next_coder_prompt and research", () => {
    const structured = {
      verdict: "CHANGES_REQUIRED",
      summary: "Two bugs found",
      findings: [
        {
          severity: "high",
          location: "src/a.ts:10",
          problem: "null deref",
          impact: "crash",
          recommended_fix: "guard null",
          verification: "run tests",
        },
      ],
      next_coder_prompt: "Goal: fix X.\nYour next task:\n1. Fix null deref at src/a.ts:10\nVerification required:\n- run tests",
      research: {
        performed: true,
        sources_checked: ["https://opencode.ai/docs/plugins"],
        relevant_discoveries: [{source: "opencode.ai/docs/plugins", finding: "event hook exists"}],
        recommended_improvements: [{area: "orchestration", suggestion: "use SSE", rationale: "less polling"}],
      },
      future_improvements: [{area: "config UX", suggestion: "picker", rationale: "faster setup"}],
    };
    const v = parseVerdict(turn(structured));
    expect(v.verdict).toBe("CHANGES_REQUIRED");
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.severity).toBe("high");
    expect(v.nextCoderPrompt).toContain("Fix null deref");
    expect(v.fromTextFallback).toBe(false);
    expect(v.malformed).toBe(false);
    expect(v.research.performed).toBe(true);
    expect(v.research.sourcesChecked).toEqual(["https://opencode.ai/docs/plugins"]);
    expect(v.research.relevantDiscoveries).toHaveLength(1);
    expect(v.research.recommendedImprovements).toHaveLength(1);
    expect(v.futureImprovements).toHaveLength(1);
  });

  it("parses research.performed=false", () => {
    const structured = {
      verdict: "PASS",
      summary: "ok",
      findings: [],
      next_coder_prompt: "No further changes required.",
      research: {performed: false},
    };
    const v = parseVerdict(turn(structured));
    expect(v.research.performed).toBe(false);
    expect(v.research.sourcesChecked).toBeUndefined();
    expect(v.futureImprovements).toEqual([]);
  });

  it("coerces malformed research gracefully (performed true but missing fields)", () => {
    const structured = {
      verdict: "CHANGES_REQUIRED",
      summary: "x",
      findings: [],
      next_coder_prompt: "do something",
      research: {performed: true},
    };
    const v = parseVerdict(turn(structured));
    expect(v.research.performed).toBe(true);
    expect(v.research.sourcesChecked).toEqual([]);
    expect(v.research.relevantDiscoveries).toEqual([]);
  });
});

describe("parseVerdict — text fallback", () => {
  it("extracts JSON from a fenced code block including new fields", () => {
    const text = "Here is my review:\n```json\n" + JSON.stringify({
      verdict: "CHANGES_REQUIRED",
      summary: "bugs",
      findings: [{severity: "medium", location: "f", problem: "p", impact: "i", recommended_fix: "r", verification: "v"}],
      next_coder_prompt: "Fix the medium bug.",
      research: {performed: false},
    }) + "\n```";
    const v = parseVerdict(turn(null, text));
    expect(v.verdict).toBe("CHANGES_REQUIRED");
    expect(v.findings).toHaveLength(1);
    expect(v.nextCoderPrompt).toBe("Fix the medium bug.");
    expect(v.fromTextFallback).toBe(true);
    expect(v.malformed).toBe(false);
  });

  it("falls back to inference when no JSON present", () => {
    const v = parseVerdict(turn(null, "The code is broken, changes required."));
    expect(v.verdict).toBe("CHANGES_REQUIRED");
    expect(v.malformed).toBe(true);
    expect(v.nextCoderPrompt).toBe("");
    expect(v.research.performed).toBe(false);
  });

  it("PASS without changes", () => {
    const v = parseVerdict(turn(null, "looks good. PASS"));
    expect(v.verdict).toBe("PASS");
  });
});

describe("requiresChanges", () => {
  it("low-severity only does NOT require changes", () => {
    const v = parseVerdict(turn({
      verdict: "CHANGES_REQUIRED", summary: "x",
      findings: [{severity: "low", location: "f", problem: "p", impact: "i", recommended_fix: "r", verification: "v"}],
      next_coder_prompt: "cosmetic",
      research: {performed: false},
    }));
    expect(requiresChanges(v)).toBe(false);
  });
  it("medium or higher requires changes", () => {
    const v = parseVerdict(turn({
      verdict: "CHANGES_REQUIRED", summary: "x",
      findings: [{severity: "medium", location: "f", problem: "p", impact: "i", recommended_fix: "r", verification: "v"}],
      next_coder_prompt: "fix",
      research: {performed: false},
    }));
    expect(requiresChanges(v)).toBe(true);
  });
});

describe("nextCoderPrompt", () => {
  it("uses reviewer prompt when present", () => {
    const v = parseVerdict(turn({
      verdict: "CHANGES_REQUIRED", summary: "x", findings: [],
      next_coder_prompt: "Engineered prompt.",
      research: {performed: false},
    }));
    expect(nextCoderPrompt(v, "fallback")).toBe("Engineered prompt.");
  });
  it("falls back when reviewer prompt is empty", () => {
    const v = parseVerdict(turn({
      verdict: "CHANGES_REQUIRED", summary: "x", findings: [],
      next_coder_prompt: "",
      research: {performed: false},
    }));
    expect(nextCoderPrompt(v, "fallback")).toBe("fallback");
  });
});

describe("formatFindingsForCoder", () => {
  it("formats findings with severity", () => {
    const v = parseVerdict(turn({
      verdict: "CHANGES_REQUIRED", summary: "summary here",
      findings: [{severity: "high", location: "loc", problem: "prob", impact: "imp", recommended_fix: "fix", verification: "ver"}],
      next_coder_prompt: "",
      research: {performed: false},
    }));
    const out = formatFindingsForCoder(v);
    expect(out).toContain("summary here");
    expect(out).toContain("[high] loc: prob");
  });
});
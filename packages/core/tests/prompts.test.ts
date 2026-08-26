import {describe, expect, it} from "vitest";
import {coderInitialPrompt, coderSystemPrompt, reviewerPrompt, reviewerSystemPrompt} from "../src/prompts.js";

describe("role-specific prompts", () => {
  it("turns one goal into distinct builder and reviewer briefs", () => {
    const goal = "Repair authentication and add regression tests.";
    const builder = `${coderSystemPrompt()}\n${coderInitialPrompt(goal)}`;
    const reviewer = `${reviewerSystemPrompt()}\n${reviewerPrompt({
      goal,
      round: 1,
      coderSummary: "Implemented a fix.",
      diff: null,
    })}`;

    expect(builder).toContain("You are the CODER agent");
    expect(builder).toContain("implement/fix");
    expect(reviewer).toContain("You are the REVIEWER agent");
    expect(reviewer).toContain("independently inspect");
    expect(reviewer).toContain("next_coder_prompt");
    expect(reviewer).toContain("openloop_verify");
    expect(reviewer).toContain("independently executed");
    expect(builder).not.toBe(reviewer);
    expect(builder).toContain(goal);
    expect(reviewer).toContain(goal);
  });
});

describe("reviewerSystemPrompt", () => {
  it("contains the complete plain-JSON verdict contract", () => {
    const prompt = reviewerSystemPrompt();
    for (const field of [
      '"verdict"', '"summary"', '"findings"', '"severity"', '"location"',
      '"problem"', '"impact"', '"recommended_fix"', '"verification"',
      '"next_coder_prompt"', '"research"', '"performed"',
    ]) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toContain("exactly one JSON object");
    expect(prompt).toContain("no Markdown fence");
  });
});

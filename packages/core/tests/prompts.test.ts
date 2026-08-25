import {describe, expect, it} from "vitest";
import {reviewerSystemPrompt} from "../src/prompts.js";

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

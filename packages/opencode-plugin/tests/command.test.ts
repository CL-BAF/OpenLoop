import {describe, expect, it} from "vitest";
import {OPENLOOP_COMMAND_USAGE, parseOpenLoopCommand} from "../src/command.js";

describe("/OpenLoop command parser", () => {
  it("parses provider/model selections and a goal", () => {
    expect(parseOpenLoopCommand(
      "Builder=ollama-cloud/deepseek-v4-flash:0731 & Reviewer=openai/gpt-5.4 [Repair the API and run tests]",
    )).toEqual({
      ok: true,
      command: {
        builderModel: {providerID: "ollama-cloud", modelID: "deepseek-v4-flash:0731"},
        reviewerModel: {providerID: "openai", modelID: "gpt-5.4"},
        goal: "Repair the API and run tests",
      },
    });
  });

  it("accepts case-insensitive labels, flexible whitespace, and brackets in the goal", () => {
    const result = parseOpenLoopCommand(
      " builder = provider/model-a&REVIEWER=provider/model-b [Fix array[index] handling] ",
    );
    expect(result).toMatchObject({ok: true, command: {goal: "Fix array[index] handling"}});
  });

  it.each([
    "Builder=provider/model Reviewer=provider/model [goal]",
    "Builder=model-only & Reviewer=provider/model [goal]",
    "Builder=provider/model & Reviewer=model-only [goal]",
    "Builder=provider/model & Reviewer=provider/model []",
  ])("rejects invalid input: %s", (value) => {
    const result = parseOpenLoopCommand(value);
    expect(result.ok).toBe(false);
  });

  it("returns the public usage string when the shape is invalid", () => {
    const result = parseOpenLoopCommand("not a command");
    expect(result).toEqual({ok: false, error: `expected: ${OPENLOOP_COMMAND_USAGE}`});
  });
});

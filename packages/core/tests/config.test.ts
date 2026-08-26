import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {loadConfig} from "../src/config.js";

beforeEach(() => {
  vi.stubEnv("OPENLOOP_REVIEWER_VERIFICATION", "");
  vi.stubEnv("OPENLOOP_REVIEWER_VERIFY_SCRIPTS", "");
  vi.stubEnv("OPENLOOP_VERIFICATION_TIMEOUT_MS", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("reviewer verification configuration", () => {
  it("enables constrained package checks by default", () => {
    const config = loadConfig({projectDir: "C:\\project", stateDir: "C:\\project\\state"});
    expect(config.reviewerVerification).toBe(true);
    expect(config.reviewerVerificationScripts).toEqual(["test", "typecheck", "lint", "build", "check"]);
    expect(config.verificationTimeoutMs).toBe(600_000);
  });

  it("accepts unique safe script names and rejects command text", () => {
    vi.stubEnv("OPENLOOP_REVIEWER_VERIFY_SCRIPTS", "test,test:unit,test");
    expect(loadConfig({projectDir: "p", stateDir: "s"}).reviewerVerificationScripts)
      .toEqual(["test", "test:unit"]);

    vi.stubEnv("OPENLOOP_REVIEWER_VERIFY_SCRIPTS", "test,build && delete");
    expect(() => loadConfig({projectDir: "p", stateDir: "s"})).toThrow("invalid package script name");

    vi.stubEnv("OPENLOOP_REVIEWER_VERIFY_SCRIPTS", "x".repeat(129));
    expect(() => loadConfig({projectDir: "p", stateDir: "s"})).toThrow("invalid package script name");
  });
});

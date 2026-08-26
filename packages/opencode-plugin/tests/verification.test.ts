import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {
  availableVerificationScripts,
  formatVerificationReport,
  runPackageVerification,
} from "../src/verification.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "openloop-verify-")); });
afterEach(() => { rmSync(dir, {recursive: true, force: true}); });

function manifest(scripts: Record<string, string>, packageManager?: string) {
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "openloop-verification-fixture",
    private: true,
    packageManager,
    scripts,
  }), "utf8");
}

describe("reviewer package verification", () => {
  it("discovers only configured scripts", async () => {
    manifest({test: "node -e \"\"", typecheck: "node -e \"\"", release: "node -e \"\""});
    await expect(availableVerificationScripts(dir, ["test", "typecheck", "build"]))
      .resolves.toEqual({packageManager: "npm", available: ["test", "typecheck"]});
  });

  it("runs fixed package scripts without accepting arbitrary command text", async () => {
    manifest({
      test: "node -e \"console.log('independent-test-ok')\"",
      typecheck: "node -e \"console.log('independent-typecheck-ok')\"",
    });
    const report = await runPackageVerification({
      projectDir: dir,
      allowedScripts: ["test", "typecheck"],
      requestedScripts: ["test", "typecheck"],
      timeoutMs: 30_000,
    });
    expect(report.checks.map((check) => check.exitCode)).toEqual([0, 0]);
    expect(formatVerificationReport(report)).toContain("independent-test-ok");
    expect(formatVerificationReport(report)).toContain("independent-typecheck-ok");
  });

  it("caps combined output across all requested scripts", async () => {
    manifest({
      test: "node -e \"process.stdout.write('x'.repeat(40000))\"",
      typecheck: "node -e \"process.stdout.write('y'.repeat(40000))\"",
    });
    const report = await runPackageVerification({
      projectDir: dir,
      allowedScripts: ["test", "typecheck"],
      requestedScripts: ["test", "typecheck"],
      timeoutMs: 30_000,
    });
    expect(report.checks.reduce((total, check) => total + Buffer.byteLength(check.output), 0))
      .toBeLessThanOrEqual(65_536);
    expect(report.checks[1]?.truncated).toBe(true);
  });

  it("rejects unconfigured, missing, and syntactically unsafe script names", async () => {
    manifest({test: "node -e \"\"", release: "node -e \"\""});
    await expect(runPackageVerification({
      projectDir: dir, allowedScripts: ["test"], requestedScripts: ["release"], timeoutMs: 1_000,
    })).rejects.toThrow("not allowed");
    await expect(runPackageVerification({
      projectDir: dir, allowedScripts: ["test", "build"], requestedScripts: ["build"], timeoutMs: 1_000,
    })).rejects.toThrow("not present");
    await expect(runPackageVerification({
      projectDir: dir, allowedScripts: ["test"], requestedScripts: ["test && destructive"], timeoutMs: 1_000,
    })).rejects.toThrow("Invalid package script name");
    await expect(runPackageVerification({
      projectDir: dir,
      allowedScripts: Array.from({length: 21}, (_, index) => `check:${index}`),
      requestedScripts: Array.from({length: 21}, (_, index) => `check:${index}`),
      timeoutMs: 1_000,
    })).rejects.toThrow("at most 20 scripts");
  });

  it("reports script failures instead of disguising them as successful execution", async () => {
    manifest({test: "node -e \"console.error('intentional-failure'); process.exit(7)\""});
    const report = await runPackageVerification({
      projectDir: dir, allowedScripts: ["test"], requestedScripts: ["test"], timeoutMs: 30_000,
    });
    expect(report.checks[0]).toMatchObject({exitCode: 7, timedOut: false, aborted: false});
    expect(formatVerificationReport(report)).toContain("FAIL (exit 7)");
    expect(formatVerificationReport(report)).toContain("intentional-failure");
  });

  it("times out a verification script", async () => {
    manifest({test: "node -e \"setTimeout(() => {}, 10000)\""});
    const report = await runPackageVerification({
      projectDir: dir, allowedScripts: ["test"], requestedScripts: ["test"], timeoutMs: 1_000,
    });
    expect(report.checks[0]).toMatchObject({timedOut: true});
    expect(formatVerificationReport(report)).toContain("TIMEOUT");
  });

  it("aborts an in-flight verification script", async () => {
    manifest({test: "node -e \"setTimeout(() => {}, 10000)\""});
    const abort = new AbortController();
    const running = runPackageVerification({
      projectDir: dir,
      allowedScripts: ["test"],
      requestedScripts: ["test"],
      timeoutMs: 30_000,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 50);
    const report = await running;
    expect(report.checks[0]).toMatchObject({aborted: true});
    expect(formatVerificationReport(report)).toContain("ABORTED");
  });
});

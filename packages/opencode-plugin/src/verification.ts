import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {join} from "node:path";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CHECKS = 20;
const SCRIPT_NAME = /^[A-Za-z0-9:_-]{1,128}$/;

export type VerificationCheck = {
  script: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  output: string;
};

export type VerificationReport = {
  packageManager: string;
  available: string[];
  checks: VerificationCheck[];
};

export async function availableVerificationScripts(
  projectDir: string,
  allowedScripts: readonly string[],
): Promise<{packageManager: string; available: string[]}> {
  const manifest = await readManifest(projectDir);
  const scripts = manifest.scripts ?? {};
  const available = allowedScripts.filter((name) => SCRIPT_NAME.test(name) && typeof scripts[name] === "string");
  return {packageManager: detectPackageManager(projectDir, manifest.packageManager), available};
}

export async function runPackageVerification(input: {
  projectDir: string;
  allowedScripts: readonly string[];
  requestedScripts?: readonly string[];
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<VerificationReport> {
  const discovered = await availableVerificationScripts(input.projectDir, input.allowedScripts);
  const requested = input.requestedScripts?.length ? [...new Set(input.requestedScripts)] : discovered.available;
  if (requested.length === 0) {
    throw new Error("No configured verification scripts are present in package.json.");
  }
  if (requested.length > MAX_CHECKS) throw new Error(`Reviewer verification accepts at most ${MAX_CHECKS} scripts.`);
  for (const script of requested) {
    if (!SCRIPT_NAME.test(script)) throw new Error(`Invalid package script name: ${script}`);
    if (!input.allowedScripts.includes(script)) {
      throw new Error(`Package script is not allowed for reviewer verification: ${script}`);
    }
    if (!discovered.available.includes(script)) {
      throw new Error(`Package script is not present in package.json: ${script}`);
    }
  }

  const checks: VerificationCheck[] = [];
  let remainingOutputBytes = MAX_OUTPUT_BYTES;
  for (const script of requested) {
    if (input.signal?.aborted) throw abortError();
    const check = await runScript(
      input.projectDir,
      discovered.packageManager,
      script,
      input.timeoutMs,
      input.signal,
      remainingOutputBytes,
    );
    checks.push(check);
    remainingOutputBytes = Math.max(0, remainingOutputBytes - Buffer.byteLength(check.output, "utf8"));
  }
  return {...discovered, checks};
}

export function formatVerificationReport(report: VerificationReport): string {
  const lines = [
    `Package manager: ${report.packageManager}`,
    `Available verification scripts: ${report.available.join(", ") || "(none)"}`,
  ];
  for (const check of report.checks) {
    const status = check.aborted ? "ABORTED"
      : check.timedOut ? "TIMEOUT"
        : check.exitCode === 0 ? "PASS" : `FAIL (exit ${check.exitCode ?? "unknown"})`;
    lines.push(
      "",
      `## ${check.script}: ${status} (${check.durationMs}ms)`,
      `Command: ${check.command}`,
      check.truncated ? "Output was truncated by the 65536-byte report limit." : "Output was not truncated.",
      check.output || "(no output)",
    );
  }
  return lines.join("\n");
}

type PackageManifest = {packageManager?: unknown; scripts?: Record<string, unknown>};

async function readManifest(projectDir: string): Promise<PackageManifest> {
  const path = join(projectDir, "package.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Reviewer verification requires ${path}: ${String((error as Error).message ?? error)}`);
  }
  try {
    return JSON.parse(raw) as PackageManifest;
  } catch (error) {
    throw new Error(`Unable to parse ${path}: ${String((error as Error).message ?? error)}`);
  }
}

function detectPackageManager(projectDir: string, configured: unknown): string {
  if (typeof configured === "string") {
    const name = configured.split("@")[0]!.trim();
    if (["npm", "pnpm", "yarn", "bun"].includes(name)) return name;
  }
  if (existsSync(join(projectDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectDir, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectDir, "bun.lock")) || existsSync(join(projectDir, "bun.lockb"))) return "bun";
  return "npm";
}

async function runScript(
  cwd: string,
  packageManager: string,
  script: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxOutputBytes = MAX_OUTPUT_BYTES,
): Promise<VerificationCheck> {
  // Windows cannot launch .cmd shims with CreateProcess directly. The command
  // string remains injection-safe because packageManager is a fixed enum and
  // script has already passed SCRIPT_NAME (no whitespace/metacharacters).
  const displayCommand = `${packageManager} run ${script}`;
  const executable = process.platform === "win32" ? windowsSystemExecutable("cmd") : packageManager;
  const args = process.platform === "win32" ? ["/d", "/s", "/c", displayCommand] : ["run", script];
  const started = Date.now();
  let output = "";
  let outputBytes = 0;
  let truncated = false;
  let timedOut = false;
  let aborted = false;

  return new Promise<VerificationCheck>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: {...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0"},
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (prefix: string, chunk: Buffer) => {
      if (outputBytes >= maxOutputBytes) { truncated = true; return; }
      const text = `${prefix}${chunk.toString("utf8")}`;
      const remaining = maxOutputBytes - outputBytes;
      const shown = Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
      output += shown;
      outputBytes += Buffer.byteLength(shown, "utf8");
      if (Buffer.byteLength(text, "utf8") > remaining) truncated = true;
    };
    child.stdout?.on("data", (chunk: Buffer) => append("", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("[stderr] ", chunk));

    let forceKillTimer: NodeJS.Timeout | null = null;
    let killRequested = false;
    const forceKill = () => {
      if (child.exitCode !== null) return;
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        return;
      }
      child.kill("SIGKILL");
    };
    const kill = () => {
      if (killRequested) return;
      killRequested = true;
      if (child.exitCode !== null) return;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(windowsSystemExecutable("taskkill"), ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", forceKill);
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
      }
      forceKillTimer ??= setTimeout(forceKill, 2_000);
    };
    const onAbort = () => { aborted = true; kill(); };
    signal?.addEventListener("abort", onAbort, {once: true});
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    // Close the race where the signal aborts after the caller's preflight
    // check but before this listener is attached.
    if (signal?.aborted) onAbort();

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        script,
        command: displayCommand,
        exitCode,
        durationMs: Date.now() - started,
        timedOut,
        aborted,
        truncated,
        output: output.trim(),
      });
    };
    child.once("error", (error) => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Unable to start ${packageManager} run ${script}: ${error.message}`));
    });
    child.once("close", (code) => finish(code));
  });
}

function abortError(): Error {
  const error = new Error("Reviewer verification was aborted");
  error.name = "AbortError";
  return error;
}

function windowsSystemExecutable(name: "cmd" | "taskkill"): string {
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (!systemRoot) throw new Error(`Unable to locate Windows ${name}.exe because SystemRoot is not set`);
  return join(systemRoot, "System32", `${name}.exe`);
}

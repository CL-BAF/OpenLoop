import type {ModelRef, Verdict} from "./types.js";
import type {OpenLoopConfig} from "./types.js";
export type {OpenLoopConfig};

export class ConfigError extends Error {}

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function envInt(key: string, fallback: number): number {
  const raw = env(key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${key} must be a positive finite number, got: ${raw}`);
  }
  return Math.floor(n);
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = env(key);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new ConfigError(`${key} must be a boolean, got: ${raw}`);
}

function envScriptList(key: string, fallback: string[]): string[] {
  const raw = env(key);
  if (raw === undefined) return [...fallback];
  const scripts = [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
  if (scripts.length === 0) throw new ConfigError(`${key} must contain at least one package script name`);
  if (scripts.length > 20) throw new ConfigError(`${key} may contain at most 20 package script names`);
  for (const script of scripts) {
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(script)) {
      throw new ConfigError(`${key} contains an invalid package script name: ${script}`);
    }
  }
  return scripts;
}

function parseModel(value: string | undefined, fieldName: string): ModelRef | null {
  if (!value) return null;
  const separator = value.indexOf("/");
  const providerID = value.slice(0, separator).trim();
  const modelID = value.slice(separator + 1).trim();
  if (separator <= 0 || !providerID || !modelID) {
    throw new ConfigError(
      `${fieldName} must be in the form "<providerID>/<modelID>" (e.g. "ollama-cloud/glm-4.6"), got: ${value}`,
    );
  }
  return {providerID, modelID};
}

export interface LoadConfigInput {
  projectDir: string;
  stateDir: string;
}

export function loadConfig(input: LoadConfigInput): OpenLoopConfig {
  const coderModel = parseModel(env("OPENLOOP_CODER_MODEL"), "OPENLOOP_CODER_MODEL");
  const reviewerModel = parseModel(env("OPENLOOP_REVIEWER_MODEL"), "OPENLOOP_REVIEWER_MODEL");
  const coderAgent = env("OPENLOOP_CODER_AGENT") ?? "build";
  const reviewerAgent = env("OPENLOOP_REVIEWER_AGENT") ?? "build";
  const maxRounds = envInt("OPENLOOP_MAX_ROUNDS", 6);
  const reviewerReadonly = envBool("OPENLOOP_REVIEWER_READONLY", true);
  const reviewerVerification = envBool("OPENLOOP_REVIEWER_VERIFICATION", true);
  const reviewerVerificationScripts = envScriptList(
    "OPENLOOP_REVIEWER_VERIFY_SCRIPTS",
    ["test", "typecheck", "lint", "build", "check"],
  );
  const verificationTimeoutMs = envInt("OPENLOOP_VERIFICATION_TIMEOUT_MS", 10 * 60 * 1000);
  const turnTimeoutMs = envInt("OPENLOOP_TURN_TIMEOUT_MS", 30 * 60 * 1000);
  const pollIntervalMs = envInt("OPENLOOP_POLL_INTERVAL_MS", 2000);

  return {
    coderModel,
    reviewerModel,
    coderAgent,
    reviewerAgent,
    maxRounds,
    reviewerReadonly,
    reviewerVerification,
    reviewerVerificationScripts,
    verificationTimeoutMs,
    turnTimeoutMs,
    pollIntervalMs,
    projectDir: input.projectDir,
    stateDir: input.stateDir,
  };
}

/** Coerce an arbitrary verdict string to the canonical union, or null. */
export function coerceVerdict(v: unknown): Verdict | null {
  if (typeof v !== "string") return null;
  const up = v.toUpperCase();
  return up === "PASS" || up === "CHANGES_REQUIRED" ? up : null;
}

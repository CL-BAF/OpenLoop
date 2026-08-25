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

function parseModel(value: string | undefined, fieldName: string): ModelRef | null {
  if (!value) return null;
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ConfigError(
      `${fieldName} must be in the form "<providerID>/<modelID>" (e.g. "ollama-cloud/glm-4.6"), got: ${value}`,
    );
  }
  return {providerID: parts[0]!, modelID: parts[1]!};
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
  const turnTimeoutMs = envInt("OPENLOOP_TURN_TIMEOUT_MS", 30 * 60 * 1000);
  const pollIntervalMs = envInt("OPENLOOP_POLL_INTERVAL_MS", 2000);

  return {
    coderModel,
    reviewerModel,
    coderAgent,
    reviewerAgent,
    maxRounds,
    reviewerReadonly,
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
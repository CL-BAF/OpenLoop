import {inspect} from "node:util";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {debug: 10, info: 20, warn: 30, error: 40};
const LEVEL_TAG: Record<LogLevel, string> = {debug: "DEBUG", info: "INFO", warn: "WARN", error: "ERROR"};

let currentLevel: LogLevel = (() => {
  const v = process.env.OPENLOOP_LOG_LEVEL as LogLevel | undefined;
  return v && LEVEL_ORDER[v] ? v : "info";
})();

function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

export const log = {
  setLevel(level: LogLevel): void {
    if (LEVEL_ORDER[level]) currentLevel = level;
  },
  debug(scope: string, msg: string, extra?: unknown): void { emit("debug", scope, msg, extra); },
  info(scope: string, msg: string, extra?: unknown): void { emit("info", scope, msg, extra); },
  warn(scope: string, msg: string, extra?: unknown): void { emit("warn", scope, msg, extra); },
  error(scope: string, msg: string, extra?: unknown): void { emit("error", scope, msg, extra); },
};

function emit(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (!shouldLog(level)) return;
  const line = `${ts()} ${LEVEL_TAG[level]} [${scope}] ${msg}`;
  process.stderr.write(line + "\n");
  if (extra !== undefined) {
    process.stderr.write(inspect(extra, {colors: true, depth: 6, breakLength: Infinity}) + "\n");
  }
}

export function banner(text: string): void {
  const rule = "─".repeat(Math.max(8, Math.min(72, text.length + 4)));
  process.stderr.write(`${rule}\n${text}\n${rule}\n`);
}

export function controlBanner(agent: string, subtitle: string): void {
  const label = agent === "CODER" ? "CODER" : "REVIEWER";
  const rule = "═".repeat(Math.max(8, Math.min(72, subtitle.length + 4)));
  process.stderr.write(`${label} has control\n${rule}\n${label} :: ${subtitle}\n${rule}\n`);
}

export function roundBanner(round: number, maxRounds: number): void {
  const text = `ROUND ${round} / ${maxRounds}`;
  const rule = "━".repeat(Math.max(8, text.length + 4));
  process.stderr.write(`${rule}\n${text}\n${rule}\n`);
}

export function section(title: string): void {
  process.stderr.write(`▸ ${title}\n`);
}
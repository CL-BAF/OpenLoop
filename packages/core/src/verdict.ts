import type {
  Finding, FutureImprovement, ResearchResult, ReviewVerdict, Severity, TurnResult,
} from "./types.js";
import {coerceVerdict} from "./config.js";

const SEVERITIES = new Set<Severity>(["critical", "high", "medium", "low"]);

type FindingShape = {
  severity?: unknown;
  location?: unknown;
  problem?: unknown;
  impact?: unknown;
  recommended_fix?: unknown;
  verification?: unknown;
};

type DiscoveryShape = {source?: unknown; finding?: unknown};
type ImprovementShape = {area?: unknown; suggestion?: unknown; rationale?: unknown};

type ResearchShape = {
  performed?: unknown;
  sources_checked?: unknown;
  relevant_discoveries?: unknown;
  recommended_improvements?: unknown;
};

type VerdictShape = {
  verdict?: unknown;
  summary?: unknown;
  findings?: unknown;
  next_coder_prompt?: unknown;
  research?: unknown;
  future_improvements?: unknown;
};

export interface ParsedVerdict {
  verdict: ReviewVerdict["verdict"];
  summary: string;
  findings: Finding[];
  /** Focused, ready-to-send prompt for the next coder round (Prompt Engineer role). */
  nextCoderPrompt: string;
  /** Optional research into OpenLoop/OpenCode improvements (Researcher role). */
  research: ResearchResult;
  /** Optional improvement ideas for OpenLoop itself, recorded for later. */
  futureImprovements: FutureImprovement[];
  /** true if recovered from text parsing rather than structured output. */
  fromTextFallback: boolean;
  /** true if the output was malformed and a best-effort guess was made. */
  malformed: boolean;
}

/**
 * Parse the reviewer's verdict from the structured output field or assistant
 * text. Handles malformed output gracefully and never throws.
 */
export function parseVerdict(turn: TurnResult): ParsedVerdict {
  // Compatibility path for servers that provide a structured field. Current
  // OpenLoop reviewer prompts use validated JSON text so message history stays
  // readable across affected OpenCode versions.
  if (turn.structured && typeof turn.structured === "object") {
    const shape = turn.structured as VerdictShape;
    const parsed = coerceVerdictObject(shape);
    if (parsed) return {...parsed, fromTextFallback: false, malformed: !isCompleteVerdictShape(shape)};
  }

  // Fallback: extract JSON from text.
  const jsonText = extractJson(turn.text);
  if (jsonText !== null) {
    try {
      const obj = JSON.parse(jsonText) as unknown;
      const shape = obj as VerdictShape;
      const parsed = coerceVerdictObject(shape);
      if (parsed) return {...parsed, fromTextFallback: true, malformed: !isCompleteVerdictShape(shape)};
    } catch {
      // fall through to best-effort
    }
  }

  return inferFromText(turn.text);
}

function isCompleteVerdictShape(obj: VerdictShape): boolean {
  if (!obj || typeof obj !== "object") return false;
  if (!coerceVerdict(obj.verdict) || typeof obj.summary !== "string") return false;
  if (!Array.isArray(obj.findings) || typeof obj.next_coder_prompt !== "string") return false;
  if (!obj.research || typeof obj.research !== "object"
    || typeof (obj.research as ResearchShape).performed !== "boolean") return false;
  return obj.findings.every((finding) => coerceFinding(finding as FindingShape) !== null);
}

function coerceVerdictObject(obj: VerdictShape): Omit<ParsedVerdict, "fromTextFallback" | "malformed"> | null {
  if (!obj || typeof obj !== "object") return null;
  const verdict = coerceVerdict(obj.verdict);
  if (!verdict) return null;
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const findings: Finding[] = [];
  if (Array.isArray(obj.findings)) {
    for (const raw of obj.findings) {
      const f = coerceFinding(raw as FindingShape);
      if (f) findings.push(f);
    }
  }
  const nextCoderPrompt = typeof obj.next_coder_prompt === "string" ? obj.next_coder_prompt : "";
  const research = coerceResearch(obj.research as ResearchShape | undefined);
  const futureImprovements = coerceImprovements(obj.future_improvements);
  return {verdict, summary, findings, nextCoderPrompt, research, futureImprovements};
}

function coerceFinding(raw: FindingShape): Finding | null {
  if (!raw || typeof raw !== "object") return null;
  const severity = typeof raw.severity === "string" ? (raw.severity as string).toLowerCase() : "";
  if (!SEVERITIES.has(severity as Severity)) return null;
  return {
    severity: severity as Severity,
    location: str(raw.location) || "(unknown location)",
    problem: str(raw.problem) || "(no problem described)",
    impact: str(raw.impact) || "(unknown impact)",
    recommended_fix: str(raw.recommended_fix) || "(no fix suggested)",
    verification: str(raw.verification) || "(no verification suggested)",
  };
}

function coerceResearch(raw: ResearchShape | undefined): ResearchResult {
  if (!raw || typeof raw !== "object") return {performed: false};
  const performed = raw.performed === true;
  if (!performed) return {performed: false};
  const sourcesChecked = strArray(raw.sources_checked);
  const relevantDiscoveries = Array.isArray(raw.relevant_discoveries)
    ? (raw.relevant_discoveries as unknown[])
        .map((d) => coerceDiscovery(d as DiscoveryShape))
        .filter((d): d is {source: string; finding: string} => d !== null)
    : [];
  const recommendedImprovements = Array.isArray(raw.recommended_improvements)
    ? (raw.recommended_improvements as unknown[])
        .map((d) => coerceImprovement(d as ImprovementShape))
        .filter((d): d is FutureImprovement => d !== null)
    : [];
  return {performed: true, sourcesChecked, relevantDiscoveries, recommendedImprovements};
}

function coerceDiscovery(raw: DiscoveryShape): {source: string; finding: string} | null {
  if (!raw || typeof raw !== "object") return null;
  const source = str(raw.source);
  const finding = str(raw.finding);
  if (!source && !finding) return null;
  return {source: source || "(unspecified)", finding: finding || "(unspecified)"};
}

function coerceImprovement(raw: ImprovementShape): FutureImprovement | null {
  if (!raw || typeof raw !== "object") return null;
  const area = str(raw.area) || "general";
  const suggestion = str(raw.suggestion);
  const rationale = str(raw.rationale);
  if (!suggestion) return null;
  return {area, suggestion, rationale};
}

function coerceImprovements(raw: unknown): FutureImprovement[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[])
    .map((d) => coerceImprovement(d as ImprovementShape))
    .filter((d): d is FutureImprovement => d !== null);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).map((x) => str(x)).filter((s) => s.length > 0);
}

/** Extract the first balanced JSON object, optionally from a fenced code block. */
export function extractJson(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1]) return fence[1].trim();
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

function inferFromText(text: string): ParsedVerdict {
  const upper = (text || "").toUpperCase();
  let verdict: ReviewVerdict["verdict"];
  if (/\bPASS\b/.test(upper) && !/CHANGES?\s*REQUIRED/.test(upper)) {
    verdict = "PASS";
  } else if (/CHANGES?\s*REQUIRED/.test(upper) || /\bFAIL(?:ED)?\b/.test(upper)) {
    verdict = "CHANGES_REQUIRED";
  } else {
    // Ambiguous: safest is to request another look (non-PASS).
    verdict = "CHANGES_REQUIRED";
  }
  return {
    verdict,
    summary: text ? text.slice(0, 500) : "(reviewer produced no parseable output)",
    findings: [],
    nextCoderPrompt: "",
    research: {performed: false},
    futureImprovements: [],
    fromTextFallback: true,
    malformed: true,
  };
}

/**
 * Decide whether the reviewer requires another coder round.
 * Low-severity cosmetic findings alone never force another round.
 */
export function requiresChanges(v: ParsedVerdict): boolean {
  const material = v.findings.filter((f) => f.severity !== "low");
  // A material finding wins over an inconsistent PASS label. Conversely, a
  // CHANGES_REQUIRED verdict containing cosmetic-only findings does not keep
  // the loop alive forever.
  return material.length > 0;
}

/**
 * Format findings as a plain-text coder prompt fallback.
 * Used only when the reviewer did not provide a `next_coder_prompt`.
 */
export function formatFindingsForCoder(v: ParsedVerdict): string {
  if (v.findings.length === 0) return v.summary || "(no findings listed)";
  const lines: string[] = [v.summary || ""];
  for (const f of v.findings) {
    lines.push(
      `- [${f.severity}] ${f.location}: ${f.problem} (impact: ${f.impact}; fix: ${f.recommended_fix}; verify: ${f.verification})`,
    );
  }
  return lines.join("\n").trim();
}

/**
 * Return the prompt to send to the coder for the next round.
 * Prefers the reviewer's authored `next_coder_prompt`; falls back to a
 * formatted findings list so the coder always gets actionable instructions.
 */
export function nextCoderPrompt(v: ParsedVerdict, fallback: string): string {
  if (v.nextCoderPrompt && v.nextCoderPrompt.trim()) return v.nextCoderPrompt.trim();
  return fallback;
}

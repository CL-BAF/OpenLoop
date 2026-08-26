import type {OpencodeClient} from "@opencode-ai/sdk/v2";
import type {DiffSummary, TurnResult} from "@openloop/core";
import type {SnapshotFileDiff, Message, Part, PermissionRuleset, Session} from "@opencode-ai/sdk/v2";

/** Read the last assistant message in a session as a TurnResult. */
export async function readLastTurn(
  client: OpencodeClient,
  sessionID: string,
  parentMessageID?: string,
): Promise<TurnResult> {
  const msgs = await unwrap(client.session.messages({sessionID}), "get messages");
  let last: {info: Message; parts: Part[]} | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.info.role === "assistant" && (!parentMessageID || m.info.parentID === parentMessageID)) {
      last = m;
      break;
    }
  }
  if (!last) {
    throw new SdkError(
      `assistant response${parentMessageID ? ` for ${parentMessageID}` : ""} was not found in session ${sessionID}`,
      "TurnNotReady",
    );
  }
  const info = last.info as Extract<Message, {role: "assistant"}>;
  let text = "";
  for (const p of last.parts) {
    if (p.type === "text" && p.text) text += p.text;
  }
  const err = info.error
    ? {name: info.error.name, message: (info.error as {data?: {message?: string}}).data?.message ?? info.error.name}
    : null;
  const structured = (info as unknown as {structured?: unknown}).structured ?? null;
  return {messageID: info.id, parentMessageID: info.parentID, text, structured, error: err};
}

/** Fetch a session diff as a DiffSummary. */
export async function readDiff(
  client: OpencodeClient,
  sessionID: string,
  messageID?: string,
): Promise<DiffSummary> {
  const diffs: SnapshotFileDiff[] = await unwrap(
    client.session.diff({sessionID, messageID}),
    "get session diff",
  );
  let additions = 0, deletions = 0;
  for (const d of diffs) {
    additions += d.additions ?? 0;
    deletions += d.deletions ?? 0;
  }
  return {files: diffs.length, additions, deletions, diffs: diffs.map(toDiffEntry)};
}

function toDiffEntry(d: SnapshotFileDiff): DiffSummary["diffs"][number] {
  const file = d.file ?? (d.patch?.split("\n")[0]?.replace(/^diff --git a\//, "").split(" b/")[0]);
  return {file, additions: d.additions ?? 0, deletions: d.deletions ?? 0, patch: d.patch};
}

/**
 * Build persistent session permissions for a read-only reviewer.
 *
 * Do not pass an equivalent `tools` map to `session.prompt*`. OpenCode 1.18.x
 * converts that legacy per-prompt map into session permissions by REPLACING
 * the rules supplied at session creation. Building one complete ruleset here
 * keeps the restrictions in force for every internal model/tool step.
 */
export async function buildReadonlyPermissions(client: OpencodeClient): Promise<PermissionRuleset> {
  const ids = await unwrap(client.tool.ids(), "list tool IDs");
  if (ids.length === 0) {
    throw new SdkError("OpenCode returned no tool IDs; reviewer read-only mode cannot be enforced", "NoTools");
  }
  const permissions: PermissionRuleset = [...REVIEWER_PERMISSION_DENIES];
  for (const id of ids) {
    // Fail closed: every unknown or write-capable tool is disabled. This also
    // blocks plugin-defined tools that could mutate files or start more agents.
    if (!READONLY_TOOL_IDS.has(id) && !hasPermissionDeny(permissions, id)) {
      permissions.push({permission: id, pattern: "*", action: "deny"});
    }
  }
  return permissions;
}

const READONLY_TOOL_IDS = new Set([
  "read", "glob", "grep", "list", "lsp", "todoread",
  "webfetch", "websearch", "codesearch", "openloop_verify",
]);

export const REVIEWER_PERMISSION_DENIES: PermissionRuleset = [
  {permission: "edit", pattern: "*", action: "deny"},
  {permission: "bash", pattern: "*", action: "deny"},
  {permission: "task", pattern: "*", action: "deny"},
  {permission: "external_directory", pattern: "*", action: "deny"},
  {permission: "todowrite", pattern: "*", action: "deny"},
];

function hasPermissionDeny(permissions: PermissionRuleset, permission: string): boolean {
  return permissions.some((rule) =>
    rule.permission === permission && rule.pattern === "*" && rule.action === "deny",
  );
}

/** Create a root session (no parentID) and surface SDK response errors. */
export async function createRootSession(
  client: OpencodeClient,
  title: string,
  permission?: PermissionRuleset,
): Promise<Session> {
  return unwrap(client.session.create({title, permission}), `create ${title} session`);
}

/** Read one session's status. Absent entries are OpenCode's documented idle state. */
export async function readSessionStatus(client: OpencodeClient, sessionID: string): Promise<string> {
  const statuses = await unwrap(client.session.status(), "get session status");
  return statuses[sessionID]?.type ?? "idle";
}

export async function abortSession(client: OpencodeClient, sessionID: string): Promise<void> {
  await unwrap(client.session.abort({sessionID}), `abort session ${sessionID}`);
}

/** Error thrown by unwrap; carries the structured error code (e.g. NotFoundError). */
export class SdkError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "SdkError";
    this.code = code;
  }
}

export async function unwrap<T>(
  p: Promise<{data?: T; error?: unknown; response?: Response}>,
  ctx: string,
  allowEmpty = false,
): Promise<T> {
  const r = await p;
  if (r && typeof r === "object") {
    if (r.error !== undefined) {
      const code = (r.error as {name?: string} | null)?.name ?? null;
      throw new SdkError(`${ctx} failed: ${describeError(r.error)}`, code);
    }
    if (r.data !== undefined) return r.data as T;
    if (r.response && !r.response.ok) {
      let body = "";
      try { body = await r.response.text(); } catch { /* ignore */ }
      throw new SdkError(`${ctx} failed: HTTP ${r.response.status} ${r.response.statusText}${body ? ` - ${body.slice(0, 500)}` : ""}`, null);
    }
    if (allowEmpty && r.error === undefined) return undefined as T;
  }
  throw new SdkError(`${ctx} returned an unexpected response`, null);
}

function describeError(e: unknown): string {
  if (e && typeof e === "object") {
    const name = (e as {name?: string}).name;
    const message = (e as {message?: unknown}).message;
    const data = (e as {data?: {message?: string}}).data;
    if (name === "NotFoundError") return `not found: ${data?.message ?? ""}`;
    if (name === "BadRequest") return `bad request: ${data?.message ?? ""}`;
    if (name && data?.message) return `${name}: ${data.message}`;
    if (name && typeof message === "string" && message) return `${name}: ${message}`;
    if (name) return name;
    if (typeof message === "string" && message) return message;
    if (data?.message) return data.message;
  }
  try {
    const json = JSON.stringify(e);
    return json === undefined ? String(e) : json;
  } catch {
    return String(e);
  }
}

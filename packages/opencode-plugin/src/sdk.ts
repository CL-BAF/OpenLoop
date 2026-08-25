import type {OpencodeClient} from "@opencode-ai/sdk/v2";
import type {DiffSummary, TurnResult} from "@openloop/core";
import type {SnapshotFileDiff, Message, Part} from "@opencode-ai/sdk/v2";

/** Read the last assistant message in a session as a TurnResult. */
export async function readLastTurn(client: OpencodeClient, sessionID: string): Promise<TurnResult> {
  const msgs = await unwrap(client.session.messages({sessionID}), "get messages");
  let last: {info: Message; parts: Part[]} | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.info.role === "assistant") { last = m; break; }
  }
  if (!last) return {messageID: "", text: "", structured: null, error: null};
  const info = last.info as Extract<Message, {role: "assistant"}>;
  let text = "";
  for (const p of last.parts) {
    if (p.type === "text" && p.text) text += p.text;
  }
  const err = info.error
    ? {name: info.error.name, message: (info.error as {data?: {message?: string}}).data?.message ?? info.error.name}
    : null;
  const structured = (info as unknown as {structured?: unknown}).structured ?? null;
  return {messageID: info.id, text, structured, error: err};
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

/** Check whether a session still exists on the server. */
export async function sessionExists(client: OpencodeClient, id: string): Promise<boolean> {
  try {
    await unwrap(client.session.get({sessionID: id}), "get session");
    return true;
  } catch (e) {
    // Match on the structured error name, not fragile message text.
    if (e instanceof SdkError && e.code === "NotFoundError") return false;
    throw e;
  }
}

/** Build a read-only tool map by disabling file-editing tool IDs. */
export async function buildReadonlyTools(client: OpencodeClient): Promise<Record<string, boolean> | undefined> {
  const ids: string[] = await client.tool.ids().then((r) => (r.data as string[] | undefined) ?? []).catch(() => []);
  if (ids.length === 0) return undefined;
  const tools: Record<string, boolean> = {};
  let disabled = 0;
  for (const id of ids) {
    const isEdit = isEditTool(id);
    if (isEdit) { tools[id] = false; disabled++; }
  }
  if (disabled === 0) return undefined;
  return tools;
}

const EDIT_TOOL_IDS = new Set(["edit", "write", "str_replace", "str_replace_editor", "create_file", "edit_file", "apply_patch"]);
function isEditTool(id: string): boolean {
  return EDIT_TOOL_IDS.has(id) || /edit|write|str_replace|apply_patch|create_file/i.test(id);
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

async function unwrap<T>(p: Promise<{data?: T; error?: unknown; response?: Response}>, ctx: string): Promise<T> {
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
  }
  throw new SdkError(`${ctx} returned an unexpected response`, null);
}

function describeError(e: unknown): string {
  if (e && typeof e === "object") {
    const name = (e as {name?: string}).name;
    const data = (e as {data?: {message?: string}}).data;
    if (name === "NotFoundError") return `not found: ${data?.message ?? ""}`;
    if (name === "BadRequest") return `bad request: ${data?.message ?? ""}`;
    if (name && data?.message) return `${name}: ${data.message}`;
    if (name) return name;
    if (data?.message) return data.message;
  }
  try { return JSON.stringify(e); } catch { return String(e); }
}
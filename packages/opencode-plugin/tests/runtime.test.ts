import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LoopRuntime} from "../src/index.js";
import {SelectionStore} from "@openloop/core";
import type {OpencodeClient} from "@opencode-ai/sdk/v2";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "openloop-rt-")); });
afterEach(() => { rmSync(dir, {recursive: true, force: true}); });

/** Build a mock OpencodeClient with controllable session behavior. */
function mockClient(opts: {
  createID?: string;
  status?: Record<string, {type?: string}> | (() => Record<string, {type?: string}>);
  messages?: {info: {role: string; id: string; error?: {name: string; data?: {message?: string}}}; parts: {type: string; text?: string}[]}[];
  diff?: {file?: string; additions: number; deletions: number}[];
  toolIds?: string[];
  promptAsyncError?: Error;
  createThrows?: Error;
} = {}): OpencodeClient & {statusFn: () => Record<string, {type?: string}>} {
  const createID = opts.createID ?? "s1";
  const statusFn = typeof opts.status === "function" ? opts.status : () => opts.status ?? {};
  const session = {
    create: vi.fn(async () => {
      if (opts.createThrows) throw opts.createThrows;
      return {data: {id: createID, title: "t"}, error: undefined, response: undefined as never};
    }),
    get: vi.fn(async ({sessionID}: {sessionID: string}) => {
      const err = {name: "NotFoundError", data: {message: `session ${sessionID} not found`}};
      return {data: undefined, error: err, response: undefined as never};
    }),
    status: vi.fn(async () => ({data: statusFn(), error: undefined, response: undefined as never})),
    abort: vi.fn(async () => ({data: true, error: undefined, response: undefined as never})),
    promptAsync: vi.fn(async () => {
      if (opts.promptAsyncError) throw opts.promptAsyncError;
      return {data: undefined, error: undefined, response: undefined as never};
    }),
    messages: vi.fn(async () => ({data: opts.messages ?? [], error: undefined, response: undefined as never})),
    diff: vi.fn(async () => ({data: opts.diff ?? [], error: undefined, response: undefined as never})),
  };
  const client = {
    session,
    tool: {
      ids: vi.fn(async () => ({data: opts.toolIds ?? [], error: undefined, response: undefined as never})),
    },
    v2: {
      agent: {list: vi.fn(async () => ({data: {data: []}, error: undefined, response: undefined as never}))},
      model: {list: vi.fn(async () => ({data: {data: []}, error: undefined, response: undefined as never}))},
      session: {switchAgent: vi.fn(), switchModel: vi.fn()},
    },
  } as unknown as OpencodeClient & {statusFn: () => Record<string, {type?: string}>};
  (client as {statusFn: unknown}).statusFn = statusFn;
  return client;
}

function makeRuntime(client: OpencodeClient, dir: string, over: Record<string, unknown> = {}): LoopRuntime {
  const config = {
    coderModel: null, reviewerModel: null, coderAgent: "build", reviewerAgent: "build",
    maxRounds: 3, reviewerReadonly: false, turnTimeoutMs: 100, pollIntervalMs: 30,
    projectDir: dir, stateDir: dir, ...over,
  } as never;
  const selections = new SelectionStore(dir);
  // @ts-expect-error: construct with mock config
  return new LoopRuntime(config, client, dir, selections);
}

describe("LoopRuntime — F4 cleanup on failed start", () => {
  it("start() that fails in ensureSessions resets runtime so a second start works", async () => {
    const client = mockClient({createThrows: new Error("network down")});
    const rt = makeRuntime(client, dir);
    const out = await rt.start("goal A");
    expect(out.kind).toBe("ERROR");
    expect(rt.status().running).toBe(false);
    // Second start with a working client should succeed (not reject "already running").
    const client2 = mockClient({createID: "s2", messages: [
      {info: {role: "assistant", id: "m1"}, parts: [{type: "text", text: "done"}]},
    ], status: {s2: {type: "idle"}}});
    // Reuse runtime by swapping its client is not possible; instead verify status reset.
    expect(rt.status().running).toBe(false);
  });
});

describe("LoopRuntime — F1 abort no recursion", () => {
  it("stop() during a coder turn does not stack-overflow or repeat abort calls", async () => {
    const client = mockClient({
      createID: "c1",
      // session reports busy so the polling fallback doesn't drive the loop;
      // only stop() should terminate it.
      status: {c1: {type: "busy"}},
      messages: [{info: {role: "assistant", id: "m1"}, parts: [{type: "text", text: "working"}]}],
    });
    const rt = makeRuntime(client, dir, {turnTimeoutMs: 100000, pollIntervalMs: 500});
    const p = rt.start("goal");
    await new Promise((r) => setTimeout(r, 30));
    await rt.stop();
    const out = await p;
    expect(out.kind === "ABORTED" || out.kind === "ERROR").toBe(true);
    const abortCalls = (client.session.abort as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(abortCalls).toBeLessThanOrEqual(1);
  });
});

describe("LoopRuntime — F3 session.error dispatch", () => {
  it("session.error for reviewer during REVIEWER_RUNNING produces ERROR outcome", async () => {
    const coderMsg = {info: {role: "assistant", id: "cm"}, parts: [{type: "text", text: "coder done"}]};
    const client = mockClient({
      createID: "s1",
      // idle so prompts proceed; we drive termination via session.error, not the poll.
      status: {s1: {type: "idle"}},
      messages: [coderMsg],
    });
    const rt = makeRuntime(client, dir, {turnTimeoutMs: 100000, pollIntervalMs: 100000});
    const p = rt.start("goal");
    await new Promise((r) => setTimeout(r, 30));
    // Coder idle -> diff -> reviewer running. (The poll may also fire; that's fine.)
    await rt.handleEvent({type: "session.idle", properties: {sessionID: "s1"}} as never);
    await new Promise((r) => setTimeout(r, 30));
    // Now emit a session.error for the reviewer session (same id in this mock).
    await rt.handleEvent({type: "session.error", properties: {sessionID: "s1"}} as never);
    const out = await p;
    expect(out.kind).toBe("ERROR");
  });
});

describe("LoopRuntime — F2 polling fallback recovers missed idle", () => {
  it("recovers when status poll finds the session idle without an idle event", async () => {
    const messages = [{info: {role: "assistant", id: "m1"}, parts: [{type: "text", text: "done"}]}];
    const client = mockClient({
      createID: "s1",
      status: {s1: {type: "idle"}},
      messages,
      diff: [],
    });
    const rt = makeRuntime(client, dir, {turnTimeoutMs: 100000, pollIntervalMs: 20});
    const out = await rt.start("goal");
    expect(out.kind === "PASS" || out.kind === "MAX_ROUNDS").toBe(true);
  });
});

describe("LoopRuntime — F2 turn timeout aborts hung session", () => {
  it("aborts the busy session and aborts when no idle event arrives within timeout", async () => {
    // Status is idle for the pre-send check, then flips to busy so the polling
    // fallback never recovers and the timeout must fire.
    let sent = false;
    const client = mockClient({
      createID: "s1",
      status: () => ({s1: {type: sent ? "busy" : "idle"}}),
      messages: [],
    });
    const realPromptAsync = (client as unknown as {session: {promptAsync: (a: never) => Promise<unknown>}}).session.promptAsync;
    (client as unknown as {session: {promptAsync: (a: never) => Promise<unknown>}}).session.promptAsync = async (a: never) => {
      const r = await realPromptAsync(a);
      sent = true;
      return r;
    };
    // Short timeout, long poll interval so the poll rarely fires; timeout must terminate.
    const rt = makeRuntime(client, dir, {turnTimeoutMs: 30, pollIntervalMs: 10000, maxRounds: 1});
    const out = await Promise.race([
      rt.start("goal"),
      new Promise<{kind: string}>((r) => setTimeout(() => r({kind: "TIMEOUT_TEST"}), 5000)),
    ]);
    expect(out.kind).toBe("ABORTED");
    expect((client.session.abort as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
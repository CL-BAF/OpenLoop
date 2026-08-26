import {describe, it, expect, vi, beforeEach, afterEach} from "vitest";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LoopRuntime} from "../src/index.js";
import {SelectionStore} from "@openloop/core";
import type {OpencodeClient} from "@opencode-ai/sdk/v2";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "openloop-rt-")); });
afterEach(() => { rmSync(dir, {recursive: true, force: true}); });

type MockOptions = {
  statusAfterPrompt?: "idle" | "busy";
  promptErrorRole?: "coder" | "reviewer";
  reviewerStructured?: unknown;
  duplicateSessionID?: boolean;
  catalogError?: boolean;
  assistantDelayMs?: number;
  omitAssistant?: boolean;
  reviewerError?: {name: string; data: {message: string}};
  reviewerText?: string;
};

function mockClient(opts: MockOptions = {}): OpencodeClient {
  const messages = new Map<string, unknown[]>();
  let createIndex = 0;
  let promptCount = 0;
  let promptAccepted = false;
  let activeSessionID = "";

  const session = {
    create: vi.fn(async () => {
      const role = createIndex % 2 === 0 ? "coder" : "reviewer";
      const run = Math.floor(createIndex / 2) + 1;
      createIndex += 1;
      return {
        data: {id: opts.duplicateSessionID ? "same" : `${role}-${run}`, title: "t"},
        error: undefined, response: undefined as never,
      };
    }),
    status: vi.fn(async () => ({
      data: promptAccepted && opts.statusAfterPrompt === "busy"
        ? {[activeSessionID]: {type: "busy"}}
        : {},
      error: undefined,
      response: undefined as never,
    })),
    abort: vi.fn(async () => ({data: true, error: undefined, response: undefined as never})),
    delete: vi.fn(async () => ({data: true, error: undefined, response: undefined as never})),
    promptAsync: vi.fn(async (input: {sessionID: string; messageID: string}) => {
      const role = input.sessionID.startsWith("coder-") ? "coder" : "reviewer";
      if (opts.promptErrorRole === role) {
        return {data: undefined, error: {name: "APIError", data: {message: "network/model failure"}}, response: undefined as never};
      }
      promptCount += 1;
      promptAccepted = true;
      activeSessionID = input.sessionID;
      const assistant = role === "coder"
        ? {
            info: {role: "assistant", id: `assistant-${promptCount}`, parentID: input.messageID},
            parts: [{type: "text", text: "coder completed and tests passed"}],
          }
        : {
            info: {
              role: "assistant", id: `assistant-${promptCount}`, parentID: input.messageID,
              error: opts.reviewerError,
              structured: opts.reviewerStructured === undefined ? {
                verdict: "PASS", summary: "verified", findings: [],
                next_coder_prompt: "No further work.", research: {performed: false},
              } : opts.reviewerStructured,
            },
            parts: [{type: "text", text: opts.reviewerText ?? "review complete"}],
          };
      if (!opts.omitAssistant) {
        if (opts.assistantDelayMs) {
          setTimeout(() => messages.set(input.sessionID, [assistant]), opts.assistantDelayMs);
        } else {
          messages.set(input.sessionID, [assistant]);
        }
      }
      return {data: undefined, error: undefined, response: undefined as never};
    }),
    messages: vi.fn(async ({sessionID}: {sessionID: string}) => ({
      data: messages.get(sessionID) ?? [], error: undefined, response: undefined as never,
    })),
    diff: vi.fn(async () => ({
      data: [{file: "src/a.ts", additions: 2, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new"}],
      error: undefined,
      response: undefined as never,
    })),
  };

  const catalogResult = opts.catalogError
    ? {data: undefined, error: {name: "APIError", data: {message: "catalog unavailable"}}, response: undefined as never}
    : null;

  return {
    session,
    config: {
      providers: vi.fn(async () => catalogResult ?? ({
        data: {providers: [], default: {}}, error: undefined, response: undefined as never,
      })),
    },
    app: {
      agents: vi.fn(async () => catalogResult ?? ({
        data: [{name: "build", mode: "primary", hidden: false, permission: [], options: {}}],
        error: undefined, response: undefined as never,
      })),
    },
    tool: {
      ids: vi.fn(async () => ({
        data: ["read", "grep", "bash", "edit", "task", "openloop_start_goal", "openloop_run"],
        error: undefined,
        response: undefined as never,
      })),
    },
  } as unknown as OpencodeClient;
}

function makeRuntime(client: OpencodeClient, over: Record<string, unknown> = {}): LoopRuntime {
  const config = {
    coderModel: null, reviewerModel: null, coderAgent: "build", reviewerAgent: "build",
    maxRounds: 3, reviewerReadonly: true, turnTimeoutMs: 500, pollIntervalMs: 10,
    projectDir: dir, stateDir: dir, ...over,
  } as never;
  return new LoopRuntime(config, client, dir, new SelectionStore(dir));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}

describe("LoopRuntime integration-shaped orchestration", () => {
  it("runs coder -> exact diff -> read-only reviewer -> PASS and persists the round", async () => {
    const client = mockClient();
    const rt = makeRuntime(client);
    const out = await rt.start("fix the application");

    expect(out.kind).toBe("PASS");
    expect(client.session.create).toHaveBeenCalledTimes(2);
    const [coderCreate, reviewerCreate] = (client.session.create as ReturnType<typeof vi.fn>).mock.calls;
    expect(coderCreate![0]).not.toHaveProperty("parentID");
    expect(reviewerCreate![0]).not.toHaveProperty("parentID");
    expect(reviewerCreate![0].permission).toEqual(expect.arrayContaining([
      {permission: "edit", pattern: "*", action: "deny"},
      {permission: "bash", pattern: "*", action: "deny"},
      {permission: "task", pattern: "*", action: "deny"},
      {permission: "openloop_start_goal", pattern: "*", action: "deny"},
      {permission: "openloop_run", pattern: "*", action: "deny"},
    ]));

    const prompts = (client.session.promptAsync as ReturnType<typeof vi.fn>).mock.calls;
    expect(prompts).toHaveLength(2);
    const coderUserMessageID = prompts[0]![0].messageID;
    expect(coderUserMessageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect((client.session.diff as ReturnType<typeof vi.fn>).mock.calls[0]![0].messageID).toBe(coderUserMessageID);
    // Passing a per-prompt tools map would replace the persistent session
    // permission rules in OpenCode 1.18.x, so read-only enforcement must live
    // exclusively on the reviewer root session.
    expect(prompts[1]![0]).not.toHaveProperty("tools");
    // OpenCode 1.18.x accepts json_schema prompts but its message-list route
    // cannot deserialize the stored format. Plain JSON text keeps the reviewer
    // session readable while the strict parser still enforces the contract.
    expect(prompts[1]![0]).not.toHaveProperty("format");
    expect(prompts[1]![0].parts[0].text).toContain("@@ -1 +1 @@");

    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as {rounds: unknown[]};
    expect(state.rounds).toHaveLength(1);
  });

  it("stops with ERROR on malformed reviewer output rather than reporting PASS", async () => {
    const client = mockClient({reviewerStructured: {verdict: "PASS"}});
    const out = await makeRuntime(client).start("goal");
    expect(out.kind).toBe("ERROR");
  });

  it("turns a prompt API failure into an ERROR outcome and remains reusable", async () => {
    const client = mockClient({promptErrorRole: "coder"});
    const rt = makeRuntime(client);
    const first = await rt.start("goal A");
    expect(first.kind).toBe("ERROR");
    expect(rt.status().running).toBe(false);
  });

  it("recovers valid text JSON when session.error reports StructuredOutputError", async () => {
    const reviewerText = JSON.stringify({
      verdict: "PASS", summary: "recovered", findings: [],
      next_coder_prompt: "done", research: {performed: false},
    });
    const client = mockClient({
      statusAfterPrompt: "busy",
      reviewerError: {name: "StructuredOutputError", data: {message: "schema retries exhausted"}},
      reviewerStructured: null,
      reviewerText,
    });
    const rt = makeRuntime(client, {turnTimeoutMs: 1_000, pollIntervalMs: 1_000});
    const running = rt.start("goal");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rt.handleEvent({type: "session.idle", properties: {sessionID: "coder-1"}} as never);
    await rt.handleEvent({
      type: "session.error",
      properties: {
        sessionID: "reviewer-1",
        error: {name: "StructuredOutputError", data: {message: "schema retries exhausted", retries: 2}},
      },
    } as never);
    const out = await running;
    expect(out.kind).toBe("PASS");
  });

  it("ignores duplicate completion events for the same turn", async () => {
    const client = mockClient({statusAfterPrompt: "busy"});
    const rt = makeRuntime(client, {turnTimeoutMs: 1_000, pollIntervalMs: 1_000});
    const running = rt.start("goal");
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    await Promise.all([
      rt.handleEvent({type: "session.idle", properties: {sessionID: "coder-1"}} as never),
      rt.handleEvent({type: "session.idle", properties: {sessionID: "coder-1"}} as never),
    ]);
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));
    await Promise.all([
      rt.handleEvent({type: "session.idle", properties: {sessionID: "reviewer-1"}} as never),
      rt.handleEvent({type: "session.idle", properties: {sessionID: "reviewer-1"}} as never),
    ]);
    expect((await running).kind).toBe("PASS");
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale start failure terminate a replacement run", async () => {
    const client = mockClient({statusAfterPrompt: "busy"});
    const agentList = client.app.agents as unknown as ReturnType<typeof vi.fn>;
    const gate = deferred<never>();
    agentList.mockImplementationOnce(() => gate.promise);
    const rt = makeRuntime(client, {turnTimeoutMs: 100_000, pollIntervalMs: 100_000});

    const runA = rt.start("goal A");
    await vi.waitFor(() => expect(agentList).toHaveBeenCalledTimes(1));
    await rt.stop();
    expect((await runA).kind).toBe("ABORTED");

    const runB = rt.start("goal B");
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    gate.reject(new Error("late catalog failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rt.status()).toMatchObject({running: true, phase: "CODER_RUNNING"});
    await rt.stop();
    expect((await runB).kind).toBe("ABORTED");
  });

  it("does not apply a stale diff continuation to a replacement run", async () => {
    const client = mockClient({statusAfterPrompt: "busy"});
    const diff = client.session.diff as unknown as ReturnType<typeof vi.fn>;
    const originalDiff = diff.getMockImplementation()!;
    const gate = deferred<never>();
    diff.mockImplementationOnce(() => gate.promise).mockImplementation(originalDiff);
    const rt = makeRuntime(client, {turnTimeoutMs: 100_000, pollIntervalMs: 100_000});

    const runA = rt.start("goal A");
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    const staleEvent = rt.handleEvent({type: "session.idle", properties: {sessionID: "coder-1"}} as never);
    await vi.waitFor(() => expect(diff).toHaveBeenCalledTimes(1));
    await rt.stop();
    expect((await runA).kind).toBe("ABORTED");

    const runB = rt.start("goal B");
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));
    gate.reject(new Error("late diff failure"));
    await staleEvent;
    expect(rt.status()).toMatchObject({running: true, phase: "CODER_RUNNING"});
    await rt.stop();
    expect((await runB).kind).toBe("ABORTED");
  });

  it("does not let a stale abort continuation abort a replacement run", async () => {
    const client = mockClient({statusAfterPrompt: "busy"});
    const abort = client.session.abort as unknown as ReturnType<typeof vi.fn>;
    const originalAbort = abort.getMockImplementation()!;
    const gate = deferred<never>();
    abort.mockImplementationOnce(() => gate.promise).mockImplementation(originalAbort);
    const rt = makeRuntime(client, {turnTimeoutMs: 20, pollIntervalMs: 100_000});

    const runA = rt.start("goal A");
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    await rt.stop();
    expect((await runA).kind).toBe("ERROR");

    (rt as unknown as {config: {turnTimeoutMs: number}}).config.turnTimeoutMs = 100_000;
    const runB = rt.start("goal B");
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(2));
    gate.resolve(undefined as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rt.status()).toMatchObject({running: true, phase: "CODER_RUNNING"});
    await rt.stop();
    expect((await runB).kind).toBe("ABORTED");
  });

  it("does not let a late coder prompt failure cancel the reviewer turn", async () => {
    const client = mockClient({statusAfterPrompt: "busy"});
    const prompt = client.session.promptAsync as unknown as ReturnType<typeof vi.fn>;
    const originalPrompt = prompt.getMockImplementation()!;
    const gate = deferred<never>();
    prompt.mockImplementationOnce(async (input: unknown) => {
      const result = await originalPrompt(input);
      await gate.promise;
      return result;
    }).mockImplementation(originalPrompt);
    const rt = makeRuntime(client, {turnTimeoutMs: 1_000, pollIntervalMs: 1_000});

    const running = rt.start("goal");
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    await rt.handleEvent({type: "session.idle", properties: {sessionID: "coder-1"}} as never);
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(rt.status()).toMatchObject({running: true, phase: "REVIEWER_RUNNING"});

    gate.reject(new Error("late coder prompt failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rt.status()).toMatchObject({running: true, phase: "REVIEWER_RUNNING"});
    await rt.handleEvent({type: "session.idle", properties: {sessionID: "reviewer-1"}} as never);
    expect((await running).kind).toBe("PASS");
  });

  it("rejects a duplicate session ID instead of collapsing coder and reviewer", async () => {
    const client = mockClient({duplicateSessionID: true});
    const out = await makeRuntime(client).start("goal");
    expect(out.kind).toBe("ERROR");
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(client.session.delete).toHaveBeenCalledTimes(1);
  });

  it("cleans up the coder root when reviewer session creation fails", async () => {
    const client = mockClient();
    // Preserve the successful coder creation as the first call, then fail the
    // reviewer creation on the second call.
    const create = client.session.create as unknown as ReturnType<typeof vi.fn>;
    const originalCreate = create.getMockImplementation()!;
    create.mockReset()
      .mockImplementationOnce(originalCreate)
      .mockRejectedValueOnce(new Error("reviewer create failed"))
      .mockImplementation(originalCreate);
    const out = await makeRuntime(client).start("goal");
    expect(out.kind).toBe("ERROR");
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    expect(client.session.abort).toHaveBeenCalledWith({sessionID: "coder-1"});
    expect(client.session.delete).toHaveBeenCalledWith({sessionID: "coder-1"});
  });

  it("cleans up both roots when read-only tool discovery fails closed", async () => {
    const client = mockClient();
    (client.tool.ids as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: undefined, error: {name: "APIError", data: {message: "tool catalog unavailable"}},
      response: undefined,
    });
    const out = await makeRuntime(client).start("goal");
    expect(out.kind).toBe("ERROR");
    // Tool discovery happens before either root is created, so a fail-closed
    // setup failure leaves no orphan sessions to clean up.
    expect(client.session.create).not.toHaveBeenCalled();
    expect(client.session.abort).not.toHaveBeenCalled();
    expect(client.session.delete).not.toHaveBeenCalled();
  });

  it("fails clearly when the live agent/model catalog cannot be validated", async () => {
    const out = await makeRuntime(mockClient({catalogError: true})).start("goal");
    expect(out.kind).toBe("ERROR");
  });

  it("keeps running and remains reusable when diagnostic state cannot be written", async () => {
    const blockedStateDir = join(dir, "blocked-state");
    writeFileSync(blockedStateDir, "this path is intentionally a file");
    const client = mockClient();
    const config = {
      coderModel: null, reviewerModel: null, coderAgent: "build", reviewerAgent: "build",
      maxRounds: 3, reviewerReadonly: true, turnTimeoutMs: 500, pollIntervalMs: 10,
      projectDir: dir, stateDir: blockedStateDir,
    } as never;
    const rt = new LoopRuntime(config, client, blockedStateDir, new SelectionStore(blockedStateDir));

    expect((await rt.start("goal A")).kind).toBe("PASS");
    expect((await rt.start("goal B")).kind).toBe("PASS");
    await expect(rt.dispose()).resolves.toBeUndefined();
  });

  it("rolls back in-memory selections when persistence fails", async () => {
    const blockedStateDir = join(dir, "blocked-selections");
    writeFileSync(blockedStateDir, "this path is intentionally a file");
    const client = mockClient();
    (client.app.agents as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        {name: "build", mode: "primary", hidden: false, permission: [], options: {}},
        {name: "plan", mode: "primary", hidden: false, permission: [], options: {}},
      ],
      error: undefined, response: undefined,
    });
    const rt = new LoopRuntime({projectDir: dir} as never, client, blockedStateDir, new SelectionStore(blockedStateDir));

    await expect(rt.applySelections({
      coder: {agent: "plan", model: null},
      reviewer: {agent: "build", model: null},
    })).rejects.toThrow();
    expect(rt.getSelections()).toEqual({
      coder: {agent: "build", model: null},
      reviewer: {agent: "build", model: null},
    });
  });

  it("aborts a hung busy turn at the configured timeout", async () => {
    const client = mockClient({statusAfterPrompt: "busy"});
    const out = await makeRuntime(client, {turnTimeoutMs: 30, pollIntervalMs: 10_000}).start("goal");
    expect(out).toMatchObject({kind: "ERROR", error: expect.stringContaining("TimeoutError")});
    expect(client.session.abort).toHaveBeenCalledTimes(1);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as {outcome: unknown};
    expect(state.outcome).toMatchObject({kind: "ERROR", error: expect.stringContaining("TimeoutError")});
  });

  it("completes a watchdog timeout even when the remote abort never responds", async () => {
    const client = mockClient({statusAfterPrompt: "busy"});
    (client.session.abort as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(() => new Promise(() => {}));
    const out = await makeRuntime(client, {turnTimeoutMs: 20, pollIntervalMs: 100_000}).start("goal");
    expect(out.kind).toBe("ERROR");
    expect(client.session.abort).toHaveBeenCalledTimes(1);
  });

  it("recovers when idle is observed before the matching assistant message is visible", async () => {
    const out = await makeRuntime(
      mockClient({assistantDelayMs: 30}),
      {turnTimeoutMs: 500, pollIntervalMs: 5},
    ).start("goal");
    expect(out.kind).toBe("PASS");
  });

  it("keeps the original deadline while retrying an idle session with no response", async () => {
    const client = mockClient({omitAssistant: true});
    const out = await makeRuntime(client, {turnTimeoutMs: 40, pollIntervalMs: 5}).start("goal");
    expect(out.kind).toBe("ERROR");
    expect(client.session.abort).toHaveBeenCalledTimes(1);
  });

  it("fails early when an OpenCode retry is scheduled beyond the turn deadline", async () => {
    const client = mockClient({statusAfterPrompt: "busy"});
    const rt = makeRuntime(client, {turnTimeoutMs: 10_000, pollIntervalMs: 10_000});
    const running = rt.start("goal");
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    await rt.handleEvent({
      type: "session.status",
      properties: {
        sessionID: "coder-1",
        status: {type: "retry", attempt: 2, message: "quota exhausted", next: Date.now() + 60_000},
      },
    } as never);
    expect(await running).toMatchObject({
      kind: "ERROR",
      error: expect.stringContaining("quota exhausted"),
    });
    expect(client.session.abort).toHaveBeenCalledTimes(1);
  });

  it("allows a provider-managed retry that fits within the original deadline", async () => {
    const client = mockClient({statusAfterPrompt: "busy"});
    const rt = makeRuntime(client, {turnTimeoutMs: 10_000, pollIntervalMs: 10_000});
    const running = rt.start("goal");
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    await rt.handleEvent({
      type: "session.status",
      properties: {
        sessionID: "coder-1",
        status: {type: "retry", attempt: 1, message: "temporary rate limit", next: Date.now() + 100},
      },
    } as never);
    expect(rt.status()).toMatchObject({running: true, phase: "CODER_RUNNING"});
    await rt.stop();
    expect((await running).kind).toBe("ABORTED");
  });

  it("stop aborts and resolves immediately without waiting for a later idle event", async () => {
    const client = mockClient({statusAfterPrompt: "busy"});
    const rt = makeRuntime(client, {turnTimeoutMs: 100_000, pollIntervalMs: 100_000});
    const running = rt.start("goal");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rt.stop();
    const out = await running;
    expect(out.kind).toBe("ABORTED");
    expect(client.session.abort).toHaveBeenCalledTimes(1);
  });

  it("stop resolves locally even when the remote abort never responds", async () => {
    const client = mockClient({statusAfterPrompt: "busy"});
    (client.session.abort as unknown as ReturnType<typeof vi.fn>)
      .mockImplementation(() => new Promise(() => {}));
    const rt = makeRuntime(client, {turnTimeoutMs: 100_000, pollIntervalMs: 100_000});
    const running = rt.start("goal");
    await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalledTimes(1));
    await rt.stop();
    expect((await running).kind).toBe("ABORTED");
    expect(client.session.abort).toHaveBeenCalledTimes(1);
  });
});

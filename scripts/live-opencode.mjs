import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {existsSync} from "node:fs";
import {createServer} from "node:http";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {delimiter, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

import {createOpencodeClient} from "@opencode-ai/sdk/v2";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(join(tmpdir(), "openloop-live-"));
const isolatedHome = await mkdtemp(join(tmpdir(), "openloop-live-home-"));
const stateDir = join(fixture, ".opencode-orchestrator");
const markerPath = join(fixture, "openloop-smoke.txt");
const model = {providerID: "openloop-smoke", modelID: "deterministic"};
let openCode;
let modelServer;
let client;
let openCodeVersion = "unknown";
const serverLog = [];
const modelLog = [];
const createdSessionIDs = new Set();

try {
  modelServer = await startModelServer(markerPath, modelLog);
  const modelPort = modelServer.address().port;

  await mkdir(join(fixture, ".opencode", "plugins"), {recursive: true});
  const bundledPlugin = await readFile(join(repository, "packages", "opencode-plugin", "dist", "openloop.js"), "utf8");
  await writeFile(join(fixture, ".opencode", "plugins", "openloop.js"), bundledPlugin, "utf8");
  await writeFile(join(fixture, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: `${model.providerID}/${model.modelID}`,
    small_model: `${model.providerID}/${model.modelID}`,
    provider: {
      "openloop-smoke": {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenLoop deterministic smoke provider",
        options: {
          baseURL: `http://127.0.0.1:${modelPort}/v1`,
          apiKey: "openloop-smoke",
        },
        models: {
          deterministic: {
            name: "Deterministic OpenLoop smoke model",
            tool_call: true,
            temperature: false,
            limit: {context: 32_000, output: 4_000},
          },
        },
      },
    },
  }, null, 2), "utf8");
  await writeFile(join(fixture, "package.json"), JSON.stringify({
    name: "openloop-live-verification-fixture",
    private: true,
    scripts: {
      test: "node -e \"console.log('reviewer-live-test-ok')\"",
      typecheck: "node -e \"console.log('reviewer-live-typecheck-ok')\"",
    },
  }, null, 2), "utf8");
  await writeFile(markerPath, "baseline\n", "utf8");
  initializeGitRepository(fixture);

  const isolatedConfig = join(isolatedHome, "config");
  await mkdir(isolatedConfig, {recursive: true});
  const openCodeBin = openCodeExecutable();
  try {
    const packageJson = JSON.parse(await readFile(resolve(dirname(openCodeBin), "..", "package.json"), "utf8"));
    if (typeof packageJson.version === "string") openCodeVersion = packageJson.version;
  } catch {}
  process.stdout.write(`Starting isolated OpenCode ${openCodeVersion} from ${openCodeBin}\n`);
  const started = await startOpenCode(
    openCodeBin,
    fixture,
    isolatedConfig,
    `http://127.0.0.1:${modelPort}`,
    serverLog,
  );
  openCode = started.process;
  client = started.client;
  const toolIDs = started.toolIDs;
  for (const id of ["openloop_verify", "openloop_run", "openloop_start_goal", "openloop_status", "openloop_stop", "openloop_setup", "openloop_config"]) {
    assert(toolIDs.includes(id), `project-local plugin did not register ${id}`);
  }
  const resolvedConfig = unwrap(await withDeadline(client.config.get({directory: fixture}), 30_000, "resolved config"), "resolved config");
  assert.equal(
    resolvedConfig.command?.OpenLoop?.template?.includes("$ARGUMENTS"),
    true,
    "plugin did not register the /OpenLoop command template",
  );
  assert.equal(resolvedConfig.command?.OpenLoop?.agent, "build", "/OpenLoop command must activate the build agent");
  const configuredProviders = unwrap(await withDeadline(client.config.providers({directory: fixture}), 30_000, "configured providers"), "configured providers");
  const smokeProvider = configuredProviders.providers.find((provider) => provider.id === model.providerID);
  assert(
    resolvedConfig.provider?.[model.providerID] && smokeProvider?.models[model.modelID],
    `deterministic model missing from active config: providers=${configuredProviders.providers.map((provider) => provider.id).join(",")}`,
  );

  const control = unwrap(await client.session.create({title: "OpenLoop command smoke"}), "control session");
  createdSessionIDs.add(control.id);
  const commandArguments = `Builder=${model.providerID}/${model.modelID} & Reviewer=${model.providerID}/${model.modelID} [Create and then correctly repair the smoke marker.]`;
  unwrap(await withDeadline(client.session.command({
    sessionID: control.id,
    command: "OpenLoop",
    arguments: commandArguments,
    model: `${model.providerID}/${model.modelID}`,
  }), 30_000, "/OpenLoop command"), "/OpenLoop command");
  const outcome = await withDeadline(waitForOutcome(join(stateDir, "state.json")), 120_000, "live loop");
  assert.deepEqual(outcome, {
    kind: "PASS",
    rounds: 2,
    finalSummary: "Independent test and typecheck scripts passed; the round-two repair is correct.",
  });

  const sessions = unwrap(await client.session.list(), "session list");
  const coder = sessions.find((session) => session.title === "CODER (openloop)");
  const reviewer = sessions.find((session) => session.title === "REVIEWER (openloop)");
  assert(coder && reviewer, "coder and reviewer root sessions were not both created");
  createdSessionIDs.add(coder.id);
  createdSessionIDs.add(reviewer.id);
  assert.notEqual(coder.id, reviewer.id, "coder and reviewer must use different sessions");
  assert.equal(coder.parentID, undefined, "coder session must be a root");
  assert.equal(reviewer.parentID, undefined, "reviewer session must be a root");

  const reviewerDetails = unwrap(await client.session.get({sessionID: reviewer.id}), "reviewer session");
  const denied = new Set((reviewerDetails.permission ?? [])
    .filter((rule) => rule.action === "deny" && rule.pattern === "*")
    .map((rule) => rule.permission));
  for (const permission of ["edit", "write", "apply_patch", "bash", "task", "openloop_start_goal", "openloop_run"]) {
    assert(denied.has(permission), `reviewer lost read-only deny for ${permission}`);
  }
  assert(!denied.has("openloop_verify"), "reviewer verification tool was incorrectly denied");

  const coderMessages = unwrap(await client.session.messages({sessionID: coder.id}), "coder messages");
  const reviewerMessages = unwrap(await client.session.messages({sessionID: reviewer.id}), "reviewer messages");
  assert.equal(coderMessages.filter((message) => message.info.role === "user").length, 2);
  assert.equal(reviewerMessages.filter((message) => message.info.role === "user").length, 2);
  const coderText = messageText(coderMessages);
  assert(coderText.includes("Independent review guidance") && coderText.includes("round-two-fixed"), "review findings did not reach the coder");
  assert(messageText(reviewerMessages).includes("openloop-smoke.txt"), "coder diff did not reach the reviewer");
  assert.equal(
    modelLog.filter((entry) => entry === "MODEL_CALL openloop_verify").length,
    2,
    "reviewer did not independently invoke openloop_verify exactly once in each round",
  );
  assert.equal(await readFile(markerPath, "utf8"), "round-two-fixed\n");

  const persisted = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
  assert.equal(persisted.coderSessionID, coder.id);
  assert.equal(persisted.reviewerSessionID, reviewer.id);
  assert.equal(persisted.rounds.length, 2);
  assert.equal(persisted.rounds[0].verdict, "CHANGES_REQUIRED");
  assert.equal(persisted.rounds[1].verdict, "PASS");
  assert.deepEqual(persisted.outcome, outcome);

  process.stdout.write(`Live OpenCode ${openCodeVersion} integration passed: ${coder.id} -> ${reviewer.id}, two rounds, PASS.\n`);
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  if (modelLog.length) process.stderr.write(`\nModel endpoint log:\n${modelLog.join("\n")}\n`);
  if (serverLog.length) process.stderr.write(`\nOpenCode server log:\n${serverLog.join("")}\n`);
  process.exitCode = 1;
} finally {
  if (client) {
    // Cleanup is deliberately restricted to IDs persisted by this temporary
    // run. Never enumerate and delete the user's unrelated OpenCode sessions.
    try {
      const state = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
      if (typeof state.coderSessionID === "string") createdSessionIDs.add(state.coderSessionID);
      if (typeof state.reviewerSessionID === "string") createdSessionIDs.add(state.reviewerSessionID);
    } catch {}
    for (const sessionID of createdSessionIDs) {
      await settleWithin(client.session.delete({sessionID}), 1_000);
    }
  }
  if (openCode && openCode.exitCode === null) openCode.kill();
  if (modelServer) {
    modelServer.closeAllConnections?.();
    await settleWithin(new Promise((resolveClose) => modelServer.close(resolveClose)), 2_000);
  }
  await rm(fixture, {recursive: true, force: true}).catch(() => {});
  await rm(isolatedHome, {recursive: true, force: true}).catch(() => {});
}

function messageText(messages) {
  return messages.flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function initializeGitRepository(directory) {
  execFileSync("git", ["init"], {cwd: directory, stdio: "ignore", windowsHide: true});
  execFileSync("git", ["config", "user.email", "openloop-smoke@example.invalid"], {cwd: directory, stdio: "ignore", windowsHide: true});
  execFileSync("git", ["config", "user.name", "OpenLoop Smoke"], {cwd: directory, stdio: "ignore", windowsHide: true});
  execFileSync("git", ["add", "."], {cwd: directory, stdio: "ignore", windowsHide: true});
  execFileSync("git", ["commit", "-m", "smoke baseline"], {cwd: directory, stdio: "ignore", windowsHide: true});
}

function openCodeExecutable() {
  if (process.env.OPENLOOP_OPENCODE_BIN) return resolve(process.env.OPENLOOP_OPENCODE_BIN);
  if (process.platform === "win32" && process.env.APPDATA) {
    // npm exec prepends <cache>/node_modules/.bin. Prefer its exact package
    // binary so the harness can verify a requested OpenCode version without
    // changing the user's global installation.
    for (const entry of (process.env.PATH ?? "").split(delimiter)) {
      const candidate = resolve(entry, "..", "opencode-ai", "bin", "opencode.exe");
      if (existsSync(candidate)) return candidate;
    }
    const globalBinary = join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    if (existsSync(globalBinary)) return globalBinary;
  }
  return "opencode";
}

async function startOpenCode(openCodeBin, projectDirectory, isolatedConfig, modelsURL, aggregateLog) {
  const attempts = process.platform === "win32" ? 2 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await reservePort();
    const attemptLog = [];
    let retainLiveLog = false;
    const child = spawn(openCodeBin, [
      "serve", "--hostname", "127.0.0.1", "--port", String(port),
      "--print-logs", "--log-level", "DEBUG",
    ], {
      cwd: projectDirectory,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: isolatedConfig,
        XDG_DATA_HOME: join(isolatedHome, "data"),
        XDG_CACHE_HOME: join(isolatedHome, "cache"),
        XDG_STATE_HOME: join(isolatedHome, "state"),
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        // Keep the live test deterministic and offline. Current OpenCode
        // otherwise contacts models.dev during project bootstrap even though
        // this fixture declares its complete provider catalog locally.
        OPENCODE_MODELS_URL: modelsURL,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = (chunk) => {
      const value = chunk.toString();
      attemptLog.push(value);
      if (retainLiveLog) aggregateLog.push(value);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const earlyExit = new Promise((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`OpenCode exited early (${code})`)));
    });
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await Promise.race([waitForServer(baseUrl), earlyExit]);
      const attemptClient = createOpencodeClient({baseUrl, directory: projectDirectory});
      // OpenCode has an acknowledged intermittent Windows project/plugin
      // bootstrap hang. Retry the isolated server rather than allowing one
      // stuck process to make the test nondeterministic.
      const toolIDs = unwrap(
        await withDeadline(attemptClient.tool.ids(), 60_000, `tool catalog (startup ${attempt})`),
        "tool catalog",
      );
      aggregateLog.push(`\n--- OpenCode startup ${attempt} ---\n`, ...attemptLog);
      retainLiveLog = true;
      return {process: child, client: attemptClient, toolIDs};
    } catch (error) {
      lastError = error;
      aggregateLog.push(`\n--- OpenCode startup ${attempt} failed ---\n`, ...attemptLog);
      await stopChild(child);
      if (attempt < attempts) {
        process.stderr.write(`OpenCode startup ${attempt} stalled; retrying with a fresh isolated server.\n`);
      }
    }
  }
  throw new Error(`OpenCode did not complete project/plugin bootstrap after ${attempts} attempt(s): ${lastError?.message ?? lastError}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await settleWithin(exited, 2_000);
}

function unwrap(response, context) {
  if (response?.error !== undefined) throw new Error(`${context}: ${JSON.stringify(response.error)}`);
  if (response?.data === undefined) throw new Error(`${context}: unexpected response`);
  return response.data;
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/global/health`, {signal: AbortSignal.timeout(500)});
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("timed out waiting for OpenCode server");
}

async function withDeadline(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForOutcome(statePath) {
  for (;;) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      if (state.outcome) return state.outcome;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => null),
      new Promise((resolveWait) => {
        timer = setTimeout(() => resolveWait(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => server.listen(0, "127.0.0.1", resolveListen).once("error", reject));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function startModelServer(outputPath, requests) {
  const server = createServer(async (request, response) => {
    if (requests.length < 20) requests.push(`${request.method} ${request.url}`);
    if (request.method === "GET" && request.url === "/api.json") {
      return json(response, {});
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(response, {object: "list", data: [{id: "deterministic", object: "model", owned_by: "openloop"}]});
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = JSON.parse(await readBody(request));
      const messages = body.messages ?? [];
      if (requests.length <= 12) {
        requests.push(JSON.stringify(messages.slice(-4).map((message) => ({
          role: message.role,
          name: message.name,
          tool_call_id: message.tool_call_id,
          tools: message.tool_calls?.map((call) => call.function?.name),
          content: contentText(message).slice(0, 120),
        }))));
      }
      const latestUser = [...messages].reverse().find((message) => message.role === "user");
      const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
      const verificationCalled = messages.slice(latestUserIndex + 1).some((message) =>
        message.role === "assistant"
        && message.tool_calls?.some((call) => call.function?.name === "openloop_verify"),
      );
      const latestTool = messages.at(-1)?.role === "tool";
      const reviewer = /^# Goal under review/m.test(contentText(latestUser));
      const openLoopCommand = /Call openloop_run exactly once/.test(contentText(latestUser));

      let payload;
      if (openLoopCommand && !latestTool) {
        const spec = /Builder=[\s\S]*$/m.exec(contentText(latestUser))?.[0]?.trim();
        if (!spec) throw new Error("/OpenLoop command template did not preserve $ARGUMENTS");
        payload = toolCall("openloop_run", {spec});
      } else if (reviewer && !verificationCalled) {
        requests.push("MODEL_CALL openloop_verify");
        payload = toolCall("openloop_verify", {checks: ["test", "typecheck"]});
      } else if (reviewer) {
        const verificationOutput = contentText(messages.at(-1));
        if (!verificationOutput.includes("reviewer-live-test-ok")
          || !verificationOutput.includes("reviewer-live-typecheck-ok")) {
          throw new Error("reviewer did not receive both independent verification results");
        }
        const round = Number(/round\s+(\d+)/i.exec(contentText(latestUser))?.[1] ?? 1);
        const verdict = round === 1 ? {
          verdict: "CHANGES_REQUIRED",
          summary: "The round-one marker is incomplete.",
          findings: [{
            severity: "medium",
            location: "openloop-smoke.txt:1",
            problem: "The round-one marker is incomplete.",
            impact: "The requested repair has not been completed.",
            recommended_fix: "Replace it with the verified round-two marker.",
            verification: "Read openloop-smoke.txt and confirm its exact contents.",
          }],
          next_coder_prompt: "Verify the finding, then replace openloop-smoke.txt with exactly round-two-fixed followed by a newline.",
          research: {performed: false},
          future_improvements: [],
        } : {
          verdict: "PASS",
          summary: "Independent test and typecheck scripts passed; the round-two repair is correct.",
          findings: [],
          next_coder_prompt: "",
          research: {performed: false},
          future_improvements: [],
        };
        payload = textCompletion(JSON.stringify(verdict));
      } else if (latestTool) {
        payload = textCompletion("Implemented the requested marker and verified the write tool completed successfully.");
      } else {
        const isFix = /Independent review guidance|round-two-fixed/i.test(contentText(latestUser));
        payload = toolCall("write", {filePath: outputPath, content: isFix ? "round-two-fixed\n" : "round-one\n"});
      }
      sendCompletion(response, payload, body.stream !== false);
    } catch (error) {
      requests.push(`ERROR ${String(error?.stack ?? error)}`);
      json(response, {error: {message: String(error?.message ?? error)}}, 500);
    }
  });
  await new Promise((resolveListen, reject) => server.listen(0, "127.0.0.1", resolveListen).once("error", reject));
  return server;
}

function contentText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((part) => part.text ?? "").join("\n");
  return "";
}

function toolCall(name, args) {
  return {
    finishReason: "tool_calls",
    delta: {
      role: "assistant",
      tool_calls: [{
        index: 0,
        id: `call_${Date.now()}`,
        type: "function",
        function: {name, arguments: JSON.stringify(args)},
      }],
    },
  };
}

function textCompletion(content) {
  return {finishReason: "stop", delta: {role: "assistant", content}};
}

function sendCompletion(response, payload, stream) {
  const id = `chatcmpl_${Date.now()}`;
  const base = {id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "deterministic"};
  if (!stream) {
    json(response, {
      ...base,
      object: "chat.completion",
      choices: [{index: 0, message: payload.delta, finish_reason: payload.finishReason}],
      usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20},
    });
    return;
  }
  response.writeHead(200, {"content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive"});
  response.write(`data: ${JSON.stringify({...base, choices: [{index: 0, delta: payload.delta, finish_reason: null}]})}\n\n`);
  response.write(`data: ${JSON.stringify({...base, choices: [{index: 0, delta: {}, finish_reason: payload.finishReason}], usage: {prompt_tokens: 10, completion_tokens: 10, total_tokens: 20}})}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, body, status = 200) {
  response.writeHead(status, {"content-type": "application/json"});
  response.end(JSON.stringify(body));
}

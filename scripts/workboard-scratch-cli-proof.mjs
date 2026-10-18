#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { GatewayClient } from "../src/gateway/client.ts";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.ts";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.ts";

const repo = process.cwd();
const temp = await mkdtemp(path.join(os.tmpdir(), "workboard-cli-proof-"));
const state = path.join(temp, "state");
const workspace = path.join(temp, "workspace");
const configPath = path.join(state, "openclaw.json");
const gatewayPort = 18789;
const token = `proof-${process.pid}-${Date.now()}`;
let requestResolve;
const captured = new Promise((resolve) => { requestResolve = resolve; });
const provider = createServer(async (req, res) => {
  if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requestResolve(body);
  const message = { type: "message", id: "msg_synthetic", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Synthetic proof complete.", annotations: [] }] };
  const events = [
    { type: "response.output_item.added", item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_item.done", item: message },
    { type: "response.completed", response: { id: "resp_synthetic", status: "completed", output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
});
await new Promise((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
const providerPort = provider.address().port;
const modelRef = "mock-openai/gpt-5.4";
const config = {
  agents: { defaults: { workspace, model: { primary: modelRef }, models: { [modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } }, skipBootstrap: true }, entries: { main: {} } },
  models: { mode: "replace", providers: { "mock-openai": { baseUrl: `http://127.0.0.1:${providerPort}/v1`, apiKey: "test", api: "openai-responses", models: [{ id: "gpt-5.4", name: "gpt-5.4", api: "openai-responses", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }] } } },
  plugins: { allow: ["workboard"], entries: { workboard: { enabled: true } }, load: { paths: [path.join(repo, "extensions/workboard")] } },
  gateway: { mode: "local", bind: "loopback", auth: { mode: "token", token } },
};
await mkdir(state, { recursive: true });
await mkdir(workspace, { recursive: true });
await writeFile(configPath, JSON.stringify(config));

const env = { ...process.env, HOME: temp, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_GATEWAY_TOKEN: token };
const log = [];
let gateway;
let fixtureClient;
function cli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repo, "openclaw.mjs"), ...args], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`CLI timed out: ${args[0]} ${args[1] ?? ""}`)); }, options.timeout ?? 30000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(`CLI failed (${code}): ${args[0]} ${args[1] ?? ""}`)); });
  });
}
function sanitizedGatewayTail() {
  return log.join("").split("\n").slice(-30).map((line) => line
    .replaceAll(token, "[redacted-token]")
    .replaceAll(temp, "[redacted-temp-path]")
    .replaceAll(repo, "[redacted-repo-path]")
    .replaceAll(`http://127.0.0.1:${providerPort}/v1`, "[redacted-loopback-endpoint]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
  ).join("\n");
}
function redactMessage(value) {
  return String(value)
    .replaceAll(token, "[redacted-token]")
    .replaceAll(temp, "[redacted-temp-path]")
    .replaceAll(repo, "[redacted-repo-path]")
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, "[redacted-endpoint]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]");
}
function waitForRequest(ms = 90000) {
  let timer;
  return Promise.race([
    captured,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out waiting for synthetic model request")), ms); }),
  ]).finally(() => clearTimeout(timer));
}
try {
  gateway = spawn(process.execPath, [path.join(repo, "openclaw.mjs"), "gateway", "run", "--port", String(gatewayPort), "--bind", "loopback", "--auth", "token", "--token", token, "--allow-unconfigured"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  gateway.stdout.on("data", (chunk) => log.push(chunk.toString()));
  gateway.stderr.on("data", (chunk) => log.push(chunk.toString()));
  let ready = false;
  const deadline = Date.now() + 90000;
  while (!ready && Date.now() < deadline) {
    if (gateway.exitCode !== null) throw new Error(`CLI Gateway exited before readiness. Sanitized Gateway output:\n${sanitizedGatewayTail()}`);
    try { await cli(["gateway", "call", "health", "--port", String(gatewayPort), "--token", token], { timeout: 5000 }); ready = true; }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  if (!ready) throw new Error(`CLI Gateway readiness timed out. Sanitized Gateway output:\n${sanitizedGatewayTail()}`);
  console.log("CLI proof: repository openclaw.mjs started a separate Gateway process; health RPC succeeded.");
  const createOut = await cli(["workboard", "create", "Synthetic scratch prompt proof", "--status", "ready", "--agent", "main", "--json"]);
  const cardId = JSON.parse(createOut).card.id;
  const retainedPath = path.join(workspace, "synthetic-retained-repository");
  await mkdir(retainedPath, { recursive: true });
  let helloResolve;
  let helloReject;
  const hello = new Promise((resolve, reject) => { helloResolve = resolve; helloReject = reject; });
  fixtureClient = new GatewayClient({
    url: `ws://127.0.0.1:${gatewayPort}`,
    token,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "Workboard scratch fixture setup",
    clientVersion: "source-proof",
    mode: GATEWAY_CLIENT_MODES.CLI,
    role: "operator",
    scopes: ["operator.admin", "operator.write", "operator.read"],
    deviceIdentity: loadOrCreateDeviceIdentity({ path: path.join(state, "proof-device-identity.sqlite") }),
    onHelloOk: () => helloResolve(),
    onConnectError: () => helloReject(new Error("fixture Gateway client connection failed")),
  });
  fixtureClient.start();
  await Promise.race([hello, new Promise((_, reject) => setTimeout(() => reject(new Error("fixture Gateway client readiness timed out")), 15000))]);
  let switched;
  try {
    await fixtureClient.request("workboard.cards.update", { id: cardId, patch: { workspace: { kind: "worktree", path: retainedPath, branch: "main" } } });
    const updateResult = await fixtureClient.request("workboard.cards.update", { id: cardId, patch: { workspace: { kind: "scratch" } } });
    switched = updateResult.card;
  } catch (error) {
    throw new Error(`Gateway Workboard workspace switch failed: ${redactMessage(error)}`);
  }
  await fixtureClient.stopAndWait({ timeoutMs: 5000 });
  fixtureClient = undefined;
  if (switched.metadata?.automation?.workspace?.kind !== "scratch" || switched.metadata?.automation?.workspace?.path !== retainedPath) throw new Error("CLI Gateway did not retain the synthetic path across the scratch switch");
  console.log("CLI proof: Gateway CLI RPC changed workspace from worktree to scratch while retaining stored path metadata.");
  const dispatchPromise = cli(["workboard", "dispatch", "--max-starts", "1", "--url", `ws://127.0.0.1:${gatewayPort}`, "--token", token, "--json"], { timeout: 60000 }).then((output) => {
    const result = JSON.parse(output);
    const startedCount = Array.isArray(result.started) ? result.started.length : 0;
    const failureCount = Array.isArray(result.startFailures) ? result.startFailures.length : 0;
    const failureMessages = Array.isArray(result.startFailures)
      ? result.startFailures.slice(0, 3).map((failure) => redactMessage(failure.error ?? failure.reason ?? "unspecified"))
      : [];
    console.log(JSON.stringify({ dispatchStartedCount: startedCount, dispatchStartFailureCount: failureCount, gatewayUnavailableFallback: result.gatewayUnavailable === true, sanitizedStartFailureMessages: failureMessages }));
    if (startedCount !== 1) throw new Error("official Workboard CLI did not start exactly one worker");
    return output;
  });
  const [dispatchOut, request] = await Promise.all([
    dispatchPromise,
    waitForRequest(),
  ]);
  const dispatched = JSON.parse(dispatchOut);
  if (!Array.isArray(dispatched.started) || dispatched.started.length !== 1) throw new Error("official Workboard CLI did not dispatch one worker");
  const serialized = JSON.stringify(request);
  if (!serialized.includes("Workspace: scratch")) throw new Error("WORKBOARD_SCRATCH_CONTEXT_MISSING");
  const retainedPathPresent = serialized.includes(retainedPath);
  const expected = process.env.WORKBOARD_PROOF_EXPECTED ?? "candidate";
  if (expected === "baseline" && !retainedPathPresent) throw new Error("BASELINE_DID_NOT_REPRODUCE_RETAINED_PATH");
  if (expected === "candidate" && retainedPathPresent) throw new Error("WORKBOARD_SCRATCH_RETAINED_PATH_PRESENT");
  console.log("CLI proof: official openclaw workboard dispatch started one worker; loopback model stub captured its request.");
  console.log(JSON.stringify({ expected, workerContext: "Workspace: scratch", syntheticRetainedPathPresent: retainedPathPresent, modelService: "local loopback stub; no external provider call", model: request.model }));
} finally {
  if (fixtureClient) await fixtureClient.stopAndWait({ timeoutMs: 5000 }).catch(() => {});
  if (gateway && gateway.exitCode === null) { gateway.kill("SIGTERM"); await Promise.race([once(gateway, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]); }
  provider.closeAllConnections();
  if (provider.listening) await new Promise((resolve) => provider.close(resolve));
  await rm(temp, { recursive: true, force: true });
}

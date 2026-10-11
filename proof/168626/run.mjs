// Static preparation only on Air. Run exclusively in parent-approved secretless Linux isolation.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseline = "ec9db387c421e0f9a330d862ea3fe5170bf01a8e";
const [expected, outputArg, expectedSha] = process.argv.slice(2);
if (process.platform !== "linux" || process.env.CI !== "true" ||
    !["baseline", "fixed"].includes(expected) || !outputArg || !/^[a-f0-9]{40}$/.test(expectedSha ?? "")) {
  throw new Error("Usage inside secretless Linux CI: node proof/168626/run.mjs baseline|fixed NEW_OUTPUT_DIR EXPECTED_SHA");
}
const bundle = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(bundle, "../..");
const actualSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
assert.equal(actualSha, expectedSha);
if (expected === "baseline") assert.equal(actualSha, baseline);
assert.equal(execFileSync("git", ["diff", "HEAD", "--", "src", "packages", "extensions"],
  { cwd: repo, encoding: "utf8" }), "", "Production source must match the recorded commit");
assert.ok(fs.existsSync(path.join(repo, "dist/index.js")), "Build the exact SHA in isolation first");
const out = path.resolve(outputArg);
fs.mkdirSync(out); // Refuse reuse so old state/logs cannot satisfy assertions.
const save = (name, value) => fs.writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}
`);
const started = Date.now();
const summary = { expected, baseline, actualSha, node: process.version,
  startedUtc: new Date().toISOString(), status: "not-completed", cases: [] };
const dirs = Object.fromEntries(["home", "state", "workspace", "tmp"].map((key) => {
  const value = path.join(out, key); fs.mkdirSync(value); return [key, value];
}));
const token = `disposable-${randomUUID()}`;
const hookLog = path.join(out, "hook.jsonl");
const readHooks = () => fs.existsSync(hookLog)
  ? fs.readFileSync(hookLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const configText = fs.readFileSync(path.join(bundle, "config.template.json"), "utf8");
const values = { __TOKEN__: token, __WORKSPACE__: dirs.workspace, __PLUGIN__: path.join(bundle, "plugin"),
  __HOOK_LOG__: hookLog, __GATEWAY_LOG__: path.join(out, "gateway.log") };
const config = JSON.parse(configText, (_key, value) =>
  typeof value === "string" && Object.hasOwn(values, value) ? values[value] : value);
save("config.json", config);
// This allowlist contains no host auth, SSH sockets, proxy credentials or runtime injections.
const childEnv = { PATH: `${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  HOME: dirs.home, XDG_CONFIG_HOME: path.join(dirs.home, ".config"),
  XDG_CACHE_HOME: path.join(dirs.home, ".cache"), TMPDIR: dirs.tmp,
  OPENCLAW_STATE_DIR: dirs.state, OPENCLAW_CONFIG_PATH: path.join(out, "config.json"),
  NODE_ENV: "production", CI: "true", NO_COLOR: "1" };
save("environment-keys.json", Object.keys(childEnv));
const providerRequests = [];
const provider = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const marker = body.match(/S168626:[a-f0-9-]+:(silent|visible|model-visible|model-silent)/)?.[0];
  const observed = { method: req.method, url: req.url, marker: marker ?? null };
  providerRequests.push(observed);
  if (req.method !== "POST" || req.url !== "/v1/chat/completions" || !marker) {
    res.writeHead(400).end("Unexpected proof provider request"); return;
  }
  const text = marker.endsWith(":model-silent") ? "NO_REPLY" : `MODEL_VISIBLE ${marker}`;
  observed.responseText = text;
  const payload = JSON.parse(body);
  const common = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: "proof-model" };
  if (!payload.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...common, object: "chat.completion", choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })); return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const choice of [
    { index: 0, delta: { role: "assistant", content: text }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: "stop" },
  ]) res.write(`data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [choice] })}

`);
  res.end("data: [DONE]\n\n");
});
let gateway, socket, watchdog;
let closed = false;
const pending = new Map();
const frames = [];
const eventWaiters = new Set();
function failWaiters(error) {
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
  pending.clear();
  for (const waiter of eventWaiters) { clearTimeout(waiter.timer); waiter.reject(error); }
  eventWaiters.clear();
}
function waitEvent(predicate, milliseconds = 120000) {
  const existing = frames.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, reject, timer: setTimeout(() => {
      eventWaiters.delete(waiter); reject(new Error("Gateway event deadline exceeded"));
    }, milliseconds) };
    eventWaiters.add(waiter);
  });
}
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} deadline exceeded`)); }, 120000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ type: "req", id, method, params }));
  });
}
async function call(method, params) {
  const frame = await rpc(method, params);
  assert.equal(frame.ok, true, `${method}: ${JSON.stringify(frame.error)}`);
  return frame.payload;
}
try {
  provider.listen(18800, "127.0.0.1");
  await once(provider, "listening");
  const stdout = fs.openSync(path.join(out, "gateway.stdout.log"), "w");
  const stderr = fs.openSync(path.join(out, "gateway.stderr.log"), "w");
  const args = [path.join(repo, "openclaw.mjs"), "gateway", "run", "--allow-unconfigured"];
  gateway = spawn(process.execPath, args, { cwd: repo, env: childEnv, stdio: ["ignore", stdout, stderr], detached: true });
  fs.closeSync(stdout); fs.closeSync(stderr);
  save("launch.json", { executable: process.execPath, args, pid: gateway.pid });
  gateway.on("error", (error) => failWaiters(error));
  gateway.on("exit", (code, signal) => {
    if (!closed) failWaiters(new Error(`Gateway exited early: ${code}/${signal}`));
  });
  watchdog = setTimeout(() => { try { process.kill(-gateway.pid, "SIGKILL"); } catch {} }, 600000);
  // External process readiness probe only, never retry the user operation or its assertion.
  const deadline = Date.now() + 120000;
  while (true) {
    if (gateway.exitCode !== null || gateway.signalCode !== null) throw new Error("Gateway startup failed; inspect logs");
    const ready = await fetch("http://127.0.0.1:18799/readyz", { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (ready?.ok) { save("readiness.json", await ready.json()); break; }
    if (Date.now() >= deadline) throw new Error("Gateway readiness deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  socket = new WebSocket("ws://127.0.0.1:18799");
  socket.addEventListener("error", () => failWaiters(new Error("Gateway WebSocket error")));
  socket.addEventListener("close", () => { if (!closed) failWaiters(new Error("Gateway WebSocket closed")); });
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(String(data));
    // Never retain hello auth/device tokens. All other data is synthetic proof data.
    if (frame.type === "res" && frame.payload?.type === "hello-ok") {
      frames.push({ ...frame, payload: { type: "hello-ok", protocol: frame.payload.protocol,
        server: frame.payload.server, auth: { scopes: frame.payload.auth?.scopes } } });
    } else frames.push(frame);
    if (frame.type === "res") {
      const waiter = pending.get(frame.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(frame.id); waiter.resolve(frame); }
    }
    for (const waiter of eventWaiters) if (waiter.predicate(frame)) {
      clearTimeout(waiter.timer); eventWaiters.delete(waiter); waiter.resolve(frame);
    }
  });
  await waitEvent((f) => f.type === "event" && f.event === "connect.challenge", 30000);
  const hello = await call("connect", { minProtocol: 4, maxProtocol: 4,
    client: { id: "cli", version: "168626-proof", platform: "linux", mode: "cli" },
    role: "operator", scopes: ["operator.admin", "operator.read", "operator.write"],
    auth: { token }, caps: [] });
  assert.ok(hello.auth.scopes.includes("operator.write"), "No write authority was granted");
  const inspection = await call("plugins.inspect", { pluginId: "silent-claim-proof" });
  save("plugin-inspection.json", inspection);
  assert.equal(inspection.plugin.id, "silent-claim-proof");
  assert.equal(inspection.plugin.enabled, true);
  assert.ok(readHooks().some((row) => row.kind === "registered"), "Fixture never registered");

  // Controls run first; a broken model fixture cannot be called a silent-claim regression.
  for (const mode of ["visible", "model-visible", "model-silent", "silent"]) {
    const marker = `S168626:${randomUUID()}:${mode}`;
    const created = await call("sessions.create", { agentId: "proof", displayName: marker });
    assert.ok(created.key && !created.key.endsWith(":main"), "Expected explicit non-main session");
    const request = { sessionKey: created.key, message: marker, idempotencyKey: randomUUID() };
    const initial = await rpc("chat.send", request);
    assert.equal(initial.ok, true, `chat.send admission failed: ${JSON.stringify(initial.error)}`);
    const runId = initial.payload.runId;
    assert.ok(runId, "Missing admitted run identity");
    const terminal = await waitEvent((f) => f.type === "event" && f.event === "chat" &&
      f.payload?.runId === runId && ["final", "error", "aborted"].includes(f.payload.state));
    const replay = await rpc("chat.send", request);
    const history = await call("chat.history", { sessionKey: created.key, limit: 100 });
    const hooks = readHooks().filter((row) => row.kind === "hook-return" && row.marker === marker);
    const modelCalls = providerRequests.filter((row) => row.marker === marker);
    const result = { mode, marker, sessionKey: created.key, initial, terminal, replay, history, hooks, modelCalls };
    summary.cases.push(result); save("summary.json", summary);
    assert.equal(hooks.length, 1, "Hook must run once, including replay");
    assert.equal(hooks[0].sessionKey, created.key, "Hook belongs to another session");
    assert.equal(hooks[0].agentId, "proof");
    const users = history.messages.filter((m) => m.role === "user" && JSON.stringify(m.content).includes(marker));
    assert.equal(users.length, 1, "Original user turn must remain exactly once");
    if (mode === "silent" || mode === "visible") {
      assert.equal(modelCalls.length, 0, "A claimed turn reached the model");
      assert.deepEqual(hooks[0].result, mode === "silent" ? { handled: true }
        : { handled: true, reply: { text: `CLAIM_VISIBLE ${marker}` } });
    } else {
      assert.equal(hooks[0].result, null, "Control hook must decline");
      assert.ok(modelCalls.length > 0, "Model control never reached its HTTP boundary");
    }
    const missingExpected = mode === "model-silent" || (mode === "silent" && expected === "baseline");
    if (missingExpected) {
      assert.equal(terminal.payload.state, "error");
      assert.equal(replay.ok, false);
      assert.equal(replay.error?.code, "UNAVAILABLE");
      assert.match(replay.error.message, /did not produce a visible reply/);
    } else {
      assert.equal(terminal.payload.state, "final");
      assert.equal(replay.ok, true);
      if (mode === "silent") assert.equal(history.messages.filter((m) => m.role === "assistant").length, 0);
    }
    if (mode === "model-visible") assert.ok(JSON.stringify(history).includes(`MODEL_VISIBLE ${marker}`));
  }
  assert.ok(providerRequests.every((row) => row.marker), "Unexpected background/provider request; inspect evidence");
  summary.status = expected === "baseline" ? "baseline-defect-reproduced" : "candidate-behavior-passed";
} catch (error) {
  summary.status = "proof-failed-not-established";
  summary.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  closed = true;
  clearTimeout(watchdog);
  socket?.close();
  failWaiters(new Error("Proof cleanup"));
  if (gateway?.pid && gateway.exitCode === null && gateway.signalCode === null) {
    const exited = once(gateway, "exit");
    process.kill(-gateway.pid, "SIGTERM");
    const kill = setTimeout(() => { try { process.kill(-gateway.pid, "SIGKILL"); } catch {} }, 15000);
    await exited; clearTimeout(kill);
  }
  provider.closeAllConnections();
  if (provider.listening) await new Promise((resolve) => provider.close(resolve));
  summary.seconds = (Date.now() - started) / 1000;
  save("frames.json", frames); save("provider-requests.json", providerRequests); save("summary.json", summary);
  console.log(JSON.stringify({ status: summary.status, actualSha, seconds: summary.seconds, out }));
}

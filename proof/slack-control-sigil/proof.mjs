// Fork-only manual evidence harness. Never imports target source on the host.
// The model and Slack Web API are external HTTP fixtures; Gateway, routing,
// actual tool execution, renderers and @slack/web-api remain production code.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const BASE = 'ac2c756da388e60a0f473a12a424a7a13358b51b';
const HEAD = 'e68b66b57efbc25dd3698f5cd1877a6607d64521';
const IMAGE = 'node:26.11.1-bookworm@sha256:253729d3f2b77dbab6a5694aa20da4b484bc759bfb7004aa2e0b683c390e825e';
const PNPM_SHA512 = '8f64efa0b792986ca98ae568791bcd7722807e274c4f0c1d9853c62116495c584119db98762a2a5343b1684d361b9ae26fdd16d551666d7635346d3fae830ddd';
const PNPM_NATIVE_SHA512 = 'ElANYUwQuMfWqMJR4m5L5h9zKjvGKcA8hi2put4J1DMx2smVaNGkGnxkgeIYgMjmF7UFxlZDcL4jItkScgsW4A==';
const SELF = fileURLToPath(import.meta.url);
const FIXTURE = '[Hash](#installation) [User](@U0123ABCD) [Broadcast](!channel) [Here](!here) [Docs](https://example.invalid/docs) native <@U0456EFGH> <#C0456EFGH> <!here>.';
const PNPM = '/workspace/.proof-tools/package/bin/pnpm.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Escape runner command delimiters in the serialized bytes, including nested
// diagnostic strings. JSON consumers still recover the original payload text.
const emit = (value) => console.log(JSON.stringify(value)
  .replace(/##\[/g, '\\u0023\\u0023[')
  .replace(/::/g, '\\u003a\\u003a'));
const safeDiagnostic = (text) => text
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/(?:Bearer\s+|\bgh[pousr]_|\bgithub_pat_|\bxox[baprs]-)[A-Za-z0-9_.-]+/gi, '[REDACTED]')
  .replace(/((?:authorization|api[_-]?key|access[_-]?token|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');

async function run(command, args, options = {}) {
  const { timeout = 120_000, label = command, quietFailure = false, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    const chunks = [];
    const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    let bytes = 0;
    const digest = createHash('sha256');
    const capture = (data, stream) => {
      digest.update(data); bytes += data.length;
      if (bytes < 8_000_000) chunks.push(data);
      tails[stream] = Buffer.concat([tails[stream], data]).subarray(-6_000);
    };
    child.stdout.on('data', (data) => capture(data, 'stdout'));
    child.stderr.on('data', (data) => capture(data, 'stderr'));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString();
      if (code !== 0) {
        if (!quietFailure) emit({ proofRecord: true, result: 'command-failure', phase: label, exit: code, signal, logBytes: bytes, logSha256: digest.digest('hex'), diagnosticTail: safeDiagnostic(`stdout:\n${tails.stdout.toString()}\nstderr:\n${tails.stderr.toString()}`) });
        // Build/runtime has no external credentials. Only structured harness
        // records are forwarded; arbitrary target stdout cannot inject Actions commands.
        for (const line of output.split('\n')) {
          try { const record = JSON.parse(line); if (record.proofRecord === true) emit(record); } catch {}
        }
        reject(new Error(`Command failed: ${label}; exit=${code}; signal=${signal}`));
      } else resolve(output);
    });
  });
}

async function host() {
  assert.equal(process.platform, 'linux', 'Host orchestration is CI-only');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.GITHUB_REPOSITORY, 'KhanCold/openclaw');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'slack-boundary-'));
  const cleanEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (args, cwd) => run('/usr/bin/git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: cleanEnv, timeout: 300_000 });
  const records = [];
  const containerName = `slack-boundary-${process.pid}`;
  try {
    const manifest = { workflow: process.env.GITHUB_SHA, harnessSha256: hash(await fs.readFile(SELF)), base: BASE, head: HEAD, image: IMAGE };
    emit(manifest);
    await run('docker', ['pull', IMAGE], { timeout: 300_000 });
    for (const [role, sha, repository] of [['base', BASE, 'openclaw/openclaw'], ['head', HEAD, 'KhanCold/openclaw']]) {
      const source = path.join(temp, role);
      await fs.mkdir(source);
      await git(['init', '--quiet'], source);
      await git(['fetch', '--depth=1', `https://github.com/${repository}.git`, sha], source);
      await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], source);
      assert.equal((await git(['rev-parse', 'HEAD'], source)).trim(), sha);
      const mounts = ['--mount', `type=bind,src=${source},dst=/workspace`, '--mount', `type=bind,src=${source}/.git,dst=/workspace/.git,readonly`, '--mount', `type=bind,src=${path.dirname(SELF)},dst=/proof,readonly`];
      const common = ['run', '--name', containerName, '--rm', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', `${process.getuid()}:${process.getgid()}`, '--pids-limit=1024', '--memory=7g', '--cpus=4', '-w', '/workspace', ...mounts];
      emit({ role, phase: 'install-and-build', sha });
      await run('docker', [...common, IMAGE, 'node', '/proof/proof.mjs', 'build'], { timeout: 2_100_000, label: `${role}-container-build` });
      emit({ role, phase: 'gateway-runtime', sha });
      const output = await run('docker', [...common, '--network=none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=512m,mode=1777', IMAGE, 'node', '/proof/proof.mjs', 'inside', role, sha], { timeout: 300_000 });
      const lines = output.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      const result = lines.find((record) => record.proofRecord === true && record.result === 'completed');
      assert(result, 'No complete runtime proof record');
      assert.equal(result.role, role);
      assert.equal(result.sha, sha);
      assert.equal((await git(['diff', '--name-only', 'HEAD'], source)).trim(), '', 'Build changed tracked source');
      assert.equal((await git(['rev-parse', 'HEAD'], source)).trim(), sha);
      emit(result);
      records.push(result);
      await fs.rm(source, { recursive: true, force: true });
    }
    assert.equal(records.length, 2);
    assert.equal(records[0].verdict, 'baseline-defect-observed');
    assert.equal(records[1].verdict, 'candidate-pass');
    if (process.env.GITHUB_STEP_SUMMARY) {
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Slack serialized payload boundary proof\n\nFrozen baseline defect observed and candidate passed. External model and Slack HTTP fixtures only; no live Slack UI or notification claim.\n\n\`\`\`json\n${JSON.stringify({ manifest, records }, null, 2)}\n\`\`\`\n`);
    }
  } finally {
    // A timeout can kill the Docker client before its container; remove that
    // exact named container before deleting the mounted source directory.
    await run('docker', ['rm', '--force', containerName], { timeout: 30_000, quietFailure: true }).catch(() => {});
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function build() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.cwd(), '/workspace');
  process.env.HOME = '/tmp/proof-build-home';
  await fs.mkdir(process.env.HOME, { recursive: true });
  await fs.mkdir('/workspace/.proof-tools');
  const response = await fetch('https://registry.npmjs.org/pnpm/-/pnpm-12.9.0.tgz');
  assert(response.ok, 'Pinned pnpm download failed');
  const tarball = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha512').update(tarball).digest('hex'), PNPM_SHA512);
  await fs.writeFile('/workspace/.proof-tools/pnpm.tgz', tarball);
  await run('tar', ['-xzf', '/workspace/.proof-tools/pnpm.tgz', '-C', '/workspace/.proof-tools']);
  const nativeResponse = await fetch('https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.9.0.tgz');
  assert(nativeResponse.ok, 'Pinned native pnpm download failed');
  const nativeTarball = Buffer.from(await nativeResponse.arrayBuffer());
  assert.equal(createHash('sha512').update(nativeTarball).digest('base64'), PNPM_NATIVE_SHA512);
  await fs.mkdir('/workspace/.proof-tools/native');
  await fs.writeFile('/workspace/.proof-tools/native.tgz', nativeTarball);
  await run('tar', ['-xzf', '/workspace/.proof-tools/native.tgz', '-C', '/workspace/.proof-tools/native']);
  await fs.copyFile('/workspace/.proof-tools/native/package/pnpm', '/workspace/.proof-tools/package/pnpm-native');
  await fs.chmod('/workspace/.proof-tools/package/pnpm-native', 0o755);
  await fs.mkdir('/workspace/.proof-tools/bin');
  await fs.symlink('../package/pnpm', '/workspace/.proof-tools/bin/pnpm');
  process.env.PATH = `/workspace/.proof-tools/bin:${process.env.PATH}`;
  process.env.CI = 'true';
  await run('node', [PNPM, 'install', '--frozen-lockfile'], { timeout: 900_000, label: 'pnpm-install' });
  // The repository's QA runtime profile builds real JS, plugins, assets and
  // freshness stamps. Declaration/package qualification is outside this proof.
  await run('node', [PNPM, 'build', 'qaRuntime'], { timeout: 1_200_000, label: 'pnpm-build-qaRuntime' });
}

async function listen(handler) {
  const server = http.createServer((req, res) => { Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end('fixture failure'); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const part of req) { size += part.length; assert(size < 4_000_000); chunks.push(part); }
  return Buffer.concat(chunks).toString();
}
function json(res, value) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
async function until(predicate, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
function message(text, phase, id) { return { type: 'message', id, role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text, annotations: [] }] }; }
function sendResponse(res, text, phase, call) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const item = message(text, phase, 'msg_proof');
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
    { type: 'response.output_item.done', output_index: 0, item },
  ];
  if (call) events.push(
    { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: call.id, delta: call.arguments },
    { type: 'response.output_item.done', output_index: 1, item: call },
  );
  events.push({ type: 'response.completed', response: { id: 'resp_proof', status: 'completed', output: call ? [item, call] : [item], usage: { input_tokens: 64, output_tokens: 64, total_tokens: 128, input_tokens_details: { cached_tokens: 0 } } } });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end('data: [DONE]\n\n');
}

async function inside(role, sha) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.cwd(), '/workspace');
  assert.equal(sha, role === 'base' ? BASE : HEAD);
  const root = await fs.mkdtemp('/tmp/slack-state-');
  const captures = [], unexpected = [], modelStages = [];
  let stage = 'reply', toolRequested = false, toolCompleted = false, gateway;
  const logs = [];
  const signingSecret = 'synthetic-local-slack-signing-fixture';
  const slack = await listen(async (req, res) => {
    const method = req.url.split('?')[0].replace(/^\/api\//, '');
    const raw = await body(req);
    const input = req.headers['content-type']?.includes('application/json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
    const channel = input.channel || 'D0123456789';
    switch (method) {
      case 'auth.test': return json(res, { ok: true, user_id: 'U0PROOFBOT', bot_id: 'B0123456789', team_id: 'T0123456789', app_id: 'A0123456789', url: 'https://example.invalid/' });
      case 'users.info': return json(res, { ok: true, user: { id: input.user, name: 'proof-user', real_name: 'Proof User', is_bot: false, profile: { display_name: 'Proof User', real_name: 'Proof User' } } });
      case 'conversations.info': return json(res, { ok: true, channel: { id: channel, name: 'proof-channel', is_im: channel.startsWith('D'), is_channel: channel.startsWith('C'), is_member: true, user: 'U0123PROOF' } });
      case 'conversations.history': case 'conversations.replies': return json(res, { ok: true, messages: [], has_more: false });
      case 'conversations.members': return json(res, { ok: true, members: ['U0123PROOF', 'U0PROOFBOT'], response_metadata: { next_cursor: '' } });
      case 'chat.postMessage': case 'chat.update': {
        const ts = input.ts || `1770000000.${String(captures.length + 1).padStart(6, '0')}`;
        captures.push({ method, channel, text: input.text || '', ts });
        return json(res, { ok: true, channel, ts, message: { text: input.text, ts } });
      }
      case 'chat.delete': case 'reactions.add': case 'reactions.remove':
      case 'assistant.threads.setStatus': case 'assistant.threads.setTitle': case 'assistant.threads.setSuggestedPrompts': return json(res, { ok: true });
      default: unexpected.push(method); res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'unsupported_fixture_method' }));
    }
  });
  const model = await listen(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') return json(res, { object: 'list', data: [{ id: 'gpt-5.6-luna', object: 'model' }] });
    if (req.method !== 'POST' || req.url !== '/v1/responses') { unexpected.push('model-route'); res.writeHead(404); return res.end(); }
    const input = JSON.parse(await body(req));
    modelStages.push(stage);
    if (stage === 'reply') return sendResponse(res, `PROOFREPLY ${FIXTURE}`, 'final_answer');
    if (!toolRequested) {
      assert(input.tools?.some((tool) => tool.name === 'tool_search'), 'Production runtime did not advertise tool_search');
      toolRequested = true;
      return sendResponse(res, `PROOFPROGRESS ${FIXTURE}`, 'commentary', { type: 'function_call', id: 'fc_proof', call_id: 'call_proof', name: 'tool_search', arguments: JSON.stringify({ query: 'read a file', limit: 1 }) });
    }
    assert(input.input?.some((item) => item.type === 'function_call_output' && item.call_id === 'call_proof'), 'No real tool result reached model');
    toolCompleted = true;
    await until(() => captures.some((item) => item.text.includes('PROOFPROGRESS')), 'progress HTTP delivery');
    return sendResponse(res, `PROOFFINAL ${FIXTURE}`, 'final_answer');
  });
  try {
    const config = {
      gateway: { mode: 'local', port: 19241, bind: 'loopback', auth: { mode: 'token', token: 'synthetic-gateway-proof-token' } },
      models: { mode: 'merge', providers: { openai: { baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: { source: 'env', provider: 'default', id: 'OPENAI_API_KEY' }, api: 'openai-responses', agentRuntime: { id: 'openclaw' }, request: { allowPrivateNetwork: true }, models: [{ id: 'gpt-5.6-luna', name: 'gpt-5.6-luna', api: 'openai-responses', agentRuntime: { id: 'openclaw' }, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, contextTokens: 96000, maxTokens: 4096 }] } } },
      agents: { defaults: { workspace: `${root}/workspace`, model: { primary: 'openai/gpt-5.6-luna' }, models: { 'openai/gpt-5.6-luna': { agentRuntime: { id: 'openclaw' }, params: { transport: 'sse', openaiWsWarmup: false } } } } },
      plugins: { enabled: true, allow: ['openai', 'slack'], entries: { slack: { enabled: true }, openai: { enabled: true } } },
      channels: { slack: { enabled: true, mode: 'http', botToken: 'xoxb-synthetic-local-proof', signingSecret, dmPolicy: 'open', allowFrom: ['*'], streaming: { mode: 'progress', progress: { style: 'compact', commentary: true, toolProgress: false } } } },
    };
    await fs.mkdir(`${root}/workspace`);
    await fs.writeFile(`${root}/config.json`, JSON.stringify(config));
    const env = { PATH: `/workspace/.proof-tools/bin:${process.env.PATH}`, HOME: root, OPENCLAW_STATE_DIR: `${root}/state`, OPENCLAW_CONFIG_PATH: `${root}/config.json`, OPENAI_API_KEY: 'synthetic-local-model-fixture', SLACK_API_URL: `http://127.0.0.1:${slack.port}/api/`, CI: 'true' };
    gateway = spawn('node', [PNPM, 'openclaw', 'gateway', 'run', '--port', '19241', '--bind', 'loopback', '--auth', 'token'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    gateway.stdout.on('data', (data) => logs.push(data)); gateway.stderr.on('data', (data) => logs.push(data));
    const signed = async (value) => {
      const payload = JSON.stringify(value), timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${payload}`).digest('hex');
      return fetch('http://127.0.0.1:19241/slack/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature }, body: payload, signal: AbortSignal.timeout(3000) });
    };
    await until(async () => {
      assert.equal(gateway.exitCode, null, 'Gateway exited before readiness');
      try { const response = await signed({ type: 'url_verification', challenge: 'proof-ready' }); return response.ok && (await response.text()).includes('proof-ready'); } catch { return false; }
    }, 'signed Slack endpoint readiness', 150_000);
    await run('node', [PNPM, 'openclaw', 'agent', '--agent', 'main', '--session-id', 'slack-proof-reply', '--message', 'Return the fixture reply.', '--deliver', '--reply-channel', 'slack', '--reply-to', 'channel:C0123456789', '--json'], { env, timeout: 90_000 });
    await until(() => captures.some((item) => item.text.includes('PROOFREPLY')), 'Gateway reply HTTP delivery');
    stage = 'progress';
    const timestamp = `${Math.floor(Date.now() / 1000)}.000001`;
    const response = await signed({ type: 'event_callback', team_id: 'T0123456789', api_app_id: 'A0123456789', event_id: 'EvProofOne', event_time: Math.floor(Date.now() / 1000), event: { type: 'message', channel: 'D0123456789', channel_type: 'im', user: 'U0123PROOF', text: 'Show commentary, search for the read tool, then finish.', ts: timestamp, event_ts: timestamp } });
    assert.equal(response.status, 200, 'Signed inbound event rejected');
    await until(() => captures.some((item) => item.text.includes('PROOFFINAL')), 'inbound final HTTP delivery', 90_000);
    assert(toolRequested && toolCompleted, 'Real tool round trip missing');
    assert.deepEqual(unexpected, [], 'External fixture contract incomplete');
    const selected = [];
    for (const [marker, progress, channel] of [['PROOFREPLY', false, 'C0123456789'], ['PROOFPROGRESS', true, 'D0123456789'], ['PROOFFINAL', false, 'D0123456789']]) {
      const matching = captures.filter((item) => item.text.includes(marker));
      assert(matching.length > 0, `Missing ${marker}`);
      if (!progress) assert(matching.some((item) => item.method === 'chat.postMessage'), 'Final output was not posted');
      for (const capture of matching) {
        assert.equal(capture.channel, channel);
        assert(capture.text.includes('<https://example.invalid/docs|Docs>'), 'Ordinary URL control failed');
        for (const mention of ['<@U0456EFGH>', '<#C0456EFGH>', '<!here>']) {
          const expected = progress ? mention.replace('<', '&lt;').replace('>', '&gt;') : mention;
          assert(capture.text.includes(expected), 'Native mention control failed');
        }
        for (const [label, target] of [['Hash', '#installation'], ['User', '@U0123ABCD'], ['Broadcast', '!channel'], ['Here', '!here']]) {
          if (role === 'base') assert(capture.text.includes(`<${target}|${label}>`), 'Baseline did not exhibit the intended defect');
          else { assert(capture.text.includes(label)); assert(!capture.text.includes(`<${target}|`), 'Candidate generated a control-sigil link'); assert(!capture.text.includes(`](${target})`), 'Candidate left Markdown unrendered'); }
        }
      }
      selected.push(...matching);
    }
    emit({ proofRecord: true, result: 'completed', role, sha, verdict: role === 'base' ? 'baseline-defect-observed' : 'candidate-pass', toolRequested, toolCompleted, modelStages, captures: selected, claim: 'serialized Slack Web API payloads; not live Slack rendering or notifications' });
  } catch (error) {
    // Do not print config, request headers, model inputs, or raw Gateway logs.
    emit({ proofRecord: true, result: 'failed', role, sha, error: String(error.message), stage, toolRequested, toolCompleted, captureMethods: captures.map((item) => item.method), unexpected, gatewayLogBytes: Buffer.concat(logs).length, gatewayLogSha256: hash(Buffer.concat(logs)) });
    throw error;
  } finally {
    if (gateway?.pid) { try { process.kill(-gateway.pid, 'SIGKILL'); } catch {} }
    slack.server.closeAllConnections(); slack.server.close();
    model.server.closeAllConnections(); model.server.close();
  }
}

try {
  if (process.argv[2] === 'build') await build();
  else if (process.argv[2] === 'inside') await inside(process.argv[3], process.argv[4]);
  else { assert.equal(process.argv.length, 2); await host(); }
} catch (error) { console.error(`Proof incomplete: ${error.message}`); process.exitCode = 1; }

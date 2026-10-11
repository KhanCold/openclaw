// Reviewed fork-only orchestration. Target code executes only inside secretless Docker.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'ec9db387c421e0f9a330d862ea3fe5170bf01a8e';
const IMAGE = 'node:26.11.1-bookworm@sha256:253729d3f2b77dbab6a5694aa20da4b484bc759bfb7004aa2e0b683c390e825e';
const PNPM_SHA512 = '8f64efa0b792986ca98ae568791bcd7722807e274c4f0c1d9853c62116495c584119db98762a2a5343b1684d361b9ae26fdd16d551666d7635346d3fae830ddd';
const PNPM_NATIVE_SHA512 = 'ElANYUwQuMfWqMJR4m5L5h9zKjvGKcA8hi2put4J1DMx2smVaNGkGnxkgeIYgMjmF7UFxlZDcL4jItkScgsW4A==';
const SELF = fileURLToPath(import.meta.url);
const PNPM = '/workspace/.proof-tools/package/bin/pnpm.mjs';
const FILES = ['README.md', 'config.template.json', 'plugin/index.mjs', 'plugin/package.json', 'plugin/openclaw.plugin.json', 'run.mjs', 'ci.mjs'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sanitize = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/disposable-[a-f0-9-]+/gi, '[REDACTED_SYNTHETIC_TOKEN]')
  .replace(/synthetic-proof-key/g, '[REDACTED_SYNTHETIC_KEY]')
  .replace(/(?:Bearer\s+|\bgh[pousr]_|\bgithub_pat_|\bxox[baprs]-)[A-Za-z0-9_.-]+/gi, '[REDACTED]')
  .replace(/((?:authorization|api[_-]?key|access[_-]?token|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
const emit = (value) => console.log(JSON.stringify(value).replace(/##\[/g, '\\u0023\\u0023[').replace(/::/g, '\\u003a\\u003a'));
const redact = (value) => {
  if (typeof value === 'string') return sanitize(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, /^(?:token|deviceToken|authorization|apiKey|password|cookie)$/i.test(k) ? '[REDACTED]' : redact(v)]));
  return value;
};
async function command(bin, args, options = {}) {
  const { label = bin, timeout = 120000, log = false, ...spawnOptions } = options;
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    const chunks = { stdout: [], stderr: [] };
    child.stdout.on('data', (b) => chunks.stdout.push(b));
    child.stderr.on('data', (b) => chunks.stderr.push(b));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks.stdout).toString();
      const stderr = Buffer.concat(chunks.stderr).toString();
      if (log || code !== 0) {
        for (const [stream, content] of Object.entries({ stdout, stderr })) {
          // Complete sanitized streams, chunked only for readable CI logging.
          const clean = sanitize(content);
          for (let offset = 0; offset < clean.length; offset += 16000) emit({ proof168626: true, kind: 'command-log', label, stream, offset, text: clean.slice(offset, offset + 16000) });
        }
      }
      emit({ proof168626: true, kind: 'command-exit', label, code, signal, seconds: (Date.now() - started) / 1000,
        stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutSha256: hash(stdout), stderrSha256: hash(stderr) });
      resolve({ code, signal, stdout, stderr });
    });
  });
}
async function checked(bin, args, options) {
  const result = await command(bin, args, options);
  assert.equal(result.code, 0, `Command failed: ${options?.label ?? bin}; signal=${result.signal}`);
  return result.stdout;
}
async function build() {
  assert.equal(process.platform, 'linux'); assert.equal(process.cwd(), '/workspace');
  process.env.HOME = '/tmp/proof-build-home'; await fs.mkdir(process.env.HOME, { recursive: true });
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
  assert.match(pkg.packageManager, /^pnpm@12\.9\.0(?:\+|$)/);
  await fs.mkdir('/workspace/.proof-tools');
  for (const [url, name, encoding, digest] of [
    ['https://registry.npmjs.org/pnpm/-/pnpm-12.9.0.tgz', 'package', 'hex', PNPM_SHA512],
    ['https://registry.npmjs.org/@pnpm/exe.linux-x64/-/exe.linux-x64-12.9.0.tgz', 'native', 'base64', PNPM_NATIVE_SHA512],
  ]) {
    const response = await fetch(url); assert(response.ok, 'Pinned pnpm download failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha512').update(bytes).digest(encoding), digest);
    const archive = `/workspace/.proof-tools/${name}.tgz`; await fs.writeFile(archive, bytes);
    const target = name === 'native' ? '/workspace/.proof-tools/native' : '/workspace/.proof-tools';
    await fs.mkdir(target, { recursive: true }); await checked('tar', ['-xzf', archive, '-C', target]);
  }
  await fs.copyFile('/workspace/.proof-tools/native/package/pnpm', '/workspace/.proof-tools/package/pnpm-native');
  await fs.chmod('/workspace/.proof-tools/package/pnpm-native', 0o755);
  await fs.mkdir('/workspace/.proof-tools/bin'); await fs.symlink('../package/pnpm', '/workspace/.proof-tools/bin/pnpm');
  process.env.PATH = `/workspace/.proof-tools/bin:${process.env.PATH}`; process.env.CI = 'true';
  await checked('node', [PNPM, 'install', '--frozen-lockfile'], { label: 'pnpm-install', timeout: 900000, log: true });
  await checked('node', [PNPM, 'build', 'qaRuntime'], { label: 'pnpm-build-qaRuntime', timeout: 1200000, log: true });
}
async function host() {
  assert.equal(process.platform, 'linux');
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: 'KhanCold/openclaw', GITHUB_REF: 'refs/heads/main' })) assert.equal(process.env[key], expected);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silent-claim-168626-'));
  const source = path.join(temp, 'source'), output = path.join(temp, 'output');
  const cleanEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: temp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (args) => checked('/usr/bin/git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: source, env: cleanEnv, timeout: 300000, label: 'git-' + args[0] });
  const container = `silent-claim-168626-${process.pid}`;
  try {
    await fs.mkdir(source); await fs.mkdir(output);
    const manifest = { proof168626: true, kind: 'manifest', sourceSha: BASE, auxiliarySha: process.env.GITHUB_SHA, image: IMAGE, buildProfile: 'qaRuntime', files: {} };
    for (const file of FILES) manifest.files[file] = hash(await fs.readFile(path.join(path.dirname(SELF), file)));
    emit(manifest);
    await git(['init', '--quiet']); await git(['fetch', '--depth=1', 'https://github.com/openclaw/openclaw.git', BASE]);
    await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD']); assert.equal((await git(['rev-parse', 'HEAD'])).trim(), BASE);
    const bundle = path.join(source, 'proof/168626'); await fs.mkdir(bundle, { recursive: true });
    for (const file of FILES) { const dest = path.join(bundle, file); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.copyFile(path.join(path.dirname(SELF), file), dest); }
    await checked('docker', ['pull', IMAGE], { label: 'docker-pull', timeout: 300000 });
    const common = ['run', '--name', container, '--rm', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', `${process.getuid()}:${process.getgid()}`, '--pids-limit=1024', '--memory=7g', '--cpus=4', '-w', '/workspace'];
    const buildResult = await command('docker', [...common, '--mount', `type=bind,src=${source},dst=/workspace`, '--mount', `type=bind,src=${source}/.git,dst=/workspace/.git,readonly`, '--mount', `type=bind,src=${path.dirname(SELF)},dst=/proof,readonly`, IMAGE, 'node', '/proof/ci.mjs', 'build'], { label: 'isolated-build', timeout: 2200000, log: true });
    assert.equal(buildResult.code, 0, 'Isolated install/build failed; runtime not established');
    assert.equal((await git(['diff', '--name-only', 'HEAD'])).trim(), '', 'Build modified tracked source');
    for (const file of FILES) assert.equal(hash(await fs.readFile(path.join(bundle, file))), manifest.files[file], 'Build modified proof bytes');
    const artifacts = {};
    for (const name of ['dist/index.js', 'dist/entry.js', 'dist/plugin-sdk/plugin-entry.js', 'pnpm-lock.yaml']) artifacts[name] = hash(await fs.readFile(path.join(source, name)));
    emit({ proof168626: true, kind: 'build-provenance', sourceSha: BASE, artifacts, trackedSourceUnchanged: true });
    const runtime = await command('docker', [...common, '--network=none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=512m,mode=1777', '--mount', `type=bind,src=${source},dst=/workspace,readonly`, '--mount', `type=bind,src=${output},dst=/proof-output`, '-e', 'CI=true', IMAGE, 'node', 'proof/168626/run.mjs', 'baseline', '/proof-output/base-run', BASE], { label: 'isolated-runtime', timeout: 720000, log: true });
    const resultDir = path.join(output, 'base-run');
    const names = ['summary.json', 'frames.json', 'provider-requests.json', 'plugin-inspection.json', 'hook.jsonl', 'readiness.json', 'launch.json', 'environment-keys.json', 'gateway.stdout.log', 'gateway.stderr.log', 'gateway.log'];
    let summary;
    for (const name of names) {
      const file = path.join(resultDir, name), stat = await fs.lstat(file).catch(() => null);
      if (!stat) continue; assert(stat.isFile(), 'Evidence must be a regular file');
      const content = await fs.readFile(file, 'utf8');
      const parsed = name.endsWith('.json') ? JSON.parse(content) : name.endsWith('.jsonl') ? content.trim().split('\n').filter(Boolean).map(JSON.parse) : content;
      emit({ proof168626: true, kind: 'artifact', name, bytes: Buffer.byteLength(content), sha256: hash(content), content: redact(parsed) });
      if (name === 'summary.json') summary = parsed;
    }
    assert.equal(runtime.code, 0, 'Runtime/fixture failure; baseline defect not established');
    assert.equal(summary?.actualSha, BASE); assert.equal(summary?.status, 'baseline-defect-reproduced');
    assert.deepEqual(summary.cases.map((c) => c.mode), ['visible', 'model-visible', 'model-silent', 'silent']);
    assert.equal((await git(['diff', '--name-only', 'HEAD'])).trim(), '');
    emit({ proof168626: true, kind: 'completed', sourceSha: BASE, auxiliarySha: process.env.GITHUB_SHA, status: summary.status, seconds: summary.seconds });
  } finally {
    await command('docker', ['rm', '--force', container], { timeout: 30000, label: 'owned-container-cleanup' }).catch(() => {});
    await fs.rm(temp, { recursive: true, force: true });
  }
}
try { if (process.argv[2] === 'build') await build(); else await host(); }
catch (error) { emit({ proof168626: true, kind: 'failure', error: sanitize(String(error.stack ?? error)) }); process.exitCode = 1; }

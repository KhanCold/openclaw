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

const BASE = 'a8a349b15b20240d387770378072c2ca51889596';
const HEAD = 'afc215037f87d26c46ae453bf770f41f8223560f';
const IMAGE = 'node:26.11.1-bookworm@sha256:253729d3f2b77dbab6a5694aa20da4b484bc759bfb7004aa2e0b683c390e825e';
const PNPM_SHA512 = '8f64efa0b792986ca98ae568791bcd7722807e274c4f0c1d9853c62116495c584119db98762a2a5343b1684d361b9ae26fdd16d551666d7635346d3fae830ddd';
const PNPM_NATIVE_SHA512 = 'ElANYUwQuMfWqMJR4m5L5h9zKjvGKcA8hi2put4J1DMx2smVaNGkGnxkgeIYgMjmF7UFxlZDcL4jItkScgsW4A==';
const SELF = fileURLToPath(import.meta.url);
const FIXTURE = 'native <@U0456EFGH> <#C0456EFGH> <!here> <!channel> <!subteam^S123> with `src/one.ts` and [Docs](https://example.invalid/docs) and <https://example.invalid/native|Native>.';
const SCENARIOS = ['compact-default', 'compact-unlabeled', 'inferred-compact', 'card', 'native-card'];
const PNPM = '/workspace/.proof-tools/package/bin/pnpm.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const modelRouteDiagnostic = (req) => {
  // Only named protocol endpoints may appear in logs. Never print query strings,
  // arbitrary URL segments, request headers or request bodies.
  const pathname = new URL(req.url, 'http://fixture.invalid').pathname;
  const knownPaths = ['/v1/responses', '/v1/models', '/v1/embeddings',
    '/v1/chat/completions', '/v1/responses/compact', '/responses', '/models',
    '/embeddings', '/chat/completions', '/responses/compact', '/'];
  return { method: ['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? req.method : 'OTHER',
    path: knownPaths.includes(pathname) ? pathname : '<unrecognized-path>',
    ...(knownPaths.includes(pathname) ? {} : { pathSha256: hash(pathname), pathLength: pathname.length }) };
};
// Escape runner command delimiters in the serialized bytes, including nested
// diagnostic strings. JSON consumers still recover the original payload text.
const emit = (value) => console.log(JSON.stringify(value)
  .replace(/##\[/g, '\\u0023\\u0023[')
  .replace(/::/g, '\\u003a\\u003a'));
const safeDiagnostic = (text) => text.replace(/synthetic-(?:local-slack-signing-fixture|local-model-fixture|gateway-proof-token)/g, '[REDACTED_SYNTHETIC]')
  .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/(?:Bearer\s+|\bgh[pousr]_|\bgithub_pat_|\bxox[baprs]-)[A-Za-z0-9_.-]+/gi, '[REDACTED]')
  .replace(/((?:authorization|api[_-]?key|access[_-]?token|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
const flushOutput = () => Promise.all([process.stdout, process.stderr]
  .map((stream) => new Promise((resolve) => stream.write('', resolve))));
function slackMrkdwnFields(input) {
  const blocks = typeof input.blocks === 'string' ? JSON.parse(input.blocks) : input.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return input.mrkdwn === false || input.mrkdwn === 'false' ? [] : [{ surface: 'text', text: input.text || '' }];
  }
  const fields = [];
  const add = (value, surface) => {
    if (value?.type === 'mrkdwn' && typeof value.text === 'string') fields.push({ surface, text: value.text });
  };
  for (const [index, block] of blocks.entries()) {
    add(block.text, `blocks[${index}].text`);
    for (const key of ['fields', 'elements']) {
      if (Array.isArray(block[key])) block[key].forEach((value, item) => add(value, `blocks[${index}].${key}[${item}]`));
    }
  }
  return fields;
}

async function run(command, args, options = {}) {
  const { timeout = 120_000, label = command, quietFailure = false, allowedExitCodes = [0], log = false, ...spawnOptions } = options;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    const chunks = { stdout: [], stderr: [] };
    child.stdout.on('data', (data) => chunks.stdout.push(data));
    child.stderr.on('data', (data) => chunks.stderr.push(data));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = Object.fromEntries(Object.entries(chunks).map(([key, parts]) => [key, Buffer.concat(parts).toString()]));
      if (log || (!allowedExitCodes.includes(code) && !quietFailure)) {
        for (const [stream, raw] of Object.entries(output)) {
          const text = safeDiagnostic(raw);
          for (let offset = 0; offset < text.length; offset += 16000) emit({ proofRecord: true, result: 'command-log', label, stream, offset, text: text.slice(offset, offset + 16000) });
        }
      }
      emit({ proofRecord: true, result: 'command-exit', label, code, signal, wallMs: Date.now() - started,
        streams: Object.fromEntries(Object.entries(output).map(([key, raw]) => [key, { bytes: Buffer.byteLength(raw), sha256: hash(raw) }])) });
      if (!allowedExitCodes.includes(code)) reject(new Error(`Command failed: ${label}; exit=${code}; signal=${signal}`));
      else resolve(output.stdout);
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
  const records = [], sdkRecords = [], qualified = [], requiredFailures = [];
  const gib = 1024 ** 3;
  const hostMemoryBytes = os.totalmem();
  const checkMemoryBytes = Math.floor(Math.min(7 * gib, hostMemoryBytes - 3 * gib));
  assert(checkMemoryBytes >= 7 * gib, 'Runner cannot provide the required check budget while reserving host memory');
  emit({ proofRecord: true, result: 'runner-resource-budget', hostMemoryBytes, checkMemoryBytes,
    hostReserveBytes: hostMemoryBytes - checkMemoryBytes, concurrentContainers: 1 });
  const stableDiffArgs = ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD'];
  const containerName = `slack-boundary-${process.pid}`;
  try {
    const manifest = { workflow: process.env.GITHUB_SHA, harnessSha256: hash(await fs.readFile(SELF)), integrityReporterSha256: hash(await fs.readFile(path.join(path.dirname(SELF), 'integrity-reporter.mjs'))), base: BASE, head: HEAD, image: IMAGE };
    emit(manifest);
    await run('docker', ['pull', IMAGE], { timeout: 300_000 });
    for (const [role, sha, repository] of [['base', BASE, 'openclaw/openclaw'], ['head', HEAD, 'KhanCold/openclaw']]) {
      const source = path.join(temp, role);
      await fs.mkdir(source);
      await git(['init', '--quiet'], source);
      await git(['fetch', '--depth=8', `https://github.com/${repository}.git`, sha], source);
      await git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], source);
      assert.equal((await git(['rev-parse', 'HEAD'], source)).trim(), sha);
      const testFiles = [
        'extensions/slack/src/delivery-trace.test.ts',
        'extensions/slack/src/delivery-trace.test-support.ts',
        'extensions/slack/src/draft-stream.test.ts',
        'extensions/slack/src/draft-stream.http.test.ts',
      ];
      if (role === 'base') {
        await git(['fetch', '--depth=1', 'https://github.com/KhanCold/openclaw.git', HEAD], source);
        for (const file of testFiles) {
          const content = await git(['show', `${HEAD}:${file}`], source);
          await fs.writeFile(path.join(source, file), content);
        }
      }
      const overlayHashes = Object.fromEntries(await Promise.all(testFiles.map(async (file) => [file, hash(await readSourceFile(source, file))])));
      const overlayModes = Object.fromEntries(await Promise.all(testFiles.map(async (file) => [file, (await fs.lstat(path.join(source, file))).mode & 0o100 ? '100755' : '100644'])));
      let frozenDiff = hash(await git(stableDiffArgs, source));
      emit({ role, sha, testSource: HEAD, overlayHashes, overlayModes, productSource: sha });
      const mounts = ['--mount', `type=bind,src=${source},dst=/workspace`, '--mount', `type=bind,src=${source}/.git,dst=/workspace/.git,readonly`, '--mount', `type=bind,src=${path.dirname(SELF)},dst=/proof,readonly`];
      const common = ['run', '--name', containerName, '--rm', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', `${process.getuid()}:${process.getgid()}`, '--pids-limit=1024', '--memory=7g', '--cpus=4', '-w', '/workspace', ...mounts];
      const readonly = common.map((arg) => arg === `type=bind,src=${source},dst=/workspace` ? `${arg},readonly` : arg);
      emit({ role, phase: 'install-and-build', sha });
      const buildOutput = await run('docker', [...common, IMAGE, 'node', '/proof/proof.mjs', 'build'], { timeout: 2_100_000, label: `${role}-container-build`, log: true });
      const summaries = proofRecords(buildOutput).filter((record) => record.result === 'tracked-source-summary');
      assert.deepEqual(summaries.map((record) => record.phase), ['before-install', 'after-install', 'after-build']);
      const initial = summaries[0];
      const expectedUntracked = role === 'base' ? ['extensions/slack/src/draft-stream.http.test.ts'] : [];
      for (const snapshot of summaries) {
        assert.equal(snapshot.head, sha, 'Wrong snapshot HEAD');
        assert.equal(snapshot.contentSha256, initial.contentSha256, 'Tracked content/mode changed during install/build');
        assert.equal(snapshot.indexContentSha256, initial.indexContentSha256, 'Tracked index identity changed');
        assert.deepEqual(snapshot.untracked, expectedUntracked, 'Unexpected untracked source');
        assert.equal(snapshot.diffSha256, frozenDiff, 'Stable full-index diff differs; inspect serialization separately from content');
      }
      assert.equal(hash(await git(stableDiffArgs, source)), frozenDiff, 'Stable host diff changed during install/build');
      const testOutput = await run('docker', [...common, '--network=none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=512m,mode=1777', IMAGE, 'node', '/proof/proof.mjs', 'tests', role, sha], { timeout: 900_000, label: `${role}-owner-regressions`, log: true });
      const sdk = testOutput.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).find((record) => record.proofRecord === true && record.result === 'sdk-regressions-completed');
      assert(sdk && sdk.sha === sha && sdk.role === role, 'Missing complete SDK regression result');
      emit(sdk); sdkRecords.push(sdk);
      const tested = proofRecords(testOutput).filter((record) => record.result === 'tracked-source-summary');
      assert.equal(tested.length, 1); assert.equal(tested[0].phase, 'after-tests');
      assert.equal(tested[0].head, sha);
      assert.equal(tested[0].contentSha256, initial.contentSha256, 'Tracked content/mode changed during tests');
      assert.equal(tested[0].indexContentSha256, initial.indexContentSha256, 'Tests changed index identity');
      assert.deepEqual(tested[0].untracked, expectedUntracked, 'Tests created unexpected untracked source');
      assert.equal(tested[0].diffSha256, frozenDiff, 'Stable diff differs after tests; inspect serialization separately from content');
      // The regression overlay is a separate source identity. Restore only the
      // four verified task-owned test paths before building pristine Gateway.
      assert.equal(hash(await git(stableDiffArgs, source)), frozenDiff, 'Host full-index diff differs after qualification; inspect serialization separately from content');
      for (const file of testFiles) {
        assert.equal(hash(await readSourceFile(source, file)), overlayHashes[file]);
        assert.equal((await fs.lstat(path.join(source, file))).mode & 0o100 ? '100755' : '100644', overlayModes[file]);
      }
      if (role === 'head') {
        try {
        const checksOutput = await run('docker', [...common.map((arg) => arg === '--memory=7g' ? `--memory=${checkMemoryBytes}` : arg), '--network=none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=512m,mode=1777', IMAGE, 'node', '/proof/proof.mjs', 'checks'], { timeout: 1_200_000, label: 'candidate-changed-checks', log: true });
        for (const line of checksOutput.split('\n')) { try { const record = JSON.parse(line); if (record.proofRecord) emit(record); } catch {} }
        } catch (error) {
          // Preserve this required failure, but allow independent Gateway proof
          // only after the same source-integrity checks below still pass.
          requiredFailures.push({ phase: 'candidate-changed-checks', error: safeDiagnostic(String(error?.message ?? error)) });
          emit({ proofRecord: true, result: 'required-phase-failed', ...requiredFailures.at(-1) });
          await run('docker', ['rm', '--force', containerName], { timeout: 30_000, label: 'cleanup-checks-container', quietFailure: true }).catch(() => {});
        }
        const checkedOutput = await run('docker', [...readonly, '--network=none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=512m,mode=1777', IMAGE, 'node', '/proof/proof.mjs', 'snapshot', 'after-checks'], { timeout: 180_000, label: 'head-source-after-checks', log: true });
        const checked = proofRecords(checkedOutput).find((record) => record.result === 'tracked-source-summary');
        assert(checked); assert.equal(checked.head, sha);
        assert.equal(checked.contentSha256, initial.contentSha256, 'Changed checks changed tracked contents/modes');
        assert.equal(checked.indexContentSha256, initial.indexContentSha256);
        assert.deepEqual(checked.untracked, expectedUntracked);
        for (const file of testFiles) {
          assert.equal(hash(await readSourceFile(source, file)), overlayHashes[file], 'Checks changed test source');
          assert.equal((await fs.lstat(path.join(source, file))).mode & 0o100 ? '100755' : '100644', overlayModes[file]);
        }
        assert.equal(hash(await git(stableDiffArgs, source)), frozenDiff, 'Changed checks changed source');
      }
      emit({ proofRecord: true, result: 'owner-tree-completed', role, productSource: sha, testSource: HEAD, overlayHashes, overlayModes });
      qualified.push({ role, sha, source, testFiles, overlayHashes, overlayModes, frozenDiff,
        initial, common, readonly });
    }
    // Both revisions qualify sequentially before any Gateway scenario.
    assert.equal(qualified.length, 2);
    for (const qualification of qualified) {
      let { role, sha, source, testFiles, overlayHashes, overlayModes, frozenDiff, initial, common, readonly } = qualification;
      const runtimeHashes = { ...overlayHashes };
      if (role === 'base') {
        for (const file of testFiles) {
          if (file === 'extensions/slack/src/draft-stream.http.test.ts') {
            assert.equal((await git(['ls-tree', '--name-only', BASE, '--', file], source)).trim(), '');
            await fs.unlink(path.join(source, file));
            runtimeHashes[file] = null;
          } else {
            const original = await git(['show', `${BASE}:${file}`], source);
            await fs.writeFile(path.join(source, file), original);
            runtimeHashes[file] = hash(original);
          }
        }
        assert.equal((await git(stableDiffArgs, source)).trim(), '', 'Baseline restoration not pristine');
        await run('docker', [...common, IMAGE, 'node', '/proof/proof.mjs', 'rebuild'], { timeout: 1_300_000, label: 'base-pristine-qaRuntime-rebuild', log: true });
      }
      assert.equal((await git(stableDiffArgs, source)).trim(), '', 'Gateway requires pristine tracked source');
      frozenDiff = hash(await git(stableDiffArgs, source));
      const pristineOutput = await run('docker', [...readonly, '--network=none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=512m,mode=1777', IMAGE, 'node', '/proof/proof.mjs', 'snapshot', 'pristine-runtime'], { timeout: 180_000, label: `${role}-pristine-source`, log: true });
      const pristine = proofRecords(pristineOutput).find((record) => record.result === 'tracked-source-summary');
      assert(pristine); assert.equal(pristine.head, sha);
      assert.equal(pristine.contentSha256, initial.indexContentSha256, 'Gateway source differs from frozen HEAD contents/modes');
      assert.equal(pristine.indexContentSha256, initial.indexContentSha256);
      assert.deepEqual(pristine.untracked, [], 'Pristine Gateway has unexpected untracked source');
      const stamps = {};
      for (const name of ['.buildstamp', '.runtime-postbuildstamp']) {
        const file = path.join(source, 'dist', name);
        assert((await fs.lstat(file)).isFile(), 'Expected a regular build stamp');
        const bytes = await fs.readFile(file);
        const stamp = JSON.parse(bytes);
        assert.equal(stamp.head, sha, 'Build stamp has wrong source head');
        assert.equal(stamp.inputsClean, true, 'Build stamp contains dirty watched inputs');
        stamps[name] = { sha256: hash(bytes), head: stamp.head, inputsClean: stamp.inputsClean };
      }
      emit({ proofRecord: true, result: 'pristine-runtime-tree', role, sha, runtimeHashes, stamps,
        entry: 'pnpm openclaw gateway run; official freshness checks retained' });
      for (const progressStyle of SCENARIOS) {
        emit({ role, phase: 'gateway-runtime', sha, progressStyle });
        const output = await run('docker', [...readonly, '--network=none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=1024m,mode=1777', IMAGE, 'node', '/proof/proof.mjs', 'inside', role, sha, progressStyle], { timeout: 300_000, label: `${role}-${progressStyle}-runtime`, log: true });
        const lines = output.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
        const result = lines.find((record) => record.proofRecord === true && record.result === 'completed');
        assert(result, 'No complete runtime proof record');
        assert.equal(result.role, role);
        assert.equal(result.sha, sha);
        assert.equal(result.progressStyle, progressStyle);
        assert.equal(hash(await git(stableDiffArgs, source)), frozenDiff, 'Build/runtime changed tracked source');
        for (const [file, expected] of Object.entries(runtimeHashes)) {
          const bytes = await readSourceFile(source, file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          assert.equal(bytes === null ? null : hash(bytes), expected, 'Pristine runtime source changed');
        }
        assert.equal((await git(['rev-parse', 'HEAD'], source)).trim(), sha);
        emit(result);
        records.push(result);
      }
      await fs.rm(source, { recursive: true, force: true });
    }
    assert.equal(sdkRecords.length, 2);
    for (const scenario of ['dispatch-partial', 'dispatch-card', 'restoration-partial']) {
      const projection = (record) => record.records.find((item) => item.scenario === scenario).writes.map(({ ts, ...write }) => write);
      assert.deepEqual(projection(sdkRecords[0]), projection(sdkRecords[1]), `Control drift: ${scenario}`);
    }
    assert.equal(records.length, SCENARIOS.length * 2);
    for (const record of records) assert.equal(record.verdict, record.role === 'base' ? (record.progressStyle.includes('compact') ? 'baseline-defect-observed' : 'baseline-control-pass') : 'candidate-pass');
    for (const style of ['card', 'native-card']) {
      const project = (role) => records.find((record) => record.role === role && record.progressStyle === style).captures
        .filter((entry) => entry.method !== 'chat.delete')
        .map(({ ts, thread_ts, ...entry }) => entry);
      assert.deepEqual(project('base'), project('head'), `Gateway control drift: ${style}`);
    }
    assert.deepEqual(requiredFailures, [], 'Required qualification phases failed; independent runtime records do not make the proof pass');
    if (process.env.GITHUB_STEP_SUMMARY) {
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## Slack serialized payload boundary proof\n\nFrozen baseline defect observed and candidate passed. External model and Slack HTTP fixtures only; no live Slack UI or notification claim.\n\n\`\`\`json\n${JSON.stringify({ manifest, records, sdkRecords }, null, 2)}\n\`\`\`\n`);
    }
  } finally {
    // A timeout can kill the Docker client before its container; remove that
    // exact named container before deleting the mounted source directory.
    await run('docker', ['rm', '--force', containerName], { timeout: 30_000, quietFailure: true }).catch(() => {});
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function readSourceFile(source, relative) {
  const file = path.join(source, relative);
  const parent = await fs.realpath(path.dirname(file));
  assert(parent === source || parent.startsWith(`${source}/`), 'Source file parent escaped checkout');
  assert((await fs.lstat(file)).isFile(), 'Expected regular source file');
  return fs.readFile(file);
}

function proofRecords(output) {
  return output.split('\n').flatMap((line) => { try { const record = JSON.parse(line); return record?.proofRecord ? [record] : []; } catch { return []; } });
}

async function snapshotTracked(phase) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.cwd(), '/workspace');
  const raw = await run('git', ['ls-files', '--stage', '-z'], { label: `${phase}-tracked-index` });
  const files = [];
  for (const entry of raw.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) (\d+)\t([\s\S]+)$/.exec(entry);
    assert(match && match[3] === '0', 'Expected an unconflicted tracked index');
    const [, indexMode, indexBlob, , relative] = match;
    assert(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
    const absolute = path.join('/workspace', relative);
    const parent = await fs.realpath(path.dirname(absolute));
    assert(parent === '/workspace' || parent.startsWith('/workspace/'), 'Tracked parent escaped source');
    const stat = await fs.lstat(absolute).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    let bytes = null, mode = null;
    if (stat?.isSymbolicLink()) { bytes = Buffer.from(await fs.readlink(absolute)); mode = '120000'; }
    else if (stat?.isFile()) { bytes = await fs.readFile(absolute); mode = stat.mode & 0o100 ? '100755' : '100644'; }
    else assert(stat === null, 'Unsupported tracked source kind');
    const blob = bytes === null ? null : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    files.push({ path: relative, indexMode, indexBlob, mode, blob });
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const stable = files.map(({ path: name, mode, blob }) => ({ path: name, mode, blob }));
  const indexStable = files.map(({ path: name, indexMode: mode, indexBlob: blob }) => ({ path: name, mode, blob }));
  const head = (await run('git', ['rev-parse', 'HEAD'], { label: `${phase}-head` })).trim();
  const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard', '--exclude=.proof-tools/', '-z'], { label: `${phase}-untracked` })).split('\0').filter(Boolean).sort();
  const patch = await run('git', ['--no-pager', 'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--diff-algorithm=myers', '--no-indent-heuristic', '--unified=3', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD'], { label: `${phase}-stable-diff` });
  emit({ proofRecord: true, result: 'tracked-source-summary', phase, files: files.length,
    head, gitVersion: (await run('git', ['--version'], { label: `${phase}-git-version` })).trim(), contentSha256: hash(JSON.stringify(stable)), indexContentSha256: hash(JSON.stringify(indexStable)), untracked, diffSha256: hash(patch), diffBytes: Buffer.byteLength(patch),
    status: safeDiagnostic(await run('git', ['status', '--porcelain=v1', '--untracked-files=no'], { label: `${phase}-status` })),
    diffHeaders: patch.split('\n').filter((line) => /^(diff --git |index |old mode |new mode |deleted file mode |new file mode )/.test(line)) });
  // Every tracked path participates in the digest. The diagnostic run retains
  // full lists; normal runs emit per-file identities only for differences.
  emit({ proofRecord: true, result: 'tracked-source-changes', phase, files: files.filter((file) => file.blob !== file.indexBlob || file.mode !== file.indexMode) });
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
  // Strict offline corepack-pnpm compatibility entry; not a Corepack install.
  await fs.writeFile('/workspace/.proof-tools/bin/corepack', "#!/bin/sh\n[ \"$1\" = \"pnpm\" ] || exit 64\nshift\nexec /usr/local/bin/node /workspace/.proof-tools/package/bin/pnpm.mjs \"$@\"\n", { mode: 0o755 });
  emit({ proofRecord: true, result: 'package-manager-entry', command: 'corepack pnpm', implementation: 'strict compatibility shim to integrity-verified pnpm 12.9.0' });
  // Official static Linux release, downloaded only in the networked build
  // phase. Both the archive and extracted executable have fixed digests.
  const rgUrl = 'https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz';
  const rgResponse = await fetch(rgUrl);
  assert(rgResponse.ok, 'Pinned ripgrep download failed');
  const rgArchive = Buffer.from(await rgResponse.arrayBuffer());
  assert.equal(hash(rgArchive), '4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e');
  await fs.writeFile('/workspace/.proof-tools/ripgrep.tgz', rgArchive);
  await fs.mkdir('/workspace/.proof-tools/ripgrep');
  await run('tar', ['-xzf', '/workspace/.proof-tools/ripgrep.tgz', '-C', '/workspace/.proof-tools/ripgrep', '--strip-components=1', 'ripgrep-14.1.1-x86_64-unknown-linux-musl/rg']);
  const rgBytes = await fs.readFile('/workspace/.proof-tools/ripgrep/rg');
  assert.equal(hash(rgBytes), 'f401154e2393f9002ac77e419f9ee5521c18f4f8cd3e32293972f493ba06fce7');
  await fs.writeFile('/workspace/.proof-tools/bin/rg', rgBytes, { mode: 0o755 });
  emit({ proofRecord: true, result: 'toolchain-provenance', tool: 'ripgrep', version: '14.1.1', url: rgUrl,
    archiveSha256: hash(rgArchive), executableSha256: hash(rgBytes) });
  process.env.PATH = `/workspace/.proof-tools/bin:${process.env.PATH}`;
  process.env.CI = 'true';
  for (const [command, args] of [['node', ['--version']], ['git', ['--version']], ['tar', ['--version']], ['rg', ['--version']], ['corepack', ['pnpm', '--version']]])
    await run(command, args, { label: `toolchain-${command}`, log: true });
  await snapshotTracked('before-install');
  await run('node', [PNPM, 'install', '--frozen-lockfile'], { timeout: 900_000, label: 'pnpm-install', log: true });
  for (const command of ['oxfmt', 'oxlint'])
    await run('node', [PNPM, 'exec', command, '--version'], { label: `toolchain-${command}`, log: true });
  await run('node', ['scripts/run-tsgo.mjs', '--version'], { label: 'toolchain-tsgo-official', log: true });
  await snapshotTracked('after-install');
  // The repository's QA runtime profile builds real JS, plugins, assets and
  // freshness stamps. Declaration/package qualification is outside this proof.
  await run('node', [PNPM, 'build', 'qaRuntime'], { timeout: 1_200_000, label: 'pnpm-build-qaRuntime', log: true });
  await snapshotTracked('after-build');
}

async function rebuildPristine() {
  assert.equal(process.platform, 'linux'); assert.equal(process.cwd(), '/workspace');
  const home = await fs.mkdtemp('/tmp/pristine-build-home-');
  await run('node', [PNPM, 'build', 'qaRuntime'], { env: { ...process.env, HOME: home,
    CI: 'true', PATH: `/workspace/.proof-tools/bin:${process.env.PATH}` }, timeout: 1_200_000,
    label: 'pristine-qaRuntime-build', log: true });
}

async function resourceSnapshot(phase) {
  const files = ['memory.current', 'memory.max', 'memory.peak', 'memory.events', 'cpu.max', 'pids.current'];
  const cgroup = {};
  for (const name of files) {
    cgroup[name] = await fs.readFile(`/sys/fs/cgroup/${name}`, 'utf8')
      .then((text) => text.trim()).catch((error) => `unavailable:${error.code}`);
  }
  emit({ proofRecord: true, result: 'check-resource-snapshot', phase, cgroup,
    controllerMemoryBytes: process.memoryUsage(), totalMemoryBytes: os.totalmem(),
    availableParallelism: os.availableParallelism() });
}

async function emitCompilerMetrics(directory) {
  try {
    const names = (await fs.readdir(directory)).filter((name) => /^tsgo-[a-zA-Z0-9-]+\.json$/.test(name)).sort();
    assert(names.length <= 100, 'Unexpected compiler metric count');
    emit({ proofRecord: true, result: 'tsgo-metrics-count', count: names.length });
    for (const name of names) {
      const file = path.join(directory, name);
      const st = await fs.lstat(file);
      assert(st.isFile() && !st.isSymbolicLink() && st.size <= 1024 * 1024, 'Invalid compiler metric file');
      const bytes = await fs.readFile(file, 'utf8');
      emit({ proofRecord: true, result: 'tsgo-compiler-metrics', file: name,
        sha256: createHash('sha256').update(bytes).digest('hex'), evidence: JSON.parse(safeDiagnostic(bytes)) });
    }
  } catch (error) {
    emit({ proofRecord: true, result: 'tsgo-metrics-unavailable', error: safeDiagnostic(String(error?.message ?? error)) });
  }
}

async function changedChecks() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.cwd(), '/workspace');
  const root = await fs.mkdtemp('/tmp/check-proof-');
  const env = { ...process.env, HOME: root, CI: 'true', OPENCLAW_LOCAL_CHECK: '1', OPENCLAW_LOCAL_CHECK_MODE: 'throttled', OPENCLAW_TSGO_METRICS_DIR: `${root}/tsgo-metrics`, OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: `${root}/module-cache`, PATH: `/workspace/.proof-tools/bin:${process.env.PATH}` };
  const files = [
    'extensions/slack/src/draft-stream.ts', 'extensions/slack/src/format.ts',
    'extensions/slack/src/monitor/message-handler/dispatch-progress.ts',
    'extensions/slack/src/delivery-trace.test.ts', 'extensions/slack/src/delivery-trace.test-support.ts',
    'extensions/slack/src/draft-stream.test.ts', 'extensions/slack/src/draft-stream.http.test.ts',
  ];
  await resourceSnapshot('before-changed-checks');
  try {
  const started = Date.now();
  const plan = await run('node', ['scripts/check-changed.mjs', '--dry-run', '--base', BASE, '--head', HEAD, '--', ...files], { env, timeout: 120_000, label: 'changed-plan', log: true });
  emit({ proofRecord: true, result: 'changed-check-plan', sha: HEAD, planStdout: plan, stderrPreservedInCommandLog: true });
  await run('node', ['scripts/check-changed.mjs', '--base', BASE, '--head', HEAD, '--', ...files], { env, timeout: 1_000_000, label: 'changed-checks', log: true });
  emit({ proofRecord: true, result: 'changed-checks-completed', sha: HEAD, exit: 0, wallMs: Date.now() - started });
  } finally {
    await resourceSnapshot('after-changed-checks');
    await emitCompilerMetrics(env.OPENCLAW_TSGO_METRICS_DIR);
  }
}

async function ownerTests(role, sha) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.cwd(), '/workspace');
  assert.equal(sha, role === 'base' ? BASE : HEAD);
  const root = await fs.mkdtemp('/tmp/owner-proof-');
  const outputFile = `${root}/vitest.json`;
  const integrityFile = `${root}/integrity.json`;
  const expectedFiles = ['delivery-trace.test.ts', 'draft-stream.http.test.ts', 'draft-stream.test.ts', 'format.test.ts', 'monitor/message-handler/dispatch.preview-fallback.test.ts'].map((file) => `/workspace/extensions/slack/src/${file}`).sort();
  const env = { ...process.env, HOME: root, CI: 'true', OPENCLAW_PROOF_INTEGRITY_REPORT: integrityFile, OPENCLAW_DELIVERY_PROOF: '1', OPENCLAW_DELIVERY_PROOF_SHA: sha, OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: `${root}/module-cache`, PATH: `/workspace/.proof-tools/bin:${process.env.PATH}` };
  const started = Date.now();
  const output = await run('node', ['scripts/run-vitest.mjs',
    'extensions/slack/src/delivery-trace.test.ts',
    'extensions/slack/src/draft-stream.http.test.ts',
    'extensions/slack/src/draft-stream.test.ts',
    'extensions/slack/src/format.test.ts',
    'extensions/slack/src/monitor/message-handler/dispatch.preview-fallback.test.ts',
    '--reporter=default', '--reporter=json', '--reporter=/proof/integrity-reporter.mjs', `--outputFile=${outputFile}`],
    { env, timeout: 600_000, allowedExitCodes: role === 'base' ? [1] : [0], label: `${role}-owner-tests`, log: true });
  const report = JSON.parse(await fs.readFile(outputFile, 'utf8'));
  const integrity = JSON.parse(await fs.readFile(integrityFile, 'utf8'));
  // JSON reporter omits unhandled errors; the public reporter hook supplies
  // those separately. Never let the five expected failures hide load errors.
  emit({ proofRecord: true, result: 'owner-machine-reports', role, sha, report, integrity });
  assert.equal(integrity.timedOut, false);
  assert.equal(integrity.reason, role === 'base' ? 'failed' : 'passed');
  assert.deepEqual(integrity.unhandledErrors, []);
  assert.deepEqual(integrity.queued.toSorted(), expectedFiles);
  assert.deepEqual(integrity.ended.toSorted(), expectedFiles);
  assert.deepEqual(integrity.modules.map((module) => module.path).sort(), expectedFiles);
  assert.deepEqual(report.testResults.map((suite) => suite.name).sort(), expectedFiles);
  const allSuites = integrity.modules.flatMap((module) => [module, ...module.suites]);
  const allTests = integrity.modules.flatMap((module) => module.tests);
  for (const suite of allSuites) {
    assert(['passed', 'failed'].includes(suite.state), 'Suite did not complete');
    assert.deepEqual(suite.errors, [], 'Suite load/runtime error');
  }
  assert(allTests.every((test) => ['passed', 'failed'].includes(test.state)), 'Test did not complete');
  assert.equal(report.numTotalTestSuites, allSuites.length);
  assert.equal(report.numFailedTestSuites, allSuites.filter((suite) => suite.state === 'failed').length);
  assert.equal(report.numPassedTestSuites, allSuites.filter((suite) => suite.state === 'passed').length);
  assert.equal(report.numPendingTestSuites, 0);
  assert.equal(report.numTotalTests, allTests.length);
  assert.equal(report.numFailedTests, allTests.filter((test) => test.state === 'failed').length);
  assert.equal(report.numPassedTests, allTests.filter((test) => test.state === 'passed').length);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests, 0);
  const cases = report.testResults.flatMap((suite) => suite.assertionResults || []);
  assert.equal(cases.length, report.numTotalTests);
  assert.equal(cases.filter((item) => item.status === 'failed').length, report.numFailedTests);
  assert.equal(cases.filter((item) => item.status === 'passed').length, report.numPassedTests);
  for (const suite of report.testResults) {
    assert.equal(suite.message, '', 'JSON report recorded a suite error');
    assert.equal(suite.status, suite.assertionResults.some((item) => item.status === 'failed') ? 'failed' : 'passed');
  }
  const failed = cases.filter((item) => item.status === 'failed').map((item) => item.fullName);
  const expectedFailures = [
    'keeps native mention policy through serialized compact posts and edits',
    'keeps native mention policy through serialized inferred-compact posts and edits',
    'restores commentary after a human interrupts the final HTTP edit',
    'restores legacy-reasoning after a human interrupts the final HTTP edit',
    'restores legacy-commentary after a human interrupts the final HTTP edit',
  ];
  const records = output.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).filter((record) => record.proofRecord && record.boundary);
  const expectedScenarios = ['dispatch-compact', 'dispatch-inferred-compact', 'dispatch-partial', 'dispatch-card', 'restoration-commentary', 'restoration-legacy-reasoning', 'restoration-legacy-commentary', 'restoration-partial'];
  emit({ proofRecord: true, result: 'sdk-regressions-observed', role, sha, wallMs: Date.now() - started, failed, records });
  assert.deepEqual(records.map((record) => record.scenario).sort(), expectedScenarios.sort(), 'Incomplete owner-boundary coverage');
  assert(records.every((record) => record.sha === sha), 'Wrong regression source revision');
  for (const record of records) {
    const writes = record.writes;
    const restoration = record.scenario.startsWith('restoration-');
    const progress = !record.scenario.endsWith('-partial');
    const card = record.scenario === 'dispatch-card';
    const first = writes.find((write) => write.method === 'chat.postMessage' && write.text?.includes('FIRST'));
    const second = writes.find((write) => write.method === 'chat.update' && write.text?.includes('SECOND'));
    assert(first && second && first.ts === second.ts, 'Post/edit ownership was not exercised');
    const previews = restoration ? [writes[0], writes[1], writes[3]] : [first, second];
    if (restoration) {
      assert.equal(writes.length, 4);
      assert.equal(writes[3].text, writes[1].text, 'Restoration did not restore the visible draft');
    }
    for (const write of previews) {
      const fields = card ? slackMrkdwnFields(write) : [{ text: write.text }];
      const text = fields.map((field) => field.text).join('\n');
      for (const token of ['<@U0456EFGH>', '<#C0456EFGH>', '<!here>']) {
        const escaped = token.replace('<', '&lt;').replace('>', '&gt;');
        assert(text.includes(progress && (role === 'head' || card) ? escaped : token), `Unexpected native token policy in ${record.scenario}`);
      }
      assert(!text.includes('&amp;lt;'));
      assert(text.includes('<https://example.invalid/docs|Docs>'));
      assert(text.includes('`src/one.ts`'));
    }
    assert(writes.some((write) => write.text?.includes('FINAL <@U0456EFGH> <#C0456EFGH> <!here>')), 'Final mention control missing');
  }
  if (role === 'base') {
    assert.equal(report.success, false, 'Baseline unexpectedly passed; re-audit the candidate');
    assert.equal(failed.length, expectedFailures.length, 'Unexpected baseline failure count');
    for (const name of expectedFailures) assert(failed.some((actual) => actual.endsWith(name)), `Missing intended baseline failure: ${name}`);
  } else {
    assert.equal(report.success, true, 'Candidate owner regressions failed');
    assert.deepEqual(failed, []);
  }
  await snapshotTracked('after-tests');
  emit({ proofRecord: true, result: 'sdk-regressions-completed', role, sha, wallMs: Date.now() - started, failed, tests: report.numTotalTests, passed: report.numPassedTests, failedCount: report.numFailedTests, pending: report.numPendingTests, todo: report.numTodoTests, records });
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

async function inside(role, sha, progressStyle) {
  assert(SCENARIOS.includes(progressStyle));
  const compact = progressStyle.includes('compact');
  const nativeCard = progressStyle === 'native-card';
  assert.equal(process.platform, 'linux');
  assert.equal(process.cwd(), '/workspace');
  assert.equal(sha, role === 'base' ? BASE : HEAD);
  const root = await fs.mkdtemp('/tmp/slack-state-');
  const captures = [], unexpected = [], modelStages = [], modelRequests = [], frames = [], humanReceipts = [];
  let sequence = 0, humanTs, socket, call, signed;
  const epoch = Math.floor(Date.now() / 1000);
  const timestamp = () => `${epoch}.${String(++sequence).padStart(6, '0')}`;
  const textOf = (item) => [item.text, item.markdown_text, ...item.mrkdwnFields.map((field) => field.text), ...(item.chunks ?? []).flatMap((chunk) => [chunk.text, chunk.title, chunk.details, chunk.output])].filter(Boolean).join('\n');
  const observed = (marker, method) => captures.find((item) => (!method || item.method === method) && textOf(item).includes(marker));
  let stage = 'reply', toolRequested = false, toolCompleted = false, toolRound = 0, modelRequestCount = 0, gateway;
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
        const ts = input.ts || timestamp();
        captures.push({ method, channel, text: input.text || '', blocks: typeof input.blocks === 'string' ? JSON.parse(input.blocks) : input.blocks, thread_ts: input.thread_ts, mrkdwnFields: slackMrkdwnFields(input), ts });
        return json(res, { ok: true, channel, ts, message: { text: input.text, ts } });
      }
      case 'chat.startStream': case 'chat.appendStream': case 'chat.stopStream': {
        assert.equal(channel, 'D0123456789');
        const chunks = typeof input.chunks === 'string' ? JSON.parse(input.chunks) : input.chunks ?? [];
        assert(Array.isArray(chunks));
        for (const chunk of chunks) {
          assert(['markdown_text', 'plan_update', 'task_update'].includes(chunk.type));
          if (chunk.type === 'markdown_text') assert.equal(typeof chunk.text, 'string');
          else assert.equal(typeof chunk.title, 'string');
          if (chunk.type === 'task_update') {
            assert.equal(typeof chunk.id, 'string');
            assert(['pending', 'in_progress', 'complete', 'error'].includes(chunk.status));
          }
        }
        if (method === 'chat.startStream') {
          assert.equal(typeof input.thread_ts, 'string');
          assert.equal(input.recipient_team_id, 'T0123456789');
          assert.equal(input.recipient_user_id, 'U0123PROOF');
        } else assert(captures.some((item) => item.method === 'chat.startStream' && item.ts === input.ts), 'Unknown stream');
        const ts = input.ts || timestamp();
        captures.push({ method, channel, ts, thread_ts: input.thread_ts, markdown_text: input.markdown_text, chunks, mrkdwnFields: [] });
        return json(res, { ok: true, channel, ts });
      }
      case 'chat.delete': captures.push({ method, channel, ts: input.ts, mrkdwnFields: [] }); return json(res, { ok: true });
      case 'reactions.add': case 'reactions.remove':
      case 'assistant.threads.setStatus': case 'assistant.threads.setTitle': case 'assistant.threads.setSuggestedPrompts': return json(res, { ok: true });
      default: unexpected.push(method); res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'unsupported_fixture_method' }));
    }
  });
  const model = await listen(async (req, res) => {
    modelRequestCount += 1;
    if (modelRequests.length < 32) modelRequests.push(modelRouteDiagnostic(req));
    if (req.method === 'GET' && req.url === '/v1/models') return json(res, { object: 'list', data: [{ id: 'gpt-5.6-luna', object: 'model' }] });
    // The frozen official OpenAI memory provider POSTs string batches to this
    // endpoint. This external fixture returns deterministic vectors only; it
    // does not intercept the real provider, memory runtime or Slack pipeline.
    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      try {
        const input = JSON.parse(await body(req));
        assert.equal(input.model, 'text-embedding-3-small');
        assert(Array.isArray(input.input) && input.input.length > 0 && input.input.length <= 64);
        assert(input.input.every((text) => typeof text === 'string' && text.length <= 100_000));
        assert(Object.keys(input).every((key) => ['model', 'input', 'dimensions'].includes(key)));
        const dimensions = input.dimensions ?? 1536;
        assert(Number.isInteger(dimensions) && dimensions > 0 && dimensions <= 1536);
        return json(res, { object: 'list', model: input.model,
          data: input.input.map((_, index) => ({ object: 'embedding', index,
            embedding: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) })),
          usage: { prompt_tokens: 1, total_tokens: 1 } });
      } catch {
        unexpected.push('embedding-request-schema');
        res.writeHead(400); return res.end('unsupported embedding fixture request');
      }
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses') { unexpected.push('model-route'); res.writeHead(404); return res.end(); }
    const input = JSON.parse(await body(req));
    modelStages.push(stage);
    if (stage === 'reply') return sendResponse(res, `PROOFREPLY ${FIXTURE}`, 'final_answer');
    if (!toolRequested) {
      assert(input.tools?.some((tool) => tool.name === 'tool_search'), 'Production runtime did not advertise tool_search');
      toolRequested = true; toolRound = 1;
      return sendResponse(res, `PROOFPROGRESSFIRST ${FIXTURE}`, 'commentary', { type: 'function_call', id: 'fc_proof', call_id: 'call_proof', name: 'tool_search', arguments: JSON.stringify({ query: 'read a file', limit: 1 }) });
    }
    assert(input.input?.some((item) => item.type === 'function_call_output' && item.call_id === (toolRound === 1 ? 'call_proof' : toolRound === 2 ? 'call_proof_second' : 'call_proof_third')), 'No real tool result reached model');
    if (toolRound === 1) {
      await until(() => observed('PROOFPROGRESSFIRST', nativeCard ? undefined : 'chat.postMessage'), 'first progress HTTP post');
      toolRound = 2;
      return sendResponse(res, `PROOFPROGRESSSECOND ${FIXTURE}`, 'commentary', { type: 'function_call', id: 'fc_proof_second', call_id: 'call_proof_second', name: 'tool_search', arguments: JSON.stringify({ query: 'list files', limit: 1 }) });
    }
    await until(() => observed('PROOFPROGRESSSECOND', nativeCard ? undefined : 'chat.update'), 'second progress HTTP edit/append');
    if (compact && toolRound === 2) {
      // Subscribe to public wire events before emitting the incomplete preamble.
      const sessions = await call('sessions.list', {});
      assert(Array.isArray(sessions.sessions) && sessions.sessions.length > 0);
      for (const session of sessions.sessions) await call('sessions.messages.subscribe', { key: session.key });
      humanTs = timestamp();
      const human = await signed({ type: 'event_callback', team_id: 'T0123456789', api_app_id: 'A0123456789', event_id: 'EvHumanBoundary', event_time: Math.floor(Date.now() / 1000), event: { type: 'message', channel: 'D0123456789', channel_type: 'im', user: 'U0OTHERHUMAN', text: 'Synthetic human boundary.', ts: humanTs, event_ts: humanTs } });
      assert.equal(human.status, 200);
      // The rejection occurs in prepare.ts AFTER noteConversationMessage. HTTP
      // acknowledgement alone is deliberately insufficient for this barrier.
      await until(async () => {
        const raw = await fs.readFile(`${root}/gateway.log`, 'utf8').catch(() => '');
        for (const line of raw.split('\n')) {
          let row; try { row = JSON.parse(line); } catch { continue; }
          const objects = Object.values(row).flatMap((value) => {
            if (value && typeof value === 'object') return [value];
            if (typeof value === 'string') { try { return [JSON.parse(value)]; } catch {} }
            return [];
          });
          if (objects.some((value) => value.messageTs === humanTs && value.channelId === 'D0123456789' && value.reason === 'dm-unauthorized')) {
            humanReceipts.push({ messageTs: humanTs, channelId: 'D0123456789', reason: 'dm-unauthorized', boundary: 'post-conversation-note preparation rejection' });
            return true;
          }
        }
        return false;
      }, 'processed human boundary');
      const before = captures.length;
      const item = message(`PROOFPROGRESSTHIRD ${FIXTURE}`, 'commentary', 'msg_fragment');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      event({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } });
      event({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'PROOFFRAGMENT' });
      await until(() => frames.some((frame) => frame.event === 'agent' && frame.payload?.stream === 'item' && frame.payload.data?.kind === 'preamble' && frame.payload.data.phase === 'update' && frame.payload.data.progressText?.includes('PROOFFRAGMENT')), 'public incomplete preamble event');
      // This records a wire-observed negative window, not a claim that a timer
      // drains the draft owner. The owner regression separately awaits flush().
      await call('health', {});
      assert(!captures.slice(before).some((entry) => ['chat.postMessage', 'chat.update'].includes(entry.method)), 'Incomplete fragment published a new draft');
      humanReceipts.push({ fragmentObserved: true, noWritesAtWireBarrier: true, beforeIndex: before });
      const completed = `PROOFFRAGMENT PROOFPROGRESSTHIRD ${FIXTURE}`;
      item.content[0].text = completed;
      event({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: ` PROOFPROGRESSTHIRD ${FIXTURE}` });
      event({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: completed });
      event({ type: 'response.output_item.done', output_index: 0, item });
      const thirdCall = { type: 'function_call', id: 'fc_proof_third', call_id: 'call_proof_third', name: 'tool_search', arguments: JSON.stringify({ query: 'read a file', limit: 1 }) };
      event({ type: 'response.output_item.added', output_index: 1, item: { ...thirdCall, arguments: '' } });
      event({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: thirdCall.id, delta: thirdCall.arguments });
      event({ type: 'response.output_item.done', output_index: 1, item: thirdCall });
      toolRound = 3;
      event({ type: 'response.completed', response: { id: 'resp_fragment', status: 'completed', output: [item, thirdCall], usage: { input_tokens: 64, output_tokens: 64, total_tokens: 128, input_tokens_details: { cached_tokens: 0 } } } });
      return res.end('data: [DONE]\n\n');
    }
    if (compact) {
      await until(() => observed('PROOFPROGRESSTHIRD', 'chat.postMessage'), 'complete preamble after human');
      const first = observed('PROOFPROGRESSFIRST', 'chat.postMessage');
      assert(!captures.some((entry) => entry.method === 'chat.delete' && entry.ts === first.ts), 'Human-replied draft disappeared before final delivery');
      humanReceipts.push({ retainedBeforeFinal: true, messageTs: first.ts });
    }
    toolCompleted = true;
    return sendResponse(res, `PROOFFINAL ${FIXTURE}`, 'final_answer');
  });
  try {
    const config = {
      logging: { level: 'debug', file: `${root}/gateway.log` },
      gateway: { mode: 'local', port: 19241, bind: 'loopback', auth: { mode: 'token', token: 'synthetic-gateway-proof-token' } },
      models: { mode: 'merge', providers: { openai: { baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKey: { source: 'env', provider: 'default', id: 'OPENAI_API_KEY' }, api: 'openai-responses', agentRuntime: { id: 'openclaw' }, request: { allowPrivateNetwork: true }, models: [{ id: 'gpt-5.6-luna', name: 'gpt-5.6-luna', api: 'openai-responses', agentRuntime: { id: 'openclaw' }, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, contextTokens: 96000, maxTokens: 4096 }] } } },
      agents: { defaults: { workspace: `${root}/workspace`, model: { primary: 'openai/gpt-5.6-luna' }, models: { 'openai/gpt-5.6-luna': { agentRuntime: { id: 'openclaw' }, params: { transport: 'sse', openaiWsWarmup: false } } } } },
      plugins: { enabled: true, allow: ['openai', 'slack'], entries: { slack: { enabled: true }, openai: { enabled: true } } },
      channels: { slack: { enabled: true, mode: 'http', botToken: 'xoxb-synthetic-local-proof', signingSecret, dmPolicy: 'allowlist', allowFrom: ['U0123PROOF'], streaming: { mode: 'progress', nativeTransport: nativeCard, progress: { ...(progressStyle === 'inferred-compact' ? {} : { style: compact ? 'compact' : 'card' }), ...(progressStyle === 'compact-unlabeled' ? { label: false } : {}), nativeTaskCards: nativeCard, maxLineChars: 1000, commentary: true, toolProgress: false } } } },
    };
    await fs.mkdir(`${root}/workspace`);
    await fs.writeFile(`${root}/config.json`, JSON.stringify(config));
    const env = { PATH: `/workspace/.proof-tools/bin:${process.env.PATH}`, HOME: root, OPENCLAW_STATE_DIR: `${root}/state`, OPENCLAW_CONFIG_PATH: `${root}/config.json`, OPENAI_API_KEY: 'synthetic-local-model-fixture', SLACK_API_URL: `http://127.0.0.1:${slack.port}/api/`, CI: 'true' };
    gateway = spawn('node', [PNPM, 'openclaw', 'gateway', 'run', '--port', '19241', '--bind', 'loopback', '--auth', 'token'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    gateway.stdout.on('data', (data) => logs.push(data)); gateway.stderr.on('data', (data) => logs.push(data));
    signed = async (value) => {
      const payload = JSON.stringify(value), timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = 'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${payload}`).digest('hex');
      return fetch('http://127.0.0.1:19241/slack/events', { method: 'POST', headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature }, body: payload, signal: AbortSignal.timeout(3000) });
    };
    await until(async () => {
      assert.equal(gateway.exitCode, null, 'Gateway exited before readiness');
      try { const response = await signed({ type: 'url_verification', challenge: 'proof-ready' }); return response.ok && (await response.text()).includes('proof-ready'); } catch { return false; }
    }, 'signed Slack endpoint readiness', 150_000);
    if (compact) {
      socket = new WebSocket('ws://127.0.0.1:19241');
      const responses = new Map(); let rpcSequence = 0;
      socket.addEventListener('message', ({ data }) => {
        const frame = JSON.parse(String(data));
        if (frame.type === 'res') responses.set(frame.id, frame);
        else if (frame.type === 'event') frames.push(frame);
      });
      socket.addEventListener('error', () => unexpected.push('gateway-ws-error'));
      await until(() => frames.some((frame) => frame.event === 'connect.challenge'), 'Gateway challenge');
      call = async (method, params) => {
        const id = `proof-${++rpcSequence}`;
        socket.send(JSON.stringify({ type: 'req', id, method, params }));
        await until(() => responses.has(id), `Gateway ${method}`);
        const response = responses.get(id); responses.delete(id);
        assert(response.ok, `Gateway ${method} rejected: ${response.error?.message}`);
        return response.payload;
      };
      await call('connect', { minProtocol: 4, maxProtocol: 4, client: { id: 'cli', version: 'compact-proof', platform: 'linux', mode: 'cli' }, role: 'operator', scopes: ['operator.admin', 'operator.read', 'operator.write'], auth: { token: 'synthetic-gateway-proof-token' }, caps: [] });
    }
    await run('node', [PNPM, 'openclaw', 'agent', '--agent', 'main', '--session-id', 'slack-proof-reply', '--message', 'Return the fixture reply.', '--deliver', '--reply-channel', 'slack', '--reply-to', 'channel:C0123456789', '--json'], { env, timeout: 90_000 });
    await until(() => observed('PROOFREPLY'), 'Gateway reply HTTP delivery');
    stage = 'progress';
    const inboundTimestamp = timestamp();
    const response = await signed({ type: 'event_callback', team_id: 'T0123456789', api_app_id: 'A0123456789', event_id: 'EvProofOne', event_time: Math.floor(Date.now() / 1000), event: { type: 'message', channel: 'D0123456789', channel_type: 'im', user: 'U0123PROOF', text: 'Show commentary, search for the read tool, then show another preamble and search for the file listing tool before finishing.', ts: inboundTimestamp, event_ts: inboundTimestamp, ...(nativeCard ? { thread_ts: inboundTimestamp } : {}) } });
    assert.equal(response.status, 200, 'Signed inbound event rejected');
    await until(() => observed('PROOFFINAL'), 'inbound final HTTP delivery', 90_000);
    await until(async () => {
      const log = await fs.readFile(`${root}/gateway.log`, 'utf8').catch(() => '');
      return /slack: delivered [1-9]\d* repl(?:y|ies) to channel:D0123456789/.test(log);
    }, 'terminal Slack dispatch after stream and preview cleanup');
    assert(toolRequested && toolCompleted, 'Real tool round trip missing');
    assert.deepEqual(unexpected, [], 'External fixture contract incomplete');
    emit({ proofRecord: true, result: 'captured-boundary', role, sha, progressStyle, captures, humanReceipts });
    const selected = [];
    if (nativeCard) {
      assert(captures.some((item) => item.method === 'chat.startStream'), 'Native card did not use startStream');
      await until(() => captures.some((item) => item.method === 'chat.stopStream'), 'Native stream finalization');
      assert(observed('PROOFPROGRESSFIRST') && observed('PROOFPROGRESSSECOND') && observed('PROOFFINAL'));
      // Native title/details are provider-owned fields. Byte parity across base/head
      // is checked by the controller; do not misclassify these as Block Kit mrkdwn.
    } else {
      for (const [marker, progress, channel] of [['PROOFREPLY', false, 'C0123456789'], ['PROOFPROGRESS', true, 'D0123456789'], ['PROOFFINAL', false, 'D0123456789']]) {
        const matching = captures.flatMap((item) => item.mrkdwnFields.filter((field) => field.text.includes(marker)).map((field) => ({ method: item.method, channel: item.channel, ts: item.ts, ...field })));
        assert(matching.length > 0, `Missing ${marker}`);
        for (const capture of matching) {
          assert.equal(capture.channel, channel);
          assert(capture.text.includes('<https://example.invalid/docs|Docs>'), `URL control failed: ${marker}`);
          assert(capture.text.includes('<https://example.invalid/native|Native>'), `Native URL control failed: ${marker}`);
          for (const mention of ['<@U0456EFGH>', '<#C0456EFGH>', '<!here>', '<!channel>', '<!subteam^S123>']) {
            const expected = progress && (role === 'head' || !compact) ? mention.replace('<', '&lt;').replace('>', '&gt;') : mention;
            assert(capture.text.includes(expected), `Native mention control failed: ${marker}/${mention}`);
            if (expected !== mention) assert(!capture.text.includes(mention), `Active native token survived: ${marker}`);
          }
          assert(!capture.text.includes('&amp;lt;'), 'Progress double entity');
          assert(capture.text.includes('`src/one.ts`'), 'Code control failed');
        }
        selected.push(...matching);
      }
      const first = observed('PROOFPROGRESSFIRST', 'chat.postMessage');
      const second = observed('PROOFPROGRESSSECOND', 'chat.update');
      assert(first && second && first.ts === second.ts, 'Progress did not edit original timestamp');
      if (compact) {
        const third = observed('PROOFPROGRESSTHIRD', 'chat.postMessage');
        assert(third && third.ts !== first.ts && Number(third.ts) > Number(humanTs));
        assert(captures.some((item) => item.method === 'chat.delete' && item.ts === first.ts), 'Terminal compact cleanup did not delete the retired draft');
        assert(captures.some((item) => item.method === 'chat.delete' && item.ts === third.ts), 'Terminal compact cleanup did not delete the active draft');
        const final = observed('PROOFFINAL', 'chat.postMessage');
        assert(final && Number(final.ts) > Number(third.ts), 'Final was not below retained progress');
        assert.equal(humanReceipts.length, 3);
      }
    }
    emit({ proofRecord: true, result: 'completed', role, sha, progressStyle, verdict: role === 'base' ? (compact ? 'baseline-defect-observed' : 'baseline-control-pass') : 'candidate-pass', toolRequested, toolCompleted, modelStages, modelRequestCount, modelRequests, captures, humanReceipts, selected, claim: 'isolated built Gateway with external HTTP fixtures; no live Slack rendering or notification claim' });

  } catch (error) {
    // Do not print config, request headers, model inputs, or raw Gateway logs.
    emit({ proofRecord: true, result: 'failed', role, sha, progressStyle, error: String(error.message), stage, toolRequested, toolCompleted, modelRequestCount, modelRequests, captures, humanReceipts, wirePreambles: frames.filter((frame) => frame.event === 'agent' && frame.payload?.stream === 'item'), unexpected, gatewayLogBytes: Buffer.concat(logs).length, gatewayLogSha256: hash(Buffer.concat(logs)) });
    throw error;
  } finally {
    socket?.close();
    emit({ proofRecord: true, result: 'gateway-log', role, sha, progressStyle, text: safeDiagnostic(Buffer.concat(logs).toString()) });
    const log = await fs.readFile(`${root}/gateway.log`, 'utf8').catch(() => '');
    emit({ proofRecord: true, result: 'gateway-file-log', role, sha, progressStyle, text: safeDiagnostic(log) });
    if (gateway?.pid) { try { process.kill(-gateway.pid, 'SIGKILL'); } catch {} }
    slack.server.closeAllConnections(); slack.server.close();
    model.server.closeAllConnections(); model.server.close();
  }
}

try {
  if (process.argv[2] === 'build') await build();
  else if (process.argv[2] === 'snapshot') await snapshotTracked(process.argv[3]);
  else if (process.argv[2] === 'rebuild') await rebuildPristine();
  else if (process.argv[2] === 'checks') {
    await changedChecks();
    await flushOutput();
    process.exit(0);
  }
  else if (process.argv[2] === 'tests') {
    await ownerTests(process.argv[3], process.argv[4]);
    await flushOutput();
    process.exit(0);
  }
  else if (process.argv[2] === 'inside') {
    await inside(process.argv[3], process.argv[4], process.argv[5]);
    await flushOutput();
    process.exit(0);
  }
  else { assert.equal(process.argv.length, 2); await host(); }
} catch (error) {
  emit({ proofRecord: true, result: 'harness-incomplete', error: safeDiagnostic(String(error?.message ?? error)) });
  // Cleanup above has run. Flush diagnostics before ending a failed harness;
  // lingering HTTP client handles must not turn its assertion into a timeout.
  await flushOutput();
  process.exit(1);
}

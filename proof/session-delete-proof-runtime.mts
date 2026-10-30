import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.env.PROOF_REPO_DIR;
const stateDir = process.env.OPENCLAW_STATE_DIR;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const gatewayPort = Number(process.env.PROOF_GATEWAY_PORT);
const gatewayToken = process.env.PROOF_GATEWAY_TOKEN;
assert(repoRoot && stateDir && configPath && gatewayPort && gatewayToken, "proof environment missing");

async function fromRepo(relativePath: string) {
  return await import(pathToFileURL(path.join(repoRoot!, relativePath)).href);
}

const [
  bindingModule,
  sqliteHelper,
  sessionStore,
  sessionPaths,
  sqliteRuntime,
  pluginStateRuntime,
  transcriptWrite,
  transcriptRead,
] = await Promise.all([
    fromRepo("extensions/codex/src/app-server/session-binding.ts"),
    fromRepo("extensions/codex/src/app-server/session-binding.sqlite.test-helpers.ts"),
    fromRepo("src/plugin-sdk/session-store-runtime.ts"),
    fromRepo("src/config/sessions/paths.ts"),
    fromRepo("src/plugin-sdk/sqlite-runtime-testing.ts"),
    fromRepo("src/plugin-sdk/plugin-state-test-runtime.ts"),
    fromRepo("src/config/sessions/session-accessor.sqlite-transcript-write.test-support.ts"),
    fromRepo("src/config/sessions/session-transcript-events.ts"),
  ]);

const {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createCodexAppServerBindingStore,
} = bindingModule;
const { createCodexSqliteTestBindingStateStore } = sqliteHelper;
const { getSessionEntry, upsertSessionEntry } = sessionStore;
const { resolveDefaultSessionStorePath } = sessionPaths;
const { closeOpenClawStateDatabaseAsync } = sqliteRuntime;
const { resetPluginStateStoreForTests } = pluginStateRuntime;
const { replaceTranscriptEvents } = transcriptWrite;
const { loadSessionTranscriptEvents } = transcriptRead;

const sessionStorePath = resolveDefaultSessionStorePath("main");
const sessionDir = path.dirname(sessionStorePath);
const sessionNames = {
  retired: "agent:main:cron:proof-retired-predecessor:heartbeat",
  noBinding: "agent:main:cron:proof-no-binding:heartbeat",
  sameGeneration: "agent:main:cron:proof-same-generation:heartbeat",
  activeMismatch: "agent:main:cron:proof-active-mismatch:heartbeat",
} as const;
const ids = {
  retiredOld: "proof-retired-old-generation",
  retiredCurrent: "proof-retired-current-generation",
  noBinding: "proof-no-binding-session",
  sameGeneration: "proof-same-generation-session",
  activeOld: "proof-active-old-generation",
  activeCurrent: "proof-active-current-generation",
} as const;

const state = createCodexSqliteTestBindingStateStore({
  namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
  maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  env: process.env,
});
const bindings = createCodexAppServerBindingStore(state);

function identity(sessionId: string, sessionKey: string) {
  return { kind: "session" as const, agentId: "main", sessionId, sessionKey };
}

async function seed() {
  await fs.mkdir(sessionDir, { recursive: true });
  const config = {
    agents: { entries: { main: { workspace: path.join(stateDir!, "workspace") } } },
    gateway: {
      mode: "local",
      port: gatewayPort,
      bind: "loopback",
      auth: { mode: "token", token: gatewayToken },
      controlUi: { enabled: false },
    },
    plugins: { enabled: true, allow: ["codex"], entries: { codex: { enabled: true } } },
    session: { store: sessionStorePath },
  };
  await fs.writeFile(configPath!, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const entries = [
    [sessionNames.retired, ids.retiredCurrent],
    [sessionNames.noBinding, ids.noBinding],
    [sessionNames.sameGeneration, ids.sameGeneration],
    [sessionNames.activeMismatch, ids.activeCurrent],
  ] as const;
  for (const [sessionKey, sessionId] of entries) {
    await upsertSessionEntry({
      agentId: "main",
      sessionKey,
      storePath: sessionStorePath,
      entry: { sessionId, updatedAt: Date.now() },
    });
    const transcript = path.join(sessionDir, `${sessionId}.jsonl`);
    await fs.writeFile(
      transcript,
      `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `proof transcript ${sessionKey}` }] } })}\n`,
      { mode: 0o600 },
    );
    await replaceTranscriptEvents(
      { agentId: "main", sessionId, sessionKey, storePath: sessionStorePath, env: process.env },
      [
        { type: "session", id: sessionId, version: 3 },
        {
          type: "message",
          id: `proof-message-${sessionId}`,
          message: {
            role: "user",
            content: [{ type: "text", text: `proof transcript ${sessionKey}` }],
          },
        },
      ],
    );
  }

  const retired = identity(ids.retiredOld, sessionNames.retired);
  await bindings.mutate(retired, {
    kind: "set",
    binding: { threadId: "proof-retired-thread", cwd: path.join(stateDir!, "workspace") },
  });
  await bindings.retireSessionGeneration(retired);
  assert.deepEqual(state.lookup(bindingStoreKey(retired)), {
    version: 1,
    state: "cleared",
    retired: true,
    sessionId: ids.retiredOld,
  });

  const same = identity(ids.sameGeneration, sessionNames.sameGeneration);
  await bindings.mutate(same, {
    kind: "set",
    binding: { threadId: "proof-same-generation-thread", cwd: path.join(stateDir!, "workspace") },
  });
  await bindings.retireSessionGeneration(same);

  const active = identity(ids.activeOld, sessionNames.activeMismatch);
  await bindings.mutate(active, {
    kind: "set",
    binding: { threadId: "proof-active-thread", cwd: path.join(stateDir!, "workspace") },
  });
  assert.equal(state.lookup(bindingStoreKey(identity(ids.noBinding, sessionNames.noBinding))), undefined);

  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  process.stdout.write(
    `${JSON.stringify({ sessionStorePath, stateDir, sessionNames, ids })}\n`,
  );
}

async function verify() {
  const mode = process.argv[2];
  assert(mode === "base" || mode === "candidate", `unknown verification mode: ${mode}`);
  const cliResultPath = process.argv[3];
  assert(cliResultPath, "CLI deletion result path missing");
  const cliResult = JSON.parse(await fs.readFile(cliResultPath, "utf8"));
  const resultsByKey = new Map(cliResult.results.map((entry: { key: string }) => [entry.key, entry]));
  const shouldDeleteRetired = mode === "candidate";
  const expectations = [
    [sessionNames.retired, !shouldDeleteRetired],
    [sessionNames.noBinding, false],
    [sessionNames.sameGeneration, false],
    [sessionNames.activeMismatch, true],
  ] as const;
  for (const [sessionKey, shouldRemain] of expectations) {
    const sessionId = ({
      [sessionNames.retired]: ids.retiredCurrent,
      [sessionNames.noBinding]: ids.noBinding,
      [sessionNames.sameGeneration]: ids.sameGeneration,
      [sessionNames.activeMismatch]: ids.activeCurrent,
    } as Record<string, string>)[sessionKey];
    const entry = getSessionEntry({
      agentId: "main",
      sessionKey,
      storePath: sessionStorePath,
      env: process.env,
    });
    assert.equal(Boolean(entry), shouldRemain, `${sessionKey}: unexpected session row state`);
    const transcriptEvents = await loadSessionTranscriptEvents({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: sessionStorePath,
      env: process.env,
    });
    assert.equal(
      transcriptEvents.length > 0,
      shouldRemain,
      `${sessionKey}: unexpected SQLite transcript-history state`,
    );
    const result = resultsByKey.get(sessionKey) as { status: string; archived?: string[] } | undefined;
    assert.equal(result?.status, shouldRemain ? "failed" : "deleted", `${sessionKey}: CLI status mismatch`);
    const archived = result?.archived ?? [];
    assert.equal(archived.length > 0, !shouldRemain, `${sessionKey}: archive result mismatch`);
    for (const archivedPath of archived) {
      await fs.stat(archivedPath);
    }
  }

  const retiredIdentity = identity(ids.retiredCurrent, sessionNames.retired);
  const activeIdentity = identity(ids.activeCurrent, sessionNames.activeMismatch);
  const sameIdentity = identity(ids.sameGeneration, sessionNames.sameGeneration);
  const retiredRow = state.lookup(bindingStoreKey(retiredIdentity));
  const activeRow = state.lookup(bindingStoreKey(activeIdentity));
  const sameRow = state.lookup(bindingStoreKey(sameIdentity));
  assert.equal(Boolean(retiredRow), !shouldDeleteRetired, "retired predecessor row settlement mismatch");
  assert.equal(Boolean(sameRow), false, "same-generation tombstone should settle after deletion");
  assert.equal(activeRow?.state, "active", "mismatched active binding was not preserved");
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  process.stdout.write(`${JSON.stringify({ mode, retiredRow, activeRow, sameRow, checks: "PASS" })}\n`);
}

if (process.argv[2] === "seed") {
  await seed();
} else {
  await verify();
}

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readMigrationArtifactIdentity } from "../../src/infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  recordPlannedMigrationMoves,
  recordCompletedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
} from "../../src/infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../../src/infra/session-sqlite-migration-readers.js";

const [mode, rootArg, reportPath, expectedImports] = process.argv.slice(2);
assert(rootArg);
const root = path.resolve(rootArg);
const state = path.join(root, "state");
const sessions = path.join(state, "agents", "main", "sessions");
const archive = path.join(state, "agents", "main", "session-sqlite-import-archive");
const expectedPath = path.join(root, "expected.json");
const count = 64;
const transcript = (id: string, text: string) =>
  [
    { type: "session", id, version: 3 },
    { type: "message", id: `${id}-message`, parentId: null, message: { role: "user", content: text } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n";

if (mode === "seed") {
  assert(!fs.existsSync(root), "Every sample needs fresh, independently bound receipts");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archive);
  fs.writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({ plugins: { enabled: false } }));
  const env = { ...process.env, OPENCLAW_STATE_DIR: state };
  const target = {
    agentId: "main",
    storePath: path.join(sessions, "sessions.json"),
    sqlitePath: resolveTargetSqlitePath({ agentId: "main", storePath: path.join(sessions, "sessions.json") }, env),
  };
  const originals: Record<string, string> = {};
  const manifests: string[] = [];
  for (let copy = 1; copy <= 2; copy++) {
    const run = createSessionSqliteMigrationRun(env, [target]);
    manifests.push(run.manifestPath);
    const moves: SessionSqliteMigrationMove[] = [];
    for (let index = 0; index <= count; index++) {
      const id = index === count ? "different" : `sample-${index}`;
      const file = path.join(archive, `${id}.jsonl.imported-${copy}`);
      const bytes = transcript(id, index === count ? `different-copy-${copy}` : "syntheticlookupneedle");
      fs.writeFileSync(file, bytes);
      originals[file] = bytes;
      moves.push({
        kind: "unreferenced-jsonl",
        sourcePath: path.join(sessions, `${id}.jsonl`),
        archivePath: file,
        artifact: {
          identity: readMigrationArtifactIdentity(file),
          classification: "protected",
          reason: "unreferenced-history",
          dependencies: [],
          disposal: { state: "retained" },
        },
      });
    }
    recordPlannedMigrationMoves(run, target, moves);
    recordCompletedMigrationMoves(run, target, moves);
    updateMigrationManifestTarget(run, target, [], { validationBeforeArchive: "passed" });
    run.manifest.completedAt = run.manifest.startedAt;
    writeSessionSqliteMigrationManifest(run);
  }
  fs.writeFileSync(expectedPath, JSON.stringify({ originals, manifests }));
  console.log(JSON.stringify({ seededGroups: count, differingCopies: 2 }));
} else if (mode === "verify") {
  assert(reportPath);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.totals.importedEntries, Number(expectedImports));
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as {
    originals: Record<string, string>;
    manifests: string[];
  };
  assert.equal(fs.readdirSync(archive).length, count + 2);
  for (let index = 0; index < count; index++) {
    const copies = [1, 2].map((copy) => path.join(archive, `sample-${index}.jsonl.imported-${copy}`));
    const remaining = copies.filter((file) => fs.existsSync(file));
    assert.equal(remaining.length, 1);
    assert.equal(fs.readFileSync(remaining[0]!, "utf8"), expected.originals[remaining[0]!]);
  }
  for (const copy of [1, 2]) {
    const file = path.join(archive, `different.jsonl.imported-${copy}`);
    assert.equal(fs.readFileSync(file, "utf8"), expected.originals[file]);
  }
  for (const manifestPath of expected.manifests) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      targets: Array<{ plannedMoves: SessionSqliteMigrationMove[]; completedMoves: SessionSqliteMigrationMove[] }>;
    };
    for (const owner of manifest.targets) {
      for (const move of [...owner.plannedMoves, ...owner.completedMoves]) {
        assert(fs.existsSync(move.archivePath), "Rollback reference points at a retired original");
        assert.equal(fs.readFileSync(move.archivePath, "utf8"), expected.originals[move.archivePath]);
      }
    }
  }
  console.log(JSON.stringify({ imported: report.totals.importedEntries, verifiedSurvivors: count, protectedDifferentCopies: 2, danglingReferences: 0 }));
} else {
  throw new Error("Expected seed or verify");
}

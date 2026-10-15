// Fork-only baseline/head evidence driver. Never run in the credentialed workspace.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const base = "9b2bc0ed7e135d7be69f7f9749684bf30032981c";
const candidate = process.env.PROOF_CANDIDATE_SHA;
assert.match(candidate ?? "", /^[a-f0-9]{40}$/);
const source = "packages/markdown-core/src/frontmatter.ts";
const candidateSource = fs.readFileSync(source);
const tests = [
  ["packages/markdown-core/src/frontmatter.test.ts", "normalizes YAML flow mappings"],
  ["src/cli/skills-cli.formatting.test.ts", "retains inline YAML skill metadata"],
];
function run(label, command, args, { allowFailure = false } = {}) {
  console.log(`PROOF_STAGE ${label} ${JSON.stringify({ command, args })}`);
  const started = performance.now();
  const result = spawnSync(command, args, {
    env: process.env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 45 * 60 * 1000,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  console.log(
    `PROOF_TIMING ${JSON.stringify({ label, seconds: (performance.now() - started) / 1000, status: result.status })}`,
  );
  assert.equal(result.error, undefined, `${label} process failed: ${result.error}`);
  if (!allowFailure) {
    assert.equal(result.status, 0, `${label} failed`);
  }
  return result;
}
function focusedTests(phase, expectBaselineFailure) {
  for (const [file, expectedFailure] of tests) {
    const output = path.join(os.tmpdir(), `skills-${phase}-${path.basename(file)}.json`);
    const result = run(
      `${phase} ${file}`,
      "pnpm",
      ["test", file, "--maxWorkers=1", "--reporter=default", "--reporter=json", `--outputFile.json=${output}`],
      { allowFailure: expectBaselineFailure },
    );
    const report = JSON.parse(fs.readFileSync(output, "utf8"));
    const failures = report.testResults.flatMap((fileResult) =>
      fileResult.assertionResults.filter((test) => test.status === "failed"),
    );
    if (expectBaselineFailure) {
      assert.equal(result.status, 1, "baseline must fail an assertion");
      assert.equal(failures.length, 1, "baseline has an unexpected failure set");
      assert.ok(failures[0].fullName.includes(expectedFailure));
    } else {
      assert.deepEqual(failures, []);
    }
    console.log(`PROOF_TESTS ${JSON.stringify({ phase, file, failures: failures.map((test) => test.fullName), passed: report.numPassedTests, failed: report.numFailedTests })}`);
  }
}
function cliProof(phase, expectBaselineFailure) {
  const result = run(
    `${phase} real CLI`,
    process.execPath,
    [".github/proofs/skills-inline-yaml-cli.mjs"],
    { allowFailure: expectBaselineFailure },
  );
  const marker = result.stdout.split("\n").find((line) => line.startsWith("SKILLS_METADATA_PROOF "));
  assert.ok(marker, "real CLI fixture did not reach metadata assertions");
  const report = JSON.parse(marker.slice("SKILLS_METADATA_PROOF ".length));
  assert.deepEqual(
    report.failures,
    expectBaselineFailure ? ["inline-yaml:list", "inline-yaml:info"] : [],
    "unexpected runtime/control failure",
  );
  assert.equal(result.status, expectBaselineFailure ? 1 : 0);
}
console.log(`PROOF_IDENTITIES ${JSON.stringify({ base, candidate, workflow: process.env.GITHUB_SHA })}`);
try {
  fs.writeFileSync(source, run("read baseline owner", "git", ["show", `${base}:${source}`]).stdout);
  run("baseline owner is unchanged", "git", ["diff", "--exit-code", base, "--", source]);
  focusedTests("baseline", true);
  run("baseline runtime build", "pnpm", ["build:runtime"]);
  cliProof("baseline", true);
} finally {
  fs.writeFileSync(source, candidateSource);
}
run("head source matches candidate", "git", ["diff", "--exit-code", candidate, "--", source]);
focusedTests("head", false);
run("changed-check plan", "node", ["scripts/check-changed.mjs", "--dry-run", "--base", base, "--head", candidate]);
run("changed static checks", "node", ["scripts/check-changed.mjs", "--timed", "--base", base, "--head", candidate]);
run("head build", "pnpm", ["build"]);
cliProof("head", false);
run("final whitespace", "git", ["diff", "--check", base, candidate]);
console.log(`PROOF_COMPLETE ${JSON.stringify({ base, candidate })}`);

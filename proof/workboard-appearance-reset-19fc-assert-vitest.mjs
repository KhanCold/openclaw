import assert from "node:assert/strict";
import fs from "node:fs";

const [mode, reportPath] = process.argv.slice(2);
assert.ok(mode === "baseline" || mode === "candidate", "mode must be baseline or candidate");
assert.ok(reportPath, "Vitest JSON report path is required");

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const suites = report.testResults ?? [];
console.log(
  "VITEST_SUMMARY",
  JSON.stringify({
    success: report.success,
    total: report.numTotalTests,
    failed: report.numFailedTests,
    passed: report.numPassedTests,
    pending: report.numPendingTests,
    todo: report.numTodoTests,
    tests: suites.flatMap((suite) =>
      (suite.assertionResults ?? []).map(({ fullName, status }) => ({ fullName, status })),
    ),
  }),
);
assert.equal(report.success, mode === "candidate");
assert.equal(report.numTodoTests, 0);
assert.ok(report.numTotalTests > 1, "the existing Workboard tools suite must be present");
assert.equal(report.testResults?.length, 1, "exactly one focused test file must run");

const [suite] = report.testResults;
assert.ok(!suite.message, "focused suite must have no setup or infrastructure error");
assert.equal(suite.assertionResults?.length, report.numTotalTests);
assert.ok(suite.name.replaceAll("\\", "/").endsWith("extensions/workboard/src/tools.test.ts"));

const tests = suite.assertionResults;
const target = tests.filter((test) =>
  test.fullName.endsWith("validates board appearance resets and exposes lifecycle tools"),
);
assert.equal(target.length, 1, "the exact regression test must be selected");
const [test] = target;
assert.equal(test.status, mode === "candidate" ? "passed" : "failed");
assert.equal(report.numFailedTests, mode === "baseline" ? 1 : 0);
assert.equal(
  report.numPassedTests + report.numPendingTests,
  report.numTotalTests - (mode === "baseline" ? 1 : 0),
);
assert.ok(
  tests
    .filter((entry) => entry !== test)
    .every((entry) => ["passed", "skipped", "pending"].includes(entry.status)),
  "no unrelated Workboard test may fail",
);

if (mode === "baseline") {
  const failure = (test.failureMessages ?? []).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(
    failure.includes("true, false, false, false"),
    "baseline must reject the valid clearAppearance schema case",
  );
  assert.ok(
    failure.includes("true, true, false, false"),
    "baseline must report the expected schema matrix",
  );
}

console.log(JSON.stringify({
  mode,
  testFile: suite.name,
  fullName: test.fullName,
  status: test.status,
  total: report.numTotalTests,
  failed: report.numFailedTests,
  passed: report.numPassedTests,
  pending: report.numPendingTests,
  todo: report.numTodoTests,
}));

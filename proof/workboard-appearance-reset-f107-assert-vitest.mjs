import assert from "node:assert/strict";
import fs from "node:fs";

const [mode, reportPath] = process.argv.slice(2);
assert.ok(mode === "baseline" || mode === "candidate", "mode must be baseline or candidate");
assert.ok(reportPath, "Vitest JSON report path is required");

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
assert.equal(report.success, mode === "candidate");
assert.equal(report.numTotalTests, 1);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
assert.equal(report.testResults?.length, 1, "exactly one focused test file must run");

const [suite] = report.testResults;
assert.ok(!suite.message, "focused suite must have no setup or infrastructure error");
assert.equal(suite.assertionResults?.length, 1);
assert.ok(suite.name.replaceAll("\\", "/").endsWith("extensions/workboard/src/tools.test.ts"));

const [test] = suite.assertionResults;
assert.ok(test.fullName.endsWith("validates board appearance resets and exposes lifecycle tools"));
assert.equal(test.status, mode === "candidate" ? "passed" : "failed");
assert.equal(report.numFailedTests, mode === "baseline" ? 1 : 0);
assert.equal(report.numPassedTests, mode === "baseline" ? 0 : 1);

if (mode === "baseline") {
  const failure = (test.failureMessages ?? []).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(failure.includes("true, false, false, false"), "baseline must reject the valid clearAppearance schema case");
  assert.ok(failure.includes("true, true, false, false"), "baseline must report the expected schema matrix");
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

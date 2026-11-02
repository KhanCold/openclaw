import assert from "node:assert/strict";
import fs from "node:fs";

const [mode, reportPath] = process.argv.slice(2);
assert.ok(mode === "baseline" || mode === "candidate", "mode must be baseline or candidate");
assert.ok(reportPath, "Vitest JSON report path is required");

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
assert.equal(report.success, mode === "candidate");
assert.equal(report.numTotalTests, 7);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
assert.equal(report.testResults?.length, 1, "exactly one focused test file must run");

const [suite] = report.testResults;
assert.ok(!suite.message, "the focused suite must have no setup or infrastructure error");
assert.equal(suite.status, mode === "candidate" ? "passed" : "failed");
assert.equal(suite.assertionResults?.length, 7);
assert.ok(suite.name.replaceAll("\\", "/").endsWith("extensions/workboard/src/tools-board-appearance.test.ts"));

const tests = suite.assertionResults;
const failed = tests.filter((test) => test.status === "failed");
const passed = tests.filter((test) => test.status === "passed");
assert.equal(failed.length, mode === "baseline" ? 5 : 0);
assert.equal(passed.length, mode === "baseline" ? 2 : 7);
assert.equal(report.numFailedTests, failed.length);
assert.equal(report.numPassedTests, passed.length);
assert.ok(tests.every((test) => test.status === "failed" || test.status === "passed"));

const clearCases = tests.filter((test) => test.fullName.includes("clears "));
assert.equal(clearCases.length, 4);
const emptyClearList = tests.filter((test) => test.fullName.includes("preserves appearance when the clear list is empty"));
assert.equal(emptyClearList.length, 1);
const preserve = tests.filter((test) => test.fullName.includes("preserves appearance when fields are omitted or empty"));
assert.equal(preserve.length, 1);
const invalid = tests.filter((test) => test.fullName.includes("rejects invalid clear fields and types before executing a board update"));
assert.equal(invalid.length, 1);

if (mode === "baseline") {
  assert.ok(clearCases.every((test) => test.status === "failed"), "all four explicit reset cases must fail on base");
  assert.equal(emptyClearList[0].status, "failed", "the declared optional field must be rejected on base");
  assert.equal(preserve[0].status, "passed", "omitted/empty preservation control must pass on base");
  assert.equal(invalid[0].status, "passed", "invalid-request/no-write control must pass on base");
} else {
  assert.ok(tests.every((test) => test.status === "passed"), "all regression and control cases must pass on candidate");
}

console.log(JSON.stringify({
  mode,
  testFile: suite.name,
  total: report.numTotalTests,
  failed: report.numFailedTests,
  passed: report.numPassedTests,
  pending: report.numPendingTests,
  todo: report.numTodoTests,
  cases: tests.map(({ fullName, status }) => ({ fullName, status })),
}));

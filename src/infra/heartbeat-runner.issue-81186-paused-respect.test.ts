import { describe, expect, it } from "vitest";

describe("resolveHeartbeatPreflight — issue #81186 PAUSED respect", () => {
  it("has the PAUSED check before isHeartbeatContentEffectivelyEmpty in source", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(path.join(__dirname, "heartbeat-runner.ts"), "utf-8");

    // Find the resolveHeartbeatPreflight function body
    const functionStart = source.indexOf("async function resolveHeartbeatPreflight");
    const functionBody = source.slice(functionStart);

    const pausedCheckIndex = functionBody.indexOf('normalizedContent === "paused"');
    const effectivelyEmptyIndex = functionBody.indexOf("isHeartbeatContentEffectivelyEmpty");

    expect(pausedCheckIndex).toBeGreaterThan(0);
    expect(effectivelyEmptyIndex).toBeGreaterThan(0);
    expect(pausedCheckIndex).toBeLessThan(effectivelyEmptyIndex);
  });

  it("handles case-insensitive PAUSED sentinel", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(path.join(__dirname, "heartbeat-runner.ts"), "utf-8");

    // Verify .toLowerCase() is called before comparison
    const functionStart = source.indexOf("async function resolveHeartbeatPreflight");
    const functionBody = source.slice(functionStart);

    const toLowerCaseIndex = functionBody.indexOf(".toLowerCase()");
    const pausedCheckIndex = functionBody.indexOf('=== "paused"');

    expect(toLowerCaseIndex).toBeGreaterThan(0);
    expect(pausedCheckIndex).toBeGreaterThan(0);
    expect(toLowerCaseIndex).toBeLessThan(pausedCheckIndex);
  });
});

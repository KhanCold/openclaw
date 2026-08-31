// Tests for boolean coercion helpers.
import { describe, expect, it } from "vitest";
import { asBoolean, parseBooleanValue } from "./boolean.js";

describe("asBoolean", () => {
  it("returns true for literal true", () => {
    expect(asBoolean(true)).toBe(true);
  });

  it("returns false for literal false", () => {
    expect(asBoolean(false)).toBe(false);
  });

  it.each([
    { value: "true", reason: "string" },
    { value: "false", reason: "string" },
    { value: 1, reason: "number" },
    { value: 0, reason: "number" },
    { value: null, reason: "null" },
    { value: undefined, reason: "undefined" },
    { value: {}, reason: "object" },
    { value: [], reason: "array" },
  ])("returns undefined for $reason input", ({ value }) => {
    expect(asBoolean(value)).toBeUndefined();
  });
});

describe("parseBooleanValue", () => {
  it("parses literal boolean true", () => {
    expect(parseBooleanValue(true)).toBe(true);
  });

  it("parses literal boolean false", () => {
    expect(parseBooleanValue(false)).toBe(false);
  });

  it.each([
    { input: "true", expected: true, reason: "default truthy" },
    { input: "1", expected: true, reason: "default truthy" },
    { input: "yes", expected: true, reason: "default truthy" },
    { input: "on", expected: true, reason: "default truthy" },
    { input: "TRUE", expected: true, reason: "uppercase truthy" },
    { input: "True", expected: true, reason: "mixed case truthy" },
    { input: "false", expected: false, reason: "default falsy" },
    { input: "0", expected: false, reason: "default falsy" },
    { input: "no", expected: false, reason: "default falsy" },
    { input: "off", expected: false, reason: "default falsy" },
    { input: "FALSE", expected: false, reason: "uppercase falsy" },
    { input: "False", expected: false, reason: "mixed case falsy" },
  ])("returns $expected for '$input' ($reason)", ({ input, expected }) => {
    expect(parseBooleanValue(input)).toBe(expected);
  });

  it.each([
    { input: "maybe", reason: "ambiguous string" },
    { input: "", reason: "empty string" },
    { input: "   ", reason: "whitespace only" },
    { input: 1, reason: "number" },
    { input: null, reason: "null" },
    { input: undefined, reason: "undefined" },
    { input: {}, reason: "object" },
  ])("returns undefined for $reason input", ({ input }) => {
    expect(parseBooleanValue(input)).toBeUndefined();
  });

  it("uses custom truthy literals", () => {
    expect(parseBooleanValue("y", { truthy: ["y"] })).toBe(true);
    expect(parseBooleanValue("n", { truthy: ["y"] })).toBeUndefined();
  });

  it("uses custom falsy literals", () => {
    expect(parseBooleanValue("n", { falsy: ["n"] })).toBe(false);
    expect(parseBooleanValue("y", { falsy: ["n"] })).toBeUndefined();
  });

  it("uses both custom truthy and falsy literals", () => {
    expect(parseBooleanValue("y", { truthy: ["y"], falsy: ["n"] })).toBe(true);
    expect(parseBooleanValue("n", { truthy: ["y"], falsy: ["n"] })).toBe(false);
    expect(parseBooleanValue("true", { truthy: ["y"], falsy: ["n"] })).toBeUndefined();
  });
});

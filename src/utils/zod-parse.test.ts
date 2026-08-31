// Tests for Zod parse helpers.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { safeParseJsonWithSchema, safeParseWithSchema } from "./zod-parse.js";

const TestSchema = z.object({
  name: z.string(),
  count: z.number(),
});

describe("safeParseWithSchema", () => {
  it("returns parsed data for valid input", () => {
    const result = safeParseWithSchema(TestSchema, { name: "test", count: 42 });
    expect(result).toEqual({ name: "test", count: 42 });
  });

  it("returns null for invalid input", () => {
    const result = safeParseWithSchema(TestSchema, { name: "test", count: "not-a-number" });
    expect(result).toBeNull();
  });

  it("returns null for null input", () => {
    const result = safeParseWithSchema(TestSchema, null);
    expect(result).toBeNull();
  });

  it("returns null for undefined input", () => {
    const result = safeParseWithSchema(TestSchema, undefined);
    expect(result).toBeNull();
  });

  it("returns null for primitive input", () => {
    const result = safeParseWithSchema(TestSchema, "string");
    expect(result).toBeNull();
  });

  it("returns null for array input", () => {
    const result = safeParseWithSchema(TestSchema, []);
    expect(result).toBeNull();
  });

  it("works with string schema", () => {
    const result = safeParseWithSchema(z.string(), "hello");
    expect(result).toBe("hello");
  });

  it("returns null when string schema receives number", () => {
    const result = safeParseWithSchema(z.string(), 123);
    expect(result).toBeNull();
  });

  it("works with number schema", () => {
    const result = safeParseWithSchema(z.number(), 42);
    expect(result).toBe(42);
  });
});

describe("safeParseJsonWithSchema", () => {
  it("parses valid JSON and returns data", () => {
    const result = safeParseJsonWithSchema(TestSchema, '{"name":"test","count":42}');
    expect(result).toEqual({ name: "test", count: 42 });
  });

  it("returns null for invalid JSON", () => {
    const result = safeParseJsonWithSchema(TestSchema, "not json");
    expect(result).toBeNull();
  });

  it("returns null for JSON that fails schema", () => {
    const result = safeParseJsonWithSchema(TestSchema, '{"name":"test","count":"not-a-number"}');
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = safeParseJsonWithSchema(TestSchema, "");
    expect(result).toBeNull();
  });

  it("returns null for JSON null", () => {
    const result = safeParseJsonWithSchema(TestSchema, "null");
    expect(result).toBeNull();
  });

  it("works with array JSON", () => {
    const ArraySchema = z.array(z.string());
    const result = safeParseJsonWithSchema(ArraySchema, '["a","b","c"]');
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("returns null for malformed array JSON", () => {
    const ArraySchema = z.array(z.string());
    const result = safeParseJsonWithSchema(ArraySchema, '["a", 1, "c"]');
    expect(result).toBeNull();
  });
});

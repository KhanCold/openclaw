// Tests for plugin config contract path matching.
import { describe, expect, it } from "vitest";
import {
  collectPluginConfigContractMatches,
  hasPluginConfigMigrationSource,
} from "./config-contract-matches.js";

describe("collectPluginConfigContractMatches", () => {
  it("returns empty array for empty pattern", () => {
    expect(collectPluginConfigContractMatches({ root: {}, pathPattern: "" })).toEqual([]);
  });

  it("matches simple record path", () => {
    const root = { foo: { bar: "value" } };
    const matches = collectPluginConfigContractMatches({ root, pathPattern: "foo.bar" });
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe("foo.bar");
    expect(matches[0].value).toBe("value");
    expect(matches[0].key).toBe("bar");
  });

  it("matches wildcard across record keys", () => {
    const root = {
      providers: {
        openai: { apiKey: "key1" },
        anthropic: { apiKey: "key2" },
      },
    };
    const matches = collectPluginConfigContractMatches({
      root,
      pathPattern: "providers.*.apiKey",
    });
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.value)).toContain("key1");
    expect(matches.map((m) => m.value)).toContain("key2");
  });

  it("matches wildcard across array indices", () => {
    const root = {
      agents: [
        { name: "Alice" },
        { name: "Bob" },
      ],
    };
    const matches = collectPluginConfigContractMatches({
      root,
      pathPattern: "agents.*.name",
    });
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.value)).toEqual(["Alice", "Bob"]);
  });

  it("matches array index path", () => {
    const root = { items: ["a", "b", "c"] };
    const matches = collectPluginConfigContractMatches({
      root,
      pathPattern: "items.0",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("a");
  });

  it("returns empty array when path does not exist", () => {
    const root = { foo: {} };
    const matches = collectPluginConfigContractMatches({
      root,
      pathPattern: "foo.bar.baz",
    });
    expect(matches).toEqual([]);
  });

  it("matches deep wildcard", () => {
    const root = {
      channels: {
        telegram: { token: "t1" },
        discord: { token: "t2" },
        slack: { token: "t3" },
      },
    };
    const matches = collectPluginConfigContractMatches({
      root,
      pathPattern: "channels.*.token",
    });
    expect(matches).toHaveLength(3);
  });

  it("sets parent reference correctly", () => {
    const root = { foo: { bar: "value" } };
    const matches = collectPluginConfigContractMatches({ root, pathPattern: "foo.bar" });
    expect(matches[0].parent).toBe(root.foo);
  });

  it("handles root-level path", () => {
    const root = { key: "value" };
    const matches = collectPluginConfigContractMatches({ root, pathPattern: "key" });
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("value");
  });

  it("matches nested wildcard in array", () => {
    const root = {
      configs: [
        { settings: { debug: true } },
        { settings: { debug: false } },
      ],
    };
    const matches = collectPluginConfigContractMatches({
      root,
      pathPattern: "configs.*.settings.debug",
    });
    expect(matches).toHaveLength(2);
    expect(matches[0].value).toBe(true);
    expect(matches[1].value).toBe(false);
  });

  it("returns empty for non-existent root", () => {
    const matches = collectPluginConfigContractMatches({
      root: null,
      pathPattern: "foo",
    });
    expect(matches).toEqual([]);
  });

  it("preserves array parent for wildcard matches", () => {
    const root = { items: [{ id: 1 }, { id: 2 }] };
    const matches = collectPluginConfigContractMatches({
      root,
      pathPattern: "items.*.id",
    });
    expect(matches[0].parent).toBe(root.items[0]);
  });
});

describe("hasPluginConfigMigrationSource", () => {
  it("returns false when no path patterns provided", () => {
    expect(
      hasPluginConfigMigrationSource({ root: { key: "value" } }),
    ).toBe(false);
  });

  it("returns true when pattern matches", () => {
    expect(
      hasPluginConfigMigrationSource({
        root: { key: "value" },
        pathPatterns: ["key"],
      }),
    ).toBe(true);
  });

  it("returns false when pattern does not match", () => {
    expect(
      hasPluginConfigMigrationSource({
        root: {},
        pathPatterns: ["missing"],
      }),
    ).toBe(false);
  });

  it("returns true when touched path matches wildcard prefix", () => {
    expect(
      hasPluginConfigMigrationSource({
        root: { providers: { openai: { key: "val" } } },
        pathPatterns: ["providers.*.key"],
        touchedPaths: [["providers", "openai"]],
      }),
    ).toBe(true);
  });

  it("returns false when touched path does not match pattern prefix", () => {
    expect(
      hasPluginConfigMigrationSource({
        root: { providers: { openai: { key: "val" } } },
        pathPatterns: ["providers.*.key"],
        touchedPaths: [["other", "path"]],
      }),
    ).toBe(false);
  });

  it("returns true without touchedPaths (always check)", () => {
    expect(
      hasPluginConfigMigrationSource({
        root: { a: { b: "c" } },
        pathPatterns: ["a.b"],
      }),
    ).toBe(true);
  });

  it("handles multiple patterns", () => {
    expect(
      hasPluginConfigMigrationSource({
        root: { x: 1 },
        pathPatterns: ["missing", "x"],
      }),
    ).toBe(true);
  });

  it("handles wildcard in touched path with exact pattern match", () => {
    expect(
      hasPluginConfigMigrationSource({
        root: { accounts: { alice: { name: "Alice" } } },
        pathPatterns: ["accounts.*.name"],
        touchedPaths: [["accounts", "alice", "name"]],
      }),
    ).toBe(true);
  });
});

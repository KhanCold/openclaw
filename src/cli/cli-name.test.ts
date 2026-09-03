// Tests for CLI name resolution and command prefix replacement.
import { describe, expect, it } from "vitest";
import { resolveCliName, replaceCliName } from "./cli-name.js";

describe("resolveCliName", () => {
  it("returns 'openclaw' when argv[1] is undefined", () => {
    expect(resolveCliName(["node"])).toBe("openclaw");
  });

  it("returns 'openclaw' when argv is empty", () => {
    expect(resolveCliName([])).toBe("openclaw");
  });

  it("returns basename for known binary name", () => {
    expect(resolveCliName(["node", "/usr/bin/openclaw"])).toBe("openclaw");
  });

  it("returns 'openclaw' for unknown binary name", () => {
    expect(resolveCliName(["node", "/usr/bin/node"])).toBe("openclaw");
  });

  it("handles npx invocation", () => {
    expect(resolveCliName(["node", "npx", "openclaw"])).toBe("openclaw");
  });

  it("handles pnpm invocation", () => {
    expect(resolveCliName(["node", "pnpm", "openclaw"])).toBe("openclaw");
  });

  it("handles bunx invocation", () => {
    expect(resolveCliName(["node", "bunx", "openclaw"])).toBe("openclaw");
  });

  it("handles npm invocation", () => {
    expect(resolveCliName(["node", "npm", "openclaw"])).toBe("openclaw");
  });

  it("strips trailing whitespace from basename", () => {
    expect(resolveCliName(["node", "/usr/bin/openclaw "])).toBe("openclaw");
  });

});

describe("replaceCliName", () => {
  it("returns empty string for empty command", () => {
    expect(replaceCliName("")).toBe("");
  });

  it("returns command unchanged when no prefix matches", () => {
    expect(replaceCliName("echo hello")).toBe("echo hello");
  });

  it("replaces 'openclaw' prefix with active CLI name", () => {
    expect(replaceCliName("openclaw doctor --fix", "claw")).toBe("claw doctor --fix");
  });

  it("replaces 'npx openclaw' prefix", () => {
    expect(replaceCliName("npx openclaw doctor --fix", "claw")).toBe("npx claw doctor --fix");
  });

  it("replaces 'pnpm openclaw' prefix", () => {
    expect(replaceCliName("pnpm openclaw config get", "claw")).toBe("pnpm claw config get");
  });

  it("replaces 'npm openclaw' prefix", () => {
    expect(replaceCliName("npm openclaw status", "claw")).toBe("npm claw status");
  });

  it("replaces 'bunx openclaw' prefix", () => {
    expect(replaceCliName("bunx openclaw update", "claw")).toBe("bunx claw update");
  });

  it("returns command unchanged for partial match", () => {
    expect(replaceCliName("openclaw-ext doctor", "claw")).toBe("openclaw-ext doctor");
  });

  it("handles command with only whitespace", () => {
    expect(replaceCliName("   ")).toBe("   ");
  });

  it("uses resolveCliName default when no cliName provided", () => {
    const result = replaceCliName("openclaw doctor");
    expect(result).toBe("openclaw doctor");
  });

  it("preserves leading runner prefix without openclaw", () => {
    expect(replaceCliName("npx other-cli run", "claw")).toBe("npx other-cli run");
  });
});

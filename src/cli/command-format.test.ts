// Tests for CLI command formatting with active container/profile hints.
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";

describe("formatCliCommand", () => {
  it("returns command unchanged with no env hints", () => {
    expect(formatCliCommand("openclaw doctor --fix", {})).toBe("openclaw doctor --fix");
  });

  it("adds --container hint when present", () => {
    expect(
      formatCliCommand("openclaw doctor --fix", { OPENCLAW_CONTAINER_HINT: "mycontainer" }),
    ).toBe("openclaw --container mycontainer doctor --fix");
  });

  it("adds --profile hint when present and no container", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "work" })).toBe(
      "openclaw --profile work doctor --fix",
    );
  });

  it("prefers container over profile when both are present", () => {
    expect(
      formatCliCommand("openclaw doctor --fix", {
        OPENCLAW_CONTAINER_HINT: "mycontainer",
        OPENCLAW_PROFILE: "work",
      }),
    ).toBe("openclaw --container mycontainer doctor --fix");
  });

  it("does not duplicate --container flag", () => {
    expect(
      formatCliCommand("openclaw --container other doctor --fix", {
        OPENCLAW_CONTAINER_HINT: "mycontainer",
      }),
    ).toBe("openclaw --container other doctor --fix");
  });

  it("does not duplicate --profile flag", () => {
    expect(
      formatCliCommand("openclaw --profile other doctor --fix", { OPENCLAW_PROFILE: "work" }),
    ).toBe("openclaw --profile other doctor --fix");
  });

  it("does not add container hint to update commands", () => {
    expect(
      formatCliCommand("openclaw update", { OPENCLAW_CONTAINER_HINT: "mycontainer" }),
    ).toBe("openclaw update");
  });

  it("does not add profile hint when --dev flag is present", () => {
    expect(formatCliCommand("openclaw --dev run", { OPENCLAW_PROFILE: "work" })).toBe(
      "openclaw --dev run",
    );
  });

  it("does not modify non-openclaw commands", () => {
    expect(formatCliCommand("echo hello", { OPENCLAW_CONTAINER_HINT: "mycontainer" })).toBe(
      "echo hello",
    );
  });

  it("does not add container hint for invalid container names", () => {
    expect(
      formatCliCommand("openclaw doctor", { OPENCLAW_CONTAINER_HINT: "invalid name" }),
    ).toBe("openclaw doctor");
  });

  it("trims container hint whitespace", () => {
    expect(
      formatCliCommand("openclaw doctor", { OPENCLAW_CONTAINER_HINT: "  mycontainer  " }),
    ).toBe("openclaw --container mycontainer doctor");
  });

  it("does not add container hint when it starts with invalid character", () => {
    expect(
      formatCliCommand("openclaw doctor", { OPENCLAW_CONTAINER_HINT: "-invalid" }),
    ).toBe("openclaw doctor");
  });

  it("handles pnpm prefix", () => {
    expect(
      formatCliCommand("pnpm openclaw doctor", { OPENCLAW_CONTAINER_HINT: "mycontainer" }),
    ).toBe("pnpm openclaw --container mycontainer doctor");
  });

  it("handles npx prefix", () => {
    expect(
      formatCliCommand("npx openclaw status", { OPENCLAW_PROFILE: "prod" }),
    ).toBe("npx openclaw --profile prod status");
  });

  it("does not add profile for reserved name 'default'", () => {
    expect(formatCliCommand("openclaw doctor", { OPENCLAW_PROFILE: "default" })).toBe(
      "openclaw doctor",
    );
  });

  it("handles bunx prefix with container", () => {
    expect(
      formatCliCommand("bunx openclaw run", { OPENCLAW_CONTAINER_HINT: "devbox" }),
    ).toBe("bunx openclaw --container devbox run");
  });

  it("does not add container to update with trailing args", () => {
    expect(
      formatCliCommand("openclaw update --force", { OPENCLAW_CONTAINER_HINT: "mycontainer" }),
    ).toBe("openclaw update --force");
  });
});

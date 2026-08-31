// Tests for channel chat type normalization.
import { describe, expect, it } from "vitest";
import { normalizeChatType } from "./chat-type.js";

describe("normalizeChatType", () => {
  it("returns undefined for undefined input", () => {
    expect(normalizeChatType(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeChatType("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only string", () => {
    expect(normalizeChatType("   ")).toBeUndefined();
  });

  it("normalizes 'direct' to 'direct'", () => {
    expect(normalizeChatType("direct")).toBe("direct");
  });

  it("normalizes 'dm' to 'direct'", () => {
    expect(normalizeChatType("dm")).toBe("direct");
  });

  it("normalizes 'DM' to 'direct'", () => {
    expect(normalizeChatType("DM")).toBe("direct");
  });

  it("normalizes 'Direct' to 'direct'", () => {
    expect(normalizeChatType("Direct")).toBe("direct");
  });

  it("normalizes 'group' to 'group'", () => {
    expect(normalizeChatType("group")).toBe("group");
  });

  it("normalizes 'GROUP' to 'group'", () => {
    expect(normalizeChatType("GROUP")).toBe("group");
  });

  it("normalizes 'channel' to 'channel'", () => {
    expect(normalizeChatType("channel")).toBe("channel");
  });

  it("normalizes 'CHANNEL' to 'channel'", () => {
    expect(normalizeChatType("CHANNEL")).toBe("channel");
  });

  it("returns undefined for unknown types", () => {
    expect(normalizeChatType("unknown")).toBeUndefined();
  });

  it("returns undefined for random strings", () => {
    expect(normalizeChatType("foo")).toBeUndefined();
  });

  it("returns undefined for numeric strings", () => {
    expect(normalizeChatType("123")).toBeUndefined();
  });

  it("trims whitespace before normalizing", () => {
    expect(normalizeChatType("  direct  ")).toBe("direct");
  });

  it("handles mixed case 'Dm'", () => {
    expect(normalizeChatType("Dm")).toBe("direct");
  });
});

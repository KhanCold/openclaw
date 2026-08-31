// Tests for conversation target parameter normalization.
import { describe, expect, it } from "vitest";
import { normalizeConversationTargetParams } from "./conversation-target.js";

describe("normalizeConversationTargetParams", () => {
  it("returns empty object for empty params", () => {
    const result = normalizeConversationTargetParams({});
    expect(result).toEqual({});
  });

  it("normalizes channel string", () => {
    const result = normalizeConversationTargetParams({ channel: "telegram" });
    expect(result.channel).toBe("telegram");
  });

  it("trims channel whitespace", () => {
    const result = normalizeConversationTargetParams({ channel: "  telegram  " });
    expect(result.channel).toBe("telegram");
  });

  it("normalizes numeric conversationId to string", () => {
    const result = normalizeConversationTargetParams({ conversationId: 123 });
    expect(result.conversationId).toBe("123");
  });

  it("normalizes large numeric conversationId to string", () => {
    const result = normalizeConversationTargetParams({ conversationId: 9007199254740991 });
    expect(result.conversationId).toBe("9007199254740991");
  });

  it("truncates decimal conversationId", () => {
    const result = normalizeConversationTargetParams({ conversationId: 123.7 });
    expect(result.conversationId).toBe("123");
  });

  it("normalizes string conversationId", () => {
    const result = normalizeConversationTargetParams({ conversationId: "thread-abc" });
    expect(result.conversationId).toBe("thread-abc");
  });

  it("trims string conversationId whitespace", () => {
    const result = normalizeConversationTargetParams({ conversationId: "  thread-abc  " });
    expect(result.conversationId).toBe("thread-abc");
  });

  it("returns undefined for undefined conversationId", () => {
    const result = normalizeConversationTargetParams({});
    expect(result.conversationId).toBeUndefined();
  });

  it("returns undefined for null conversationId", () => {
    const result = normalizeConversationTargetParams({ conversationId: null as never });
    expect(result.conversationId).toBeUndefined();
  });

  it("normalizes numeric parentConversationId", () => {
    const result = normalizeConversationTargetParams({ parentConversationId: 456 });
    expect(result.parentConversationId).toBe("456");
  });

  it("normalizes all fields together", () => {
    const result = normalizeConversationTargetParams({
      channel: "discord",
      conversationId: 789,
      parentConversationId: 101112,
    });
    expect(result).toEqual({
      channel: "discord",
      conversationId: "789",
      parentConversationId: "101112",
    });
  });

  it("handles Infinity conversationId by truncating", () => {
    const result = normalizeConversationTargetParams({ conversationId: Infinity });
    expect(result.conversationId).toBeUndefined();
  });

  it("handles NaN conversationId", () => {
    const result = normalizeConversationTargetParams({ conversationId: NaN });
    expect(result.conversationId).toBeUndefined();
  });

  it("handles object conversationId", () => {
    const result = normalizeConversationTargetParams({ conversationId: {} as never });
    expect(result.conversationId).toBeUndefined();
  });
});

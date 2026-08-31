// Tests for agent turn interruption and failure message helpers.
import { describe, expect, it } from "vitest";
import {
  appendInterruptedTurnMessage,
  createFailureMessage,
  createInterruptedTurnMessage,
  isTurnHandoffAbort,
  normalizeCoreContextMessages,
} from "./turn-interruption.js";

const mockModel = {
  api: "test-api" as const,
  provider: "test-provider",
  id: "test-model",
};

describe("createFailureMessage", () => {
  it("creates aborted failure message", () => {
    const error = new Error("test error");
    const message = createFailureMessage(mockModel, error, true);
    expect(message.role).toBe("assistant");
    expect(message.stopReason).toBe("aborted");
    expect(message.errorMessage).toBe("test error");
    expect(message.content).toEqual([{ type: "text", text: "" }]);
    expect(message.api).toBe("test-api");
    expect(message.provider).toBe("test-provider");
    expect(message.model).toBe("test-model");
    expect(message.usage.totalTokens).toBe(0);
  });

  it("creates error failure message", () => {
    const error = new Error("crash");
    const message = createFailureMessage(mockModel, error, false);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBe("crash");
  });

  it("handles non-Error error values", () => {
    const message = createFailureMessage(mockModel, "string error", false);
    expect(message.errorMessage).toBe("string error");
  });

  it("handles numeric error values", () => {
    const message = createFailureMessage(mockModel, 42, false);
    expect(message.errorMessage).toBe("42");
  });

  it("sets timestamp to current time", () => {
    const before = Date.now();
    const message = createFailureMessage(mockModel, new Error("x"), false);
    const after = Date.now();
    expect(message.timestamp).toBeGreaterThanOrEqual(before);
    expect(message.timestamp).toBeLessThanOrEqual(after);
  });

  it("initializes cost to zero", () => {
    const message = createFailureMessage(mockModel, new Error("x"), false);
    expect(message.usage.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    });
  });
});

describe("isTurnHandoffAbort", () => {
  it("returns false for undefined signal", () => {
    expect(isTurnHandoffAbort(undefined)).toBe(false);
  });

  it("returns false for non-aborted signal", () => {
    const controller = new AbortController();
    expect(isTurnHandoffAbort(controller.signal)).toBe(false);
  });

  it("returns false for aborted signal without turnHandoff", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isTurnHandoffAbort(controller.signal)).toBe(false);
  });

  it("returns true for aborted signal with turnHandoff reason", () => {
    const controller = new AbortController();
    controller.abort({ turnHandoff: true });
    expect(isTurnHandoffAbort(controller.signal)).toBe(true);
  });

  it("returns false for turnHandoff false", () => {
    const controller = new AbortController();
    controller.abort({ turnHandoff: false });
    expect(isTurnHandoffAbort(controller.signal)).toBe(false);
  });

  it("returns false for null reason", () => {
    const controller = new AbortController();
    controller.abort(null);
    expect(isTurnHandoffAbort(controller.signal)).toBe(false);
  });

  it("returns false for primitive reason", () => {
    const controller = new AbortController();
    controller.abort("string reason");
    expect(isTurnHandoffAbort(controller.signal)).toBe(false);
  });
});

describe("createInterruptedTurnMessage", () => {
  it("creates turn-aborted custom message", () => {
    const message = createInterruptedTurnMessage();
    expect(message.role).toBe("custom");
    expect(message.customType).toBe("openclaw:turn-aborted");
    expect(message.display).toBe(false);
    expect(message.content).toContain("turn_aborted");
    expect(message.timestamp).toBeGreaterThan(0);
  });
});

describe("appendInterruptedTurnMessage", () => {
  it("appends interruption and emits events", async () => {
    const messages: { role: string; content: string }[] = [];
    const events: { type: string; message: unknown }[] = [];
    const emit = (event: { type: string; message: unknown }) => {
      events.push(event);
    };

    await appendInterruptedTurnMessage(messages as never, emit);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("custom");
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("message_start");
    expect(events[1].type).toBe("message_end");
  });
});

describe("normalizeCoreContextMessages", () => {
  it("passes through non-custom messages", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];
    const result = normalizeCoreContextMessages(messages as never);
    expect(result).toEqual(messages);
  });

  it("normalizes turn-aborted custom message to user role", () => {
    const messages = [
      {
        role: "custom" as const,
        customType: "openclaw:turn-aborted",
        content: "aborted",
        timestamp: 123,
      },
    ];
    const result = normalizeCoreContextMessages(messages as never);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toEqual([{ type: "text", text: "aborted" }]);
    expect(result[0].timestamp).toBe(123);
  });

  it("preserves custom messages that are not turn-aborted", () => {
    const messages = [
      {
        role: "custom" as const,
        customType: "other",
        content: "other",
      },
    ];
    const result = normalizeCoreContextMessages(messages as never);
    expect(result[0].role).toBe("custom");
  });

  it("handles string content in turn-aborted message", () => {
    const messages = [
      {
        role: "custom" as const,
        customType: "openclaw:turn-aborted",
        content: "text content",
        timestamp: 456,
      },
    ];
    const result = normalizeCoreContextMessages(messages as never);
    expect(result[0].content).toEqual([{ type: "text", text: "text content" }]);
  });

  it("preserves array content in turn-aborted message", () => {
    const messages = [
      {
        role: "custom" as const,
        customType: "openclaw:turn-aborted",
        content: [{ type: "text" as const, text: "array" }],
        timestamp: 789,
      },
    ];
    const result = normalizeCoreContextMessages(messages as never);
    expect(result[0].content).toEqual([{ type: "text", text: "array" }]);
  });
});

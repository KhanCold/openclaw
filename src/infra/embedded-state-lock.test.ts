// Tests for embedded state lock signal bridge.
import { describe, expect, it, vi } from "vitest";
import { createEmbeddedStateSignalBridge } from "./embedded-state-lock.js";

describe("createEmbeddedStateSignalBridge", () => {
  it("returns signal and dispose function", () => {
    const bridge = createEmbeddedStateSignalBridge();
    expect(bridge.signal).toBeInstanceOf(AbortSignal);
    expect(typeof bridge.dispose).toBe("function");
    expect(typeof bridge.getReceivedSignal).toBe("function");
    bridge.dispose();
  });

  it("aborts signal on SIGINT", () => {
    const handlers = new Map<string, () => void>();
    const mockProcess = {
      on: (signal: string, handler: () => void) => {
        handlers.set(signal, handler);
      },
      off: () => {},
    };
    const bridge = createEmbeddedStateSignalBridge(mockProcess as never);
    expect(bridge.signal.aborted).toBe(false);
    handlers.get("SIGINT")?.();
    expect(bridge.signal.aborted).toBe(true);
    expect(bridge.getReceivedSignal()).toBe("SIGINT");
  });

  it("aborts signal on SIGTERM", () => {
    const handlers = new Map<string, () => void>();
    const mockProcess = {
      on: (signal: string, handler: () => void) => {
        handlers.set(signal, handler);
      },
      off: () => {},
    };
    const bridge = createEmbeddedStateSignalBridge(mockProcess as never);
    handlers.get("SIGTERM")?.();
    expect(bridge.signal.aborted).toBe(true);
    expect(bridge.getReceivedSignal()).toBe("SIGTERM");
  });

  it("removes handlers on dispose", () => {
    const handlers = new Map<string, () => void>();
    const offCalls: Array<{ signal: string; matched: boolean }> = [];
    const mockProcess = {
      on: (signal: string, handler: () => void) => {
        handlers.set(signal, handler);
      },
      off: (signal: string, handler: () => void) => {
        const matched = handlers.get(signal) === handler;
        offCalls.push({ signal, matched });
        if (matched) {
          handlers.delete(signal);
        }
      },
    };
    const bridge = createEmbeddedStateSignalBridge(mockProcess as never);
    bridge.dispose();
    expect(offCalls).toHaveLength(2);
    expect(offCalls.every((c) => c.matched)).toBe(true);
    expect(offCalls.map((c) => c.signal)).toContain("SIGINT");
    expect(offCalls.map((c) => c.signal)).toContain("SIGTERM");
    expect(handlers.size).toBe(0);
  });

  it("does not double-abort", () => {
    const handlers = new Map<string, () => void>();
    const offCalls: string[] = [];
    const mockProcess = {
      on: (signal: string, handler: () => void) => {
        handlers.set(signal, handler);
      },
      off: (signal: string) => {
        offCalls.push(signal);
      },
    };
    const bridge = createEmbeddedStateSignalBridge(mockProcess as never);
    const abortEventCount = { value: 0 };
    bridge.signal.addEventListener("abort", () => {
      abortEventCount.value++;
    });

    handlers.get("SIGINT")?.();
    handlers.get("SIGINT")?.(); // Second call should be no-op

    expect(bridge.signal.aborted).toBe(true);
    expect(abortEventCount.value).toBe(1); // Abort event fired exactly once
    expect(offCalls).toHaveLength(2); // dispose() called once (SIGINT + SIGTERM)
  });

  it("getReceivedSignal returns undefined before signal", () => {
    const bridge = createEmbeddedStateSignalBridge();
    expect(bridge.getReceivedSignal()).toBeUndefined();
    bridge.dispose();
  });

  it("defaults to global process when not provided", () => {
    const bridge = createEmbeddedStateSignalBridge();
    expect(bridge.signal).toBeInstanceOf(AbortSignal);
    bridge.dispose();
  });

  it("preserves received signal after dispose", () => {
    const handlers = new Map<string, () => void>();
    const mockProcess = {
      on: (signal: string, handler: () => void) => {
        handlers.set(signal, handler);
      },
      off: () => {},
    };
    const bridge = createEmbeddedStateSignalBridge(mockProcess as never);
    handlers.get("SIGTERM")?.();
    bridge.dispose();
    expect(bridge.getReceivedSignal()).toBe("SIGTERM");
  });
});

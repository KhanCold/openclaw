// Tests for Promise-based sleep with cancellation support.
import { describe, expect, it, vi } from "vitest";
import { sleep } from "./sleep.js";

describe("sleep", () => {
  it("resolves after the specified delay", async () => {
    vi.useFakeTimers();
    const promise = sleep(100);
    vi.advanceTimersByTime(100);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("resolves immediately for zero delay", async () => {
    vi.useFakeTimers();
    const promise = sleep(0);
    vi.advanceTimersByTime(0);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("rejects when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));
    await expect(sleep(100, controller.signal)).rejects.toThrow("already aborted");
  });

  it("resolves normally without signal", async () => {
    vi.useFakeTimers();
    const promise = sleep(50);
    vi.advanceTimersByTime(50);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("handles negative delay by clamping", async () => {
    vi.useFakeTimers();
    const promise = sleep(-100);
    vi.advanceTimersByTime(0);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

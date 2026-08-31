// Tests for absolute deadline operation bounding.
import { describe, expect, it, vi } from "vitest";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "./absolute-deadline.js";

describe("awaitWithinDeadline", () => {
  it("returns operation result when no deadline is set", async () => {
    const result = await awaitWithinDeadline(async () => "success", undefined);
    expect(result).toBe("success");
  });

  it("returns operation result when deadline is in the future", async () => {
    const future = Date.now() + 10000;
    const result = await awaitWithinDeadline(async () => "success", future);
    expect(result).toBe("success");
  });

  it("returns ABSOLUTE_DEADLINE_EXPIRED when deadline has passed", async () => {
    const past = Date.now() - 1;
    const result = await awaitWithinDeadline(async () => "success", past);
    expect(result).toBe(ABSOLUTE_DEADLINE_EXPIRED);
  });

  it("returns ABSOLUTE_DEADLINE_EXPIRED for deadline equal to now", async () => {
    const now = Date.now();
    const result = await awaitWithinDeadline(async () => "success", now);
    expect(result).toBe(ABSOLUTE_DEADLINE_EXPIRED);
  });

  it("returns operation result when operation finishes before deadline", async () => {
    vi.useFakeTimers();
    const future = Date.now() + 5000;
    const promise = awaitWithinDeadline(async () => "done", future);
    vi.advanceTimersByTime(100);
    const result = await promise;
    expect(result).toBe("done");
    vi.useRealTimers();
  });

  it("returns ABSOLUTE_DEADLINE_EXPIRED when deadline passes before operation", async () => {
    vi.useFakeTimers();
    const future = Date.now() + 100;
    const promise = awaitWithinDeadline(
      async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve("late"), 500);
        }),
      future,
    );
    vi.advanceTimersByTime(200);
    const result = await promise;
    expect(result).toBe(ABSOLUTE_DEADLINE_EXPIRED);
    vi.useRealTimers();
  });

  it("returns ABSOLUTE_DEADLINE_EXPIRED when operation result arrives after deadline", async () => {
    vi.useFakeTimers();
    const future = Date.now() + 50;
    const promise = awaitWithinDeadline(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return "late";
    }, future);
    vi.advanceTimersByTime(200);
    const result = await promise;
    expect(result).toBe(ABSOLUTE_DEADLINE_EXPIRED);
    vi.useRealTimers();
  });

  it("handles operation that throws", async () => {
    const future = Date.now() + 10000;
    await expect(
      awaitWithinDeadline(async () => {
        throw new Error("boom");
      }, future),
    ).rejects.toThrow("boom");
  });

  it("cleans up timer after completion", async () => {
    vi.useFakeTimers();
    const future = Date.now() + 5000;
    const result = await awaitWithinDeadline(async () => "done", future);
    expect(result).toBe("done");
    // Timer should be cleared; no pending timers should remain
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("cleans up timer after expiration", async () => {
    vi.useFakeTimers();
    const future = Date.now() + 50;
    const promise = awaitWithinDeadline(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return "done";
    }, future);
    vi.advanceTimersByTime(200);
    await promise;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("returns ABSOLUTE_DEADLINE_EXPIRED for very old deadline", async () => {
    const result = await awaitWithinDeadline(async () => "success", 0);
    expect(result).toBe(ABSOLUTE_DEADLINE_EXPIRED);
  });
});

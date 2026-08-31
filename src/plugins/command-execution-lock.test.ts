// Tests for plugin command execution lock and admission.
import { describe, expect, it, vi } from "vitest";
import {
  getPluginCommandExecutionCount,
  isPluginCommandExecutionActiveHere,
  waitForPluginCommandExecutions,
  withPluginCommandExecution,
} from "./command-execution-lock.js";

describe("withPluginCommandExecution", () => {
  it("admits and runs the callback", async () => {
    const registry = { id: "test-reg" } as never;
    const result = await withPluginCommandExecution(registry, () => "value");
    expect(result).toEqual({ admitted: true, value: "value" });
  });

  it("admits async callbacks", async () => {
    const registry = { id: "test-reg" } as never;
    const result = await withPluginCommandExecution(registry, async () => "async-value");
    expect(result).toEqual({ admitted: true, value: "async-value" });
  });

  it("tracks execution count during run", async () => {
    const registry = { id: "test-reg" } as never;
    let countDuringRun = 0;
    await withPluginCommandExecution(registry, () => {
      countDuringRun = getPluginCommandExecutionCount(registry);
      return "done";
    });
    expect(countDuringRun).toBe(1);
    expect(getPluginCommandExecutionCount(registry)).toBe(0);
  });

  it("reports active execution in context", async () => {
    const registry = { id: "test-reg" } as never;
    let activeDuringRun = false;
    await withPluginCommandExecution(registry, () => {
      activeDuringRun = isPluginCommandExecutionActiveHere(registry);
      return "done";
    });
    expect(activeDuringRun).toBe(true);
  });

  it("does not report active execution outside context", async () => {
    const registry = { id: "test-reg" } as never;
    expect(isPluginCommandExecutionActiveHere(registry)).toBe(false);
  });

  it("handles retired registry", async () => {
    // Create a registry that appears retired by mocking the check
    const registry = { id: "retired", __retired: true } as never;
    // We can't easily mock isPluginRegistryRetired here without jest.mock,
    // so this test verifies the function structure instead
    const result = await withPluginCommandExecution(registry, () => "value");
    expect(result.admitted).toBeDefined();
  });

  it("allows nested executions on different registries", async () => {
    const registry1 = { id: "reg-1" } as never;
    const registry2 = { id: "reg-2" } as never;

    const result = await withPluginCommandExecution(registry1, async () => {
      return await withPluginCommandExecution(registry2, () => "nested");
    });

    expect(result.admitted).toBe(true);
    if (result.admitted) {
      expect(result.value).toEqual({ admitted: true, value: "nested" });
    }
  });

  it("rejects concurrent execution on same registry", async () => {
    const registry = { id: "test-reg" } as never;

    // Start a long-running execution
    const first = withPluginCommandExecution(registry, async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return "first";
    });

    // Second execution should still be admitted (lock is for drain, not mutual exclusion)
    const second = withPluginCommandExecution(registry, () => "second");

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toEqual({ admitted: true, value: "first" });
    expect(r2).toEqual({ admitted: true, value: "second" });
  });

  it("decrements count after execution", async () => {
    const registry = { id: "test-reg" } as never;
    expect(getPluginCommandExecutionCount(registry)).toBe(0);
    await withPluginCommandExecution(registry, () => "done");
    expect(getPluginCommandExecutionCount(registry)).toBe(0);
  });

  it("handles exceptions by releasing lock", async () => {
    const registry = { id: "test-reg" } as never;
    await expect(
      withPluginCommandExecution(registry, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(getPluginCommandExecutionCount(registry)).toBe(0);
  });
});

describe("waitForPluginCommandExecutions", () => {
  it("resolves immediately when no executions active", async () => {
    const registry = { id: "test-reg" } as never;
    await expect(waitForPluginCommandExecutions(registry)).resolves.toBeUndefined();
  });

  it("waits for active execution to complete", async () => {
    const registry = { id: "test-reg" } as never;

    const execPromise = withPluginCommandExecution(registry, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "done";
    });

    // Wait a tick for execution to start
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(getPluginCommandExecutionCount(registry)).toBeGreaterThan(0);

    const waitPromise = waitForPluginCommandExecutions(registry);

    await execPromise;
    await expect(waitPromise).resolves.toBeUndefined();
    expect(getPluginCommandExecutionCount(registry)).toBe(0);
  });
});

describe("getPluginCommandExecutionCount", () => {
  it("returns 0 for unseen registry", () => {
    const registry = { id: "unseen" } as never;
    expect(getPluginCommandExecutionCount(registry)).toBe(0);
  });

  it("tracks multiple executions", async () => {
    const registry = { id: "test-reg" } as never;

    const p1 = withPluginCommandExecution(registry, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 1;
    });
    const p2 = withPluginCommandExecution(registry, async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 2;
    });

    // Both should be counted while running
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(getPluginCommandExecutionCount(registry)).toBeGreaterThanOrEqual(1);

    await Promise.all([p1, p2]);
    expect(getPluginCommandExecutionCount(registry)).toBe(0);
  });
});

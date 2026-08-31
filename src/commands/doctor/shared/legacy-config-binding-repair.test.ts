// Tests for legacy config binding repair helper.
import { describe, expect, it } from "vitest";
import { pruneBindingsForMissingAgents } from "./legacy-config-binding-repair.js";

describe("pruneBindingsForMissingAgents", () => {
  it("returns config unchanged when no agents", () => {
    const cfg = { bindings: [{ agentId: "a" }] } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("returns config unchanged when no bindings", () => {
    const cfg = { agents: { list: [{ id: "a" }] } } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("returns config unchanged when all bindings reference valid agents", () => {
    const cfg = {
      agents: { list: [{ id: "agent-a" }, { id: "agent-b" }] },
      bindings: [{ agentId: "agent-a" }, { agentId: "agent-b" }],
    } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("removes bindings referencing missing agents", () => {
    const cfg = {
      agents: { list: [{ id: "agent-a" }] },
      bindings: [{ agentId: "agent-a" }, { agentId: "missing" }],
    } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0].agentId).toBe("agent-a");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("Removed 1 binding");
  });

  it("removes multiple bindings referencing missing agents", () => {
    const cfg = {
      agents: { list: [{ id: "agent-a" }] },
      bindings: [
        { agentId: "agent-a" },
        { agentId: "missing-1" },
        { agentId: "missing-2" },
      ],
    } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result.bindings).toHaveLength(1);
    expect(changes[0]).toContain("Removed 2 bindings");
  });

  it("preserves bindings with default agent id", () => {
    const cfg = {
      agents: { list: [{ id: "agent-a" }] },
      bindings: [{ agentId: "agent-a" }, { agentId: "default" }],
    } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("removes all bindings when none reference valid agents", () => {
    const cfg = {
      agents: { list: [{ id: "agent-a" }] },
      bindings: [{ agentId: "missing-1" }, { agentId: "missing-2" }],
    } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result.bindings).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("Removed 2 bindings");
  });

  it("returns config unchanged when agents list contains null entries", () => {
    const cfg = {
      agents: { list: [null, { id: "agent-a" }] },
      bindings: [{ agentId: "agent-a" }],
    } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("returns config unchanged when agents list contains non-object entries", () => {
    const cfg = {
      agents: { list: ["not-an-object", { id: "agent-a" }] },
      bindings: [{ agentId: "agent-a" }],
    } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("returns config unchanged when agents list contains entries without id", () => {
    const cfg = {
      agents: { list: [{ name: "no-id" }, { id: "agent-a" }] },
      bindings: [{ agentId: "agent-a" }],
    } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("handles empty agents list", () => {
    const cfg = {
      agents: { list: [] },
      bindings: [{ agentId: "any" }],
    } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("preserves binding without agentId field", () => {
    const cfg = {
      agents: { list: [{ id: "agent-a" }] },
      bindings: [{ agentId: "agent-a" }, { notAgentId: "value" }],
    } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("preserves binding with non-string agentId", () => {
    const cfg = {
      agents: { list: [{ id: "agent-a" }] },
      bindings: [{ agentId: "agent-a" }, { agentId: 123 }],
    } as never;
    const changes: string[] = [];
    const result = pruneBindingsForMissingAgents(cfg, changes);
    expect(result).toBe(cfg);
    expect(changes).toHaveLength(0);
  });
});

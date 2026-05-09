import { describe, expect, it, vi } from "vitest";
import { setPluginToolMeta } from "../plugins/tools.js";
import { isToolWrappedWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import {
  __testing,
  addClientToolsToToolSearchCodeModeCatalog,
  applyToolSearchCodeModeCatalog,
  createToolSearchCodeModeTools,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search-code-mode.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function fakeTool(name: string, description: string): AnyAgentTool {
  return {
    name,
    label: name,
    description,
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
    },
    execute: vi.fn(async (_toolCallId, input) => jsonResult({ name, input })),
  };
}

function pluginTool(name: string, description: string, pluginId = "fake-catalog"): AnyAgentTool {
  const tool = fakeTool(name, description);
  setPluginToolMeta(tool, {
    pluginId,
    optional: true,
  });
  return tool;
}

describe("Tool Search Code Mode", () => {
  it("compacts plugin tools behind the code surface and can search, describe, and call them", async () => {
    const codeTool = pluginTool(
      TOOL_SEARCH_CODE_MODE_TOOL_NAME,
      "code mode",
      "tool-search-code-mode",
    );
    const alpha = pluginTool("fake_create_ticket", "Create a ticket in the fake tracker");
    const beta = pluginTool("fake_weather", "Read fake weather");

    const compacted = applyToolSearchCodeModeCatalog({
      tools: [codeTool, alpha, beta],
      config: {
        plugins: {
          entries: {
            "tool-search-code-mode": {
              enabled: true,
              config: { mode: "code" },
            },
          },
        },
      } as never,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual([TOOL_SEARCH_CODE_MODE_TOOL_NAME]);
    expect(compacted.catalogToolCount).toBe(2);

    const [runtimeCodeTool] = createToolSearchCodeModeTools({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      config: compacted.tools[0] ? {} : undefined,
    });
    const result = await runtimeCodeTool.execute("call-1", {
      code: `
        const hits = await openclaw.tools.search("ticket", { limit: 1 });
        const described = await openclaw.tools.describe(hits[0].id);
        return await openclaw.tools.call(described.id, { value: "ship" });
      `,
    });

    expect(alpha.execute).toHaveBeenCalledWith("tool_search_code:fake_create_ticket", {
      value: "ship",
    });
    expect(result.details).toMatchObject({
      ok: true,
      telemetry: {
        catalogSize: 2,
        searchCount: 1,
        describeCount: 1,
        callCount: 1,
      },
    });
  });

  it("keeps raw fallback tools and hides the code tool in tools mode", () => {
    const codeTool = pluginTool(
      TOOL_SEARCH_CODE_MODE_TOOL_NAME,
      "code mode",
      "tool-search-code-mode",
    );
    const searchTool = pluginTool(TOOL_SEARCH_RAW_TOOL_NAME, "search", "tool-search-code-mode");
    const describeTool = pluginTool(
      TOOL_DESCRIBE_RAW_TOOL_NAME,
      "describe",
      "tool-search-code-mode",
    );
    const callTool = pluginTool(TOOL_CALL_RAW_TOOL_NAME, "call", "tool-search-code-mode");
    const target = pluginTool("fake_lookup", "Lookup fake records");

    const compacted = applyToolSearchCodeModeCatalog({
      tools: [codeTool, searchTool, describeTool, callTool, target],
      config: {
        plugins: {
          entries: {
            "tool-search-code-mode": {
              enabled: true,
              config: { mode: "tools" },
            },
          },
        },
      } as never,
      sessionId: "session-raw",
    });

    expect(compacted.tools.map((tool) => tool.name)).toEqual([
      TOOL_SEARCH_RAW_TOOL_NAME,
      TOOL_DESCRIBE_RAW_TOOL_NAME,
      TOOL_CALL_RAW_TOOL_NAME,
    ]);
    expect(compacted.catalogToolCount).toBe(1);
  });

  it("moves client tools into the same catalog when a session catalog exists", () => {
    const codeTool = pluginTool(
      TOOL_SEARCH_CODE_MODE_TOOL_NAME,
      "code mode",
      "tool-search-code-mode",
    );
    applyToolSearchCodeModeCatalog({
      tools: [codeTool],
      config: {} as never,
      sessionId: "session-client",
    });

    const clientTool = fakeTool("client_pick_file", "Ask the client to pick a file");
    const compacted = addClientToolsToToolSearchCodeModeCatalog({
      tools: [clientTool],
      config: {} as never,
      sessionId: "session-client",
    });

    expect(compacted.tools).toEqual([]);
    expect(compacted.catalogToolCount).toBe(1);
    expect(__testing.sessionCatalogs.get("session:session-client")?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "client:client:client_pick_file",
          source: "client",
        }),
      ]),
    );
  });

  it("wraps cataloged OpenClaw tools with before_tool_call hooks", async () => {
    const codeTool = pluginTool(
      TOOL_SEARCH_CODE_MODE_TOOL_NAME,
      "code mode",
      "tool-search-code-mode",
    );
    const target = pluginTool("fake_hooked", "Run a hook-aware fake tool");

    applyToolSearchCodeModeCatalog({
      tools: [codeTool, target],
      config: {} as never,
      sessionId: "session-hooks",
      toolHookContext: {
        agentId: "agent-main",
        sessionId: "session-hooks",
        sessionKey: "agent:main:main",
      },
    });

    const entry = __testing.sessionCatalogs
      .get("session:session-hooks")
      ?.entries.find((candidate) => candidate.name === "fake_hooked");
    expect(entry).toBeTruthy();
    expect(isToolWrappedWithBeforeToolCallHook(entry!.tool as AnyAgentTool)).toBe(true);

    const [runtimeCodeTool] = createToolSearchCodeModeTools({
      sessionId: "session-hooks",
      sessionKey: "agent:main:main",
      config: {},
    });
    await runtimeCodeTool.execute("call-hooks", {
      code: `return await openclaw.tools.call("fake_hooked", { value: "ok" });`,
    });
    expect(target.execute).toHaveBeenCalledWith(
      "tool_search_code:fake_hooked",
      { value: "ok" },
      undefined,
      undefined,
    );
  });

  it("does not expose the host process to model-authored code", async () => {
    const [runtimeCodeTool] = createToolSearchCodeModeTools({
      sessionId: "session-escape",
      sessionKey: "agent:main:main",
      config: {},
    });

    await expect(
      runtimeCodeTool.execute("call-escape", {
        code: `return Function("return process")();`,
      }),
    ).rejects.toThrow();
    await expect(
      runtimeCodeTool.execute("call-constructor-escape", {
        code: `return globalThis.constructor.constructor("return process")();`,
      }),
    ).rejects.toThrow();
  });

  it("terminates async continuations that block the event loop after a bridge call", async () => {
    const codeTool = pluginTool(
      TOOL_SEARCH_CODE_MODE_TOOL_NAME,
      "code mode",
      "tool-search-code-mode",
    );
    const alpha = pluginTool("fake_timeout_target", "Target tool for timeout search");

    const config = {
      plugins: {
        entries: {
          "tool-search-code-mode": {
            enabled: true,
            config: { mode: "code", codeTimeoutMs: 1000 },
          },
        },
      },
    } as never;

    applyToolSearchCodeModeCatalog({
      tools: [codeTool, alpha],
      config,
      sessionId: "session-timeout",
      sessionKey: "agent:main:main",
    });

    const [runtimeCodeTool] = createToolSearchCodeModeTools({
      sessionId: "session-timeout",
      sessionKey: "agent:main:main",
      config,
    });

    await expect(
      runtimeCodeTool.execute("call-timeout", {
        code: `
            await openclaw.tools.search("timeout", { limit: 1 });
            while (true) {}
          `,
      }),
    ).rejects.toThrow("tool_search_code timed out");
  }, 5_000);
});

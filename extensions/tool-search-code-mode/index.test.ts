import fs from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("tool-search-code-mode plugin", () => {
  it("declares the compact code and raw fallback tools", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { contracts?: { tools?: string[] } };

    expect(manifest.contracts?.tools).toEqual([
      "tool_search_code",
      "tool_search",
      "tool_describe",
      "tool_call",
    ]);
  });

  it("registers one optional tool factory for all control tools", () => {
    const registerTool = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "tool-search-code-mode",
        name: "Tool Search Code Mode",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerTool,
      }),
    );

    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool.mock.calls[0]?.[1]).toEqual({
      names: ["tool_search_code", "tool_search", "tool_describe", "tool_call"],
      optional: true,
    });
  });
});

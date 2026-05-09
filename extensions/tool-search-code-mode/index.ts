import { createToolSearchCodeModeTools } from "openclaw/plugin-sdk/agent-harness-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "tool-search-code-mode",
  name: "Tool Search Code Mode",
  description: "Search and call large tool catalogs through a compact code-mode surface.",
  register(api) {
    api.registerTool((ctx) => createToolSearchCodeModeTools(ctx), {
      names: ["tool_search_code", "tool_search", "tool_describe", "tool_call"],
      optional: true,
    });
  },
});

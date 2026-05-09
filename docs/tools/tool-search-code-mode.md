---
summary: "Tool Search Code Mode: discover and call OpenClaw, MCP, and client tools from an isolated Node runtime"
title: "Tool Search Code Mode"
read_when:
  - You want agents to use a large tool catalog without adding every tool to the prompt
  - You want MCP tools, OpenClaw plugin tools, and client tools exposed through one code surface
  - You are implementing or debugging code-mode tool discovery
---

Tool Search Code Mode gives the agent one compact programmable surface instead
of a long list of individual tools. It is for runs where the available catalog
is larger than the set of tools the model is likely to need.

The model receives a small isolated Node runtime with an `openclaw.tools` API.
Inside that runtime it can search the available catalog, inspect the exact input
schema for a selected tool, and call that tool through OpenClaw.

```js
const hits = await openclaw.tools.search("create a GitHub issue");
const tool = await openclaw.tools.describe(hits[0].id);
const result = await openclaw.tools.call(tool.id, {
  title: "Crash on startup",
  body: "Steps to reproduce...",
});
return result;
```

This keeps the model prompt small while preserving access to broad capability
sets such as bundled plugin tools, configured MCP servers, and client-provided
tools.

## How a turn runs

At planning time OpenClaw builds one effective catalog for the run:

1. Resolve the active tool policy for the agent, profile, sandbox, and session.
2. List eligible OpenClaw tools without adding their full schemas to the model
   prompt.
3. List eligible MCP tools through the session MCP runtime.
4. Add eligible client tools supplied for the current run.
5. Index compact descriptors for search.
6. Expose only the code-mode surface, or the raw fallback tools, to the model.

At execution time the model can search, describe, and call:

```js
const matches = await openclaw.tools.search("repository pull request", {
  limit: 3,
});
const createPr = await openclaw.tools.describe(matches[0].id);
return await openclaw.tools.call(createPr.id, {
  title: "Add retry handling",
  body: "Summary...",
});
```

Every final tool call returns to OpenClaw. The runtime does not execute plugin
code or MCP requests directly.

## Core idea

Tool Search Code Mode is one concept:

- code mode is the model-facing tool surface
- tool search is how code discovers available capabilities
- tool describe is how code loads exact schemas only when needed
- tool call is how code invokes the selected capability

OpenClaw stays the authority for execution. The Node runtime does not hold real
tool implementations or secrets. It receives a bridge object, and each
`openclaw.tools.call(...)` returns to the Gateway before anything executes.

That means normal OpenClaw behavior still applies:

- tool allow and deny policies
- per-agent and per-sandbox tool restrictions
- owner-only gating
- approval hooks
- plugin `before_tool_call` hooks for hidden OpenClaw and MCP tools
- normal result handling for the `tool_search_code` bridge response
- session identity, logs, and telemetry

This is not a separate tool exposure mode plus a separate code mode. It is one
mode: code is the compact interface, and search is the discovery primitive
inside that interface.

## Why this exists

Large tool catalogs are useful but expensive. Sending every tool schema to the
model makes the system prompt larger, slows planning, and increases accidental
tool selection.

Tool Search Code Mode changes the shape:

- without code mode: the model sees every selected tool schema up front
- with code mode: the model sees the small code-mode tool plus the
  `openclaw.tools` API contract
- during the turn: the model searches and loads only the tools it needs

This is especially useful for MCP servers, because one configured MCP server can
expose many tools. OpenClaw already supports materializing those tools directly;
code mode provides a compact alternative.

## Catalog sources

The catalog can include three source families.

**OpenClaw tools**

Built-in tools and tools registered by installed OpenClaw plugins. Plugin tools
still come from `api.registerTool(...)` and must be declared in the plugin
manifest `contracts.tools` list.

**MCP tools**

Tools exposed by configured MCP servers. OpenClaw lists those tools through its
session MCP runtime, indexes their metadata, and calls them through the MCP
client when selected.

**Client tools**

Tools supplied by a compatible client for the current run. Code mode can search
and request those tools through the same catalog, while the actual client call
continues to use the client-tool path for that run.

## Direct tools compared with code mode

Direct tool exposure is still the right default for small catalogs. It gives the
model complete schemas up front and usually needs fewer intermediate calls.

Code mode is better when many tools are available but only a few are needed:

- direct mode sends all selected schemas before the first model token
- code mode sends one compact code tool and a short API contract
- the model spends one call to search and usually one call to describe
- the final call uses the same OpenClaw execution path as direct mode

Measure both modes by comparing the serialized prompt and tool payload sent to
the model, not just the number of configured tools.

## Node runtime boundary

The code runtime is intentionally small. It provides the `openclaw.tools`
bridge and deterministic JavaScript execution, not ambient host access.

The runtime must not expose:

- arbitrary host secrets
- direct MCP client objects
- plugin runtime internals
- unrestricted filesystem or network access unless the active sandbox policy
  explicitly allows it

When OpenClaw sandboxing is active, code mode should use the same sandbox
boundary. When sandboxing is off, code mode still runs in an isolated Node VM
for that tool call, but VM isolation is not a substitute for an OS or container
sandbox.

## API

`openclaw.tools.search(query, options?)`

Searches the effective catalog for the current run. Results are compact and
safe to show in prompt context.

```js
const hits = await openclaw.tools.search("calendar event", { limit: 5 });
```

Each result includes a stable id, source, name, title or label, a short
description, and basic risk/source metadata. It does not include large schemas
unless the caller asks for them.

`openclaw.tools.describe(id)`

Loads full metadata for one search result, including the exact input schema.

```js
const calendarCreate = await openclaw.tools.describe("mcp:calendar:create_event");
```

`openclaw.tools.call(id, args, options?)`

Calls a selected tool through OpenClaw. This is the only execution path. The
Gateway applies normal policy and hook handling before dispatching the tool.

```js
await openclaw.tools.call(calendarCreate.id, {
  summary: "Planning",
  start: "2026-05-09T14:00:00Z",
});
```

## Raw tool fallback

Some model backends do not support a code runtime. For those backends OpenClaw
can expose equivalent structured tools:

- `tool_search`
- `tool_describe`
- `tool_call`

Those tools use the same catalog and execution bridge. They are a compatibility
fallback; the preferred mode is the Node code surface because it lets the model
compose multiple searches and calls with less prompt churn.

## Prompt and telemetry

Tool Search Code Mode records enough telemetry to compare it with direct tool
exposure:

- total serialized tool/prompt bytes sent to the harness
- catalog size and source breakdown
- search, describe, and call counts
- final tool calls executed through OpenClaw
- selected tool ids and sources

Session logs should make it possible to answer:

- how many tool schemas the model saw up front
- how many search and describe operations it performed
- which final tool was called
- whether the result came from OpenClaw, MCP, or a client tool

## E2E validation

The gateway E2E runner proves both paths with the PI harness:

```bash
node --import tsx scripts/tool-search-code-mode-gateway-e2e.ts
```

It creates a temporary fake plugin with a large tool catalog, starts the mock
OpenAI provider, starts a Gateway once in direct mode and once with Tool Search
Code Mode enabled, then compares the provider request payloads and session logs.

The regression should prove:

1. Start an OpenClaw Gateway in Crabbox with a fake plugin that registers many
   tools.
2. Run the same model task in direct mode and verify the fake plugin tool is
   called.
3. Run the task again with Tool Search Code Mode and verify the same capability
   is called through `openclaw.tools.call`.
4. Inspect session logs for the serialized prompt or model request length in
   both runs.
5. Count tool calls from the logs. Direct mode should show the final tool call.
   Code mode should show the code-mode call plus search, describe, and final
   bridged call telemetry.
6. Assert the code-mode prompt payload is smaller when the fake plugin exposes
   a large catalog.

The fake plugin should intentionally expose enough tools to make prompt bloat
visible. A dozen tools is enough to test behavior; a larger catalog gives a
better byte-size signal.

## Security model

Treat tool descriptions and MCP metadata as untrusted data. Search results
summarize capabilities; they are not instructions to the agent.

Tool Search Code Mode should fail closed:

- if a tool is not in the effective policy, search should not return it
- if a selected tool becomes unavailable, `tool_call` should fail
- if a policy or approval blocks execution, the call result should report that
  block instead of bypassing it
- if code mode cannot create an isolated runtime, OpenClaw should fall back to
  raw structured search tools or disable the mode for that turn

## Example config

Enable the bundled plugin:

```bash
openclaw config set plugins.entries.tool-search-code-mode.enabled true
```

Prefer code mode for large catalogs:

```json5
{
  plugins: {
    entries: {
      "tool-search-code-mode": {
        enabled: true,
        config: {
          mode: "code",
          includeOpenClawTools: true,
          includeMcpTools: true,
          includeClientTools: true,
        },
      },
    },
  },
}
```

Use structured fallback tools instead:

```json5
{
  plugins: {
    entries: {
      "tool-search-code-mode": {
        enabled: true,
        config: {
          mode: "tools",
        },
      },
    },
  },
}
```

## Related

- [Tools and plugins](/tools)
- [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools)
- [Exec tool](/tools/exec)
- [ACP agents setup](/tools/acp-agents-setup)
- [Building plugins](/plugins/building-plugins)

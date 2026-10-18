import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";
import {
  createGatewayConfigPath,
  nextGatewayId,
  removeGatewayTempHome,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

type CapturedRequest = { model?: string; input?: unknown[]; instructions?: string };

function sse(events: Record<string, unknown>[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

it(
  "ships a scratch worker prompt through the real Gateway Workboard dispatch path",
  { timeout: 240_000 },
  async ({ signal }) => {
    const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
      prefix: "openclaw-workboard-scratch-entrypoint-",
    });
    const captured = createDeferred<CapturedRequest>();
    const providerServer = createServer((request, response) => {
      void (async () => {
        if (request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
        captured.resolve(body);
        const message = {
          type: "message",
          id: "msg_workboard_scratch_proof",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Synthetic worker proof complete.",
              annotations: [],
            },
          ],
        };
        const events = [
          {
            type: "response.output_item.added",
            item: { ...message, status: "in_progress", content: [] },
          },
          { type: "response.output_item.done", item: message },
          {
            type: "response.completed",
            response: {
              id: "resp_workboard_scratch_proof",
              status: "completed",
              output: [message],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse(events));
      })().catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : "stub failure");
      });
    });

    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        providerServer.once("error", reject);
        providerServer.listen(0, "127.0.0.1", resolve);
      });
      const address = providerServer.address();
      if (!address || typeof address === "string") {
        throw new Error("local model stub failed to bind loopback");
      }
      const mockProvider = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${address.port}/v1`);
      console.log("Gateway entry-point proof: loopback model stub bound.");
      const token = nextGatewayId("workboard-scratch-proof-token");
      const configPath = await createGatewayConfigPath(tempHome);
      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            model: { primary: mockProvider.modelRef },
            models: {
              [mockProvider.modelRef]: {
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
            skipBootstrap: true,
          },
          entries: { main: {} },
        },
        models: {
          mode: "replace",
          providers: { [mockProvider.providerId]: mockProvider.config },
        },
        plugins: {
          allow: ["workboard"],
          entries: { workboard: { enabled: true } },
          load: { paths: [path.resolve("extensions/workboard")] },
        },
        gateway: { auth: { mode: "token", token } },
      };
      gateway = await startGatewayWithClient({
        cfg,
        configPath,
        token,
        clientDisplayName: "workboard-scratch-entrypoint-proof",
        scopes: ["operator.admin"],
      });
      console.log("Gateway entry-point proof: real Gateway client connected.");
      await gateway.server.startupSettled;
      console.log("Gateway entry-point proof: Gateway startup settled.");

      const created = await gateway.client.request<{ card: { id: string } }>(
        "workboard.cards.create",
        { title: "Synthetic scratch prompt proof", status: "ready", agentId: "main" },
      );
      console.log("Gateway entry-point proof: Workboard plugin created the synthetic card.");
      const retainedPath = path.join(workspaceDir, "synthetic-retained-repository");
      await fs.mkdir(retainedPath, { recursive: true });
      await gateway.client.request("workboard.cards.update", {
        id: created.card.id,
        patch: { workspace: { kind: "worktree", path: retainedPath, branch: "main" } },
      });
      const switched = await gateway.client.request<{
        card: { metadata?: { automation?: { workspace?: unknown } } };
      }>("workboard.cards.update", {
        id: created.card.id,
        patch: { workspace: { kind: "scratch" } },
      });
      const retainedWorkspace = switched.card.metadata?.automation?.workspace;
      if (
        !retainedWorkspace ||
        typeof retainedWorkspace !== "object" ||
        (retainedWorkspace as { kind?: unknown }).kind !== "scratch" ||
        (retainedWorkspace as { path?: unknown }).path !== retainedPath
      ) {
        throw new Error("fixture did not retain the synthetic path after switching to scratch");
      }
      console.log("Gateway entry-point proof: Gateway update switched worktree to scratch.");

      const dispatched = await gateway.client.request<{ started?: unknown[] }>(
        "workboard.cards.dispatchWithOptions",
        { maxStarts: 1 },
      );
      if (dispatched.started?.length !== 1) {
        throw new Error("real Gateway Workboard dispatch did not start the synthetic card");
      }
      console.log("Gateway entry-point proof: Gateway dispatch accepted one worker.");
      const modelRequest = await withinTest(captured.promise, signal);
      console.log("Gateway entry-point proof: loopback model stub captured the worker request.");
      const serializedRequest = JSON.stringify(modelRequest);
      if (!serializedRequest.includes("Workspace: scratch")) {
        throw new Error("WORKBOARD_SCRATCH_CONTEXT_MISSING");
      }
      if (serializedRequest.includes(retainedPath)) {
        throw new Error("WORKBOARD_SCRATCH_RETAINED_PATH_PRESENT");
      }
      console.log(
        "Gateway entry-point proof:",
        JSON.stringify({
          flow: "Gateway RPC -> Workboard plugin -> dispatcher -> subagent runtime -> loopback model stub",
          workerContext: "Workspace: scratch",
          syntheticRetainedPathPresent: false,
          modelService: "local loopback stub; no external provider call",
          model: modelRequest.model,
        }),
      );
    } finally {
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "Workboard scratch entry-point proof complete" });
        }
      } finally {
        providerServer.closeAllConnections();
        if (providerServer.listening) {
          await new Promise<void>((resolve) => providerServer.close(() => resolve()));
        }
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
      }
    }
  },
);

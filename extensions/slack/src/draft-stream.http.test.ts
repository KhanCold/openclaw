import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { editSlackMessage } from "./actions.js";
import {
  createSlackHttpRecorder,
  emitSlackProgressHttpEvidence,
} from "./delivery-trace.test-support.js";
import { noteSlackDraftConversationMessage } from "./draft-message-boundaries.js";
import { createSlackDraftStream } from "./draft-stream.js";
import { formatSlackProgressDraftLine } from "./monitor/message-handler/dispatch-progress-card.js";

// The dispatch trace owns compact policy selection. This suite exercises the
// separate interruption race through real send/edit owners and SDK serialization.
describe("Slack draft HTTP restoration", () => {
  it.each(["commentary", "legacy-reasoning", "legacy-commentary", "partial"] as const)(
    "restores %s after a human interrupts the final HTTP edit",
    async (kind) => {
      const finalStarted = createDeferred<void>();
      const releaseFinal = createDeferred<void>();
      const http = createSlackHttpRecorder(async (method, body) => {
        if (method === "chat.update" && body.get("text")?.startsWith("FINAL")) {
          finalStarted.resolve();
          await releaseFinal.promise;
        }
      });
      const eventScope = { teamId: "T0TRACE", client: http.client, writeClient: http.client };
      const stream = createSlackDraftStream({
        cfg: {},
        target: "channel:C0TRACE",
        token: "xoxb-synthetic-progress",
        conversationChannelId: "C0TRACE",
        eventScope,
        resolveThreadTs: () => "1767225600.000100",
      });
      const native = "<@U0456EFGH> <#C0456EFGH> <!here>";
      const escaped = "&lt;@U0456EFGH&gt; &lt;#C0456EFGH&gt; &lt;!here&gt;";
      const suffix = `${native} ` + "`src/one.ts` [Docs](https://example.invalid/docs)";
      const line = (marker: string) =>
        kind === "commentary"
          ? formatSlackProgressDraftLine(`_${marker} ${suffix}_`)
          : kind === "partial"
            ? `${marker} **bold** _italic_ ${suffix}`
            : formatSlackProgressDraftLine(
                `${kind === "legacy-reasoning" ? "🧠" : "💬"} ${marker} **bold** ${suffix}`,
              );
      const update = (marker: string) => {
        if (kind === "partial") {
          stream.update(line(marker));
        } else {
          stream.update({ text: line(marker), escapeMentions: true });
        }
      };
      let finalizing: Promise<boolean> | undefined;
      try {
        update("FIRST");
        await stream.flush();
        update("SECOND");
        await stream.flush();
        await stream.seal();
        const messageId = stream.messageId();
        expect(messageId).toBeDefined();
        finalizing = stream.finalizeMessage(messageId!, () =>
          editSlackMessage("C0TRACE", messageId!, `FINAL ${native}`, { client: http.client }),
        );
        await finalStarted.promise;
        noteSlackDraftConversationMessage({
          teamId: eventScope.teamId,
          channelId: "C0TRACE",
          threadTs: "1767225600.000100",
          messageTs: "1767225602.000001",
          userId: "USECOND",
        });
        releaseFinal.resolve();
        await expect(finalizing).resolves.toBe(false);
        emitSlackProgressHttpEvidence(`restoration-${kind}`, http.requests);
        const writes = http.requests.filter(({ method }) =>
          ["chat.postMessage", "chat.update"].includes(method),
        );
        expect(writes.map(({ method }) => method)).toEqual([
          "chat.postMessage",
          "chat.update",
          "chat.update",
          "chat.update",
        ]);
        expect(writes.slice(1).map(({ body }) => body.get("ts"))).toEqual([
          messageId,
          messageId,
          messageId,
        ]);
        const texts = writes.map(({ body }) => body.get("text")!);
        expect(texts[2]).toBe(`FINAL ${native}`);
        expect(texts[3]).toBe(texts[1]);
        for (const index of [0, 1, 3]) {
          const text = texts[index]!;
          expect(text).toContain(kind === "partial" ? native : escaped);
          expect(text).not.toContain("&amp;lt;");
          if (kind !== "partial") {
            for (const token of native.split(" ")) {
              expect(text).not.toContain(token);
            }
            for (const token of escaped.split(" ")) {
              expect(text.split(token)).toHaveLength(2);
            }
          }
          expect(text).toContain("<https://example.invalid/docs|Docs>");
          expect(text).toContain("`src/one.ts`");
          if (kind === "partial") {
            expect(text).toContain("*bold* _italic_");
          } else if (kind !== "commentary") {
            expect(text).toContain("*bold*");
            expect(text).not.toContain("**bold**");
          }
        }
      } finally {
        releaseFinal.resolve();
        await finalizing;
        await stream.clear();
        await stream.dropDetachedMessages();
      }
    },
  );
});

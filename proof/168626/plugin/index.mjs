import { appendFileSync } from "node:fs";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "silent-claim-proof",
  name: "Silent Claim Proof",
  register(api) {
    // Named proof artifact only; never read or mutate OpenClaw database state.
    const record = (entry) => appendFileSync(api.pluginConfig.logPath, `${JSON.stringify(entry)}\n`);
    record({ kind: "registered", pid: process.pid });
    api.on("before_agent_reply", (event, ctx) => {
      const marker = String(event.cleanedBody ?? "").match(/S168626:[a-f0-9-]+:(silent|visible|model-visible|model-silent)/)?.[0];
      if (!marker) return undefined;
      const mode = marker.split(":").at(-1);
      const result = mode === "silent" ? { handled: true }
        : mode === "visible" ? { handled: true, reply: { text: `CLAIM_VISIBLE ${marker}` } }
        : undefined;
      record({ kind: "hook-return", pid: process.pid, marker, agentId: ctx.agentId,
        sessionKey: ctx.sessionKey, result: result ?? null });
      // Log the actual returned object, not a NO_REPLY-derived classification.
      return result;
    }, { eligibleTriggers: ["user"] });
  },
});

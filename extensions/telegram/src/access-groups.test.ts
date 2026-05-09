import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { expandTelegramAllowFromWithAccessGroups } from "./access-groups.js";

describe("expandTelegramAllowFromWithAccessGroups", () => {
  it("expands matched access groups through the shared ingress runtime", async () => {
    const cfg = {
      accessGroups: {
        operators: {
          type: "message.senders",
          members: {
            telegram: ["telegram:123"],
          },
        },
      },
    } satisfies Pick<OpenClawConfig, "accessGroups">;

    await expect(
      expandTelegramAllowFromWithAccessGroups({
        cfg: cfg as OpenClawConfig,
        allowFrom: ["accessGroup:operators"],
        senderId: "123",
      }),
    ).resolves.toEqual(["123"]);
  });

  it("preserves access-group references when no group matches", async () => {
    const cfg = {
      accessGroups: {
        operators: {
          type: "message.senders",
          members: {
            telegram: ["456"],
          },
        },
      },
    } satisfies Pick<OpenClawConfig, "accessGroups">;

    await expect(
      expandTelegramAllowFromWithAccessGroups({
        cfg: cfg as OpenClawConfig,
        allowFrom: ["accessGroup:operators"],
        senderId: "123",
      }),
    ).resolves.toEqual(["accessGroup:operators"]);
  });
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { describe, expect, it } from "vitest";
import { resolveQQBotAccess } from "../engine/access/index.js";
import type { QQBotDmPolicy, QQBotGroupPolicy } from "../engine/access/types.js";
import { createSdkAccessAdapter } from "./sdk-adapter.js";

type AccessCase = {
  isGroup: boolean;
  senderId: string;
  allowFrom?: Array<string | number>;
  groupPolicy?: QQBotGroupPolicy;
  dmPolicy?: QQBotDmPolicy;
};

describe("QQBot SDK access adapter", () => {
  const access = createSdkAccessAdapter();

  it("preserves legacy access decisions through channel ingress", async () => {
    const cases: AccessCase[] = [
      { isGroup: false, senderId: "USER1" },
      { isGroup: false, senderId: "USER1", allowFrom: [] },
      { isGroup: false, senderId: "qqbot:user1", allowFrom: ["QQBot:USER1"] },
      { isGroup: false, senderId: "USER2", allowFrom: ["USER1"] },
      { isGroup: true, senderId: "USER1", allowFrom: ["USER1"] },
      { isGroup: true, senderId: "USER2", allowFrom: ["USER1"] },
      { isGroup: true, senderId: "RANDOM_USER", allowFrom: ["USER1"], groupPolicy: "open" },
      { isGroup: true, senderId: "USER1", groupPolicy: "allowlist" },
    ];
    for (const input of cases) {
      await expect(
        access.resolveInboundAccess({
          cfg: {},
          accountId: "default",
          conversationId: input.isGroup ? "GROUP1" : input.senderId,
          ...input,
        }),
      ).resolves.toMatchObject(resolveQQBotAccess(input));
    }
  });

  it("matches static access groups through channel ingress", async () => {
    const cfg = {
      accessGroups: {
        operators: {
          type: "message.senders",
          members: {
            qqbot: ["USER1"],
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      access.resolveInboundAccess({
        cfg,
        accountId: "default",
        conversationId: "USER1",
        isGroup: false,
        senderId: "USER1",
        dmPolicy: "allowlist",
        allowFrom: ["accessGroup:operators"],
      }),
    ).resolves.toMatchObject({
      decision: "allow",
      reasonCode: "dm_policy_allowlisted",
    });
  });

  it("authorizes requireAuth slash commands through channel ingress", async () => {
    await expect(
      access.resolveSlashCommandAuthorization({
        cfg: {},
        accountId: "default",
        conversationId: "USER1",
        isGroup: false,
        senderId: "qqbot:user1",
        allowFrom: ["QQBot:USER1"],
      }),
    ).resolves.toBe(true);

    await expect(
      access.resolveSlashCommandAuthorization({
        cfg: {},
        accountId: "default",
        conversationId: "USER1",
        isGroup: false,
        senderId: "USER1",
        allowFrom: ["*"],
      }),
    ).resolves.toBe(false);
  });
});

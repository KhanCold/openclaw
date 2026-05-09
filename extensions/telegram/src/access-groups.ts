import { resolveChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { DmPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { parseAccessGroupAllowFromEntry } from "openclaw/plugin-sdk/security-runtime";
import { normalizeDmAllowFromWithStore, type NormalizedAllowFrom } from "./bot-access.js";
import {
  createTelegramIngressSubject,
  TELEGRAM_CHANNEL_ID,
  telegramIngressIdentity,
} from "./ingress.js";

export async function expandTelegramAllowFromWithAccessGroups(params: {
  cfg?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  accountId?: string;
  senderId?: string;
}): Promise<string[]> {
  const allowFrom = (params.allowFrom ?? []).map(String);
  const senderId = params.senderId?.trim() ?? "";
  if (
    !params.cfg ||
    !senderId ||
    !allowFrom.some((entry) => parseAccessGroupAllowFromEntry(entry))
  ) {
    return allowFrom;
  }
  const expanded = (
    await resolveChannelMessageIngress({
      channelId: TELEGRAM_CHANNEL_ID,
      accountId: params.accountId ?? "default",
      identity: telegramIngressIdentity,
      subject: createTelegramIngressSubject(senderId),
      conversation: {
        kind: "direct",
        id: senderId,
      },
      event: {
        kind: "message",
        authMode: "inbound",
        mayPair: false,
      },
      accessGroups: params.cfg.accessGroups,
      policy: {
        dmPolicy: "allowlist",
        groupPolicy: "disabled",
      },
      allowFrom,
    })
  ).senderAccess.effectiveAllowFrom;
  const originalEntries = new Set(allowFrom);
  const matched = !originalEntries.has(senderId) && expanded.includes(senderId);
  return matched
    ? Array.from(
        new Set([
          ...allowFrom.filter((entry) => parseAccessGroupAllowFromEntry(entry) == null),
          senderId,
        ]),
      )
    : allowFrom;
}

export async function resolveTelegramDmAllow(params: {
  cfg?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  groupAllowOverride?: Array<string | number>;
  storeAllowFrom?: string[];
  dmPolicy?: DmPolicy;
  accountId?: string;
  senderId?: string;
}): Promise<{
  allowFrom?: Array<string | number>;
  expandedAllowFrom: string[];
  effectiveAllow: NormalizedAllowFrom;
}> {
  const allowFrom = params.groupAllowOverride ?? params.allowFrom;
  const expandedAllowFrom = await expandTelegramAllowFromWithAccessGroups({
    cfg: params.cfg,
    allowFrom,
    accountId: params.accountId,
    senderId: params.senderId,
  });
  return {
    allowFrom,
    expandedAllowFrom,
    effectiveAllow: normalizeDmAllowFromWithStore({
      allowFrom: expandedAllowFrom,
      storeAllowFrom: params.storeAllowFrom,
      dmPolicy: params.dmPolicy,
    }),
  };
}

import {
  type ChannelIngressEventInput,
  type IngressReasonCode,
} from "openclaw/plugin-sdk/channel-ingress";
import { resolveChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { DmPolicy } from "openclaw/plugin-sdk/config-types";
import type { NormalizedAllowFrom } from "./bot-access.js";
import {
  createTelegramIngressSubject,
  telegramAllowEntries,
  TELEGRAM_CHANNEL_ID,
  telegramIngressIdentity,
} from "./ingress.js";

export async function resolveTelegramEventIngressAuthorization(params: {
  accountId: string;
  dmPolicy: DmPolicy;
  isGroup: boolean;
  chatId: number;
  resolvedThreadId?: number;
  senderId: string;
  effectiveDmAllow: NormalizedAllowFrom;
  effectiveGroupAllow: NormalizedAllowFrom;
  enforceGroupAuthorization: boolean;
  eventKind: Extract<ChannelIngressEventInput["kind"], "reaction" | "button">;
}): Promise<{ allowed: boolean; reasonCode: IngressReasonCode }> {
  const result = await resolveChannelMessageIngress({
    channelId: TELEGRAM_CHANNEL_ID,
    accountId: params.accountId,
    identity: telegramIngressIdentity,
    subject: createTelegramIngressSubject(params.senderId),
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: String(params.chatId),
      ...(params.resolvedThreadId != null ? { threadId: String(params.resolvedThreadId) } : {}),
    },
    event: {
      kind: params.eventKind,
      authMode: "inbound",
      mayPair: false,
    },
    policy: {
      dmPolicy: params.dmPolicy,
      groupPolicy: params.enforceGroupAuthorization ? "allowlist" : "open",
    },
    allowFrom: telegramAllowEntries(params.effectiveDmAllow),
    groupAllowFrom: params.enforceGroupAuthorization
      ? telegramAllowEntries(params.effectiveGroupAllow)
      : [],
  });
  return {
    allowed: result.ingress.decision === "allow",
    reasonCode: result.ingress.reasonCode,
  };
}

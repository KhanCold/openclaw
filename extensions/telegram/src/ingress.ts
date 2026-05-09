import {
  defineStableChannelIngressIdentity,
  type ChannelIngressIdentitySubjectInput,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeAllowFrom, type NormalizedAllowFrom } from "./bot-access.js";

export const TELEGRAM_CHANNEL_ID = "telegram";

export const telegramIngressIdentity = defineStableChannelIngressIdentity({
  key: "telegram-user-id",
  normalize: (value) => {
    const normalized = normalizeAllowFrom([value]);
    return normalized.entries[0] ?? (normalized.hasWildcard ? "*" : null);
  },
  sensitivity: "pii",
});

export function createTelegramIngressSubject(senderId: string): ChannelIngressIdentitySubjectInput {
  return { stableId: senderId };
}

export function telegramAllowEntries(allow: NormalizedAllowFrom): string[] {
  return [...(allow.hasWildcard ? ["*"] : []), ...allow.entries];
}

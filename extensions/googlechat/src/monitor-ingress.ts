import type { RouteGateFacts } from "openclaw/plugin-sdk/channel-ingress";
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
  routeAllowlistFact,
  routeDisabledFact,
  type ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawConfig } from "../runtime-api.js";

type GoogleChatDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
type GoogleChatGroupPolicy = "open" | "allowlist" | "disabled";

const GOOGLECHAT_EMAIL_KIND = "plugin:googlechat-email" as const;

function normalizeUserId(raw?: string | null): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return "";
  }
  return normalizeLowercaseStringOrEmpty(trimmed.replace(/^users\//i, ""));
}

function normalizeEntryValue(raw?: string | null): string {
  return normalizeLowercaseStringOrEmpty(raw ?? "");
}

function isEmailLike(value: string): boolean {
  return value.includes("@");
}

function normalizeGoogleChatStableEntry(entry: string): string | null {
  const normalized = normalizeEntryValue(entry);
  if (!normalized) {
    return null;
  }
  const withoutPrefix = normalized.replace(/^(googlechat|google-chat|gchat):/i, "");
  if (withoutPrefix.startsWith("users/")) {
    return normalizeUserId(withoutPrefix);
  }
  return withoutPrefix;
}

function normalizeGoogleChatEmailEntry(entry: string): string | null {
  const normalized = normalizeEntryValue(entry);
  const withoutPrefix = normalized.replace(/^(googlechat|google-chat|gchat):/i, "");
  if (withoutPrefix.startsWith("users/")) {
    return null;
  }
  const stable = normalizeGoogleChatStableEntry(entry);
  return stable && isEmailLike(stable) ? stable : null;
}

const googleChatIngressIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  normalizeEntry: normalizeGoogleChatStableEntry,
  normalizeSubject: normalizeUserId,
  aliases: [
    {
      key: "email",
      kind: GOOGLECHAT_EMAIL_KIND,
      normalizeEntry: normalizeGoogleChatEmailEntry,
      normalizeSubject: normalizeEntryValue,
      dangerous: true,
    },
  ],
  isWildcardEntry(entry) {
    return normalizeEntryValue(entry) === "*";
  },
  resolveEntryId({ entryIndex, fieldKey }) {
    if (fieldKey === "stableId") {
      return `entry-${entryIndex + 1}:user`;
    }
    return `entry-${entryIndex + 1}:${fieldKey}`;
  },
});

function createGoogleChatRouteFacts(params: {
  isGroup: boolean;
  groupPolicy: GoogleChatGroupPolicy;
  routeAllowlistConfigured: boolean;
  routeMatched: boolean;
  routeEnabled: boolean;
}): RouteGateFacts[] {
  if (!params.isGroup || params.groupPolicy === "disabled") {
    return [];
  }
  if (params.routeMatched && !params.routeEnabled) {
    return [
      routeDisabledFact({
        id: "googlechat:space",
        match: {
          matched: true,
          matchedEntryIds: ["googlechat-space"],
        },
      }),
    ];
  }
  if (params.groupPolicy === "allowlist" && params.routeAllowlistConfigured) {
    return [
      routeAllowlistFact({
        id: "googlechat:space",
        senderPolicy: "deny-when-empty",
        senderAllowFromSource: params.routeMatched ? "effective-group" : undefined,
        match: {
          matched: params.routeMatched,
          matchedEntryIds: params.routeMatched ? ["googlechat-space"] : [],
        },
        matched: params.routeMatched,
      }),
    ];
  }
  return [];
}

function resolveSenderGroupPolicy(params: {
  groupPolicy: GoogleChatGroupPolicy;
  routeAllowlistConfigured: boolean;
  groupAllowFrom: string[];
}): GoogleChatGroupPolicy {
  if (params.routeAllowlistConfigured && params.groupAllowFrom.length === 0) {
    return params.groupPolicy;
  }
  if (params.groupPolicy === "disabled") {
    return "disabled";
  }
  return params.groupAllowFrom.length > 0 ? "allowlist" : "open";
}

export async function resolveGoogleChatIngressAccess(params: {
  accountId: string;
  accessGroups?: OpenClawConfig["accessGroups"];
  isGroup: boolean;
  spaceId: string;
  senderId: string;
  senderEmail?: string;
  allowNameMatching: boolean;
  dmPolicy: GoogleChatDmPolicy;
  groupPolicy: GoogleChatGroupPolicy;
  routeAllowlistConfigured: boolean;
  routeMatched: boolean;
  routeEnabled: boolean;
  allowFrom: string[];
  groupAllowFrom: string[];
  readStoreAllowFrom?: () => Promise<Array<string | number>>;
  command?: {
    useAccessGroups: boolean;
    hasControlCommand: boolean;
  };
}): Promise<ResolvedChannelMessageIngress> {
  const senderGroupPolicy = resolveSenderGroupPolicy({
    groupPolicy: params.groupPolicy,
    routeAllowlistConfigured: params.routeAllowlistConfigured,
    groupAllowFrom: params.groupAllowFrom,
  });
  const conversation = {
    kind: params.isGroup ? "group" : "direct",
    id: params.spaceId,
  } as const;
  return await resolveChannelMessageIngress({
    channelId: "googlechat",
    accountId: params.accountId,
    identity: googleChatIngressIdentity,
    subject: {
      stableId: params.senderId,
      aliases: { email: params.senderEmail },
    },
    conversation,
    accessGroups: params.accessGroups,
    routeFacts: createGoogleChatRouteFacts({
      isGroup: params.isGroup,
      groupPolicy: params.groupPolicy,
      routeAllowlistConfigured: params.routeAllowlistConfigured,
      routeMatched: params.routeMatched,
      routeEnabled: params.routeEnabled,
    }),
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: !params.isGroup,
    },
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    readStoreAllowFrom: params.readStoreAllowFrom,
    policy: {
      dmPolicy: params.dmPolicy,
      groupPolicy: senderGroupPolicy,
      groupAllowFromFallbackToAllowFrom: false,
      mutableIdentifierMatching: params.allowNameMatching ? "enabled" : "disabled",
    },
    command:
      params.command == null
        ? undefined
        : {
            useAccessGroups: params.command.useAccessGroups,
            allowTextCommands: false,
            hasControlCommand: params.command.hasControlCommand,
            groupOwnerAllowFrom: "none",
          },
  });
}

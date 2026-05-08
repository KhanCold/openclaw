import {
  normalizeAccountId,
  resolveMergedAccountConfig,
} from "openclaw/plugin-sdk/account-resolution";
import {
  createChannelIngressPluginId,
  createChannelIngressStringAdapter,
  createChannelIngressSubject,
  decideChannelIngress,
  findChannelIngressCommandGate,
  type ChannelIngressDecision,
  type ChannelIngressIdentifierKind,
  type ChannelIngressState,
  type ChannelIngressSubject,
  resolveChannelIngressState,
} from "openclaw/plugin-sdk/channel-ingress";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { evaluateSenderGroupAccessForPolicy } from "openclaw/plugin-sdk/group-access";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import type { AllowlistMatch, ChannelGroupContext } from "../runtime-api.js";
import { detectIdType } from "./targets.js";
import type { FeishuConfig } from "./types.js";

type FeishuAllowlistMatch = AllowlistMatch<"wildcard" | "id">;
type FeishuDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
type FeishuGroupPolicy = "open" | "allowlist" | "disabled" | "allowall";
type NormalizedFeishuGroupPolicy = Exclude<FeishuGroupPolicy, "allowall">;
type FeishuIngressResult = {
  state: ChannelIngressState;
  decision: ChannelIngressDecision;
};

const FEISHU_PROVIDER_PREFIX_RE = /^(feishu|lark):/i;
const FEISHU_CHANNEL_ID = createChannelIngressPluginId("feishu");
const FEISHU_ID_KIND = "plugin:feishu-id" as const satisfies ChannelIngressIdentifierKind;
const feishuIngressAdapter = createChannelIngressStringAdapter({
  kind: FEISHU_ID_KIND,
  normalizeEntry: normalizeFeishuAllowEntry,
  normalizeSubject: normalizeFeishuAllowEntry,
  isWildcardEntry: (entry) => normalizeFeishuAllowEntry(entry) === "*",
});

function stripRepeatedFeishuProviderPrefixes(raw: string): string {
  let normalized = raw.trim();
  while (FEISHU_PROVIDER_PREFIX_RE.test(normalized)) {
    normalized = normalized.replace(FEISHU_PROVIDER_PREFIX_RE, "").trim();
  }
  return normalized;
}

function canonicalizeFeishuAllowlistKey(params: { kind: "chat" | "user"; value: string }): string {
  const value = params.value.trim();
  if (!value) {
    return "";
  }
  // A typed wildcard (`chat:*`, `user:*`, `open_id:*`, `dm:*`, `group:*`,
  // `channel:*`) collapses to the bare wildcard so it keeps matching across
  // both kinds, preserving the prior `normalizeFeishuTarget`-based behavior.
  if (value === "*") {
    return "*";
  }
  return `${params.kind}:${value}`;
}

function normalizeFeishuAllowEntry(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }

  const withoutProviderPrefix = stripRepeatedFeishuProviderPrefixes(trimmed);
  if (withoutProviderPrefix === "*") {
    return "*";
  }
  const lowered = normalizeOptionalLowercaseString(withoutProviderPrefix) ?? "";
  if (!lowered) {
    return "";
  }
  // Lowercase for prefix detection only; preserve the original ID casing in the
  // canonicalized key. Sender candidates pass through this same path so allowlist
  // entries and runtime IDs stay normalized symmetrically.
  if (
    lowered.startsWith("chat:") ||
    lowered.startsWith("group:") ||
    lowered.startsWith("channel:")
  ) {
    return canonicalizeFeishuAllowlistKey({
      kind: "chat",
      value: withoutProviderPrefix.slice(withoutProviderPrefix.indexOf(":") + 1),
    });
  }
  if (lowered.startsWith("user:") || lowered.startsWith("dm:")) {
    return canonicalizeFeishuAllowlistKey({
      kind: "user",
      value: withoutProviderPrefix.slice(withoutProviderPrefix.indexOf(":") + 1),
    });
  }
  if (lowered.startsWith("open_id:")) {
    return canonicalizeFeishuAllowlistKey({
      kind: "user",
      value: withoutProviderPrefix.slice(withoutProviderPrefix.indexOf(":") + 1),
    });
  }

  const detectedType = detectIdType(withoutProviderPrefix);
  if (detectedType === "chat_id") {
    return canonicalizeFeishuAllowlistKey({
      kind: "chat",
      value: withoutProviderPrefix,
    });
  }
  if (detectedType === "open_id" || detectedType === "user_id") {
    return canonicalizeFeishuAllowlistKey({
      kind: "user",
      value: withoutProviderPrefix,
    });
  }

  return "";
}

export function resolveFeishuAllowlistMatch(params: {
  allowFrom: Array<string | number>;
  senderId: string;
  senderIds?: Array<string | null | undefined>;
  senderName?: string | null;
}): FeishuAllowlistMatch {
  const allowFrom = params.allowFrom
    .map((entry) => normalizeFeishuAllowEntry(String(entry)))
    .filter(Boolean);
  if (allowFrom.length === 0) {
    return { allowed: false };
  }
  if (allowFrom.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  // Feishu allowlists are ID-based; mutable display names must never grant access.
  const senderCandidates = [params.senderId, ...(params.senderIds ?? [])]
    .map((entry) => normalizeFeishuAllowEntry(entry ?? ""))
    .filter(Boolean);

  for (const senderId of senderCandidates) {
    if (allowFrom.includes(senderId)) {
      return { allowed: true, matchKey: senderId, matchSource: "id" };
    }
  }

  return { allowed: false };
}

function normalizeFeishuDmPolicy(policy: string | null | undefined): FeishuDmPolicy {
  return policy === "open" ||
    policy === "pairing" ||
    policy === "allowlist" ||
    policy === "disabled"
    ? policy
    : "pairing";
}

function normalizeFeishuGroupPolicy(policy: FeishuGroupPolicy): NormalizedFeishuGroupPolicy {
  return policy === "allowall" ? "open" : policy;
}

function createFeishuIngressSubject(params: {
  primaryId?: string | null;
  alternateIds?: Array<string | null | undefined>;
  opaquePrefix: string;
}): ChannelIngressSubject {
  const ids = [params.primaryId, ...(params.alternateIds ?? [])]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return createChannelIngressSubject({
    identifiers: ids.map((value, index) => ({
      kind: FEISHU_ID_KIND,
      opaqueId: `${params.opaquePrefix}-${index + 1}`,
      value,
    })),
  });
}

export async function resolveFeishuDmIngressAccess(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  dmPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  senderOpenId: string;
  senderUserId?: string | null;
  conversationId: string;
  mayPair: boolean;
}): Promise<FeishuIngressResult & { effectiveAllowFrom: Array<string | number> }> {
  const state = await resolveChannelIngressState({
    channelId: FEISHU_CHANNEL_ID,
    accountId: normalizeAccountId(params.accountId) ?? "default",
    subject: createFeishuIngressSubject({
      primaryId: params.senderOpenId,
      alternateIds: [params.senderUserId],
      opaquePrefix: "sender",
    }),
    conversation: {
      kind: "direct",
      id: params.conversationId,
    },
    adapter: feishuIngressAdapter,
    accessGroups: params.cfg.accessGroups,
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: params.mayPair,
    },
    allowlists: {
      dm: params.allowFrom ?? [],
      pairingStore: params.storeAllowFrom ?? [],
    },
  });
  return {
    state,
    decision: decideChannelIngress(state, {
      dmPolicy: normalizeFeishuDmPolicy(params.dmPolicy),
      groupPolicy: "disabled",
    }),
    effectiveAllowFrom: [...(params.allowFrom ?? []), ...(params.storeAllowFrom ?? [])],
  };
}

export async function resolveFeishuGroupConversationIngressAccess(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatId: string;
  groupPolicy: FeishuGroupPolicy;
  groupAllowFrom?: Array<string | number> | null;
  groupExplicitlyConfigured?: boolean;
}): Promise<FeishuIngressResult> {
  const groupPolicy = normalizeFeishuGroupPolicy(params.groupPolicy);
  const groupAllowFrom =
    groupPolicy === "allowlist" && params.groupExplicitlyConfigured
      ? [...(params.groupAllowFrom ?? []), params.chatId]
      : (params.groupAllowFrom ?? []);
  const state = await resolveChannelIngressState({
    channelId: FEISHU_CHANNEL_ID,
    accountId: normalizeAccountId(params.accountId) ?? "default",
    subject: createFeishuIngressSubject({
      primaryId: params.chatId,
      opaquePrefix: "chat",
    }),
    conversation: {
      kind: "group",
      id: params.chatId,
    },
    adapter: feishuIngressAdapter,
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: false,
    },
    allowlists: {
      group: groupAllowFrom,
    },
  });
  return {
    state,
    decision: decideChannelIngress(state, {
      dmPolicy: "disabled",
      groupPolicy,
    }),
  };
}

export async function resolveFeishuGroupSenderIngressAccess(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatId: string;
  allowFrom?: Array<string | number> | null;
  senderOpenId: string;
  senderUserId?: string | null;
}): Promise<FeishuIngressResult> {
  const state = await resolveChannelIngressState({
    channelId: FEISHU_CHANNEL_ID,
    accountId: normalizeAccountId(params.accountId) ?? "default",
    subject: createFeishuIngressSubject({
      primaryId: params.senderOpenId,
      alternateIds: [params.senderUserId],
      opaquePrefix: "sender",
    }),
    conversation: {
      kind: "group",
      id: params.chatId,
    },
    adapter: feishuIngressAdapter,
    accessGroups: params.cfg.accessGroups,
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: false,
    },
    allowlists: {
      group: params.allowFrom ?? [],
    },
  });
  return {
    state,
    decision: decideChannelIngress(state, {
      dmPolicy: "disabled",
      groupPolicy: "allowlist",
    }),
  };
}

export async function resolveFeishuMentionActivationIngressAccess(params: {
  accountId?: string | null;
  chatId: string;
  requireMention: boolean;
  mentionedBot: boolean;
}): Promise<FeishuIngressResult> {
  const state = await resolveChannelIngressState({
    channelId: FEISHU_CHANNEL_ID,
    accountId: normalizeAccountId(params.accountId) ?? "default",
    subject: createChannelIngressSubject({ identifiers: [] }),
    conversation: {
      kind: "group",
      id: params.chatId,
    },
    adapter: feishuIngressAdapter,
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: false,
    },
    mentionFacts: {
      canDetectMention: true,
      wasMentioned: params.mentionedBot,
    },
    allowlists: {},
  });
  return {
    state,
    decision: decideChannelIngress(state, {
      dmPolicy: "disabled",
      groupPolicy: "open",
      activation: {
        requireMention: params.requireMention,
        allowTextCommands: false,
      },
    }),
  };
}

export async function resolveFeishuCommandIngressAccess(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  isGroup: boolean;
  conversationId: string;
  allowFrom?: Array<string | number> | null;
  senderOpenId: string;
  senderUserId?: string | null;
  useAccessGroups: boolean;
  hasControlCommand: boolean;
}): Promise<FeishuIngressResult & { commandAuthorized: boolean }> {
  const state = await resolveChannelIngressState({
    channelId: FEISHU_CHANNEL_ID,
    accountId: normalizeAccountId(params.accountId) ?? "default",
    subject: createFeishuIngressSubject({
      primaryId: params.senderOpenId,
      alternateIds: [params.senderUserId],
      opaquePrefix: "sender",
    }),
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.conversationId,
    },
    adapter: feishuIngressAdapter,
    accessGroups: params.cfg.accessGroups,
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: false,
    },
    allowlists: {
      dm: params.isGroup ? [] : ["*"],
      commandOwner: params.allowFrom ?? [],
    },
  });
  const decision = decideChannelIngress(state, {
    dmPolicy: params.isGroup ? "disabled" : "open",
    groupPolicy: params.isGroup ? "open" : "disabled",
    command: {
      useAccessGroups: params.useAccessGroups,
      allowTextCommands: false,
      hasControlCommand: params.hasControlCommand,
    },
  });
  return {
    state,
    decision,
    commandAuthorized: findChannelIngressCommandGate(decision)?.allowed === true,
  };
}

export function resolveFeishuGroupConfig(params: { cfg?: FeishuConfig; groupId?: string | null }) {
  const groups = params.cfg?.groups ?? {};
  const wildcard = groups["*"];
  const groupId = params.groupId?.trim();
  if (!groupId) {
    return undefined;
  }

  const direct = groups[groupId];
  if (direct) {
    return direct;
  }

  const lowered = normalizeOptionalLowercaseString(groupId) ?? "";
  const matchKey = Object.keys(groups).find(
    (key) => normalizeOptionalLowercaseString(key) === lowered,
  );
  if (matchKey) {
    return groups[matchKey];
  }
  return wildcard;
}

export function hasExplicitFeishuGroupConfig(params: {
  cfg?: FeishuConfig;
  groupId?: string | null;
}): boolean {
  const groups = params.cfg?.groups ?? {};
  const groupId = params.groupId?.trim();
  if (!groupId) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(groups, groupId) && groupId !== "*") {
    return true;
  }

  const lowered = normalizeOptionalLowercaseString(groupId) ?? "";
  return Object.keys(groups).some(
    (key) => key !== "*" && normalizeOptionalLowercaseString(key) === lowered,
  );
}

export function resolveFeishuGroupToolPolicy(params: ChannelGroupContext) {
  const cfg = params.cfg.channels?.feishu;
  if (!cfg) {
    return undefined;
  }

  const groupConfig = resolveFeishuGroupConfig({
    cfg,
    groupId: params.groupId,
  });

  return groupConfig?.tools;
}

export function isFeishuGroupAllowed(params: {
  groupPolicy: "open" | "allowlist" | "disabled" | "allowall";
  allowFrom: Array<string | number>;
  senderId: string;
  senderIds?: Array<string | null | undefined>;
  senderName?: string | null;
}): boolean {
  return evaluateSenderGroupAccessForPolicy({
    groupPolicy: params.groupPolicy === "allowall" ? "open" : params.groupPolicy,
    groupAllowFrom: params.allowFrom.map((entry) => String(entry)),
    senderId: params.senderId,
    isSenderAllowed: () => resolveFeishuAllowlistMatch(params).allowed,
  }).allowed;
}

export function resolveFeishuReplyPolicy(params: {
  isDirectMessage: boolean;
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  /**
   * Effective group policy resolved for this chat. When "open", requireMention
   * defaults to false so that non-text messages (e.g. images) that cannot carry
   * @-mentions are still delivered to the agent.
   */
  groupPolicy?: "open" | "allowlist" | "disabled" | "allowall";
}): { requireMention: boolean } {
  if (params.isDirectMessage) {
    return { requireMention: false };
  }

  const feishuCfg = params.cfg.channels?.feishu;
  const resolvedCfg = resolveMergedAccountConfig<FeishuConfig>({
    channelConfig: feishuCfg,
    accounts: feishuCfg?.accounts as Record<string, Partial<FeishuConfig>> | undefined,
    accountId: normalizeAccountId(params.accountId),
    normalizeAccountId,
    omitKeys: ["defaultAccount"],
  });
  const groupRequireMention = resolveFeishuGroupConfig({
    cfg: resolvedCfg,
    groupId: params.groupId,
  })?.requireMention;

  return {
    requireMention:
      typeof groupRequireMention === "boolean"
        ? groupRequireMention
        : typeof resolvedCfg.requireMention === "boolean"
          ? resolvedCfg.requireMention
          : params.groupPolicy !== "open",
  };
}

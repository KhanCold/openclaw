import {
  createChannelIngressPluginId,
  createChannelIngressStringAdapter,
  createChannelIngressSubject,
  decideChannelIngress,
  resolveChannelIngressState,
  type ChannelIngressAdapter,
  type ChannelIngressDecision,
  type ChannelIngressPolicyInput,
  type ChannelIngressState,
  type ChannelIngressSubject,
  type ChannelIngressSubjectIdentifierInput,
} from "openclaw/plugin-sdk/channel-ingress";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { TwitchAccountConfig, TwitchChatMessage } from "./types.js";

/**
 * Result of checking access control for a Twitch message
 */
type TwitchAccessControlResult = {
  allowed: boolean;
  reason?: string;
  matchKey?: string;
  matchSource?: string;
};

export type TwitchAccessControlIngressResult = {
  stage: "activation" | "sender";
  policyKind: "open" | "allowFrom" | "role";
  state: ChannelIngressState;
  decision: ChannelIngressDecision;
};

const twitchIngressPluginId = createChannelIngressPluginId("twitch");
const twitchUserIdAdapter = createChannelIngressStringAdapter();
const twitchRoleAdapter = createChannelIngressStringAdapter({
  kind: "role",
  normalizeEntry: normalizeTwitchRole,
  normalizeSubject: normalizeTwitchRole,
  isWildcardEntry: (entry) => normalizeTwitchRole(entry) === "all",
});

/**
 * Check if a Twitch message should be allowed based on account configuration
 *
 * This function implements the access control logic for incoming Twitch messages,
 * checking allowlists, role-based restrictions, and mention requirements.
 *
 * Priority order:
 * 1. If `requireMention` is true, message must mention the bot
 * 2. If `allowFrom` is set, sender must be in the allowlist (by user ID)
 * 3. If `allowedRoles` is set (and `allowFrom` is not), sender must have at least one role
 *
 * Note: `allowFrom` is a hard allowlist. When set, only those user IDs are allowed.
 * Use `allowedRoles` as an alternative when you don't want to maintain an allowlist.
 *
 * Available roles:
 * - "moderator": Moderators
 * - "owner": Channel owner/broadcaster
 * - "vip": VIPs
 * - "subscriber": Subscribers
 * - "all": Anyone in the chat
 */
export async function checkTwitchAccessControl(params: {
  message: TwitchChatMessage;
  account: TwitchAccountConfig;
  botUsername: string;
}): Promise<TwitchAccessControlResult> {
  const ingress = await resolveTwitchAccessControlIngress(params);
  const { decision, policyKind } = ingress;

  if (ingress.stage === "activation" && decision.admission !== "dispatch") {
    return {
      allowed: false,
      reason: "message does not mention the bot (requireMention is enabled)",
    };
  }

  if (decision.admission === "dispatch") {
    if (policyKind === "allowFrom") {
      return {
        allowed: true,
        matchKey: params.message.userId,
        matchSource: "allowlist",
      };
    }
    if (policyKind === "role") {
      return {
        allowed: true,
        matchKey: params.account.allowedRoles?.join(","),
        matchSource: "role",
      };
    }
    return {
      allowed: true,
    };
  }

  if (policyKind === "allowFrom") {
    if (!params.message.userId) {
      return {
        allowed: false,
        reason: "sender user ID not available for allowlist check",
      };
    }
    return {
      allowed: false,
      reason: "sender is not in allowFrom allowlist",
    };
  }

  if (policyKind === "role") {
    return {
      allowed: false,
      reason: `sender does not have any of the required roles: ${params.account.allowedRoles?.join(", ") ?? ""}`,
    };
  }

  return {
    allowed: false,
    reason: reasonForTwitchIngressDecision(decision),
  };
}

export async function resolveTwitchAccessControlIngress(params: {
  message: TwitchChatMessage;
  account: TwitchAccountConfig;
  botUsername: string;
}): Promise<TwitchAccessControlIngressResult> {
  const { message, account, botUsername } = params;

  const activation = await decideTwitchAccess({
    message,
    adapter: twitchUserIdAdapter,
    subject: createChannelIngressSubject({ identifiers: [] }),
    allowlists: {},
    mentionFacts: {
      canDetectMention: true,
      wasMentioned: extractMentions(message.message).includes(
        normalizeLowercaseStringOrEmpty(botUsername),
      ),
    },
    policy: {
      dmPolicy: "open",
      groupPolicy: "open",
      activation: {
        requireMention: account.requireMention ?? true,
        allowTextCommands: false,
      },
    },
  });
  if (activation.decision.admission !== "dispatch") {
    return {
      stage: "activation",
      policyKind: "open",
      ...activation,
    };
  }

  if (account.allowFrom !== undefined) {
    return {
      stage: "sender",
      policyKind: "allowFrom",
      ...(await decideTwitchAccess({
        message,
        adapter: twitchUserIdAdapter,
        subject: twitchUserIdSubject(message),
        allowlists: {
          group: account.allowFrom,
        },
        policy: {
          dmPolicy: "open",
          groupPolicy: "allowlist",
        },
      })),
    };
  }

  if (account.allowedRoles && account.allowedRoles.length > 0) {
    return {
      stage: "sender",
      policyKind: "role",
      ...(await decideTwitchAccess({
        message,
        adapter: twitchRoleAdapter,
        subject: twitchRoleSubject(message),
        allowlists: {
          group: account.allowedRoles,
        },
        policy: {
          dmPolicy: "open",
          groupPolicy: "allowlist",
        },
      })),
    };
  }

  return {
    stage: "activation",
    policyKind: "open",
    ...activation,
  };
}

async function decideTwitchAccess(params: {
  message: TwitchChatMessage;
  adapter: ChannelIngressAdapter;
  subject: ChannelIngressSubject;
  allowlists: {
    group?: Array<string | number>;
  };
  policy: ChannelIngressPolicyInput;
  mentionFacts?: {
    canDetectMention: boolean;
    wasMentioned: boolean;
  };
}): Promise<{
  state: ChannelIngressState;
  decision: ChannelIngressDecision;
}> {
  const state = await resolveChannelIngressState({
    channelId: twitchIngressPluginId,
    accountId: "default",
    subject: params.subject,
    conversation: {
      kind: "group",
      id: params.message.channel,
    },
    adapter: params.adapter,
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: false,
    },
    mentionFacts: params.mentionFacts,
    allowlists: params.allowlists,
  });
  return {
    state,
    decision: decideChannelIngress(state, params.policy),
  };
}

function twitchUserIdSubject(message: TwitchChatMessage): ChannelIngressSubject {
  if (!message.userId) {
    return createChannelIngressSubject({ identifiers: [] });
  }
  return createChannelIngressSubject({
    opaqueId: "sender-id",
    value: message.userId,
  });
}

function twitchRoleSubject(message: TwitchChatMessage): ChannelIngressSubject {
  const identifiers: ChannelIngressSubjectIdentifierInput[] = [];
  if (message.isMod) {
    identifiers.push({ opaqueId: "role-moderator", kind: "role", value: "moderator" });
  }
  if (message.isOwner) {
    identifiers.push({ opaqueId: "role-owner", kind: "role", value: "owner" });
  }
  if (message.isVip) {
    identifiers.push({ opaqueId: "role-vip", kind: "role", value: "vip" });
  }
  if (message.isSub) {
    identifiers.push({ opaqueId: "role-subscriber", kind: "role", value: "subscriber" });
  }
  return createChannelIngressSubject({ identifiers });
}

function normalizeTwitchRole(value: string): string | null {
  const role = normalizeLowercaseStringOrEmpty(value);
  return role === "moderator" ||
    role === "owner" ||
    role === "vip" ||
    role === "subscriber" ||
    role === "all"
    ? role
    : null;
}

function reasonForTwitchIngressDecision(decision: ChannelIngressDecision): string {
  switch (decision.reasonCode) {
    case "activation_skipped":
      return "message does not mention the bot (requireMention is enabled)";
    case "group_policy_empty_allowlist":
    case "group_policy_not_allowlisted":
      return "sender is not in allowFrom allowlist";
    default:
      return decision.reasonCode;
  }
}

/**
 * Extract @mentions from a Twitch chat message
 *
 * Returns a list of lowercase usernames that were mentioned in the message.
 * Twitch mentions are in the format @username.
 */
export function extractMentions(message: string): string[] {
  const mentionRegex = /@(\w+)/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = mentionRegex.exec(message)) !== null) {
    const username = match[1];
    if (username) {
      mentions.push(normalizeLowercaseStringOrEmpty(username));
    }
  }

  return mentions;
}

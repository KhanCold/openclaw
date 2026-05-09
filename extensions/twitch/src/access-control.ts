import {
  type ChannelIngressDecision,
  type ChannelIngressState,
} from "openclaw/plugin-sdk/channel-ingress";
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
  type ChannelIngressIdentitySubjectInput,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
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

type TwitchPolicyKind = TwitchAccessControlIngressResult["policyKind"];

const twitchUserIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  entryIdPrefix: "twitch-user-entry",
});

const twitchRoleIdentity = defineStableChannelIngressIdentity({
  key: "role-moderator",
  kind: "role",
  normalizeEntry: normalizeTwitchRole,
  normalizeSubject: normalizeTwitchRole,
  aliases: [
    {
      key: "role-owner",
      kind: "role",
      normalizeEntry: () => null,
      normalizeSubject: normalizeTwitchRole,
    },
    {
      key: "role-vip",
      kind: "role",
      normalizeEntry: () => null,
      normalizeSubject: normalizeTwitchRole,
    },
    {
      key: "role-subscriber",
      kind: "role",
      normalizeEntry: () => null,
      normalizeSubject: normalizeTwitchRole,
    },
  ],
  isWildcardEntry: (entry) => normalizeTwitchRole(entry) === "all",
  resolveEntryId: ({ entryIndex }) => `twitch-role-entry-${entryIndex + 1}`,
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
  const policyKind = resolveTwitchPolicyKind(account);
  const mentionFacts = {
    canDetectMention: true,
    wasMentioned: extractMentions(message.message).includes(
      normalizeLowercaseStringOrEmpty(botUsername),
    ),
  };
  const activation = {
    requireMention: account.requireMention ?? true,
    allowTextCommands: false,
  };

  if (activation.requireMention && !mentionFacts.wasMentioned) {
    const activationResolved = await resolveChannelMessageIngress({
      channelId: "twitch",
      accountId: "default",
      identity: twitchUserIdentity,
      subject: {},
      conversation: {
        kind: "group",
        id: message.channel,
      },
      event: {
        kind: "message",
        authMode: "inbound",
        mayPair: false,
      },
      mentionFacts,
      policy: {
        dmPolicy: "open",
        groupPolicy: "open",
        activation,
      },
    });

    return {
      stage: "activation",
      policyKind: "open",
      state: activationResolved.state,
      decision: activationResolved.ingress,
    };
  }

  const resolved = await resolveChannelMessageIngress({
    channelId: "twitch",
    accountId: "default",
    identity: policyKind === "role" ? twitchRoleIdentity : twitchUserIdentity,
    subject:
      policyKind === "role"
        ? twitchRoleSubject(message)
        : ({ stableId: message.userId } satisfies ChannelIngressIdentitySubjectInput),
    conversation: {
      kind: "group",
      id: message.channel,
    },
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: false,
    },
    mentionFacts,
    policy: {
      dmPolicy: "open",
      groupPolicy: policyKind === "open" ? "open" : "allowlist",
      activation,
    },
    groupAllowFrom:
      policyKind === "allowFrom"
        ? account.allowFrom
        : policyKind === "role"
          ? account.allowedRoles
          : undefined,
  });

  if (
    resolved.ingress.admission !== "dispatch" &&
    resolved.ingress.decisiveGateId === "activation"
  ) {
    return {
      stage: "activation",
      policyKind: "open",
      state: resolved.state,
      decision: resolved.ingress,
    };
  }

  return {
    stage: policyKind === "open" ? "activation" : "sender",
    policyKind,
    state: resolved.state,
    decision: resolved.ingress,
  };
}

function resolveTwitchPolicyKind(account: TwitchAccountConfig): TwitchPolicyKind {
  if (account.allowFrom !== undefined) {
    return "allowFrom";
  }
  if (account.allowedRoles && account.allowedRoles.length > 0) {
    return "role";
  }
  return "open";
}

function twitchRoleSubject(message: TwitchChatMessage): ChannelIngressIdentitySubjectInput {
  return {
    stableId: message.isMod ? "moderator" : undefined,
    aliases: {
      "role-owner": message.isOwner ? "owner" : undefined,
      "role-vip": message.isVip ? "vip" : undefined,
      "role-subscriber": message.isSub ? "subscriber" : undefined,
    },
  };
}

function normalizeTwitchRole(value: string): string | null {
  const role = normalizeLowercaseStringOrEmpty(value);
  if (role === "*") {
    return "all";
  }
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

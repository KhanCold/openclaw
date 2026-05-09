import {
  type ChannelIngressDecision,
  type RouteGateFacts,
} from "openclaw/plugin-sdk/channel-ingress";
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
  routeAllowlistFact,
  routeDisabledFact,
  routeSenderAllowlistFact,
  type ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { buildIrcAllowlistCandidates, normalizeIrcAllowEntry } from "./normalize.js";
import type { IrcGroupMatch } from "./policy.js";
import type { GroupPolicy, OpenClawConfig } from "./runtime-api.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

type IrcRoomGateReason = "channel_not_allowlisted" | "channel_disabled";
type ResolvedIrcIngressAccess = ResolvedChannelMessageIngress & {
  roomGateReason?: IrcRoomGateReason;
};

const IRC_NICK_KIND = "plugin:irc-nick" as const;

const ircIngressIdentity = defineStableChannelIngressIdentity({
  key: "irc-id",
  normalizeEntry: normalizeIrcStableEntry,
  normalizeSubject: normalizeLowercaseStringOrEmpty,
  sensitivity: "pii",
  aliases: [
    {
      key: "irc-id-nick-user",
      kind: "stable-id",
      normalizeEntry: () => null,
      normalizeSubject: normalizeLowercaseStringOrEmpty,
      sensitivity: "pii",
    },
    {
      key: "irc-id-nick-host",
      kind: "stable-id",
      normalizeEntry: () => null,
      normalizeSubject: normalizeLowercaseStringOrEmpty,
      sensitivity: "pii",
    },
    {
      key: "irc-nick",
      kind: IRC_NICK_KIND,
      normalizeEntry: normalizeIrcNickEntry,
      normalizeSubject: normalizeLowercaseStringOrEmpty,
      dangerous: true,
      sensitivity: "pii",
    },
  ],
  isWildcardEntry: (entry) => normalizeIrcAllowEntry(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    `irc-entry-${entryIndex + 1}:${fieldKey === "irc-nick" ? "nick" : "id"}`,
});

function isBareNick(value: string): boolean {
  return !value.includes("!") && !value.includes("@");
}

function normalizeIrcStableEntry(value: string): string | null {
  const normalized = normalizeIrcAllowEntry(value);
  if (!normalized || normalized === "*" || isBareNick(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeIrcNickEntry(value: string): string | null {
  const normalized = normalizeIrcAllowEntry(value);
  if (!normalized || normalized === "*" || !isBareNick(normalized)) {
    return null;
  }
  return normalized;
}

function stringEntries(entries: Array<string | number> | undefined): string[] {
  return (entries ?? []).map((entry) => String(entry));
}

function hasEntries(entries: Array<string | number> | undefined): boolean {
  return stringEntries(entries).some((entry) => normalizeIrcAllowEntry(entry));
}

function createIrcSubject(message: IrcInboundMessage) {
  const candidates = buildIrcAllowlistCandidates(message, { allowNameMatching: true });
  const stableCandidates = candidates.filter((candidate) => !isBareNick(candidate));
  const nick = normalizeLowercaseStringOrEmpty(message.senderNick);
  return {
    stableId: stableCandidates[stableCandidates.length - 1] ?? nick,
    aliases: {
      "irc-id-nick-user": stableCandidates.find(
        (candidate) => candidate.includes("!") && !candidate.includes("@"),
      ),
      "irc-id-nick-host": stableCandidates.find(
        (candidate) => !candidate.includes("!") && candidate.includes("@"),
      ),
      "irc-nick": nick,
    },
  };
}

function resolveGroupRouteAllowFrom(groupMatch: IrcGroupMatch): string[] {
  const directGroupAllowFrom = stringEntries(groupMatch.groupConfig?.allowFrom);
  if (directGroupAllowFrom.length > 0) {
    return directGroupAllowFrom;
  }
  return stringEntries(groupMatch.wildcardConfig?.allowFrom);
}

function routeFactsForIrcGroup(params: {
  isGroup: boolean;
  groupPolicy: GroupPolicy;
  groupMatch: IrcGroupMatch;
  routeGroupAllowFrom: string[];
}): RouteGateFacts[] {
  if (!params.isGroup) {
    return [];
  }
  const facts: RouteGateFacts[] = [];
  if (params.groupPolicy === "allowlist") {
    facts.push(
      routeAllowlistFact({
        id: "irc:channel",
        matched: params.groupMatch.hasConfiguredGroups && params.groupMatch.allowed,
        precedence: 0,
        match: {
          matched: params.groupMatch.hasConfiguredGroups && params.groupMatch.allowed,
          matchedEntryIds:
            params.groupMatch.hasConfiguredGroups && params.groupMatch.allowed
              ? ["irc-channel"]
              : [],
        },
      }),
    );
  }
  if (
    params.groupMatch.groupConfig?.enabled === false ||
    params.groupMatch.wildcardConfig?.enabled === false
  ) {
    facts.push(
      routeDisabledFact({
        id: "irc:channel-enabled",
        precedence: 10,
      }),
    );
  }
  if (hasEntries(params.routeGroupAllowFrom)) {
    facts.push(
      routeSenderAllowlistFact({
        id: "irc:channel-sender",
        precedence: 20,
        senderPolicy: "replace",
        senderAllowFrom: params.routeGroupAllowFrom,
      }),
    );
  }
  return facts;
}

function resolveIngressGroupPolicy(params: {
  groupPolicy: GroupPolicy;
  groupAllowFrom?: Array<string | number>;
  routeGroupAllowFrom: string[];
}): GroupPolicy {
  if (params.groupPolicy !== "open") {
    return params.groupPolicy;
  }
  return hasEntries(params.groupAllowFrom) || hasEntries(params.routeGroupAllowFrom)
    ? "allowlist"
    : "open";
}

function roomGateReason(decision: ChannelIngressDecision): IrcRoomGateReason | undefined {
  if (decision.decisiveGateId === "irc:channel") {
    return "channel_not_allowlisted";
  }
  if (decision.decisiveGateId === "irc:channel-enabled") {
    return "channel_disabled";
  }
  return undefined;
}

export async function resolveIrcIngressAccess(params: {
  accountId: string;
  message: IrcInboundMessage;
  config: CoreConfig;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  groupPolicy: GroupPolicy;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  groupMatch: IrcGroupMatch;
  allowNameMatching: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  requireMention: boolean;
  wasMentioned: boolean;
  readAllowFromStore: () => Promise<string[]>;
}): Promise<ResolvedIrcIngressAccess> {
  const routeGroupAllowFrom = resolveGroupRouteAllowFrom(params.groupMatch);
  const groupPolicy = resolveIngressGroupPolicy({
    groupPolicy: params.groupPolicy,
    groupAllowFrom: params.groupAllowFrom,
    routeGroupAllowFrom,
  });
  const resolved = await resolveChannelMessageIngress({
    channelId: "irc",
    accountId: params.accountId,
    identity: ircIngressIdentity,
    subject: createIrcSubject(params.message),
    conversation: {
      kind: params.message.isGroup ? "group" : "direct",
      id: params.message.target,
    },
    accessGroups: (params.config as OpenClawConfig).accessGroups,
    routeFacts: routeFactsForIrcGroup({
      isGroup: params.message.isGroup,
      groupPolicy: params.groupPolicy,
      groupMatch: params.groupMatch,
      routeGroupAllowFrom,
    }),
    mentionFacts: params.message.isGroup
      ? {
          canDetectMention: true,
          wasMentioned: params.wasMentioned,
          hasAnyMention: params.wasMentioned,
        }
      : undefined,
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: !params.message.isGroup,
    },
    policy: {
      dmPolicy: params.dmPolicy,
      groupPolicy,
      groupAllowFromFallbackToAllowFrom: false,
      mutableIdentifierMatching: params.allowNameMatching ? "enabled" : "disabled",
      activation: {
        requireMention: params.message.isGroup && params.requireMention,
        allowTextCommands: params.allowTextCommands,
      },
    },
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    readStoreAllowFrom: async () => await params.readAllowFromStore(),
    command: {
      useAccessGroups: (params.config as OpenClawConfig).commands?.useAccessGroups !== false,
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      modeWhenAccessGroupsOff: "allow",
    },
  });
  return {
    ...resolved,
    roomGateReason: roomGateReason(resolved.ingress),
  };
}

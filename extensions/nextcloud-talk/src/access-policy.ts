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
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  type GroupPolicy,
  type OpenClawConfig,
} from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  normalizeNextcloudTalkAllowEntry,
  normalizeNextcloudTalkAllowlist,
  resolveNextcloudTalkAllowlistMatch,
  resolveNextcloudTalkRoomMatch,
} from "./policy.js";
import type { CoreConfig, NextcloudTalkRoomConfig } from "./types.js";

type NextcloudTalkRoomMatch = ReturnType<typeof resolveNextcloudTalkRoomMatch>;
type NextcloudTalkRoomGateReason =
  | "room_not_allowlisted"
  | "room_disabled"
  | "room_sender_not_allowlisted";

const nextcloudTalkIngressIdentity = defineStableChannelIngressIdentity({
  key: "nextcloud-talk-user-id",
  normalize: normalizeNextcloudTalkIngressEntry,
  sensitivity: "pii",
  entryIdPrefix: "nextcloud-talk-entry",
});

function normalizeNextcloudTalkIngressEntry(value: string): string | null {
  const normalized = normalizeNextcloudTalkAllowEntry(value);
  return normalized || null;
}

function stringEntries(entries: Array<string | number> | undefined): string[] {
  return (entries ?? []).map((entry) => String(entry));
}

function resolveConfiguredGroupAllowFrom(
  accountConfig: ResolvedNextcloudTalkAccount["config"],
): string[] {
  return accountConfig.groupAllowFrom?.length
    ? stringEntries(accountConfig.groupAllowFrom)
    : stringEntries(accountConfig.allowFrom);
}

function hasEntries(entries: string[]): boolean {
  return normalizeNextcloudTalkAllowlist(entries).length > 0;
}

function roomSenderRouteFact(params: {
  senderId: string;
  outerGroupAllowFrom: string[];
  roomAllowFrom: string[];
}): RouteGateFacts | null {
  if (!hasEntries(params.roomAllowFrom)) {
    return null;
  }
  if (!hasEntries(params.outerGroupAllowFrom)) {
    return routeSenderAllowlistFact({
      id: "nextcloud-talk:room-sender",
      kind: "nestedAllowlist",
      precedence: 20,
      senderPolicy: "replace",
      senderAllowFrom: params.roomAllowFrom,
    });
  }
  const match = resolveNextcloudTalkAllowlistMatch({
    allowFrom: params.roomAllowFrom,
    senderId: params.senderId,
  });
  return routeAllowlistFact({
    id: "nextcloud-talk:room-sender",
    kind: "nestedAllowlist",
    matched: match.allowed,
    precedence: 20,
    match: {
      matched: match.allowed,
      matchedEntryIds: match.allowed ? ["nextcloud-talk-room-sender"] : [],
    },
  });
}

function roomRouteFacts(params: {
  isGroup: boolean;
  groupPolicy: GroupPolicy;
  roomMatch: NextcloudTalkRoomMatch;
  roomConfig?: NextcloudTalkRoomConfig;
  senderId: string;
  outerGroupAllowFrom: string[];
  roomAllowFrom: string[];
}): RouteGateFacts[] {
  if (!params.isGroup) {
    return [];
  }
  const facts: RouteGateFacts[] = [];
  if (params.roomMatch.allowlistConfigured) {
    facts.push(
      routeAllowlistFact({
        id: "nextcloud-talk:room",
        matched: params.roomMatch.allowed,
        precedence: 0,
        match: {
          matched: params.roomMatch.allowed,
          matchedEntryIds: params.roomMatch.allowed ? ["nextcloud-talk-room"] : [],
        },
      }),
    );
  }
  if (params.roomConfig?.enabled === false) {
    facts.push(
      routeDisabledFact({
        id: "nextcloud-talk:room-enabled",
        precedence: 10,
      }),
    );
  }
  if (params.groupPolicy === "allowlist") {
    const roomSender = roomSenderRouteFact({
      senderId: params.senderId,
      outerGroupAllowFrom: params.outerGroupAllowFrom,
      roomAllowFrom: params.roomAllowFrom,
    });
    if (roomSender) {
      facts.push(roomSender);
    }
  }
  return facts;
}

function roomGateReason(params: {
  decision: ChannelIngressDecision;
  roomMatch: NextcloudTalkRoomMatch;
  roomConfig?: NextcloudTalkRoomConfig;
  groupPolicy: GroupPolicy;
  outerGroupAllowFrom: string[];
  roomAllowFrom: string[];
}): NextcloudTalkRoomGateReason | undefined {
  const decisiveId = params.decision.decisiveGateId;
  if (decisiveId === "nextcloud-talk:room" && !params.roomMatch.allowed) {
    return "room_not_allowlisted";
  }
  if (decisiveId === "nextcloud-talk:room-enabled" && params.roomConfig?.enabled === false) {
    return "room_disabled";
  }
  if (decisiveId === "nextcloud-talk:room-sender") {
    return "room_sender_not_allowlisted";
  }
  if (
    decisiveId === "sender:group" &&
    params.groupPolicy === "allowlist" &&
    !hasEntries(params.outerGroupAllowFrom) &&
    hasEntries(params.roomAllowFrom)
  ) {
    return "room_sender_not_allowlisted";
  }
  return undefined;
}

export async function resolveNextcloudTalkIngressAccess(params: {
  config: CoreConfig;
  account: ResolvedNextcloudTalkAccount;
  isGroup: boolean;
  roomToken: string;
  senderId: string;
  roomMatch: NextcloudTalkRoomMatch;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  readAllowFromStore: () => Promise<string[]>;
}): Promise<
  ResolvedChannelMessageIngress & {
    groupPolicy: GroupPolicy;
    providerMissingFallbackApplied: boolean;
    roomGateReason?: NextcloudTalkRoomGateReason;
  }
> {
  const dmPolicy = params.account.config.dmPolicy ?? "pairing";
  const allowFrom = stringEntries(params.account.config.allowFrom);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent:
        ((params.config.channels as Record<string, unknown> | undefined)?.["nextcloud-talk"] ??
          undefined) !== undefined,
      groupPolicy: params.account.config.groupPolicy,
      defaultGroupPolicy: resolveDefaultGroupPolicy(params.config as OpenClawConfig),
    });
  const outerGroupAllowFrom = resolveConfiguredGroupAllowFrom(params.account.config);
  const roomConfig = params.roomMatch.roomConfig;
  const roomAllowFrom = stringEntries(roomConfig?.allowFrom);
  const resolved = await resolveChannelMessageIngress({
    channelId: "nextcloud-talk",
    accountId: params.account.accountId,
    identity: nextcloudTalkIngressIdentity,
    subject: { stableId: params.senderId },
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.isGroup ? params.roomToken : params.senderId,
    },
    accessGroups: (params.config as OpenClawConfig).accessGroups,
    routeFacts: roomRouteFacts({
      isGroup: params.isGroup,
      groupPolicy,
      roomMatch: params.roomMatch,
      roomConfig,
      senderId: params.senderId,
      outerGroupAllowFrom,
      roomAllowFrom,
    }),
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: !params.isGroup,
    },
    policy: {
      dmPolicy,
      groupPolicy,
      groupAllowFromFallbackToAllowFrom: true,
    },
    allowFrom,
    groupAllowFrom: params.account.config.groupAllowFrom,
    readStoreAllowFrom: async () => await params.readAllowFromStore(),
    command: {
      useAccessGroups:
        (params.config.commands as Record<string, unknown> | undefined)?.useAccessGroups !== false,
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      modeWhenAccessGroupsOff: "allow",
    },
  });
  const ingress = resolved.ingress;
  return {
    ...resolved,
    groupPolicy,
    providerMissingFallbackApplied,
    roomGateReason: roomGateReason({
      decision: ingress,
      roomMatch: params.roomMatch,
      roomConfig,
      groupPolicy,
      outerGroupAllowFrom,
      roomAllowFrom,
    }),
  };
}

import {
  createChannelIngressPluginId,
  createChannelIngressMultiIdentifierAdapter,
  findChannelIngressSenderReasonCode,
  resolveChannelIngressAccess,
  type ChannelIngressAdapterEntry,
  type ChannelIngressDecision,
  type ChannelIngressIdentifierKind,
  type ChannelIngressPolicyInput,
  type ChannelIngressSubject,
  type RouteGateFacts,
} from "openclaw/plugin-sdk/channel-ingress";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  createChannelPairingController,
  isDangerousNameMatchingEnabled,
  readStoreAllowFromForDmPolicy,
  resolveDefaultGroupPolicy,
  resolveEffectiveAllowFromLists,
  type OpenClawConfig,
} from "../../runtime-api.js";
import { normalizeMSTeamsConversationId } from "../inbound.js";
import { resolveMSTeamsRouteConfig } from "../policy.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

type MSTeamsGroupPolicy = "open" | "allowlist" | "disabled";
type MSTeamsAccessDecision = {
  decision: "allow" | "block" | "pairing";
  reasonCode:
    | "group_policy_allowed"
    | "group_policy_disabled"
    | "group_policy_empty_allowlist"
    | "group_policy_not_allowlisted"
    | "dm_policy_open"
    | "dm_policy_disabled"
    | "dm_policy_allowlisted"
    | "dm_policy_pairing_required"
    | "dm_policy_not_allowlisted";
  reason: string;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
};
type MSTeamsSenderGroupAccess = {
  allowed: boolean;
  groupPolicy: MSTeamsGroupPolicy;
  providerMissingFallbackApplied: boolean;
  reason: "allowed" | "disabled" | "empty_allowlist" | "sender_not_allowlisted";
};

const MSTEAMS_SENDER_NAME_KIND =
  "plugin:msteams-sender-name" as const satisfies ChannelIngressIdentifierKind;
const MSTEAMS_CHANNEL_ID = createChannelIngressPluginId("msteams");

function normalizeIngressValue(value?: string | null): string | null {
  return normalizeOptionalLowercaseString(value) ?? null;
}

function createMSTeamsAdapterEntry(params: {
  index: number;
  kind: ChannelIngressIdentifierKind;
  value: string;
  suffix: string;
  dangerous?: boolean;
}): ChannelIngressAdapterEntry {
  return {
    opaqueEntryId: `entry-${params.index + 1}:${params.suffix}`,
    kind: params.kind,
    value: params.value,
    dangerous: params.dangerous,
  };
}

function normalizeMSTeamsIngressEntry(entry: string, index: number): ChannelIngressAdapterEntry[] {
  const normalized = normalizeIngressValue(entry);
  if (!normalized) {
    return [];
  }
  if (normalized === "*") {
    return [
      createMSTeamsAdapterEntry({
        index,
        kind: "stable-id",
        value: "*",
        suffix: "wildcard",
      }),
    ];
  }
  return [
    createMSTeamsAdapterEntry({
      index,
      kind: "stable-id",
      value: normalized,
      suffix: "id",
    }),
    createMSTeamsAdapterEntry({
      index,
      kind: MSTEAMS_SENDER_NAME_KIND,
      value: normalized,
      suffix: "name",
      dangerous: true,
    }),
  ];
}

const msteamsIngressAdapter = createChannelIngressMultiIdentifierAdapter({
  normalizeEntry: normalizeMSTeamsIngressEntry,
});

function createMSTeamsIngressSubject(params: {
  senderId: string;
  senderName: string;
}): ChannelIngressSubject {
  const identifiers: ChannelIngressSubject["identifiers"] = [];
  const senderId = normalizeIngressValue(params.senderId);
  if (senderId) {
    identifiers.push({
      opaqueId: "sender-id",
      kind: "stable-id",
      value: senderId,
    });
  }
  const senderName = normalizeIngressValue(params.senderName);
  if (senderName) {
    identifiers.push({
      opaqueId: "sender-name",
      kind: MSTEAMS_SENDER_NAME_KIND,
      value: senderName,
      dangerous: true,
    });
  }
  return { identifiers };
}

function createMSTeamsRouteFacts(params: {
  isDirectMessage: boolean;
  routeAllowed: boolean;
  routeAllowlistConfigured: boolean;
  groupPolicy: MSTeamsGroupPolicy;
  effectiveGroupAllowFrom: string[];
}): RouteGateFacts[] {
  if (params.isDirectMessage || !params.routeAllowlistConfigured) {
    return [];
  }
  return [
    {
      id: "msteams:team-channel",
      kind: "nestedAllowlist",
      gate: params.routeAllowed ? "matched" : "not-matched",
      effect: params.routeAllowed ? "allow" : "block-dispatch",
      precedence: 0,
      senderPolicy: params.groupPolicy === "allowlist" ? "deny-when-empty" : "inherit",
      senderAllowFrom: params.routeAllowed ? params.effectiveGroupAllowFrom : undefined,
      match: {
        matched: params.routeAllowed,
        matchedEntryIds: params.routeAllowed ? ["msteams-route"] : [],
      },
    },
  ];
}

function senderGroupAccessFromIngress(params: {
  ingress: ChannelIngressDecision;
  groupPolicy: MSTeamsGroupPolicy;
}): MSTeamsSenderGroupAccess {
  const reasonCode = findChannelIngressSenderReasonCode(params.ingress, { isGroup: true });
  if (params.groupPolicy === "disabled" || reasonCode === "group_policy_disabled") {
    return {
      allowed: false,
      groupPolicy: params.groupPolicy,
      providerMissingFallbackApplied: false,
      reason: "disabled",
    };
  }
  if (reasonCode === "route_sender_empty" || reasonCode === "group_policy_empty_allowlist") {
    return {
      allowed: false,
      groupPolicy: params.groupPolicy,
      providerMissingFallbackApplied: false,
      reason: "empty_allowlist",
    };
  }
  if (reasonCode === "group_policy_not_allowlisted") {
    return {
      allowed: false,
      groupPolicy: params.groupPolicy,
      providerMissingFallbackApplied: false,
      reason: "sender_not_allowlisted",
    };
  }
  return {
    allowed: true,
    groupPolicy: params.groupPolicy,
    providerMissingFallbackApplied: false,
    reason: "allowed",
  };
}

export async function resolveMSTeamsSenderAccess(params: {
  cfg: OpenClawConfig;
  activity: MSTeamsTurnContext["activity"];
  hasControlCommand?: boolean;
}) {
  const activity = params.activity;
  const msteamsCfg = params.cfg.channels?.msteams;
  const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "unknown");
  const convType = normalizeOptionalLowercaseString(activity.conversation?.conversationType);
  const isDirectMessage = convType === "personal" || (!convType && !activity.conversation?.isGroup);
  const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "unknown";
  const senderName = activity.from?.name ?? activity.from?.id ?? senderId;

  const core = getMSTeamsRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: "msteams",
    accountId: DEFAULT_ACCOUNT_ID,
  });
  const dmPolicy = msteamsCfg?.dmPolicy ?? "pairing";
  const storedAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: "msteams",
    accountId: pairing.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const configuredDmAllowFrom = msteamsCfg?.allowFrom ?? [];
  const groupAllowFrom = msteamsCfg?.groupAllowFrom;
  const resolvedAllowFromLists = resolveEffectiveAllowFromLists({
    allowFrom: configuredDmAllowFrom,
    groupAllowFrom,
    storeAllowFrom: storedAllowFrom,
    dmPolicy,
  });
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const groupPolicy =
    !isDirectMessage && msteamsCfg
      ? (msteamsCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist")
      : "disabled";
  const effectiveGroupAllowFrom = resolvedAllowFromLists.effectiveGroupAllowFrom;
  const commandDmAllowFrom = isDirectMessage
    ? resolvedAllowFromLists.effectiveAllowFrom
    : configuredDmAllowFrom;
  const allowNameMatching = isDangerousNameMatchingEnabled(msteamsCfg);
  const channelGate = resolveMSTeamsRouteConfig({
    cfg: msteamsCfg,
    teamId: activity.channelData?.team?.id,
    teamName: activity.channelData?.team?.name,
    conversationId,
    channelName: activity.channelData?.channel?.name,
    allowNameMatching,
  });

  const ingressPolicy: ChannelIngressPolicyInput = {
    dmPolicy,
    groupPolicy,
    groupAllowFromFallbackToAllowFrom: false,
    mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
    command: {
      useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
      allowTextCommands: true,
      hasControlCommand: params.hasControlCommand === true,
    },
  };
  const resolved = await resolveChannelIngressAccess({
    channelId: MSTEAMS_CHANNEL_ID,
    accountId: pairing.accountId,
    subject: createMSTeamsIngressSubject({ senderId, senderName }),
    conversation: {
      kind: isDirectMessage ? "direct" : convType === "channel" ? "channel" : "group",
      id: conversationId,
      parentId: activity.channelData?.team?.id,
    },
    adapter: msteamsIngressAdapter,
    accessGroups: params.cfg.accessGroups,
    routeFacts: createMSTeamsRouteFacts({
      isDirectMessage,
      routeAllowed: channelGate.allowed,
      routeAllowlistConfigured: channelGate.allowlistConfigured,
      groupPolicy,
      effectiveGroupAllowFrom,
    }),
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: isDirectMessage,
    },
    allowlists: {
      dm: configuredDmAllowFrom,
      group: effectiveGroupAllowFrom,
      commandOwner: commandDmAllowFrom,
      commandGroup: effectiveGroupAllowFrom,
      pairingStore: storedAllowFrom,
    },
    policy: ingressPolicy,
    effectiveAllowFrom: resolvedAllowFromLists.effectiveAllowFrom,
    effectiveGroupAllowFrom,
  });
  const access: MSTeamsAccessDecision = {
    ...resolved.access,
  };
  const senderGroupAccess = senderGroupAccessFromIngress({
    ingress: resolved.ingress,
    groupPolicy,
  });

  return {
    msteamsCfg,
    pairing,
    isDirectMessage,
    conversationId,
    senderId,
    senderName,
    dmPolicy,
    channelGate,
    access,
    senderGroupAccess,
    commandAuthorized: resolved.commandAuthorized,
    shouldBlockControlCommand: resolved.shouldBlockControlCommand,
    configuredDmAllowFrom,
    effectiveDmAllowFrom: access.effectiveAllowFrom,
    effectiveGroupAllowFrom,
    allowNameMatching,
    groupPolicy,
  };
}

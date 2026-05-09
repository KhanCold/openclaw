import {
  type ChannelIngressIdentifierKind,
  type RouteGateFacts,
} from "openclaw/plugin-sdk/channel-ingress";
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
  routeAllowlistFact,
  routeDenyWhenSenderEmptyFact,
  type ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  createChannelPairingController,
  isDangerousNameMatchingEnabled,
  resolveDefaultGroupPolicy,
  type OpenClawConfig,
} from "../../runtime-api.js";
import { normalizeMSTeamsConversationId } from "../inbound.js";
import { resolveMSTeamsRouteConfig } from "../policy.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

type MSTeamsGroupPolicy = "open" | "allowlist" | "disabled";
const MSTEAMS_SENDER_NAME_KIND =
  "plugin:msteams-sender-name" as const satisfies ChannelIngressIdentifierKind;
const msteamsIngressIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  normalize: normalizeIngressValue,
  aliases: [
    {
      key: "sender-name",
      kind: MSTEAMS_SENDER_NAME_KIND,
      normalizeEntry: normalizeIngressValue,
      normalizeSubject: normalizeIngressValue,
      dangerous: true,
    },
  ],
  isWildcardEntry: (entry) => normalizeIngressValue(entry) === "*",
  resolveEntryId: ({ entryIndex, fieldKey }) =>
    `msteams-entry-${entryIndex + 1}:${fieldKey === "sender-name" ? "name" : "id"}`,
});

function normalizeIngressValue(value?: string | null): string | null {
  return normalizeOptionalLowercaseString(value) ?? null;
}

function createMSTeamsRouteFacts(params: {
  isDirectMessage: boolean;
  routeAllowed: boolean;
  routeAllowlistConfigured: boolean;
  groupPolicy: MSTeamsGroupPolicy;
}): RouteGateFacts[] {
  if (params.isDirectMessage || !params.routeAllowlistConfigured) {
    return [];
  }
  if (!params.routeAllowed) {
    return [
      routeAllowlistFact({
        id: "msteams:team-channel",
        kind: "nestedAllowlist",
        matched: false,
        precedence: 0,
        match: {
          matched: false,
          matchedEntryIds: [],
        },
      }),
    ];
  }
  const fact =
    params.groupPolicy === "allowlist"
      ? routeDenyWhenSenderEmptyFact({
          id: "msteams:team-channel",
          kind: "nestedAllowlist",
          precedence: 0,
          senderAllowFromSource: "effective-group",
          match: {
            matched: true,
            matchedEntryIds: ["msteams-route"],
          },
        })
      : routeAllowlistFact({
          id: "msteams:team-channel",
          kind: "nestedAllowlist",
          matched: true,
          precedence: 0,
          match: {
            matched: true,
            matchedEntryIds: ["msteams-route"],
          },
        });
  return [fact];
}

export async function resolveMSTeamsSenderAccess(params: {
  cfg: OpenClawConfig;
  activity: MSTeamsTurnContext["activity"];
  hasControlCommand?: boolean;
}): Promise<
  ResolvedChannelMessageIngress & {
    msteamsCfg: NonNullable<OpenClawConfig["channels"]>["msteams"] | undefined;
    pairing: ReturnType<typeof createChannelPairingController>;
    isDirectMessage: boolean;
    conversationId: string;
    senderId: string;
    senderName: string;
    dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
    channelGate: ReturnType<typeof resolveMSTeamsRouteConfig>;
    configuredDmAllowFrom: Array<string | number>;
    allowNameMatching: boolean;
    groupPolicy: MSTeamsGroupPolicy;
  }
> {
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
  const configuredDmAllowFrom = msteamsCfg?.allowFrom ?? [];
  const groupAllowFrom = msteamsCfg?.groupAllowFrom;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const groupPolicy =
    !isDirectMessage && msteamsCfg
      ? (msteamsCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist")
      : "disabled";
  const allowNameMatching = isDangerousNameMatchingEnabled(msteamsCfg);
  const channelGate = resolveMSTeamsRouteConfig({
    cfg: msteamsCfg,
    teamId: activity.channelData?.team?.id,
    teamName: activity.channelData?.team?.name,
    conversationId,
    channelName: activity.channelData?.channel?.name,
    allowNameMatching,
  });

  const resolved = await resolveChannelMessageIngress({
    channelId: "msteams",
    accountId: pairing.accountId,
    identity: msteamsIngressIdentity,
    subject: {
      stableId: senderId,
      aliases: { "sender-name": senderName },
    },
    conversation: {
      kind: isDirectMessage ? "direct" : convType === "channel" ? "channel" : "group",
      id: conversationId,
      parentId: activity.channelData?.team?.id,
    },
    accessGroups: params.cfg.accessGroups,
    routeFacts: createMSTeamsRouteFacts({
      isDirectMessage,
      routeAllowed: channelGate.allowed,
      routeAllowlistConfigured: channelGate.allowlistConfigured,
      groupPolicy,
    }),
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: isDirectMessage,
    },
    policy: {
      dmPolicy,
      groupPolicy,
      groupAllowFromFallbackToAllowFrom: true,
      mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
    },
    allowFrom: configuredDmAllowFrom,
    groupAllowFrom,
    readStoreAllowFrom: pairing.readAllowFromStore,
    command: {
      useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
      allowTextCommands: true,
      hasControlCommand: params.hasControlCommand === true,
      directGroupAllowFrom: isDirectMessage ? "effective" : "none",
    },
  });
  return {
    ...resolved,
    msteamsCfg,
    pairing,
    isDirectMessage,
    conversationId,
    senderId,
    senderName,
    dmPolicy,
    channelGate,
    configuredDmAllowFrom,
    allowNameMatching,
    groupPolicy,
  };
}

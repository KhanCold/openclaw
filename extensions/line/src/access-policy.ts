import {
  type ChannelIngressEventInput,
  type RouteGateFacts,
} from "openclaw/plugin-sdk/channel-ingress";
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
  routeDisabledFact,
  type ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { firstDefined, normalizeLineAllowEntry } from "./bot-access.js";
import type { LineAccountConfig, LineGroupConfig } from "./types.js";

export type ResolvedLineIngressAccess = ResolvedChannelMessageIngress & {
  groupPolicy: GroupPolicy;
  providerMissingFallbackApplied: boolean;
};

const lineIngressIdentity = defineStableChannelIngressIdentity({
  key: "line-user-id",
  normalize: normalizeLineIngressEntry,
  sensitivity: "pii",
  entryIdPrefix: "line-entry",
});

function normalizeLineIngressEntry(value: string): string | null {
  const normalized = normalizeLineAllowEntry(value);
  return normalized || null;
}

function stringEntries(entries: Array<string | number> | undefined): string[] {
  return (entries ?? []).map((entry) => String(entry));
}

function resolveLineGroupAllowFrom(params: {
  accountConfig: LineAccountConfig;
  groupConfig?: LineGroupConfig;
}): string[] {
  const fallbackGroupAllowFrom = params.accountConfig.allowFrom?.length
    ? params.accountConfig.allowFrom
    : undefined;
  return stringEntries(
    firstDefined(
      params.groupConfig?.allowFrom,
      params.accountConfig.groupAllowFrom,
      fallbackGroupAllowFrom,
    ),
  );
}

function resolveIngressGroupPolicy(params: {
  groupPolicy: GroupPolicy;
  groupConfig?: LineGroupConfig;
}): GroupPolicy {
  if (params.groupPolicy === "disabled") {
    return "disabled";
  }
  return params.groupConfig?.allowFrom !== undefined ? "allowlist" : params.groupPolicy;
}

function routeFactsForLineGroupConfig(params: {
  isGroup: boolean;
  groupConfig?: LineGroupConfig;
}): RouteGateFacts[] {
  if (!params.isGroup || params.groupConfig?.enabled !== false) {
    return [];
  }
  return [
    routeDisabledFact({
      id: "line:group-config",
    }),
  ];
}

export async function resolveLineIngressAccess(params: {
  cfg: OpenClawConfig;
  accountId: string;
  accountConfig: LineAccountConfig;
  providerConfigPresent: boolean;
  isGroup: boolean;
  conversationId: string;
  senderId: string;
  hasControlCommand: boolean;
  eventKind: ChannelIngressEventInput["kind"];
  groupConfig?: LineGroupConfig;
  readAllowFromStore: () => Promise<string[]>;
}): Promise<ResolvedLineIngressAccess> {
  const dmPolicy = params.accountConfig.dmPolicy ?? "pairing";
  const allowFrom = stringEntries(params.accountConfig.allowFrom);
  const { groupPolicy: runtimeGroupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: params.providerConfigPresent,
      groupPolicy: params.accountConfig.groupPolicy,
      defaultGroupPolicy: resolveDefaultGroupPolicy(params.cfg),
    });
  const groupPolicy = resolveIngressGroupPolicy({
    groupPolicy: runtimeGroupPolicy,
    groupConfig: params.groupConfig,
  });
  const groupAllowFrom = resolveLineGroupAllowFrom({
    accountConfig: params.accountConfig,
    groupConfig: params.groupConfig,
  });
  const resolved = await resolveChannelMessageIngress({
    channelId: "line",
    accountId: params.accountId,
    identity: lineIngressIdentity,
    subject: { stableId: params.senderId },
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.conversationId,
    },
    accessGroups: params.cfg.accessGroups,
    routeFacts: routeFactsForLineGroupConfig({
      isGroup: params.isGroup,
      groupConfig: params.groupConfig,
    }),
    event: {
      kind: params.eventKind,
      authMode: "inbound",
      mayPair: !params.isGroup,
    },
    policy: {
      dmPolicy,
      groupPolicy,
      groupAllowFromFallbackToAllowFrom: false,
    },
    allowFrom,
    groupAllowFrom,
    readStoreAllowFrom: async () => await params.readAllowFromStore(),
    command: {
      useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
      allowTextCommands: false,
      hasControlCommand: params.hasControlCommand,
      modeWhenAccessGroupsOff: "allow",
      groupOwnerAllowFrom: "none",
    },
  });
  return {
    ...resolved,
    groupPolicy,
    providerMissingFallbackApplied,
  };
}

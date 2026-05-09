import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
  type ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { GroupPolicy } from "openclaw/plugin-sdk/group-access";
import { normalizeZaloAllowEntry, resolveZaloRuntimeGroupPolicy } from "./group-access.js";
import type { ZaloAccountConfig } from "./types.js";

type ZaloCommandRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
};

const zaloIngressIdentity = defineStableChannelIngressIdentity({
  key: "zalo-user-id",
  normalize: normalizeZaloAllowEntry,
  sensitivity: "pii",
  entryIdPrefix: "zalo-entry",
});

function stringEntries(entries: Array<string | number> | undefined): string[] {
  return (entries ?? []).map((entry) => String(entry));
}

export async function resolveZaloMessageIngressAccess(params: {
  accountId: string;
  cfg: OpenClawConfig;
  accountConfig: ZaloAccountConfig;
  providerConfigPresent: boolean;
  defaultGroupPolicy?: GroupPolicy;
  isGroup: boolean;
  chatId: string;
  senderId: string;
  rawBody: string;
  readAllowFromStore: () => Promise<string[]>;
  commandRuntime: ZaloCommandRuntime;
}): Promise<ResolvedChannelMessageIngress> {
  const dmPolicy = params.accountConfig.dmPolicy ?? "pairing";
  const allowFrom = stringEntries(params.accountConfig.allowFrom);
  const configuredGroupAllowFrom = stringEntries(params.accountConfig.groupAllowFrom);
  const { groupPolicy, providerMissingFallbackApplied } = resolveZaloRuntimeGroupPolicy({
    providerConfigPresent: params.providerConfigPresent,
    groupPolicy: params.accountConfig.groupPolicy,
    defaultGroupPolicy: params.defaultGroupPolicy,
  });
  const shouldComputeAuth = params.commandRuntime.shouldComputeCommandAuthorized(
    params.rawBody,
    params.cfg,
  );
  return await resolveChannelMessageIngress({
    channelId: "zalo",
    accountId: params.accountId,
    identity: zaloIngressIdentity,
    subject: { stableId: params.senderId },
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.chatId,
    },
    accessGroups: params.cfg.accessGroups,
    providerMissingFallbackApplied,
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
    groupAllowFrom: configuredGroupAllowFrom,
    readStoreAllowFrom: async () => await params.readAllowFromStore(),
    command: shouldComputeAuth
      ? {
          useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
          allowTextCommands: false,
          hasControlCommand: true,
          modeWhenAccessGroupsOff: "allow",
        }
      : undefined,
  });
}

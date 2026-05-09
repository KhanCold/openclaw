import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
  type ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { DmPolicy, GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

export function normalizeZalouserAllowEntry(entry: string): string {
  return entry.replace(/^(zalouser|zlu):/i, "").trim();
}

function normalizeZalouserSender(value: string): string | null {
  const normalized = normalizeOptionalLowercaseString(normalizeZalouserAllowEntry(value));
  return normalized || null;
}

const zalouserIngressIdentity = defineStableChannelIngressIdentity({
  normalize: normalizeZalouserSender,
  sensitivity: "pii",
  entryIdPrefix: "zalouser-entry",
});

function normalizeDmPolicy(policy: string): DmPolicy {
  return policy === "open" || policy === "allowlist" || policy === "disabled" ? policy : "pairing";
}

function normalizeGroupPolicy(policy: string): GroupPolicy {
  return policy === "open" || policy === "disabled" ? policy : "allowlist";
}

export async function resolveZalouserIngressAccess(params: {
  cfg: OpenClawConfig;
  accountId: string;
  isGroup: boolean;
  senderId: string;
  rawBody: string;
  dmPolicy: string;
  groupPolicy: string;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  readAllowFromStore: () => Promise<Array<string | number>>;
  commandRuntime: {
    shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  };
}): Promise<ResolvedChannelMessageIngress> {
  const dmPolicy = normalizeDmPolicy(params.dmPolicy);
  const groupPolicy = normalizeGroupPolicy(params.groupPolicy);
  const shouldComputeCommandAuth = params.commandRuntime.shouldComputeCommandAuthorized(
    params.rawBody,
    params.cfg,
  );
  const resolved = await resolveChannelMessageIngress({
    channelId: "zalouser",
    accountId: params.accountId,
    identity: zalouserIngressIdentity,
    subject: { stableId: params.senderId },
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.isGroup ? "group" : params.senderId,
    },
    accessGroups: params.cfg.accessGroups,
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: !params.isGroup,
    },
    policy: {
      dmPolicy,
      groupPolicy,
      groupAllowFromFallbackToAllowFrom: false,
    },
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    readStoreAllowFrom: async () => await params.readAllowFromStore(),
    command: shouldComputeCommandAuth
      ? {
          useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
          allowTextCommands: false,
          hasControlCommand: true,
          directGroupAllowFrom: "effective",
          commandGroupAllowFromFallbackToAllowFrom: true,
        }
      : undefined,
  });
  return resolved;
}

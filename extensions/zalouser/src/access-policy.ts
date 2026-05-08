import {
  mergeDmAllowFromSources,
  resolveGroupAllowFromSources,
} from "openclaw/plugin-sdk/allow-from";
import {
  createChannelIngressPluginId,
  createChannelIngressMultiIdentifierAdapter,
  createChannelIngressSubject,
  resolveChannelIngressAccess,
  type ChannelIngressDecision,
} from "openclaw/plugin-sdk/channel-ingress";
import type { DmPolicy, GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type {
  DmGroupAccessDecision,
  DmGroupAccessReasonCode,
} from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

const ZALOUSER_CHANNEL_ID = createChannelIngressPluginId("zalouser");

export function normalizeZalouserAllowEntry(entry: string): string {
  return entry.replace(/^(zalouser|zlu):/i, "").trim();
}

function normalizeZalouserSender(value: string): string | null {
  const normalized = normalizeOptionalLowercaseString(normalizeZalouserAllowEntry(value));
  return normalized || null;
}

const zalouserIngressAdapter = createChannelIngressMultiIdentifierAdapter({
  normalizeEntry(entry, index) {
    const raw = entry.trim();
    const normalized = raw === "*" ? "*" : normalizeZalouserSender(raw);
    return normalized
      ? [
          {
            opaqueEntryId: `zalouser-entry-${index + 1}`,
            kind: "stable-id" as const,
            value: normalized,
            sensitivity: "pii" as const,
          },
        ]
      : [];
  },
  getSubjectMatchKeys(identifier) {
    if (identifier.kind !== "stable-id") {
      return [];
    }
    const normalized = normalizeZalouserSender(identifier.value);
    return normalized ? [`stable-id:${normalized}`] : [];
  },
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
  storeAllowFrom?: Array<string | number>;
  commandRuntime: {
    shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  };
}): Promise<{
  ingress: ChannelIngressDecision;
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  commandAuthorized: boolean | undefined;
}> {
  const dmPolicy = normalizeDmPolicy(params.dmPolicy);
  const groupPolicy = normalizeGroupPolicy(params.groupPolicy);
  const effectiveAllowFrom = mergeDmAllowFromSources({
    allowFrom: params.allowFrom,
    storeAllowFrom: params.storeAllowFrom,
    dmPolicy,
  });
  const effectiveGroupAllowFrom = resolveGroupAllowFromSources({
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    fallbackToAllowFrom: false,
  });
  const commandGroupAllowFrom = resolveGroupAllowFromSources({
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
  });
  const shouldComputeCommandAuth = params.commandRuntime.shouldComputeCommandAuthorized(
    params.rawBody,
    params.cfg,
  );
  const resolved = await resolveChannelIngressAccess({
    channelId: ZALOUSER_CHANNEL_ID,
    accountId: params.accountId,
    subject: createChannelIngressSubject({
      value: params.senderId,
      sensitivity: "pii",
    }),
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.isGroup ? "group" : params.senderId,
    },
    adapter: zalouserIngressAdapter,
    accessGroups: params.cfg.accessGroups,
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: !params.isGroup,
    },
    allowlists: {
      dm: params.allowFrom,
      group: params.groupAllowFrom,
      pairingStore: params.isGroup ? [] : params.storeAllowFrom,
      commandOwner: effectiveAllowFrom,
      commandGroup: commandGroupAllowFrom,
    },
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    policy: {
      dmPolicy,
      groupPolicy,
      groupAllowFromFallbackToAllowFrom: false,
      ...(shouldComputeCommandAuth
        ? {
            command: {
              useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
              allowTextCommands: false,
              hasControlCommand: true,
            },
          }
        : {}),
    },
  });
  return {
    ingress: resolved.ingress,
    decision: resolved.access.decision,
    reasonCode: resolved.access.reasonCode,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    commandAuthorized: shouldComputeCommandAuth ? resolved.commandAuthorized : undefined,
  };
}

import type { GroupPolicy } from "../../config/types.base.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { resolveGroupAllowFromSources } from "../allow-from.js";
import { resolveControlCommandGate } from "../command-gating.js";
import type { ChannelId } from "../plugins/types.public.js";
import { resolveDmAllowAuditState } from "./dm-allow-state.js";
import {
  readChannelIngressStoreAllowFromForDmPolicy,
  resolveChannelIngressEffectiveAllowFromLists,
} from "./runtime.js";

function evaluateMatchedGroupAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  allowlistConfigured: boolean;
  allowlistMatched: boolean;
}): { allowed: boolean; reason: "allowed" | "disabled" | "empty_allowlist" | "not_allowlisted" } {
  if (params.groupPolicy === "disabled") {
    return { allowed: false, reason: "disabled" };
  }
  if (params.groupPolicy === "allowlist") {
    if (!params.allowlistConfigured) {
      return { allowed: false, reason: "empty_allowlist" };
    }
    if (!params.allowlistMatched) {
      return { allowed: false, reason: "not_allowlisted" };
    }
  }
  return { allowed: true, reason: "allowed" };
}

export function resolvePinnedMainDmOwnerFromAllowlist(params: {
  dmScope?: string | null;
  allowFrom?: Array<string | number> | null;
  normalizeEntry: (entry: string) => string | undefined;
}): string | null {
  if ((params.dmScope ?? "main") !== "main") {
    return null;
  }
  const rawAllowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : [];
  if (rawAllowFrom.some((entry) => String(entry).trim() === "*")) {
    return null;
  }
  const normalizedOwners = Array.from(
    new Set(
      rawAllowFrom
        .map((entry) => params.normalizeEntry(String(entry)))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  );
  return normalizedOwners.length === 1 ? normalizedOwners[0] : null;
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveEffectiveAllowFromLists(params: {
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  return resolveChannelIngressEffectiveAllowFromLists(params);
}

export type DmGroupAccessDecision = "allow" | "block" | "pairing";
export const DM_GROUP_ACCESS_REASON = {
  GROUP_POLICY_ALLOWED: "group_policy_allowed",
  GROUP_POLICY_DISABLED: "group_policy_disabled",
  GROUP_POLICY_EMPTY_ALLOWLIST: "group_policy_empty_allowlist",
  GROUP_POLICY_NOT_ALLOWLISTED: "group_policy_not_allowlisted",
  DM_POLICY_OPEN: "dm_policy_open",
  DM_POLICY_DISABLED: "dm_policy_disabled",
  DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted",
  DM_POLICY_PAIRING_REQUIRED: "dm_policy_pairing_required",
  DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted",
} as const;
export type DmGroupAccessReasonCode =
  (typeof DM_GROUP_ACCESS_REASON)[keyof typeof DM_GROUP_ACCESS_REASON];
type DmGroupAccessResult = {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
};

function dmGroupAccess(
  decision: DmGroupAccessDecision,
  reasonCode: DmGroupAccessReasonCode,
  reason: string,
): DmGroupAccessResult {
  return { decision, reasonCode, reason };
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveOpenDmAllowlistAccess(params: {
  effectiveAllowFrom: Array<string | number>;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): DmGroupAccessResult {
  const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
  if (effectiveAllowFrom.includes("*")) {
    return dmGroupAccess("allow", DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN, "dmPolicy=open");
  }
  if (params.isSenderAllowed(effectiveAllowFrom)) {
    return dmGroupAccess(
      "allow",
      DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
      "dmPolicy=open (allowlisted)",
    );
  }
  return dmGroupAccess(
    "block",
    DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
    "dmPolicy=open (not allowlisted)",
  );
}

type DmGroupAccessInputParams = {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
  isSenderAllowed: (allowFrom: string[]) => boolean;
};

/** @deprecated Use `resolveChannelMessageIngress` or `readChannelIngressStoreAllowFromForDmPolicy` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export async function readStoreAllowFromForDmPolicy(params: {
  provider: ChannelId;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<string[]> {
  return await readChannelIngressStoreAllowFromForDmPolicy(params);
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveDmGroupAccessDecision(params: {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  effectiveAllowFrom: Array<string | number>;
  effectiveGroupAllowFrom: Array<string | number>;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): DmGroupAccessResult {
  const dmPolicy = params.dmPolicy ?? "pairing";
  const groupPolicy: GroupPolicy =
    params.groupPolicy === "open" || params.groupPolicy === "disabled"
      ? params.groupPolicy
      : "allowlist";
  const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
  const effectiveGroupAllowFrom = normalizeStringEntries(params.effectiveGroupAllowFrom);

  if (params.isGroup) {
    const groupAccess = evaluateMatchedGroupAccessForPolicy({
      groupPolicy,
      allowlistConfigured: effectiveGroupAllowFrom.length > 0,
      allowlistMatched: params.isSenderAllowed(effectiveGroupAllowFrom),
    });

    if (!groupAccess.allowed) {
      if (groupAccess.reason === "disabled") {
        return dmGroupAccess(
          "block",
          DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED,
          "groupPolicy=disabled",
        );
      }
      if (groupAccess.reason === "empty_allowlist") {
        return dmGroupAccess(
          "block",
          DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST,
          "groupPolicy=allowlist (empty allowlist)",
        );
      }
      if (groupAccess.reason === "not_allowlisted") {
        return dmGroupAccess(
          "block",
          DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
          "groupPolicy=allowlist (not allowlisted)",
        );
      }
    }

    return dmGroupAccess(
      "allow",
      DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED,
      `groupPolicy=${groupPolicy}`,
    );
  }

  if (dmPolicy === "disabled") {
    return dmGroupAccess("block", DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED, "dmPolicy=disabled");
  }
  if (dmPolicy === "open") {
    return resolveOpenDmAllowlistAccess({
      effectiveAllowFrom,
      isSenderAllowed: params.isSenderAllowed,
    });
  }
  if (params.isSenderAllowed(effectiveAllowFrom)) {
    return dmGroupAccess(
      "allow",
      DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
      `dmPolicy=${dmPolicy} (allowlisted)`,
    );
  }
  if (dmPolicy === "pairing") {
    return dmGroupAccess(
      "pairing",
      DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED,
      "dmPolicy=pairing (not allowlisted)",
    );
  }
  return dmGroupAccess(
    "block",
    DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
    `dmPolicy=${dmPolicy} (not allowlisted)`,
  );
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveDmGroupAccessWithLists(params: DmGroupAccessInputParams): {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    storeAllowFrom: params.storeAllowFrom,
    dmPolicy: params.dmPolicy,
    groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
  });
  const access = resolveDmGroupAccessDecision({
    isGroup: params.isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    isSenderAllowed: params.isSenderAllowed,
  });
  return {
    ...access,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
  };
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export function resolveDmGroupAccessWithCommandGate(
  params: DmGroupAccessInputParams & {
    command?: {
      useAccessGroups: boolean;
      allowTextCommands: boolean;
      hasControlCommand: boolean;
    };
  },
): {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  commandAuthorized: boolean;
  shouldBlockControlCommand: boolean;
} {
  const access = resolveDmGroupAccessWithLists({
    isGroup: params.isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    storeAllowFrom: params.storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
    isSenderAllowed: params.isSenderAllowed,
  });

  const configuredAllowFrom = normalizeStringEntries(params.allowFrom ?? []);
  const configuredGroupAllowFrom = normalizeStringEntries(
    resolveGroupAllowFromSources({
      allowFrom: configuredAllowFrom,
      groupAllowFrom: normalizeStringEntries(params.groupAllowFrom ?? []),
      fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? undefined,
    }),
  );
  // Group command authorization must not inherit DM pairing-store approvals.
  const commandDmAllowFrom = params.isGroup ? configuredAllowFrom : access.effectiveAllowFrom;
  const commandGroupAllowFrom = params.isGroup
    ? configuredGroupAllowFrom
    : access.effectiveGroupAllowFrom;
  const ownerAllowedForCommands = params.isSenderAllowed(commandDmAllowFrom);
  const groupAllowedForCommands = params.isSenderAllowed(commandGroupAllowFrom);
  const commandGate = params.command
    ? resolveControlCommandGate({
        useAccessGroups: params.command.useAccessGroups,
        authorizers: [
          {
            configured: commandDmAllowFrom.length > 0,
            allowed: ownerAllowedForCommands,
          },
          {
            configured: commandGroupAllowFrom.length > 0,
            allowed: groupAllowedForCommands,
          },
        ],
        allowTextCommands: params.command.allowTextCommands,
        hasControlCommand: params.command.hasControlCommand,
      })
    : { commandAuthorized: false, shouldBlock: false };

  return {
    ...access,
    commandAuthorized: commandGate.commandAuthorized,
    shouldBlockControlCommand: params.isGroup && commandGate.shouldBlock,
  };
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export async function resolveDmAllowState(params: {
  provider: ChannelId;
  accountId: string;
  allowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  normalizeEntry?: (raw: string) => string;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<{
  configAllowFrom: string[];
  hasWildcard: boolean;
  allowCount: number;
  isMultiUserDm: boolean;
}> {
  return await resolveDmAllowAuditState(params);
}

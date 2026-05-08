import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readStoreAllowFromForDmPolicy,
  resolveEffectiveAllowFromLists,
  type DmGroupAccessReasonCode,
} from "../security/dm-policy-shared.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import {
  expandAllowFromWithAccessGroups,
  type AccessGroupMembershipResolver,
} from "./access-groups.js";
import {
  createChannelIngressPluginId,
  createChannelIngressSubject,
  decideChannelIngress,
  findChannelIngressCommandGate,
  findChannelIngressSenderGate,
  resolveChannelIngressState,
  type ChannelIngressAdapter,
  type ChannelIngressDecision,
} from "./channel-ingress.js";
export type { AccessGroupMembershipResolver } from "./access-groups.js";

export type DirectDmCommandAuthorizationRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  /** @deprecated Command authorization is resolved by channel ingress. Kept for runtime injection compatibility. */
  resolveCommandAuthorizedFromAuthorizers?: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
    modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  }) => boolean;
};

export type ResolvedInboundDirectDmAccess = {
  access: {
    decision: "allow" | "block" | "pairing";
    reasonCode: DmGroupAccessReasonCode;
    reason: string;
    effectiveAllowFrom: string[];
  };
  shouldComputeAuth: boolean;
  senderAllowedForCommands: boolean;
  commandAuthorized: boolean | undefined;
};

type DirectDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

function normalizeDirectDmPolicy(policy: string | null | undefined): DirectDmPolicy {
  return policy === "pairing" ||
    policy === "allowlist" ||
    policy === "open" ||
    policy === "disabled"
    ? policy
    : "allowlist";
}

function createDirectDmAccessAdapter(params: {
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}): ChannelIngressAdapter {
  return {
    normalizeEntries({ entries }) {
      return {
        matchable: normalizeStringEntries(entries).map((entry, index) => ({
          opaqueEntryId: `entry-${index + 1}`,
          kind: "stable-id",
          value: entry,
        })),
        invalid: [],
        disabled: [],
      };
    },
    matchSubject({ entries }) {
      const matchedEntryIds = entries
        .filter(
          (entry) => entry.value === "*" || params.isSenderAllowed(params.senderId, [entry.value]),
        )
        .map((entry) => entry.opaqueEntryId);
      return {
        matched: matchedEntryIds.length > 0,
        matchedEntryIds,
      };
    },
  };
}

function mapDirectDmIngressDecision(params: {
  decision: ChannelIngressDecision;
  rawDmPolicy: string;
}): {
  decision: "allow" | "block" | "pairing";
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
} {
  const reasonCode =
    findChannelIngressSenderGate(params.decision, { isGroup: false })?.reasonCode ??
    params.decision.reasonCode;
  switch (reasonCode) {
    case "dm_policy_disabled":
      return {
        decision: "block",
        reasonCode: "dm_policy_disabled",
        reason: "dmPolicy=disabled",
      };
    case "dm_policy_open":
      return {
        decision: "allow",
        reasonCode: "dm_policy_open",
        reason: "dmPolicy=open",
      };
    case "dm_policy_allowlisted":
      return {
        decision: "allow",
        reasonCode: "dm_policy_allowlisted",
        reason: `dmPolicy=${params.rawDmPolicy} (allowlisted)`,
      };
    case "dm_policy_pairing_required":
      return {
        decision: "pairing",
        reasonCode: "dm_policy_pairing_required",
        reason: "dmPolicy=pairing (not allowlisted)",
      };
    default:
      return {
        decision: "block",
        reasonCode: "dm_policy_not_allowlisted",
        reason: `dmPolicy=${params.rawDmPolicy} (not allowlisted)`,
      };
  }
}

/** Resolve direct-DM policy, effective allowlists, and optional command auth in one place. */
export async function resolveInboundDirectDmAccessWithRuntime(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId: string;
  dmPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  senderId: string;
  rawBody: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  resolveAccessGroupMembership?: AccessGroupMembershipResolver;
  runtime: DirectDmCommandAuthorizationRuntime;
  modeWhenAccessGroupsOff?: "allow" | "deny" | "configured";
  readStoreAllowFrom?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<ResolvedInboundDirectDmAccess> {
  const rawDmPolicy = params.dmPolicy ?? "pairing";
  const dmPolicy = normalizeDirectDmPolicy(rawDmPolicy);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: params.channel,
    accountId: params.accountId,
    dmPolicy: rawDmPolicy,
    readStore: params.readStoreAllowFrom,
  });
  const [allowFrom, effectiveStoreAllowFrom] = await Promise.all([
    expandAllowFromWithAccessGroups({
      cfg: params.cfg,
      allowFrom: params.allowFrom,
      channel: params.channel,
      accountId: params.accountId,
      senderId: params.senderId,
      isSenderAllowed: params.isSenderAllowed,
      resolveMembership: params.resolveAccessGroupMembership,
    }),
    expandAllowFromWithAccessGroups({
      cfg: params.cfg,
      allowFrom: storeAllowFrom,
      channel: params.channel,
      accountId: params.accountId,
      senderId: params.senderId,
      isSenderAllowed: params.isSenderAllowed,
      resolveMembership: params.resolveAccessGroupMembership,
    }),
  ]);

  const { effectiveAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom,
    storeAllowFrom: effectiveStoreAllowFrom,
    dmPolicy: rawDmPolicy,
  });
  const state = await resolveChannelIngressState({
    channelId: createChannelIngressPluginId(params.channel),
    accountId: params.accountId,
    subject: createChannelIngressSubject({
      opaqueId: "sender-id",
      value: params.senderId,
    }),
    conversation: {
      kind: "direct",
      id: params.senderId,
    },
    adapter: createDirectDmAccessAdapter({
      senderId: params.senderId,
      isSenderAllowed: params.isSenderAllowed,
    }),
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: true,
    },
    allowlists: {
      dm: dmPolicy === rawDmPolicy ? allowFrom : effectiveAllowFrom,
      pairingStore: dmPolicy === "pairing" ? effectiveStoreAllowFrom : [],
    },
  });
  const decision = decideChannelIngress(state, {
    dmPolicy,
    groupPolicy: "disabled",
  });
  const access = {
    ...mapDirectDmIngressDecision({ decision, rawDmPolicy }),
    effectiveAllowFrom,
  };

  const shouldComputeAuth = params.runtime.shouldComputeCommandAuthorized(
    params.rawBody,
    params.cfg,
  );
  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    access.effectiveAllowFrom,
  );
  const commandState = await resolveChannelIngressState({
    channelId: createChannelIngressPluginId(params.channel),
    accountId: params.accountId,
    subject: createChannelIngressSubject({
      opaqueId: "sender-id",
      value: params.senderId,
    }),
    conversation: {
      kind: "direct",
      id: params.senderId,
    },
    adapter: createDirectDmAccessAdapter({
      senderId: params.senderId,
      isSenderAllowed: params.isSenderAllowed,
    }),
    event: {
      kind: "message",
      authMode: "none",
      mayPair: false,
    },
    allowlists: {
      commandOwner: access.effectiveAllowFrom,
    },
  });
  const commandDecision = decideChannelIngress(commandState, {
    dmPolicy: "allowlist",
    groupPolicy: "disabled",
    command: {
      useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
      allowTextCommands: false,
      hasControlCommand: shouldComputeAuth,
      modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
    },
  });
  const commandAuthorized = shouldComputeAuth
    ? findChannelIngressCommandGate(commandDecision)?.allowed === true
    : undefined;

  return {
    access: {
      decision: access.decision,
      reasonCode: access.reasonCode,
      reason: access.reason,
      effectiveAllowFrom: access.effectiveAllowFrom,
    },
    shouldComputeAuth,
    senderAllowedForCommands,
    commandAuthorized,
  };
}

/** Convert resolved DM policy into a pre-crypto allow/block/pairing callback. */
export function createPreCryptoDirectDmAuthorizer(params: {
  resolveAccess: (
    senderId: string,
  ) => Promise<Pick<ResolvedInboundDirectDmAccess, "access"> | ResolvedInboundDirectDmAccess>;
  issuePairingChallenge?: (params: {
    senderId: string;
    reply: (text: string) => Promise<void>;
  }) => Promise<void>;
  onBlocked?: (params: {
    senderId: string;
    reason: string;
    reasonCode: DmGroupAccessReasonCode;
  }) => void;
}) {
  return async (input: {
    senderId: string;
    reply: (text: string) => Promise<void>;
  }): Promise<"allow" | "block" | "pairing"> => {
    const resolved = await params.resolveAccess(input.senderId);
    const access = "access" in resolved ? resolved.access : resolved;
    if (access.decision === "allow") {
      return "allow";
    }
    if (access.decision === "pairing") {
      if (params.issuePairingChallenge) {
        await params.issuePairingChallenge({
          senderId: input.senderId,
          reply: input.reply,
        });
      }
      return "pairing";
    }
    params.onBlocked?.({
      senderId: input.senderId,
      reason: access.reason,
      reasonCode: access.reasonCode,
    });
    return "block";
  };
}

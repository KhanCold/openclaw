import { type DmGroupAccessReasonCode } from "../channels/message-access/legacy-policy.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type AccessGroupMembershipResolver } from "./access-groups.js";
import {
  defineChannelIngressIdentity,
  resolveChannelMessageIngress,
} from "./channel-ingress-runtime.js";
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

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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

function createDirectDmIngressIdentity(params: {
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
}) {
  return defineChannelIngressIdentity({
    primary: {
      key: "sender-id",
    },
    matchEntry({ entry }) {
      return entry.value === "*" || params.isSenderAllowed(params.senderId, [entry.value]);
    },
  });
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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
  const resolveAccessGroupMembership = params.resolveAccessGroupMembership;
  const shouldComputeAuth = params.runtime.shouldComputeCommandAuthorized(
    params.rawBody,
    params.cfg,
  );
  const resolved = await resolveChannelMessageIngress({
    channelId: params.channel,
    accountId: params.accountId,
    identity: createDirectDmIngressIdentity({
      senderId: params.senderId,
      isSenderAllowed: params.isSenderAllowed,
    }),
    subject: { stableId: params.senderId },
    conversation: {
      kind: "direct",
      id: params.senderId,
    },
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: true,
    },
    accessGroups: params.cfg.accessGroups,
    resolveAccessGroupMembership: resolveAccessGroupMembership
      ? async ({ name, group, channelId, accountId }) =>
          await resolveAccessGroupMembership({
            cfg: params.cfg,
            name,
            group,
            channel: channelId as ChannelId,
            accountId,
            senderId: params.senderId,
          })
      : undefined,
    policy: {
      dmPolicy,
      groupPolicy: "disabled",
    },
    allowFrom: params.allowFrom,
    readStoreAllowFrom: params.readStoreAllowFrom
      ? async () => await params.readStoreAllowFrom?.(params.channel, params.accountId)
      : undefined,
    useDefaultPairingStore: params.readStoreAllowFrom == null,
    command: shouldComputeAuth
      ? {
          useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
          allowTextCommands: false,
          hasControlCommand: true,
          modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
        }
      : undefined,
  });
  const access = resolved.senderAccess;

  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    access.effectiveAllowFrom,
  );

  return {
    access: {
      decision: access.decision,
      reasonCode: access.reasonCode,
      reason: access.reason,
      effectiveAllowFrom: access.effectiveAllowFrom,
    },
    shouldComputeAuth,
    senderAllowedForCommands,
    commandAuthorized: shouldComputeAuth ? resolved.commandAccess.authorized : undefined,
  };
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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

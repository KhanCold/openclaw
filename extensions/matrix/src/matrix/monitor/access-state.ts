import type { ChannelIngressPolicyInput } from "openclaw/plugin-sdk/channel-ingress";
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngressBundle,
  resolveChannelMessageIngress,
  type ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeMatrixAllowList, resolveMatrixAllowListMatch } from "./allowlist.js";

type MatrixMonitorAllowListMatch = {
  allowed: boolean;
  matchKey?: string;
  matchSource?: "wildcard" | "id" | "prefixed-id" | "prefixed-user";
};

type MatrixMonitorAccessState = {
  effectiveGroupAllowFrom: string[];
  effectiveRoomUsers: string[];
  directAllowMatch: MatrixMonitorAllowListMatch;
  roomUserMatch: MatrixMonitorAllowListMatch | null;
  groupAllowMatch: MatrixMonitorAllowListMatch | null;
  messageIngress: ResolvedChannelMessageIngress;
  accountId: string;
  senderId: string;
  isRoom: boolean;
};

function normalizeMatrixEntry(raw?: string | null): string | null {
  return normalizeMatrixAllowList([raw ?? ""])[0] ?? null;
}

const matrixIngressIdentity = defineStableChannelIngressIdentity({
  key: "sender-id",
  normalize: normalizeMatrixEntry,
  matchEntry({ subject, entry }) {
    const senderId = subject.identifiers[0]?.value;
    return (
      entry.value === "*" ||
      resolveMatrixAllowListMatch({
        allowList: [entry.value],
        userId: senderId ?? "",
      }).allowed
    );
  },
});

function resolveMatrixIngressGroupPolicy(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  effectiveGroupAllowFrom: string[];
  effectiveRoomUsers: string[];
}): ChannelIngressPolicyInput["groupPolicy"] {
  if (params.groupPolicy === "disabled") {
    return "disabled";
  }
  if (params.effectiveRoomUsers.length > 0) {
    return "allowlist";
  }
  if (params.groupPolicy === "allowlist" && params.effectiveGroupAllowFrom.length > 0) {
    return "allowlist";
  }
  return "open";
}

function resolveMatrixIngressGroupAllowFrom(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  effectiveGroupAllowFrom: string[];
  effectiveRoomUsers: string[];
}): string[] {
  if (params.effectiveRoomUsers.length > 0) {
    return params.effectiveRoomUsers;
  }
  if (params.groupPolicy === "allowlist" && params.effectiveGroupAllowFrom.length > 0) {
    return params.effectiveGroupAllowFrom;
  }
  return [];
}

export async function resolveMatrixMonitorAccessState(params: {
  allowFrom: Array<string | number>;
  storeAllowFrom: Array<string | number>;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom: Array<string | number>;
  roomUsers: Array<string | number>;
  senderId: string;
  isRoom: boolean;
  accountId?: string;
  eventKind?: "message" | "reaction";
}): Promise<MatrixMonitorAccessState> {
  const dmPolicy = params.dmPolicy ?? "pairing";
  const groupPolicy = params.groupPolicy ?? "open";
  const effectiveGroupAllowFrom = normalizeMatrixAllowList(params.groupAllowFrom);
  const effectiveRoomUsers = normalizeMatrixAllowList(params.roomUsers);
  const ingressGroupPolicy = resolveMatrixIngressGroupPolicy({
    groupPolicy,
    effectiveGroupAllowFrom,
    effectiveRoomUsers,
  });
  const accountId = params.accountId ?? "default";
  const eventKind = params.eventKind ?? "message";
  const directInput = {
    channelId: "matrix",
    accountId,
    identity: matrixIngressIdentity,
    subject: { stableId: params.senderId },
    conversation: {
      kind: "direct" as const,
      id: "matrix-dm",
    },
    event: {
      kind: eventKind,
      authMode: "inbound" as const,
      mayPair: !params.isRoom && eventKind === "message",
    },
    policy: {
      dmPolicy,
      groupPolicy: "disabled" as const,
      groupAllowFromFallbackToAllowFrom: false,
    },
    allowFrom: params.allowFrom,
    readStoreAllowFrom: async () => params.storeAllowFrom,
  };
  const groupInput = {
    channelId: "matrix",
    accountId,
    identity: matrixIngressIdentity,
    subject: { stableId: params.senderId },
    conversation: {
      kind: "group" as const,
      id: "matrix-room",
    },
    event: {
      kind: eventKind,
      authMode: "inbound" as const,
      mayPair: false,
    },
    policy: {
      dmPolicy,
      groupPolicy: ingressGroupPolicy,
      groupAllowFromFallbackToAllowFrom: false,
    },
    allowFrom: params.allowFrom,
    groupAllowFrom: resolveMatrixIngressGroupAllowFrom({
      groupPolicy,
      effectiveGroupAllowFrom,
      effectiveRoomUsers,
    }),
  };
  const { direct: directResolved, group: resolved } = params.isRoom
    ? await resolveChannelMessageIngressBundle({
        direct: directInput,
        group: groupInput,
      })
    : { direct: await resolveChannelMessageIngress(directInput), group: undefined };
  const effectiveAllowFrom = directResolved.senderAccess.effectiveAllowFrom;
  const directAllowMatch = resolveMatrixAllowListMatch({
    allowList: effectiveAllowFrom,
    userId: params.senderId,
  });
  const roomUserMatch =
    params.isRoom && effectiveRoomUsers.length > 0
      ? resolveMatrixAllowListMatch({
          allowList: effectiveRoomUsers,
          userId: params.senderId,
        })
      : null;
  const groupAllowMatch =
    effectiveGroupAllowFrom.length > 0
      ? resolveMatrixAllowListMatch({
          allowList: effectiveGroupAllowFrom,
          userId: params.senderId,
        })
      : null;

  return {
    effectiveGroupAllowFrom,
    effectiveRoomUsers,
    directAllowMatch,
    roomUserMatch,
    groupAllowMatch,
    messageIngress: resolved ?? directResolved,
    accountId,
    senderId: params.senderId,
    isRoom: params.isRoom,
  };
}

export async function resolveMatrixMonitorCommandAccess(
  state: MatrixMonitorAccessState,
  params: {
    useAccessGroups: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
  },
): Promise<ResolvedChannelMessageIngress["commandAccess"]> {
  const commandAllowFrom = state.isRoom ? [] : state.messageIngress.senderAccess.effectiveAllowFrom;
  const commandGroupAllowFrom =
    state.effectiveRoomUsers.length > 0 ? state.effectiveRoomUsers : state.effectiveGroupAllowFrom;
  const resolved = await resolveChannelMessageIngress({
    channelId: "matrix",
    accountId: state.accountId,
    identity: matrixIngressIdentity,
    subject: { stableId: state.senderId },
    conversation: {
      kind: state.isRoom ? "group" : "direct",
      id: state.isRoom ? "matrix-room" : "matrix-dm",
    },
    event: {
      kind: "message",
      authMode: "command",
      mayPair: false,
    },
    policy: {
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      groupAllowFromFallbackToAllowFrom: false,
    },
    allowFrom: commandAllowFrom,
    groupAllowFrom: commandGroupAllowFrom,
    command: {
      useAccessGroups: params.useAccessGroups,
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      groupOwnerAllowFrom: "none",
      commandGroupAllowFromFallbackToAllowFrom: false,
    },
  });
  return resolved.commandAccess;
}

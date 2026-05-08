/**
 * SDK adapter — binds engine port interfaces to the framework's shared
 * SDK implementations.
 *
 * This file lives in bridge/ (not engine/) because it imports from
 * `openclaw/plugin-sdk/*`. The engine layer stays zero-SDK-dependency;
 * only the bridge layer couples to the framework.
 */

import {
  createChannelIngressPluginId,
  createChannelIngressStringAdapter,
  createChannelIngressSubject,
  decideChannelIngress,
  findChannelIngressCommandGate,
  findChannelIngressSenderGate,
  resolveChannelIngressState,
} from "openclaw/plugin-sdk/channel-ingress";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry as SdkHistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { resolveQQBotEffectivePolicies } from "../engine/access/resolve-policy.js";
import { normalizeQQBotAllowFrom, normalizeQQBotSenderId } from "../engine/access/sender-match.js";
import {
  QQBOT_ACCESS_REASON,
  type QQBotAccessResult,
  type QQBotDmPolicy,
  type QQBotGroupPolicy,
} from "../engine/access/types.js";
import type { AccessPort } from "../engine/adapter/access.port.js";
import type { HistoryPort, HistoryEntryLike } from "../engine/adapter/history.port.js";
import type {
  MentionGatePort,
  MentionGateDecision,
  MentionFacts,
  MentionPolicy,
} from "../engine/adapter/mention-gate.port.js";

const QQBOT_CHANNEL_ID = createChannelIngressPluginId("qqbot");
const qqbotIngressAdapter = createChannelIngressStringAdapter({
  normalizeEntry: normalizeQQBotSenderId,
  normalizeSubject: normalizeQQBotSenderId,
  isWildcardEntry: (entry) => normalizeQQBotSenderId(entry) === "*",
});

// ============ History Adapter ============

// Helper: cast engine Map to SDK Map. TypeScript Map is invariant on its
// value type, but the shapes are structurally identical (HistoryEntryLike
// ⊇ SdkHistoryEntry). The `as unknown as` double-cast is safe here.
function asSdkMap<T>(map: Map<string, T[]>): Map<string, SdkHistoryEntry[]> {
  return map as unknown as Map<string, SdkHistoryEntry[]>;
}

/**
 * History adapter backed by SDK `reply-history`.
 *
 * Delegates record/build/clear to the SDK's shared implementation so
 * the engine benefits from SDK improvements (e.g. future visibility
 * filtering) without code duplication.
 */
export function createSdkHistoryAdapter(): HistoryPort {
  return {
    recordPendingHistoryEntry<T extends HistoryEntryLike>(params: {
      historyMap: Map<string, T[]>;
      historyKey: string;
      entry?: T | null;
      limit: number;
    }): T[] {
      return recordPendingHistoryEntryIfEnabled({
        historyMap: asSdkMap(params.historyMap),
        historyKey: params.historyKey,
        entry: params.entry as SdkHistoryEntry | undefined,
        limit: params.limit,
      }) as T[];
    },

    buildPendingHistoryContext(params: {
      historyMap: Map<string, HistoryEntryLike[]>;
      historyKey: string;
      limit: number;
      currentMessage: string;
      formatEntry: (entry: HistoryEntryLike) => string;
      lineBreak?: string;
    }): string {
      return buildPendingHistoryContextFromMap({
        historyMap: asSdkMap(params.historyMap),
        historyKey: params.historyKey,
        limit: params.limit,
        currentMessage: params.currentMessage,
        formatEntry: params.formatEntry as (entry: SdkHistoryEntry) => string,
        lineBreak: params.lineBreak,
      });
    },

    clearPendingHistory(params: {
      historyMap: Map<string, HistoryEntryLike[]>;
      historyKey: string;
      limit: number;
    }): void {
      clearHistoryEntriesIfEnabled({
        historyMap: asSdkMap(params.historyMap),
        historyKey: params.historyKey,
        limit: params.limit,
      });
    },
  };
}

// ============ MentionGate Adapter ============

/**
 * MentionGate adapter backed by SDK `channel-mention-gating`.
 *
 * Maps the engine's mention facts/policy to the SDK's
 * `resolveInboundMentionDecision` call, normalizing the implicit
 * mention boolean into the SDK's typed `ImplicitMentionKind[]`.
 */
export function createSdkMentionGateAdapter(): MentionGatePort {
  return {
    resolveInboundMentionDecision(params: {
      facts: MentionFacts;
      policy: MentionPolicy;
    }): MentionGateDecision {
      const result = resolveInboundMentionDecision({
        facts: {
          canDetectMention: params.facts.canDetectMention,
          wasMentioned: params.facts.wasMentioned,
          hasAnyMention: params.facts.hasAnyMention,
          implicitMentionKinds:
            params.facts.implicitMentionKinds ?? implicitMentionKindWhen("reply_to_bot", false),
        },
        policy: {
          isGroup: params.policy.isGroup,
          requireMention: params.policy.requireMention,
          allowTextCommands: params.policy.allowTextCommands,
          hasControlCommand: params.policy.hasControlCommand,
          commandAuthorized: params.policy.commandAuthorized,
        },
      });
      return {
        effectiveWasMentioned: result.effectiveWasMentioned,
        shouldSkip: result.shouldSkip,
        shouldBypassMention: result.shouldBypassMention,
        implicitMention: result.implicitMention,
      };
    },
  };
}

// ============ Access Adapter ============

export function createSdkAccessAdapter(): AccessPort {
  return {
    async resolveInboundAccess(input) {
      const { dmPolicy, groupPolicy } = resolveQQBotEffectivePolicies(input);
      const rawGroupAllowFrom =
        input.groupAllowFrom && input.groupAllowFrom.length > 0
          ? input.groupAllowFrom
          : (input.allowFrom ?? []);
      const normalizedAllowFrom = normalizeQQBotAllowFrom(input.allowFrom);
      const effectiveAllowFrom =
        dmPolicy === "open" && normalizedAllowFrom.length === 0 ? ["*"] : normalizedAllowFrom;
      const dmAllowFromForIngress =
        dmPolicy === "open" && normalizedAllowFrom.length === 0 ? ["*"] : (input.allowFrom ?? []);
      const effectiveGroupAllowFrom = normalizeQQBotAllowFrom(rawGroupAllowFrom);

      const state = await resolveChannelIngressState({
        channelId: QQBOT_CHANNEL_ID,
        accountId: input.accountId,
        subject: createChannelIngressSubject({
          opaqueId: "sender-id",
          value: input.senderId,
        }),
        conversation: {
          kind: input.isGroup ? "group" : "direct",
          id: input.conversationId,
        },
        adapter: qqbotIngressAdapter,
        accessGroups: (input.cfg as OpenClawConfig).accessGroups,
        event: {
          kind: "message",
          authMode: "inbound",
          mayPair: false,
        },
        allowlists: {
          dm: dmAllowFromForIngress,
          group: rawGroupAllowFrom,
        },
      });
      const decision = decideChannelIngress(state, {
        dmPolicy,
        groupPolicy,
      });
      const commandAuthorized = await resolveQQBotCommandAuthorized({
        cfg: input.cfg,
        accountId: input.accountId,
        isGroup: input.isGroup,
        senderId: input.senderId,
        conversationId: input.conversationId,
        allowFrom: input.allowFrom,
      });
      return mapQQBotIngressAccess({
        isGroup: input.isGroup,
        decisionAllowed:
          findChannelIngressSenderGate(decision, { isGroup: input.isGroup })?.allowed === true,
        dmPolicy,
        groupPolicy,
        effectiveAllowFrom,
        effectiveGroupAllowFrom,
        commandAuthorized,
      });
    },
    async resolveSlashCommandAuthorization(input) {
      return await resolveQQBotSlashCommandAuthorized(input);
    },
  };
}

async function resolveQQBotCommandAuthorized(params: {
  cfg: unknown;
  accountId: string;
  isGroup: boolean;
  senderId: string;
  conversationId: string;
  allowFrom?: Array<string | number> | null;
}): Promise<boolean> {
  const rawAllowFrom = params.allowFrom && params.allowFrom.length > 0 ? params.allowFrom : ["*"];
  const state = await resolveChannelIngressState({
    channelId: QQBOT_CHANNEL_ID,
    accountId: params.accountId,
    subject: createChannelIngressSubject({
      opaqueId: "sender-id",
      value: params.senderId,
    }),
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.conversationId,
    },
    adapter: qqbotIngressAdapter,
    accessGroups: (params.cfg as OpenClawConfig).accessGroups,
    event: {
      kind: "message",
      authMode: "inbound",
      mayPair: false,
    },
    allowlists: {
      dm: params.isGroup ? [] : ["*"],
      commandOwner: rawAllowFrom,
    },
  });
  const decision = decideChannelIngress(state, {
    dmPolicy: params.isGroup ? "disabled" : "open",
    groupPolicy: params.isGroup ? "open" : "disabled",
    command: {
      useAccessGroups: true,
      allowTextCommands: false,
      hasControlCommand: true,
    },
  });
  return findChannelIngressCommandGate(decision)?.allowed === true;
}

async function resolveQQBotSlashCommandAuthorized(params: {
  cfg: unknown;
  accountId: string;
  isGroup: boolean;
  senderId: string;
  conversationId: string;
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  commandsAllowFrom?: Array<string | number> | null;
}): Promise<boolean> {
  const rawAllowFrom =
    params.commandsAllowFrom ??
    (params.isGroup && params.groupAllowFrom && params.groupAllowFrom.length > 0
      ? params.groupAllowFrom
      : params.allowFrom);
  const explicitAllowFrom = normalizeQQBotAllowFrom(rawAllowFrom).filter((entry) => entry !== "*");
  if (explicitAllowFrom.length === 0) {
    return false;
  }
  const state = await resolveChannelIngressState({
    channelId: QQBOT_CHANNEL_ID,
    accountId: params.accountId,
    subject: createChannelIngressSubject({
      opaqueId: "sender-id",
      value: params.senderId,
    }),
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.conversationId,
    },
    adapter: qqbotIngressAdapter,
    accessGroups: (params.cfg as OpenClawConfig).accessGroups,
    event: {
      kind: "slash-command",
      authMode: "none",
      mayPair: false,
    },
    allowlists: {
      commandOwner: explicitAllowFrom,
    },
  });
  const decision = decideChannelIngress(state, {
    dmPolicy: "allowlist",
    groupPolicy: "open",
    command: {
      useAccessGroups: (params.cfg as OpenClawConfig).commands?.useAccessGroups !== false,
      allowTextCommands: false,
      hasControlCommand: true,
      modeWhenAccessGroupsOff: "configured",
    },
  });
  return findChannelIngressCommandGate(decision)?.allowed === true;
}

function mapQQBotIngressAccess(params: {
  isGroup: boolean;
  decisionAllowed: boolean;
  dmPolicy: QQBotDmPolicy;
  groupPolicy: QQBotGroupPolicy;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  commandAuthorized: boolean;
}): QQBotAccessResult {
  const base = {
    effectiveAllowFrom: params.effectiveAllowFrom,
    effectiveGroupAllowFrom: params.effectiveGroupAllowFrom,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
    commandAuthorized: params.commandAuthorized,
  };
  if (params.isGroup) {
    if (params.groupPolicy === "disabled") {
      return {
        ...base,
        decision: "block",
        reasonCode: QQBOT_ACCESS_REASON.GROUP_POLICY_DISABLED,
        reason: "groupPolicy=disabled",
      };
    }
    if (params.groupPolicy === "open") {
      return {
        ...base,
        decision: "allow",
        reasonCode: QQBOT_ACCESS_REASON.GROUP_POLICY_ALLOWED,
        reason: "groupPolicy=open",
      };
    }
    if (params.effectiveGroupAllowFrom.length === 0) {
      return {
        ...base,
        decision: "block",
        reasonCode: QQBOT_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST,
        reason: "groupPolicy=allowlist (empty allowlist)",
      };
    }
    return params.decisionAllowed
      ? {
          ...base,
          decision: "allow",
          reasonCode: QQBOT_ACCESS_REASON.GROUP_POLICY_ALLOWED,
          reason: "groupPolicy=allowlist (allowlisted)",
        }
      : {
          ...base,
          decision: "block",
          reasonCode: QQBOT_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
          reason: "groupPolicy=allowlist (not allowlisted)",
        };
  }

  if (params.dmPolicy === "disabled") {
    return {
      ...base,
      decision: "block",
      reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_DISABLED,
      reason: "dmPolicy=disabled",
    };
  }
  if (params.dmPolicy === "open") {
    if (params.effectiveAllowFrom.includes("*")) {
      return {
        ...base,
        decision: "allow",
        reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_OPEN,
        reason: "dmPolicy=open",
      };
    }
    return params.decisionAllowed
      ? {
          ...base,
          decision: "allow",
          reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
          reason: "dmPolicy=open (allowlisted)",
        }
      : {
          ...base,
          decision: "block",
          reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
          reason: "dmPolicy=open (not allowlisted)",
        };
  }
  if (params.effectiveAllowFrom.length === 0) {
    return {
      ...base,
      decision: "block",
      reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_EMPTY_ALLOWLIST,
      reason: "dmPolicy=allowlist (empty allowlist)",
    };
  }
  return params.decisionAllowed
    ? {
        ...base,
        decision: "allow",
        reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
        reason: "dmPolicy=allowlist (allowlisted)",
      }
    : {
        ...base,
        decision: "block",
        reasonCode: QQBOT_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
        reason: "dmPolicy=allowlist (not allowlisted)",
      };
}

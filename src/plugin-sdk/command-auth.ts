import {
  buildCommandsMessage as buildCommandsMessageCompat,
  buildCommandsMessagePaginated as buildCommandsMessagePaginatedCompat,
  buildHelpMessage as buildHelpMessageCompat,
} from "../auto-reply/command-status-builders.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEffectiveAllowFromLists } from "../security/dm-policy-shared.js";
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
  resolveChannelIngressState,
  type ChannelIngressAdapter,
} from "./channel-ingress.js";
export {
  ACCESS_GROUP_ALLOW_FROM_PREFIX,
  expandAllowFromWithAccessGroups,
  parseAccessGroupAllowFromEntry,
  resolveAccessGroupAllowFromMatches,
  resolveAccessGroupAllowFromState,
  type AccessGroupMembershipResolver,
  type AccessGroupMembershipLookup,
  type ResolvedAccessGroupAllowFromState,
} from "./access-groups.js";
export { buildCommandsPaginationKeyboard } from "./telegram-command-ui.js";
export {
  createPreCryptoDirectDmAuthorizer,
  resolveInboundDirectDmAccessWithRuntime,
  type DirectDmCommandAuthorizationRuntime,
  type ResolvedInboundDirectDmAccess,
} from "./direct-dm.js";

export {
  hasControlCommand,
  hasInlineCommandTokens,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "../auto-reply/command-detection.js";
export {
  buildCommandText,
  buildCommandTextFromArgs,
  findCommandByNativeName,
  formatCommandArgMenuTitle,
  getCommandDetection,
  isCommandEnabled,
  isCommandMessage,
  isNativeCommandSurface,
  listChatCommands,
  listChatCommandsForConfig,
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
  maybeResolveTextAlias,
  normalizeCommandBody,
  parseCommandArgs,
  resolveCommandArgChoices,
  resolveCommandArgMenu,
  resolveTextCommand,
  serializeCommandArgs,
  shouldHandleTextCommands,
} from "../auto-reply/commands-registry.js";
export type {
  ChatCommandDefinition,
  CommandArgChoiceContext,
  CommandArgDefinition,
  CommandArgMenuSpec,
  CommandArgValues,
  CommandArgs,
  CommandDetection,
  CommandNormalizeOptions,
  CommandScope,
  NativeCommandSpec,
  ResolvedCommandArgChoice,
  ShouldHandleTextCommandsParams,
} from "../auto-reply/commands-registry.js";
export type { CommandArgsParsing } from "../auto-reply/commands-registry.types.js";
export {
  resolveCommandAuthorizedFromAuthorizers,
  resolveControlCommandGate,
  resolveDualTextControlCommandGate,
  type CommandAuthorizer,
  type CommandGatingModeWhenAccessGroupsOff,
} from "../channels/command-gating.js";
export {
  resolveNativeCommandSessionTargets,
  type ResolveNativeCommandSessionTargetsParams,
} from "../channels/native-command-session-targets.js";
export {
  resolveCommandAuthorization,
  type CommandAuthorization,
} from "../auto-reply/command-auth.js";
export {
  listReservedChatSlashCommandNames,
  listSkillCommandsForAgents,
  listSkillCommandsForWorkspace,
  resolveSkillCommandInvocation,
} from "../auto-reply/skill-commands.js";
export { getPluginCommandSpecs, listProviderPluginCommandSpecs } from "../plugins/command-specs.js";
export type { SkillCommandSpec } from "../agents/skills.js";
export {
  buildModelsProviderData,
  formatModelsAvailableHeader,
  resolveModelsCommandReply,
} from "../auto-reply/reply/commands-models.js";
export type { ModelsProviderData } from "../auto-reply/reply/commands-models.js";
export { resolveStoredModelOverride } from "../auto-reply/reply/stored-model-override.js";
export type { StoredModelOverride } from "../auto-reply/reply/stored-model-override.js";

export type ResolveSenderCommandAuthorizationParams = {
  cfg: OpenClawConfig;
  rawBody: string;
  isGroup: boolean;
  dmPolicy: string;
  configuredAllowFrom: string[];
  configuredGroupAllowFrom?: string[];
  senderId: string;
  isSenderAllowed: (senderId: string, allowFrom: string[]) => boolean;
  channel?: ChannelId;
  accountId?: string;
  resolveAccessGroupMembership?: AccessGroupMembershipResolver;
  readAllowFromStore: () => Promise<string[]>;
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  /** @deprecated Command authorization is resolved by channel ingress. Kept for runtime injection compatibility. */
  resolveCommandAuthorizedFromAuthorizers?: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
};

export type CommandAuthorizationRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
};

export type ResolveSenderCommandAuthorizationWithRuntimeParams = Omit<
  ResolveSenderCommandAuthorizationParams,
  "shouldComputeCommandAuthorized" | "resolveCommandAuthorizedFromAuthorizers"
> & {
  runtime: CommandAuthorizationRuntime;
};

/** Fast-path DM command authorization when only policy and sender allowlist state matter. */
export function resolveDirectDmAuthorizationOutcome(params: {
  isGroup: boolean;
  dmPolicy: string;
  senderAllowedForCommands: boolean;
}): "disabled" | "unauthorized" | "allowed" {
  if (params.isGroup) {
    return "allowed";
  }
  if (params.dmPolicy === "disabled") {
    return "disabled";
  }
  if (!params.senderAllowedForCommands) {
    return "unauthorized";
  }
  return "allowed";
}

function normalizeCommandAuthDmPolicy(policy: string | null | undefined) {
  return policy === "pairing" ||
    policy === "allowlist" ||
    policy === "open" ||
    policy === "disabled"
    ? policy
    : "allowlist";
}

function createSenderCommandIngressAdapter(params: {
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

/** Runtime-backed wrapper around sender command authorization for grouped helper surfaces. */
export async function resolveSenderCommandAuthorizationWithRuntime(
  params: ResolveSenderCommandAuthorizationWithRuntimeParams,
): ReturnType<typeof resolveSenderCommandAuthorization> {
  return resolveSenderCommandAuthorization({
    ...params,
    shouldComputeCommandAuthorized: params.runtime.shouldComputeCommandAuthorized,
    resolveCommandAuthorizedFromAuthorizers: params.runtime.resolveCommandAuthorizedFromAuthorizers,
  });
}

/** Compute effective allowlists and command authorization for one inbound sender. */
export async function resolveSenderCommandAuthorization(
  params: ResolveSenderCommandAuthorizationParams,
): Promise<{
  shouldComputeAuth: boolean;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  senderAllowedForCommands: boolean;
  commandAuthorized: boolean | undefined;
}> {
  const shouldComputeAuth = params.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
  const storeAllowFrom =
    !params.isGroup && params.dmPolicy !== "allowlist" && params.dmPolicy !== "open"
      ? await params.readAllowFromStore().catch(() => [])
      : [];
  const channel = params.channel;
  const accountId = params.accountId ?? "default";
  let configuredAllowFrom = params.configuredAllowFrom;
  let configuredGroupAllowFrom = params.configuredGroupAllowFrom ?? [];
  let dmStoreAllowFrom = storeAllowFrom;
  if (channel) {
    [configuredAllowFrom, configuredGroupAllowFrom] = await Promise.all([
      expandAllowFromWithAccessGroups({
        cfg: params.cfg,
        allowFrom: params.configuredAllowFrom,
        channel,
        accountId,
        senderId: params.senderId,
        isSenderAllowed: params.isSenderAllowed,
        resolveMembership: params.resolveAccessGroupMembership,
      }),
      expandAllowFromWithAccessGroups({
        cfg: params.cfg,
        allowFrom: params.configuredGroupAllowFrom ?? [],
        channel,
        accountId,
        senderId: params.senderId,
        isSenderAllowed: params.isSenderAllowed,
        resolveMembership: params.resolveAccessGroupMembership,
      }),
    ]);
    if (!params.isGroup) {
      dmStoreAllowFrom = await expandAllowFromWithAccessGroups({
        cfg: params.cfg,
        allowFrom: storeAllowFrom,
        channel,
        accountId,
        senderId: params.senderId,
        isSenderAllowed: params.isSenderAllowed,
        resolveMembership: params.resolveAccessGroupMembership,
      });
    }
  }
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: configuredAllowFrom,
    groupAllowFrom: configuredGroupAllowFrom,
    storeAllowFrom: dmStoreAllowFrom,
    dmPolicy: params.dmPolicy,
  });
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    params.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
  );
  const commandState = await resolveChannelIngressState({
    channelId: createChannelIngressPluginId(channel ?? "command-auth"),
    accountId,
    subject: createChannelIngressSubject({
      opaqueId: "sender-id",
      value: params.senderId,
    }),
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.senderId,
    },
    adapter: createSenderCommandIngressAdapter({
      senderId: params.senderId,
      isSenderAllowed: params.isSenderAllowed,
    }),
    event: {
      kind: "message",
      authMode: "none",
      mayPair: false,
    },
    allowlists: {
      commandOwner: effectiveAllowFrom,
      commandGroup: effectiveGroupAllowFrom,
    },
  });
  const commandDecision = decideChannelIngress(commandState, {
    dmPolicy: normalizeCommandAuthDmPolicy(params.dmPolicy),
    groupPolicy: "open",
    command: {
      useAccessGroups,
      allowTextCommands: false,
      hasControlCommand: shouldComputeAuth,
    },
  });
  const commandAuthorized = shouldComputeAuth
    ? findChannelIngressCommandGate(commandDecision)?.allowed === true
    : undefined;

  return {
    shouldComputeAuth,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    senderAllowedForCommands,
    commandAuthorized,
  };
}

/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
export function buildCommandsMessage(
  ...args: Parameters<typeof buildCommandsMessageCompat>
): ReturnType<typeof buildCommandsMessageCompat> {
  return buildCommandsMessageCompat(...args);
}

/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
export function buildCommandsMessagePaginated(
  ...args: Parameters<typeof buildCommandsMessagePaginatedCompat>
): ReturnType<typeof buildCommandsMessagePaginatedCompat> {
  return buildCommandsMessagePaginatedCompat(...args);
}

/** @deprecated Use `openclaw/plugin-sdk/command-status` instead. */
export function buildHelpMessage(
  ...args: Parameters<typeof buildHelpMessageCompat>
): ReturnType<typeof buildHelpMessageCompat> {
  return buildHelpMessageCompat(...args);
}

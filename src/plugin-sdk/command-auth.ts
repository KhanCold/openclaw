import {
  buildCommandsMessage as buildCommandsMessageCompat,
  buildCommandsMessagePaginated as buildCommandsMessagePaginatedCompat,
  buildHelpMessage as buildHelpMessageCompat,
} from "../auto-reply/command-status-builders.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type AccessGroupMembershipResolver } from "./access-groups.js";
import {
  defineChannelIngressIdentity,
  resolveChannelMessageIngress,
} from "./channel-ingress-runtime.js";
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

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type CommandAuthorizationRuntime = {
  shouldComputeCommandAuthorized: (rawBody: string, cfg: OpenClawConfig) => boolean;
  resolveCommandAuthorizedFromAuthorizers: (params: {
    useAccessGroups: boolean;
    authorizers: Array<{ configured: boolean; allowed: boolean }>;
  }) => boolean;
};

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
export type ResolveSenderCommandAuthorizationWithRuntimeParams = Omit<
  ResolveSenderCommandAuthorizationParams,
  "shouldComputeCommandAuthorized" | "resolveCommandAuthorizedFromAuthorizers"
> & {
  runtime: CommandAuthorizationRuntime;
};

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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

function createSenderCommandIngressIdentity(params: {
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
export async function resolveSenderCommandAuthorizationWithRuntime(
  params: ResolveSenderCommandAuthorizationWithRuntimeParams,
): ReturnType<typeof resolveSenderCommandAuthorization> {
  return resolveSenderCommandAuthorization({
    ...params,
    shouldComputeCommandAuthorized: params.runtime.shouldComputeCommandAuthorized,
    resolveCommandAuthorizedFromAuthorizers: params.runtime.resolveCommandAuthorizedFromAuthorizers,
  });
}

/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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
  const channel = params.channel;
  const accountId = params.accountId ?? "default";
  const resolveAccessGroupMembership = params.resolveAccessGroupMembership;
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const resolved = await resolveChannelMessageIngress({
    channelId: channel ?? "command-auth",
    accountId,
    identity: createSenderCommandIngressIdentity({
      senderId: params.senderId,
      isSenderAllowed: params.isSenderAllowed,
    }),
    subject: { stableId: params.senderId },
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.senderId,
    },
    event: {
      kind: "message",
      authMode: "none",
      mayPair: false,
    },
    accessGroups: params.cfg.accessGroups,
    resolveAccessGroupMembership:
      channel && resolveAccessGroupMembership
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
      dmPolicy: normalizeCommandAuthDmPolicy(params.dmPolicy),
      groupPolicy: "open",
    },
    allowFrom: params.configuredAllowFrom,
    groupAllowFrom: params.configuredGroupAllowFrom ?? [],
    readStoreAllowFrom: async () => {
      return await params.readAllowFromStore().catch(() => []);
    },
    command: {
      useAccessGroups,
      allowTextCommands: false,
      hasControlCommand: shouldComputeAuth,
      directGroupAllowFrom: "effective",
    },
  });
  const effectiveAllowFrom = resolved.senderAccess.effectiveAllowFrom;
  const effectiveGroupAllowFrom = resolved.senderAccess.effectiveGroupAllowFrom;
  const senderAllowedForCommands = params.isSenderAllowed(
    params.senderId,
    params.isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom,
  );

  return {
    shouldComputeAuth,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    senderAllowedForCommands,
    commandAuthorized: shouldComputeAuth ? resolved.commandAccess.authorized : undefined,
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

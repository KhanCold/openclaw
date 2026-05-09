import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-message";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import {
  deliverFormattedTextWithAttachments,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveIrcIngressAccess } from "./access-policy.js";
import type { ResolvedIrcAccount } from "./accounts.js";
import { resolveIrcGroupMatch, resolveIrcRequireMention } from "./policy.js";
import { getIrcRuntime } from "./runtime.js";
import { sendMessageIrc } from "./send.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

const CHANNEL_ID = "irc" as const;

const escapeIrcRegexLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function deliverIrcReply(params: {
  payload: OutboundReplyPayload;
  cfg: CoreConfig;
  target: string;
  accountId: string;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  const delivered = await deliverFormattedTextWithAttachments({
    payload: params.payload,
    send: async ({ text, replyToId }) => {
      if (params.sendReply) {
        await params.sendReply(params.target, text, replyToId);
      } else {
        await sendMessageIrc(params.target, text, {
          cfg: params.cfg,
          accountId: params.accountId,
          replyTo: replyToId,
        });
      }
      params.statusSink?.({ lastOutboundAt: Date.now() });
    },
  });
  if (!delivered) {
    return;
  }
}

export async function handleIrcInbound(params: {
  message: IrcInboundMessage;
  account: ResolvedIrcAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  connectedNick?: string;
  sendReply?: (target: string, text: string, replyToId?: string) => Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, connectedNick, statusSink } = params;
  const core = getIrcRuntime();
  const pairing = createChannelPairingController({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const senderDisplay = message.senderHost
    ? `${message.senderNick}!${message.senderUser ?? "?"}@${message.senderHost}`
    : message.senderNick;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);

  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.irc !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "irc",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.channel,
    log: (message) => runtime.log?.(message),
  });

  const groupMatch = resolveIrcGroupMatch({
    groups: account.config.groups,
    target: message.target,
  });

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const mentionRegexes = core.channel.mentions.buildMentionRegexes(config as OpenClawConfig);
  const mentionNick = connectedNick?.trim() || account.nick;
  const explicitMentionRegex = mentionNick
    ? new RegExp(`\\b${escapeIrcRegexLiteral(mentionNick)}\\b[:,]?`, "i")
    : null;
  const wasMentioned =
    core.channel.mentions.matchesMentionPatterns(rawBody, mentionRegexes) ||
    (explicitMentionRegex ? explicitMentionRegex.test(rawBody) : false);
  const requireMention = message.isGroup
    ? resolveIrcRequireMention({
        groupConfig: groupMatch.groupConfig,
        wildcardConfig: groupMatch.wildcardConfig,
      })
    : false;
  const access = await resolveIrcIngressAccess({
    accountId: account.accountId,
    message,
    config,
    dmPolicy,
    groupPolicy,
    allowFrom: account.config.allowFrom,
    groupAllowFrom: account.config.groupAllowFrom,
    groupMatch,
    allowNameMatching,
    allowTextCommands,
    hasControlCommand,
    requireMention,
    wasMentioned,
    readAllowFromStore: async () => await pairing.readAllowFromStore(),
  });
  const commandAuthorized = access.commandAccess.authorized;

  if (access.ingress.admission === "pairing-required") {
    await pairing.issueChallenge({
      senderId: normalizeLowercaseStringOrEmpty(senderDisplay),
      senderIdLine: `Your IRC id: ${senderDisplay}`,
      meta: { name: message.senderNick || undefined },
      sendPairingReply: async (text) => {
        await deliverIrcReply({
          payload: { text },
          cfg: config,
          target: message.senderNick,
          accountId: account.accountId,
          sendReply: params.sendReply,
          statusSink,
        });
      },
      onReplyError: (err) => {
        runtime.error?.(`irc: pairing reply failed for ${senderDisplay}: ${String(err)}`);
      },
    });
    runtime.log?.(`irc: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
    return;
  }
  if (access.ingress.admission === "skip") {
    runtime.log?.(`irc: drop channel ${message.target} (missing-mention)`);
    return;
  }
  if (access.ingress.admission !== "dispatch") {
    if (
      message.isGroup &&
      access.ingress.decisiveGateId === "command" &&
      access.commandAccess.shouldBlockControlCommand
    ) {
      const { logInboundDrop } = await import("openclaw/plugin-sdk/channel-inbound");
      logInboundDrop({
        log: (line) => runtime.log?.(line),
        channel: CHANNEL_ID,
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }
    if (message.isGroup) {
      if (access.roomGateReason === "channel_not_allowlisted") {
        runtime.log?.(`irc: drop channel ${message.target} (not allowlisted)`);
      } else if (access.roomGateReason === "channel_disabled") {
        runtime.log?.(`irc: drop channel ${message.target} (disabled)`);
      } else {
        runtime.log?.(`irc: drop group sender ${senderDisplay} (policy=${groupPolicy})`);
      }
    } else {
      runtime.log?.(`irc: drop DM sender ${senderDisplay} (dmPolicy=${dmPolicy})`);
    }
    return;
  }

  const peerId = message.isGroup ? message.target : message.senderNick;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: message.isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const fromLabel = message.isGroup ? message.target : senderDisplay;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "IRC",
    from: fromLabel,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = normalizeOptionalString(groupMatch.groupConfig?.systemPrompt);

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: message.isGroup ? `irc:channel:${message.target}` : `irc:${senderDisplay}`,
    To: `irc:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: message.isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: message.senderNick || undefined,
    SenderId: senderDisplay,
    GroupSubject: message.isGroup ? message.target : undefined,
    GroupSystemPrompt: message.isGroup ? groupSystemPrompt : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    WasMentioned: message.isGroup ? wasMentioned : undefined,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `irc:${peerId}`,
    CommandAuthorized: commandAuthorized,
  });

  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  await core.channel.turn.runPrepared({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: core.channel.session.recordInboundSession,
    runDispatch: async () =>
      await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config as OpenClawConfig,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload) => {
            await deliverIrcReply({
              payload,
              cfg: config,
              target: peerId,
              accountId: account.accountId,
              sendReply: params.sendReply,
              statusSink,
            });
          },
          onError: (err, info) => {
            runtime.error?.(`irc ${info.kind} reply failed: ${String(err)}`);
          },
        },
        replyOptions: {
          onModelSelected,
          skillFilter: groupMatch.groupConfig?.skills,
          disableBlockStreaming:
            typeof account.config.blockStreaming === "boolean"
              ? !account.config.blockStreaming
              : undefined,
        },
      }),
    record: {
      onRecordError: (err) => {
        runtime.error?.(`irc: failed updating session meta: ${String(err)}`);
      },
    },
  });
}

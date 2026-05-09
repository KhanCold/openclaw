import { type ChannelIngressIdentifierKind } from "openclaw/plugin-sdk/channel-ingress";
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
  type ResolvedChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { DmPolicy, GroupPolicy, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { normalizeIMessageHandle, parseIMessageAllowTarget } from "../targets.js";

const IMESSAGE_CHAT_ID_KIND = "plugin:imessage-chat-id" as ChannelIngressIdentifierKind;
const IMESSAGE_CHAT_GUID_KIND = "plugin:imessage-chat-guid" as ChannelIngressIdentifierKind;
const IMESSAGE_CHAT_IDENTIFIER_KIND =
  "plugin:imessage-chat-identifier" as ChannelIngressIdentifierKind;

function normalizeIMessageHandleEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = parseIMessageAllowTarget(trimmed);
  return parsed.kind === "handle" ? normalizeIMessageHandle(parsed.handle) : null;
}

function normalizeIMessageChatIdEntry(entry: string): string | null {
  const parsed = parseIMessageAllowTarget(entry.trim());
  return parsed.kind === "chat_id" ? String(parsed.chatId) : null;
}

function normalizeIMessageChatGuidEntry(entry: string): string | null {
  const parsed = parseIMessageAllowTarget(entry.trim());
  return parsed.kind === "chat_guid" ? parsed.chatGuid.trim() || null : null;
}

function normalizeIMessageChatIdentifierEntry(entry: string): string | null {
  const parsed = parseIMessageAllowTarget(entry.trim());
  return parsed.kind === "chat_identifier" ? parsed.chatIdentifier.trim() || null : null;
}

const imessageIngressIdentity = defineStableChannelIngressIdentity({
  key: "imessage-sender",
  normalizeEntry: normalizeIMessageHandleEntry,
  normalizeSubject: normalizeIMessageHandle,
  sensitivity: "pii",
  aliases: [
    {
      key: "imessage-chat-id",
      kind: IMESSAGE_CHAT_ID_KIND,
      normalizeEntry: normalizeIMessageChatIdEntry,
      normalizeSubject: (value) => value.trim() || null,
      sensitivity: "pii",
    },
    {
      key: "imessage-chat-guid",
      kind: IMESSAGE_CHAT_GUID_KIND,
      normalizeEntry: normalizeIMessageChatGuidEntry,
      normalizeSubject: (value) => value.trim() || null,
      sensitivity: "pii",
    },
    {
      key: "imessage-chat-identifier",
      kind: IMESSAGE_CHAT_IDENTIFIER_KIND,
      normalizeEntry: normalizeIMessageChatIdentifierEntry,
      normalizeSubject: (value) => value.trim() || null,
      sensitivity: "pii",
    },
  ],
  resolveEntryId: ({ entryIndex }) => `imessage-entry-${entryIndex + 1}`,
});

function normalizeDmPolicy(policy: string): DmPolicy {
  return policy === "open" || policy === "allowlist" || policy === "disabled" ? policy : "pairing";
}

function normalizeGroupPolicy(policy: string): GroupPolicy {
  return policy === "open" || policy === "disabled" ? policy : "allowlist";
}

function subjectAliases(params: {
  sender: string;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
}) {
  return {
    ...(params.chatId != null ? { "imessage-chat-id": String(params.chatId) } : {}),
    ...(params.chatGuid ? { "imessage-chat-guid": params.chatGuid } : {}),
    ...(params.chatIdentifier ? { "imessage-chat-identifier": params.chatIdentifier } : {}),
  };
}

export async function resolveIMessageIngressAccess(params: {
  cfg: OpenClawConfig;
  accountId: string;
  isGroup: boolean;
  sender: string;
  chatId?: number;
  chatGuid?: string;
  chatIdentifier?: string;
  allowFrom: string[];
  groupAllowFrom: string[];
  storeAllowFrom: string[];
  dmPolicy: string;
  groupPolicy: string;
  hasControlCommand: boolean;
}): Promise<ResolvedChannelMessageIngress> {
  const dmPolicy = normalizeDmPolicy(params.dmPolicy);
  const groupPolicy = normalizeGroupPolicy(params.groupPolicy);
  return await resolveChannelMessageIngress({
    channelId: "imessage",
    accountId: params.accountId,
    identity: imessageIngressIdentity,
    subject: {
      stableId: params.sender,
      aliases: subjectAliases({
        sender: params.sender,
        chatId: params.chatId,
        chatGuid: params.chatGuid,
        chatIdentifier: params.chatIdentifier,
      }),
    },
    conversation: {
      kind: params.isGroup ? "group" : "direct",
      id: params.isGroup
        ? String(params.chatId ?? params.chatGuid ?? params.chatIdentifier ?? "unknown")
        : normalizeIMessageHandle(params.sender),
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
    readStoreAllowFrom: async () => params.storeAllowFrom,
    command: {
      useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
      allowTextCommands: params.isGroup,
      hasControlCommand: params.hasControlCommand,
      modeWhenAccessGroupsOff: "allow",
      directGroupAllowFrom: "effective",
    },
  });
}

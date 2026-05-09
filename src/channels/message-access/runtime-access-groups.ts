import type { AccessGroupConfig } from "../../config/types.access-groups.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { parseAccessGroupAllowFromEntry } from "../allow-from.js";
import type {
  ChannelIngressAdapter,
  ChannelIngressSubject,
  ResolveChannelMessageIngressParams,
} from "./runtime-types.js";
import type { AccessGroupMembershipFact, ChannelIngressChannelId } from "./types.js";

function uniqueValues<T extends string | number>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function accessGroupNames(entries: readonly (string | number)[]): string[] {
  return Array.from(
    new Set(
      entries
        .map((entry) => parseAccessGroupAllowFromEntry(String(entry)))
        .filter((entry): entry is string => entry != null),
    ),
  );
}

export function allReferencedAccessGroupNames(
  entries: Array<readonly (string | number)[]>,
): string[] {
  return Array.from(new Set(entries.flatMap((entryGroup) => accessGroupNames(entryGroup))));
}

function accessGroupMatchedEntry(
  params: ResolveChannelMessageIngressParams,
): string | number | null {
  return params.accessGroupMatchedAllowFromEntry ?? params.subject.stableId ?? null;
}

function messageSenderGroupEntries(params: {
  group: AccessGroupConfig;
  channelId: ChannelIngressChannelId;
}): string[] {
  if (params.group.type !== "message.senders") {
    return [];
  }
  return normalizeStringEntries([
    ...(params.group.members["*"] ?? []),
    ...(params.group.members[params.channelId] ?? []),
  ]);
}

async function subjectMatchesEntries(params: {
  adapter: ChannelIngressAdapter;
  subject: ChannelIngressSubject;
  accountId: string;
  entries: readonly string[];
  context: "dm" | "group" | "route" | "command";
}): Promise<boolean> {
  if (params.entries.length === 0) {
    return false;
  }
  const normalized = await params.adapter.normalizeEntries({
    entries: params.entries,
    context: params.context,
    accountId: params.accountId,
  });
  if (normalized.matchable.length === 0) {
    return false;
  }
  const match = await params.adapter.matchSubject({
    subject: params.subject,
    entries: normalized.matchable,
    context: params.context,
  });
  return match.matched;
}

export async function normalizeEffectiveEntries(params: {
  adapter: ChannelIngressAdapter;
  accountId: string;
  entries: readonly (string | number)[];
  context: "dm" | "group" | "route" | "command";
}): Promise<string[]> {
  const rawEntries = normalizeStringEntries(params.entries);
  const accessGroupEntries = rawEntries.filter(
    (entry) => parseAccessGroupAllowFromEntry(entry) != null,
  );
  const directEntries = rawEntries.filter((entry) => parseAccessGroupAllowFromEntry(entry) == null);
  if (directEntries.length === 0) {
    return accessGroupEntries;
  }
  const normalized = await params.adapter.normalizeEntries({
    entries: directEntries,
    context: params.context,
    accountId: params.accountId,
  });
  return uniqueValues([...accessGroupEntries, ...normalized.matchable.map((entry) => entry.value)]);
}

export async function resolveRuntimeAccessGroupMembershipFacts(params: {
  input: ResolveChannelMessageIngressParams;
  channelId: ChannelIngressChannelId;
  names: readonly string[];
}): Promise<AccessGroupMembershipFact[]> {
  if (!params.input.resolveAccessGroupMembership || params.names.length === 0) {
    return [];
  }
  const facts: AccessGroupMembershipFact[] = [];
  for (const name of params.names) {
    const group = params.input.accessGroups?.[name];
    if (!group || group.type === "message.senders") {
      continue;
    }
    try {
      const matched = await params.input.resolveAccessGroupMembership({
        name,
        group,
        channelId: params.channelId,
        accountId: params.input.accountId,
        subject: params.input.subject,
      });
      facts.push(
        matched
          ? {
              kind: "matched",
              groupName: name,
              source: "dynamic",
              matchedEntryIds: [`access-group:${name}`],
            }
          : {
              kind: "not-matched",
              groupName: name,
              source: "dynamic",
            },
      );
    } catch {
      facts.push({
        kind: "failed",
        groupName: name,
        source: "dynamic",
        reasonCode: "access_group_failed",
        diagnosticId: `access-group:${name}`,
      });
    }
  }
  return facts;
}

async function hasMatchedAccessGroup(params: {
  input: ResolveChannelMessageIngressParams;
  channelId: ChannelIngressChannelId;
  adapter: ChannelIngressAdapter;
  subject: ChannelIngressSubject;
  entries: readonly (string | number)[];
  context: "dm" | "group" | "route" | "command";
  accessGroupMembership: readonly AccessGroupMembershipFact[];
}): Promise<boolean> {
  const names = accessGroupNames(params.entries);
  if (names.length === 0) {
    return false;
  }
  const factByName = new Map(params.accessGroupMembership.map((fact) => [fact.groupName, fact]));
  for (const name of names) {
    const fact = factByName.get(name);
    if (fact?.kind === "matched") {
      return true;
    }
    const group = params.input.accessGroups?.[name];
    if (!group || group.type !== "message.senders") {
      continue;
    }
    if (
      await subjectMatchesEntries({
        adapter: params.adapter,
        subject: params.subject,
        accountId: params.input.accountId,
        entries: messageSenderGroupEntries({ group, channelId: params.channelId }),
        context: params.context,
      })
    ) {
      return true;
    }
  }
  return false;
}

export async function expandEffectiveAllowFromForMatchedAccessGroups(params: {
  input: ResolveChannelMessageIngressParams;
  channelId: ChannelIngressChannelId;
  adapter: ChannelIngressAdapter;
  subject: ChannelIngressSubject;
  entries: readonly (string | number)[];
  effectiveEntries: string[];
  context: "dm" | "group" | "route" | "command";
  accessGroupMembership: readonly AccessGroupMembershipFact[];
}): Promise<string[]> {
  const matchedEntry = accessGroupMatchedEntry(params.input);
  if (matchedEntry == null) {
    return params.effectiveEntries;
  }
  const matched = await hasMatchedAccessGroup(params);
  return matched
    ? uniqueValues([...params.effectiveEntries, String(matchedEntry)])
    : params.effectiveEntries;
}

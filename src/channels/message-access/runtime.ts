import { readChannelAllowFromStore } from "../../pairing/pairing-store.js";
import type { PairingChannel } from "../../pairing/pairing-store.types.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { mergeDmAllowFromSources, resolveGroupAllowFromSources } from "../allow-from.js";
import { decideChannelIngress } from "./decision.js";
import {
  findChannelIngressActivationGate,
  findChannelIngressCommandGate,
  findChannelIngressEventGate,
  findChannelIngressSenderGate,
} from "./gates.js";
import { projectIngressAccessFacts } from "./projection.js";
import {
  allReferencedAccessGroupNames,
  expandEffectiveAllowFromForMatchedAccessGroups,
  normalizeEffectiveEntries,
  resolveRuntimeAccessGroupMembershipFacts,
} from "./runtime-access-groups.js";
import { createIdentityAdapter, createIdentitySubject, toChannelId } from "./runtime-identity.js";
import {
  createChannelIngressDmGroupAccessProjection,
  createChannelIngressSenderGroupAccessProjection,
} from "./runtime-projection.js";
import type {
  ChannelMessageIngressCommandInput,
  ChannelIngressActivationAccess,
  ChannelIngressCommandAccess,
  ChannelIngressEventAccess,
  ChannelIngressSenderAccess,
  ResolveChannelMessageIngressBundleParams,
  ResolveChannelMessageIngressParams,
  ResolvedChannelMessageIngress,
  ResolvedChannelMessageIngressBundle,
} from "./runtime-types.js";
import { resolveChannelIngressState } from "./state.js";
import type {
  ChannelIngressChannelId,
  ChannelIngressPolicyInput,
  ChannelIngressStateInput,
} from "./types.js";

function shouldReadStore(params: {
  conversationKind: ChannelIngressStateInput["conversation"]["kind"];
  dmPolicy: ChannelIngressPolicyInput["dmPolicy"];
}): boolean {
  return (
    params.conversationKind === "direct" &&
    params.dmPolicy !== "allowlist" &&
    params.dmPolicy !== "open"
  );
}

export function resolveChannelIngressEffectiveAllowFromLists(params: {
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  const allowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : undefined;
  const groupAllowFrom = Array.isArray(params.groupAllowFrom) ? params.groupAllowFrom : undefined;
  const storeAllowFrom = Array.isArray(params.storeAllowFrom) ? params.storeAllowFrom : undefined;
  const effectiveAllowFrom = normalizeStringEntries(
    mergeDmAllowFromSources({
      allowFrom,
      storeAllowFrom,
      dmPolicy: params.dmPolicy ?? undefined,
    }),
  );
  const effectiveGroupAllowFrom = normalizeStringEntries(
    resolveGroupAllowFromSources({
      allowFrom,
      groupAllowFrom,
      fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? undefined,
    }),
  );
  return { effectiveAllowFrom, effectiveGroupAllowFrom };
}

export async function readChannelIngressStoreAllowFromForDmPolicy(params: {
  provider: PairingChannel;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
  readStore?: (provider: PairingChannel, accountId: string) => Promise<string[]>;
}): Promise<string[]> {
  if (
    params.shouldRead === false ||
    params.dmPolicy === "allowlist" ||
    params.dmPolicy === "open"
  ) {
    return [];
  }
  const readStore =
    params.readStore ??
    ((provider: PairingChannel, accountId: string) =>
      readChannelAllowFromStore(provider, process.env, accountId));
  return await readStore(params.provider, params.accountId).catch(() => []);
}

async function readStoreAllowFrom(
  params: ResolveChannelMessageIngressParams & { channelId: ChannelIngressChannelId },
): Promise<Array<string | number>> {
  if (
    !shouldReadStore({
      conversationKind: params.conversation.kind,
      dmPolicy: params.policy.dmPolicy,
    })
  ) {
    return [];
  }
  const entries = params.readStoreAllowFrom
    ? await params
        .readStoreAllowFrom({
          channelId: params.channelId,
          accountId: params.accountId,
          dmPolicy: params.policy.dmPolicy,
        })
        .catch(() => [])
    : params.useDefaultPairingStore
      ? await readChannelIngressStoreAllowFromForDmPolicy({
          provider: params.channelId as PairingChannel,
          accountId: params.accountId,
          dmPolicy: params.policy.dmPolicy,
        })
      : [];
  return [...(entries ?? [])];
}

function commandRequested(policy: ChannelIngressPolicyInput): boolean {
  return policy.command != null;
}

function projectSenderAccess(params: {
  ingress: ResolvedChannelMessageIngress["ingress"];
  isGroup: boolean;
  dmPolicy: ChannelIngressPolicyInput["dmPolicy"];
  groupPolicy: ChannelIngressPolicyInput["groupPolicy"];
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  providerMissingFallbackApplied?: boolean;
}): ChannelIngressSenderAccess {
  const gate = findChannelIngressSenderGate(params.ingress, { isGroup: params.isGroup });
  const ingressReasonCode = gate?.reasonCode ?? params.ingress.reasonCode;
  const legacy = createChannelIngressDmGroupAccessProjection({
    ingress: {
      ...params.ingress,
      decision:
        ingressReasonCode === "dm_policy_pairing_required"
          ? "pairing"
          : gate?.allowed === true
            ? "allow"
            : "block",
      reasonCode: ingressReasonCode,
    },
    isGroup: params.isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
  });
  return {
    ...legacy,
    allowed: legacy.decision === "allow",
    ingressReasonCode,
    ...(gate ? { gate } : {}),
    effectiveAllowFrom: params.effectiveAllowFrom,
    effectiveGroupAllowFrom: params.effectiveGroupAllowFrom,
    ...(params.isGroup
      ? {
          groupAccess: createChannelIngressSenderGroupAccessProjection({
            decisionAllowed: legacy.decision === "allow",
            reasonCode: ingressReasonCode,
            groupPolicy: params.groupPolicy,
            providerMissingFallbackApplied: params.providerMissingFallbackApplied,
          }),
        }
      : {}),
  };
}

function projectCommandAccess(params: {
  ingress: ResolvedChannelMessageIngress["ingress"];
  policy: ChannelIngressPolicyInput;
}): ChannelIngressCommandAccess {
  const gate = findChannelIngressCommandGate(params.ingress);
  return {
    requested: commandRequested(params.policy),
    authorized: commandRequested(params.policy) ? gate?.allowed === true : false,
    shouldBlockControlCommand: gate?.command?.shouldBlockControlCommand === true,
    reasonCode: gate?.reasonCode ?? params.ingress.reasonCode,
    ...(gate ? { gate } : {}),
  };
}

function projectEventAccess(params: {
  ingress: ResolvedChannelMessageIngress["ingress"];
  event: ResolveChannelMessageIngressParams["event"];
}): ChannelIngressEventAccess {
  const gate = findChannelIngressEventGate(params.ingress);
  return {
    ran: gate != null,
    authorized: gate?.allowed === true,
    authMode: params.event.authMode,
    reasonCode: gate?.reasonCode ?? params.ingress.reasonCode,
    ...(gate ? { gate } : {}),
  };
}

function projectActivationAccess(params: {
  ingress: ResolvedChannelMessageIngress["ingress"];
}): ChannelIngressActivationAccess {
  const gate = findChannelIngressActivationGate(params.ingress);
  return {
    ran: gate != null,
    allowed: gate?.allowed === true,
    shouldSkip: gate?.activation?.shouldSkip === true,
    reasonCode: gate?.reasonCode ?? params.ingress.reasonCode,
    ...(gate?.activation?.effectiveWasMentioned !== undefined
      ? { effectiveWasMentioned: gate.activation.effectiveWasMentioned }
      : {}),
    ...(gate ? { gate } : {}),
  };
}

function commandOwnerAllowFrom(params: {
  command?: ChannelMessageIngressCommandInput;
  isGroup: boolean;
  configuredAllowFrom: Array<string | number>;
  effectiveAllowFrom: string[];
}): Array<string | number> {
  if (params.command?.commandOwnerAllowFrom != null) {
    return params.command.commandOwnerAllowFrom;
  }
  if (!params.isGroup) {
    return params.effectiveAllowFrom;
  }
  return params.command?.groupOwnerAllowFrom === "none" ? [] : params.configuredAllowFrom;
}

function commandGroupAllowFrom(params: {
  command?: ChannelMessageIngressCommandInput;
  isGroup: boolean;
  effectiveCommandGroupAllowFrom: string[];
}): Array<string | number> {
  if (params.isGroup) {
    return params.effectiveCommandGroupAllowFrom;
  }
  return params.command?.directGroupAllowFrom === "effective"
    ? params.effectiveCommandGroupAllowFrom
    : [];
}

export async function resolveChannelMessageIngress(
  params: ResolveChannelMessageIngressParams,
): Promise<ResolvedChannelMessageIngress> {
  const channelId = toChannelId(params.channelId);
  const adapter = createIdentityAdapter(params.identity);
  const subject = createIdentitySubject(params.identity, params.subject);
  const storeAllowFrom = await readStoreAllowFrom({ ...params, channelId });
  const rawAllowFrom = normalizeStringEntries(params.allowFrom ?? []);
  const rawStoreAllowFrom = normalizeStringEntries(storeAllowFrom);
  const rawGroupAllowFrom = normalizeStringEntries(params.groupAllowFrom ?? []);
  const normalizedAllowFrom = await normalizeEffectiveEntries({
    adapter,
    accountId: params.accountId,
    entries: rawAllowFrom,
    context: "dm",
  });
  const normalizedStoreAllowFrom = await normalizeEffectiveEntries({
    adapter,
    accountId: params.accountId,
    entries: rawStoreAllowFrom,
    context: "dm",
  });
  const normalizedGroupAllowFrom = await normalizeEffectiveEntries({
    adapter,
    accountId: params.accountId,
    entries: rawGroupAllowFrom,
    context: "group",
  });
  const referencedAccessGroups = allReferencedAccessGroupNames([
    rawAllowFrom,
    rawGroupAllowFrom,
    rawStoreAllowFrom,
    params.command?.commandOwnerAllowFrom ?? [],
    ...(params.routeFacts ?? []).map((route) => route.senderAllowFrom ?? []),
  ]);
  const runtimeAccessGroupMembership = await resolveRuntimeAccessGroupMembershipFacts({
    input: params,
    channelId,
    names: referencedAccessGroups,
  });
  const accessGroupMembership = [
    ...runtimeAccessGroupMembership,
    ...(params.accessGroupMembership ?? []),
  ];
  const baseEffective = resolveChannelIngressEffectiveAllowFromLists({
    allowFrom: normalizedAllowFrom,
    groupAllowFrom: normalizedGroupAllowFrom,
    storeAllowFrom: normalizedStoreAllowFrom,
    dmPolicy: params.policy.dmPolicy,
    groupAllowFromFallbackToAllowFrom: params.policy.groupAllowFromFallbackToAllowFrom,
  });
  const effectiveAllowFrom = await expandEffectiveAllowFromForMatchedAccessGroups({
    input: params,
    channelId,
    adapter,
    subject,
    entries: [...rawAllowFrom, ...rawStoreAllowFrom],
    effectiveEntries: baseEffective.effectiveAllowFrom,
    context: "dm",
    accessGroupMembership,
  });
  const effectiveGroupAllowFrom = await expandEffectiveAllowFromForMatchedAccessGroups({
    input: params,
    channelId,
    adapter,
    subject,
    entries:
      rawGroupAllowFrom.length > 0
        ? rawGroupAllowFrom
        : params.policy.groupAllowFromFallbackToAllowFrom === false
          ? []
          : rawAllowFrom,
    effectiveEntries: baseEffective.effectiveGroupAllowFrom,
    context: "group",
    accessGroupMembership,
  });
  const rawEffective = resolveChannelIngressEffectiveAllowFromLists({
    allowFrom: rawAllowFrom,
    groupAllowFrom: rawGroupAllowFrom,
    storeAllowFrom: rawStoreAllowFrom,
    dmPolicy: params.policy.dmPolicy,
    groupAllowFromFallbackToAllowFrom: params.policy.groupAllowFromFallbackToAllowFrom,
  });
  const rawCommandGroup = resolveChannelIngressEffectiveAllowFromLists({
    allowFrom: rawAllowFrom,
    groupAllowFrom: rawGroupAllowFrom,
    dmPolicy: params.policy.dmPolicy,
    groupAllowFromFallbackToAllowFrom:
      params.command?.commandGroupAllowFromFallbackToAllowFrom ??
      params.policy.groupAllowFromFallbackToAllowFrom,
  });
  const isGroup = params.conversation.kind !== "direct";
  const policy: ChannelIngressPolicyInput = {
    ...params.policy,
    ...(params.command !== undefined ? { command: params.command } : {}),
  };
  const state = await resolveChannelIngressState({
    channelId,
    accountId: params.accountId,
    subject,
    conversation: params.conversation,
    adapter,
    accessGroups: params.accessGroups,
    accessGroupMembership,
    routeFacts: params.routeFacts,
    mentionFacts: params.mentionFacts,
    event: params.event,
    allowlists: {
      dm: rawAllowFrom,
      group: rawEffective.effectiveGroupAllowFrom,
      pairingStore: rawStoreAllowFrom,
      commandOwner: commandOwnerAllowFrom({
        command: params.command,
        isGroup,
        configuredAllowFrom: rawAllowFrom,
        effectiveAllowFrom: rawEffective.effectiveAllowFrom,
      }),
      commandGroup: commandGroupAllowFrom({
        command: params.command,
        isGroup,
        effectiveCommandGroupAllowFrom: rawCommandGroup.effectiveGroupAllowFrom,
      }),
    },
  });
  const ingress = decideChannelIngress(state, policy);
  const senderAccess = projectSenderAccess({
    ingress,
    isGroup,
    dmPolicy: policy.dmPolicy,
    groupPolicy: policy.groupPolicy,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    providerMissingFallbackApplied: params.providerMissingFallbackApplied,
  });
  const commandAccess = projectCommandAccess({ ingress, policy });
  const eventAccess = projectEventAccess({ ingress, event: params.event });
  const activationAccess = projectActivationAccess({ ingress });
  return {
    state,
    ingress,
    senderAccess,
    commandAccess,
    eventAccess,
    activationAccess,
    accessFacts: projectIngressAccessFacts(ingress),
  };
}

export async function resolveChannelMessageIngressBundle(
  params: ResolveChannelMessageIngressBundleParams,
): Promise<ResolvedChannelMessageIngressBundle> {
  const [direct, group] = await Promise.all([
    resolveChannelMessageIngress(params.direct),
    resolveChannelMessageIngress(params.group),
  ]);
  return { direct, group };
}

import {
  decideChannelIngress,
  decideChannelIngressBundle,
  findChannelIngressCommandGate,
  findChannelIngressGate,
  findChannelIngressSenderGate,
  mapChannelIngressDecisionToTurnAdmission,
  projectIngressAccessFacts,
  resolveChannelIngressState as resolveChannelIngressStateInternal,
  CHANNEL_INGRESS_GATE_SELECTORS,
} from "../channels/message-access/index.js";
import type {
  ChannelIngressDecision,
  ChannelIngressIdentifierKind,
  ChannelIngressPluginId,
  ChannelIngressPolicyInput,
  ChannelIngressState,
  ChannelIngressStateInput as MessageAccessChannelIngressStateInput,
  InternalChannelIngressAdapter,
  InternalChannelIngressNormalizeResult,
  InternalChannelIngressSubject,
  InternalMatchMaterial,
  InternalNormalizedEntry,
  IngressReasonCode,
} from "../channels/message-access/index.js";
import type {
  DmGroupAccessDecision,
  DmGroupAccessReasonCode,
} from "../security/dm-policy-shared.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";

export {
  CHANNEL_INGRESS_GATE_SELECTORS,
  decideChannelIngress,
  decideChannelIngressBundle,
  findChannelIngressCommandGate,
  findChannelIngressGate,
  findChannelIngressSenderGate,
  mapChannelIngressDecisionToTurnAdmission,
  projectIngressAccessFacts,
};
export type {
  AccessGraph,
  AccessGraphGate,
  AccessGroupMembershipFact,
  ChannelIngressDecisionBundle,
  ChannelIngressGateSelector,
  ChannelIngressAdmission,
  ChannelIngressChannelId,
  ChannelIngressDecision,
  ChannelIngressEventInput,
  ChannelIngressIdentifierKind,
  ChannelIngressNormalizedEntry,
  ChannelIngressPluginId,
  ChannelIngressPolicyInput,
  ChannelIngressSideEffectResult,
  ChannelIngressState,
  IngressGateEffect,
  IngressGateKind,
  IngressGatePhase,
  IngressReasonCode,
  MatchableIdentifier,
  RedactedChannelIngressEvent,
  RedactedIngressAllowlistFacts,
  RedactedIngressDiagnostics,
  RedactedIngressEntryDiagnostic,
  RedactedIngressMatch,
  ResolvedIngressAllowlist,
  ResolvedRouteGateFacts,
  RouteGateFacts,
  RouteGateState,
  RouteSenderPolicy,
} from "../channels/message-access/index.js";

export type ChannelIngressSubjectIdentifier = InternalMatchMaterial;
export type ChannelIngressSubject = InternalChannelIngressSubject;
export type ChannelIngressAdapterEntry = InternalNormalizedEntry;
export type ChannelIngressAdapterNormalizeResult = InternalChannelIngressNormalizeResult;
export type ChannelIngressAdapter = InternalChannelIngressAdapter;
export type ChannelIngressStateInput = MessageAccessChannelIngressStateInput;

export type ChannelIngressSubjectIdentifierInput = {
  value: string;
  opaqueId?: string;
  kind?: ChannelIngressIdentifierKind;
  dangerous?: boolean;
  sensitivity?: "normal" | "pii";
};

export type CreateChannelIngressStringAdapterParams = {
  kind?: ChannelIngressIdentifierKind;
  normalizeEntry?: (value: string) => string | null | undefined;
  normalizeSubject?: (value: string) => string | null | undefined;
  isWildcardEntry?: (value: string) => boolean;
  resolveEntryId?: (params: { entry: string; index: number }) => string;
  dangerous?: boolean | ((entry: string) => boolean);
  sensitivity?: "normal" | "pii";
};

export type CreateChannelIngressMultiIdentifierAdapterParams = {
  normalizeEntry: (entry: string, index: number) => readonly ChannelIngressAdapterEntry[];
  getEntryMatchKey?: (entry: ChannelIngressAdapterEntry) => string | null | undefined;
  getSubjectMatchKeys?: (
    identifier: ChannelIngressSubjectIdentifier,
  ) => readonly (string | null | undefined)[];
  isWildcardEntry?: (entry: ChannelIngressAdapterEntry) => boolean;
};

export type ChannelIngressDmGroupAccessProjection = {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
};

export type ResolveChannelIngressAccessParams = ChannelIngressStateInput & {
  policy: ChannelIngressPolicyInput;
  effectiveAllowFrom?: readonly string[];
  effectiveGroupAllowFrom?: readonly string[];
};

export type ResolvedChannelIngressAccess = {
  state: ChannelIngressState;
  ingress: ChannelIngressDecision;
  isGroup: boolean;
  senderReasonCode: IngressReasonCode;
  access: ChannelIngressDmGroupAccessProjection & {
    effectiveAllowFrom: string[];
    effectiveGroupAllowFrom: string[];
  };
  commandAuthorized: boolean;
  shouldBlockControlCommand: boolean;
};

function defaultNormalize(value: string): string {
  return value;
}

function normalizeMatchValue(
  value: string,
  normalize: (value: string) => string | null | undefined,
): string | null {
  const normalized = normalize(value);
  return normalized == null ? null : normalized.trim() || null;
}

function resolveDangerous(
  dangerous: CreateChannelIngressStringAdapterParams["dangerous"],
  entry: string,
): boolean | undefined {
  return typeof dangerous === "function" ? dangerous(entry) : dangerous;
}

function defaultIngressMatchKey(params: {
  kind: ChannelIngressIdentifierKind;
  value: string;
}): string {
  return `${params.kind}:${params.value}`;
}

export function createChannelIngressPluginId(id: string): ChannelIngressPluginId {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("Channel ingress plugin id must be non-empty.");
  }
  return trimmed as ChannelIngressPluginId;
}

export function createChannelIngressSubject(
  input:
    | ChannelIngressSubjectIdentifierInput
    | { identifiers: readonly ChannelIngressSubjectIdentifierInput[] },
): ChannelIngressSubject {
  const identifiers = "identifiers" in input ? input.identifiers : [input];
  return {
    identifiers: identifiers.map((identifier, index) => ({
      opaqueId: identifier.opaqueId ?? `subject-${index + 1}`,
      kind: identifier.kind ?? "stable-id",
      value: identifier.value,
      dangerous: identifier.dangerous,
      sensitivity: identifier.sensitivity,
    })),
  };
}

export function createChannelIngressStringAdapter(
  params: CreateChannelIngressStringAdapterParams = {},
): ChannelIngressAdapter {
  const kind = params.kind ?? "stable-id";
  const normalizeEntry = params.normalizeEntry ?? defaultNormalize;
  const normalizeSubject = params.normalizeSubject ?? normalizeEntry;
  const isWildcardEntry = params.isWildcardEntry ?? ((entry: string) => entry === "*");
  return {
    normalizeEntries({ entries }) {
      const matchable = normalizeStringEntries(entries).flatMap((entry, index) => {
        const value = isWildcardEntry(entry) ? "*" : normalizeMatchValue(entry, normalizeEntry);
        if (!value) {
          return [];
        }
        return [
          {
            opaqueEntryId: params.resolveEntryId?.({ entry, index }) ?? `entry-${index + 1}`,
            kind,
            value,
            dangerous: resolveDangerous(params.dangerous, entry),
            sensitivity: params.sensitivity,
          },
        ];
      });
      return {
        matchable,
        invalid: [],
        disabled: [],
      };
    },
    matchSubject({ subject, entries }) {
      const values = new Set(
        subject.identifiers.flatMap((identifier) => {
          if (identifier.kind !== kind) {
            return [];
          }
          const value = normalizeMatchValue(identifier.value, normalizeSubject);
          return value ? [value] : [];
        }),
      );
      const matchedEntryIds = entries
        .filter((entry) => entry.kind === kind && (entry.value === "*" || values.has(entry.value)))
        .map((entry) => entry.opaqueEntryId);
      return {
        matched: matchedEntryIds.length > 0,
        matchedEntryIds,
      };
    },
  };
}

export function createChannelIngressMultiIdentifierAdapter(
  params: CreateChannelIngressMultiIdentifierAdapterParams,
): ChannelIngressAdapter {
  const getEntryMatchKey = params.getEntryMatchKey ?? defaultIngressMatchKey;
  const getSubjectMatchKeys =
    params.getSubjectMatchKeys ??
    ((identifier: ChannelIngressSubjectIdentifier) => [defaultIngressMatchKey(identifier)]);
  const isWildcardEntry = params.isWildcardEntry ?? ((entry) => entry.value === "*");
  return {
    normalizeEntries({ entries }) {
      return {
        matchable: entries.flatMap((entry, index) => params.normalizeEntry(entry, index)),
        invalid: [],
        disabled: [],
      };
    },
    matchSubject({ subject, entries }) {
      const subjectKeys = new Set(
        subject.identifiers.flatMap((identifier) =>
          getSubjectMatchKeys(identifier).filter((key): key is string => Boolean(key)),
        ),
      );
      const matchedEntryIds = entries
        .filter((entry) => {
          if (isWildcardEntry(entry)) {
            return true;
          }
          const key = getEntryMatchKey(entry);
          return key ? subjectKeys.has(key) : false;
        })
        .map((entry) => entry.opaqueEntryId);
      return {
        matched: matchedEntryIds.length > 0,
        matchedEntryIds,
      };
    },
  };
}

export function assertNeverChannelIngressReason(reasonCode: never): never {
  throw new Error(`Unhandled channel ingress reason code: ${String(reasonCode)}`);
}

export function findChannelIngressSenderReasonCode(
  decision: ChannelIngressDecision,
  params: { isGroup: boolean },
): IngressReasonCode {
  return findChannelIngressSenderGate(decision, params)?.reasonCode ?? decision.reasonCode;
}

export function mapChannelIngressReasonCodeToDmGroupAccessReason(params: {
  reasonCode: IngressReasonCode;
  isGroup: boolean;
}): DmGroupAccessReasonCode {
  switch (params.reasonCode) {
    case "group_policy_open":
    case "group_policy_allowed":
      return "group_policy_allowed";
    case "group_policy_disabled":
      return "group_policy_disabled";
    case "route_sender_empty":
    case "group_policy_empty_allowlist":
      return "group_policy_empty_allowlist";
    case "group_policy_not_allowlisted":
      return "group_policy_not_allowlisted";
    case "dm_policy_open":
      return "dm_policy_open";
    case "dm_policy_disabled":
      return "dm_policy_disabled";
    case "dm_policy_allowlisted":
      return "dm_policy_allowlisted";
    case "dm_policy_pairing_required":
      return "dm_policy_pairing_required";
    default:
      return params.isGroup ? "group_policy_not_allowlisted" : "dm_policy_not_allowlisted";
  }
}

export function projectChannelIngressDmGroupAccess(params: {
  ingress: ChannelIngressDecision;
  isGroup: boolean;
  dmPolicy: string;
  groupPolicy: string;
}): ChannelIngressDmGroupAccessProjection {
  const reasonCode = mapChannelIngressReasonCodeToDmGroupAccessReason({
    reasonCode: findChannelIngressSenderReasonCode(params.ingress, { isGroup: params.isGroup }),
    isGroup: params.isGroup,
  });
  const decision: DmGroupAccessDecision =
    reasonCode === "dm_policy_pairing_required"
      ? "pairing"
      : params.ingress.decision === "allow"
        ? "allow"
        : "block";
  const reason = (() => {
    switch (reasonCode) {
      case "group_policy_allowed":
        return `groupPolicy=${params.groupPolicy}`;
      case "group_policy_disabled":
        return "groupPolicy=disabled";
      case "group_policy_empty_allowlist":
        return "groupPolicy=allowlist (empty allowlist)";
      case "group_policy_not_allowlisted":
        return "groupPolicy=allowlist (not allowlisted)";
      case "dm_policy_open":
        return "dmPolicy=open";
      case "dm_policy_disabled":
        return "dmPolicy=disabled";
      case "dm_policy_allowlisted":
        return `dmPolicy=${params.dmPolicy} (allowlisted)`;
      case "dm_policy_pairing_required":
        return "dmPolicy=pairing (not allowlisted)";
      case "dm_policy_not_allowlisted":
        return `dmPolicy=${params.dmPolicy} (not allowlisted)`;
    }
    const exhaustive: never = reasonCode;
    return exhaustive;
  })();
  return {
    decision,
    reasonCode,
    reason,
  };
}

export async function resolveChannelIngressState(
  input: ChannelIngressStateInput,
): Promise<ChannelIngressState> {
  return await resolveChannelIngressStateInternal(input);
}

export async function resolveChannelIngressAccess(
  params: ResolveChannelIngressAccessParams,
): Promise<ResolvedChannelIngressAccess> {
  const { policy, effectiveAllowFrom, effectiveGroupAllowFrom, ...stateInput } = params;
  const state = await resolveChannelIngressState(stateInput);
  const ingress = decideChannelIngress(state, policy);
  const isGroup = params.conversation.kind !== "direct";
  const senderReasonCode = findChannelIngressSenderReasonCode(ingress, { isGroup });
  const access = projectChannelIngressDmGroupAccess({
    ingress,
    isGroup,
    dmPolicy: policy.dmPolicy,
    groupPolicy: policy.groupPolicy,
  });
  const commandGate = findChannelIngressCommandGate(ingress);
  return {
    state,
    ingress,
    isGroup,
    senderReasonCode,
    access: {
      ...access,
      effectiveAllowFrom: [...(effectiveAllowFrom ?? [])],
      effectiveGroupAllowFrom: [...(effectiveGroupAllowFrom ?? [])],
    },
    commandAuthorized: commandGate?.allowed === true,
    shouldBlockControlCommand: commandGate?.command?.shouldBlockControlCommand === true,
  };
}

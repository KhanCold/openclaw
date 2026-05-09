import { findChannelIngressSenderGate } from "./gates.js";
import type { DmGroupAccessDecision, DmGroupAccessReasonCode } from "./legacy-policy.js";
import type {
  ChannelIngressDmGroupAccessProjection,
  ChannelIngressSenderGroupAccessProjection,
} from "./runtime-types.js";
import type {
  ChannelIngressDecision,
  ChannelIngressPolicyInput,
  IngressReasonCode,
} from "./types.js";

/** @deprecated Use `senderAccess.ingressReasonCode` from `resolveChannelMessageIngress(...)` or typed gate selectors. */
export function findChannelIngressSenderReasonCode(
  decision: ChannelIngressDecision,
  params: { isGroup: boolean },
): IngressReasonCode {
  return resolveChannelIngressSenderReasonCode(decision, params);
}

function resolveChannelIngressSenderReasonCode(
  decision: ChannelIngressDecision,
  params: { isGroup: boolean },
): IngressReasonCode {
  return findChannelIngressSenderGate(decision, params)?.reasonCode ?? decision.reasonCode;
}

function mapReasonCodeToDmGroupAccessReason(params: {
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

function formatPolicyReason(params: {
  reasonCode: DmGroupAccessReasonCode;
  dmPolicy: string;
  groupPolicy: string;
}): string {
  switch (params.reasonCode) {
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
  const exhaustive: never = params.reasonCode;
  return exhaustive;
}

export function createChannelIngressSenderGroupAccessProjection(params: {
  reasonCode: IngressReasonCode;
  decisionAllowed: boolean;
  groupPolicy: ChannelIngressPolicyInput["groupPolicy"];
  providerMissingFallbackApplied?: boolean;
}): ChannelIngressSenderGroupAccessProjection {
  const reasonCode = mapReasonCodeToDmGroupAccessReason({
    reasonCode: params.reasonCode,
    isGroup: true,
  });
  const reason =
    params.groupPolicy === "disabled" || reasonCode === "group_policy_disabled"
      ? "disabled"
      : reasonCode === "group_policy_empty_allowlist"
        ? "empty_allowlist"
        : reasonCode === "group_policy_not_allowlisted"
          ? "sender_not_allowlisted"
          : "allowed";
  return {
    allowed: reason === "allowed" && params.decisionAllowed,
    groupPolicy: params.groupPolicy,
    providerMissingFallbackApplied: params.providerMissingFallbackApplied ?? false,
    reason,
  };
}

export function createChannelIngressDmGroupAccessProjection(params: {
  ingress: ChannelIngressDecision;
  isGroup: boolean;
  dmPolicy: string;
  groupPolicy: string;
}): ChannelIngressDmGroupAccessProjection {
  const reasonCode = mapReasonCodeToDmGroupAccessReason({
    reasonCode: resolveChannelIngressSenderReasonCode(params.ingress, {
      isGroup: params.isGroup,
    }),
    isGroup: params.isGroup,
  });
  const decision: DmGroupAccessDecision =
    params.ingress.decision === "pairing" || reasonCode === "dm_policy_pairing_required"
      ? "pairing"
      : params.ingress.decision === "block"
        ? "block"
        : reasonCode === "group_policy_allowed" ||
            reasonCode === "dm_policy_open" ||
            reasonCode === "dm_policy_allowlisted"
          ? "allow"
          : "block";
  const reason = formatPolicyReason({
    reasonCode,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
  });
  return {
    decision,
    reasonCode,
    reason,
  };
}

/** @deprecated Use `senderAccess.ingressReasonCode` from `resolveChannelMessageIngress(...)` or typed gate selectors. */
export function mapChannelIngressReasonCodeToDmGroupAccessReason(params: {
  reasonCode: IngressReasonCode;
  isGroup: boolean;
}): DmGroupAccessReasonCode {
  return mapReasonCodeToDmGroupAccessReason(params);
}

/** @deprecated Use `senderAccess.reason` from `resolveChannelMessageIngress(...)`. */
export function formatChannelIngressPolicyReason(params: {
  reasonCode: DmGroupAccessReasonCode;
  dmPolicy: string;
  groupPolicy: string;
}): string {
  return formatPolicyReason(params);
}

/** @deprecated Use `senderAccess.groupAccess` from `resolveChannelMessageIngress(...)`. */
export function projectChannelIngressSenderGroupAccess(params: {
  reasonCode: IngressReasonCode;
  decisionAllowed: boolean;
  groupPolicy: ChannelIngressPolicyInput["groupPolicy"];
  providerMissingFallbackApplied?: boolean;
}): ChannelIngressSenderGroupAccessProjection {
  return createChannelIngressSenderGroupAccessProjection(params);
}

/** @deprecated Use `senderAccess` from `resolveChannelMessageIngress(...)`. */
export function projectChannelIngressDmGroupAccess(params: {
  ingress: ChannelIngressDecision;
  isGroup: boolean;
  dmPolicy: string;
  groupPolicy: string;
}): ChannelIngressDmGroupAccessProjection {
  return createChannelIngressDmGroupAccessProjection(params);
}

import type { AccessGroupConfig } from "../../config/types.access-groups.js";
import type { AccessFacts } from "../turn/types.js";
import type { DmGroupAccessDecision, DmGroupAccessReasonCode } from "./legacy-policy.js";
import type {
  AccessGroupMembershipFact,
  AccessGraphGate,
  ChannelIngressChannelId,
  ChannelIngressDecision,
  ChannelIngressEventInput,
  ChannelIngressIdentifierKind,
  ChannelIngressPolicyInput,
  ChannelIngressState,
  ChannelIngressStateInput,
  IngressReasonCode,
  InternalChannelIngressAdapter,
  InternalChannelIngressSubject,
  InternalMatchMaterial,
  InternalNormalizedEntry,
  RouteGateFacts,
} from "./types.js";

export type ChannelIngressSubjectIdentifier = InternalMatchMaterial;
export type ChannelIngressSubject = InternalChannelIngressSubject;
export type ChannelIngressAdapterEntry = InternalNormalizedEntry;
export type ChannelIngressAdapter = InternalChannelIngressAdapter;

export type ChannelIngressIdentityField = {
  key?: string;
  kind?: ChannelIngressIdentifierKind;
  normalize?: (value: string) => string | null | undefined;
  normalizeEntry?: (value: string) => string | null | undefined;
  normalizeSubject?: (value: string) => string | null | undefined;
  dangerous?: boolean | ((value: string) => boolean | undefined);
  sensitivity?: "normal" | "pii";
};

export type ChannelIngressIdentityAlias = ChannelIngressIdentityField & {
  key: string;
};

export type ChannelIngressIdentityDescriptor = {
  primary: ChannelIngressIdentityField;
  aliases?: readonly ChannelIngressIdentityAlias[];
  isWildcardEntry?: (value: string) => boolean;
  matchEntry?: (params: {
    subject: ChannelIngressSubject;
    entry: ChannelIngressAdapterEntry;
    context: "dm" | "group" | "route" | "command";
  }) => boolean | undefined;
  resolveEntryId?: (params: {
    entry: string;
    entryIndex: number;
    fieldKey: string;
    fieldIndex: number;
  }) => string;
};

export type StableChannelIngressIdentityParams = ChannelIngressIdentityField &
  Pick<ChannelIngressIdentityDescriptor, "aliases" | "isWildcardEntry" | "matchEntry"> & {
    entryIdPrefix?: string;
    resolveEntryId?: ChannelIngressIdentityDescriptor["resolveEntryId"];
  };

export type ChannelIngressIdentitySubjectInput = {
  stableId?: string | number | null;
  aliases?: Record<string, string | number | null | undefined>;
};

export type ChannelMessageIngressCommandInput = NonNullable<
  ChannelIngressPolicyInput["command"]
> & {
  commandOwnerAllowFrom?: Array<string | number> | null;
  groupOwnerAllowFrom?: "configured" | "none";
  directGroupAllowFrom?: "effective" | "none";
  commandGroupAllowFromFallbackToAllowFrom?: boolean;
};

export type ChannelIngressAccessGroupMembershipResolver = (params: {
  name: string;
  group: AccessGroupConfig;
  channelId: ChannelIngressChannelId;
  accountId: string;
  subject: ChannelIngressIdentitySubjectInput;
}) => boolean | Promise<boolean>;

export type ResolveChannelMessageIngressParams = {
  channelId: string | ChannelIngressChannelId;
  accountId: string;
  identity: ChannelIngressIdentityDescriptor;
  subject: ChannelIngressIdentitySubjectInput;
  conversation: ChannelIngressStateInput["conversation"];
  event: ChannelIngressEventInput;
  policy: ChannelIngressPolicyInput;
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  routeFacts?: RouteGateFacts[];
  accessGroups?: ChannelIngressStateInput["accessGroups"];
  accessGroupMembership?: readonly AccessGroupMembershipFact[];
  resolveAccessGroupMembership?: ChannelIngressAccessGroupMembershipResolver;
  accessGroupMatchedAllowFromEntry?: string | number | null;
  providerMissingFallbackApplied?: boolean;
  mentionFacts?: ChannelIngressStateInput["mentionFacts"];
  readStoreAllowFrom?: (params: {
    channelId: ChannelIngressChannelId;
    accountId: string;
    dmPolicy: ChannelIngressPolicyInput["dmPolicy"];
  }) => Promise<readonly (string | number)[] | null | undefined>;
  useDefaultPairingStore?: boolean;
  command?: ChannelMessageIngressCommandInput;
};

export type ChannelIngressDmGroupAccessProjection = {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
};

export type ChannelIngressSenderGroupAccessProjection = {
  allowed: boolean;
  groupPolicy: ChannelIngressPolicyInput["groupPolicy"];
  providerMissingFallbackApplied: boolean;
  reason: "allowed" | "disabled" | "empty_allowlist" | "sender_not_allowlisted";
};

export type ChannelIngressSenderAccess = ChannelIngressDmGroupAccessProjection & {
  allowed: boolean;
  ingressReasonCode: IngressReasonCode;
  gate?: AccessGraphGate;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  groupAccess?: ChannelIngressSenderGroupAccessProjection;
};

export type ChannelIngressCommandAccess = {
  requested: boolean;
  authorized: boolean;
  shouldBlockControlCommand: boolean;
  reasonCode: IngressReasonCode;
  gate?: AccessGraphGate;
};

export type ChannelIngressEventAccess = {
  ran: boolean;
  authorized: boolean;
  authMode: ChannelIngressEventInput["authMode"];
  reasonCode: IngressReasonCode;
  gate?: AccessGraphGate;
};

export type ChannelIngressActivationAccess = {
  ran: boolean;
  allowed: boolean;
  shouldSkip: boolean;
  reasonCode: IngressReasonCode;
  effectiveWasMentioned?: boolean;
  gate?: AccessGraphGate;
};

export type ResolvedChannelMessageIngress = {
  state: ChannelIngressState;
  ingress: ChannelIngressDecision;
  senderAccess: ChannelIngressSenderAccess;
  commandAccess: ChannelIngressCommandAccess;
  eventAccess: ChannelIngressEventAccess;
  activationAccess: ChannelIngressActivationAccess;
  accessFacts: AccessFacts;
};

export type ResolveChannelMessageIngressBundleParams = {
  direct: ResolveChannelMessageIngressParams;
  group: ResolveChannelMessageIngressParams;
};

export type ResolvedChannelMessageIngressBundle = {
  direct: ResolvedChannelMessageIngress;
  group: ResolvedChannelMessageIngress;
};

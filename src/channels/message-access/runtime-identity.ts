import type {
  ChannelIngressAdapter,
  ChannelIngressAdapterEntry,
  ChannelIngressIdentityDescriptor,
  ChannelIngressIdentityField,
  ChannelIngressIdentitySubjectInput,
  ChannelIngressSubject,
  StableChannelIngressIdentityParams,
} from "./runtime-types.js";
import type { ChannelIngressPluginId, InternalMatchMaterial } from "./types.js";

type ResolvedIdentityField = Required<Pick<ChannelIngressIdentityField, "key" | "kind">> &
  Omit<ChannelIngressIdentityField, "key" | "kind">;

export function createChannelIngressPluginId(id: string): ChannelIngressPluginId {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("Channel ingress plugin id must be non-empty.");
  }
  return trimmed as ChannelIngressPluginId;
}

export function defineChannelIngressIdentity(
  identity: ChannelIngressIdentityDescriptor,
): ChannelIngressIdentityDescriptor {
  return identity;
}

export function defineStableChannelIngressIdentity(
  params: StableChannelIngressIdentityParams = {},
): ChannelIngressIdentityDescriptor {
  const { entryIdPrefix, resolveEntryId, aliases, isWildcardEntry, matchEntry, ...primary } =
    params;
  return defineChannelIngressIdentity({
    primary,
    aliases,
    isWildcardEntry,
    matchEntry,
    resolveEntryId:
      resolveEntryId ??
      (entryIdPrefix ? ({ entryIndex }) => `${entryIdPrefix}-${entryIndex + 1}` : undefined),
  });
}

export function toChannelId(id: string | ChannelIngressPluginId): ChannelIngressPluginId {
  return createChannelIngressPluginId(id);
}

function defaultNormalize(value: string): string {
  return value;
}

function normalizeFieldValue(
  field: ResolvedIdentityField,
  value: string,
  mode: "entry" | "subject",
): string | null {
  const normalize =
    mode === "entry"
      ? (field.normalizeEntry ?? field.normalize ?? defaultNormalize)
      : (field.normalizeSubject ?? field.normalize ?? defaultNormalize);
  const normalized = normalize(value);
  return normalized == null ? null : normalized.trim() || null;
}

function fieldDangerous(field: ResolvedIdentityField, value: string): boolean | undefined {
  return typeof field.dangerous === "function" ? field.dangerous(value) : field.dangerous;
}

function identityFields(identity: ChannelIngressIdentityDescriptor): ResolvedIdentityField[] {
  const fields: ResolvedIdentityField[] = [
    {
      ...identity.primary,
      key: identity.primary.key ?? "stableId",
      kind: identity.primary.kind ?? "stable-id",
    },
  ];
  for (const alias of identity.aliases ?? []) {
    fields.push({
      ...alias,
      kind: alias.kind ?? (`plugin:${alias.key}` as const),
    });
  }
  return fields;
}

function identityMatchKey(entry: Pick<ChannelIngressAdapterEntry, "kind" | "value">): string {
  return `${entry.kind}:${entry.value}`;
}

export function createIdentityAdapter(
  identity: ChannelIngressIdentityDescriptor,
): ChannelIngressAdapter {
  const fields = identityFields(identity);
  const isWildcardEntry = identity.isWildcardEntry ?? ((value: string) => value === "*");
  return {
    normalizeEntries({ entries }) {
      const matchable = entries.flatMap((entry, entryIndex) => {
        if (isWildcardEntry(entry)) {
          const primary = fields[0];
          return [
            {
              opaqueEntryId:
                identity.resolveEntryId?.({
                  entry,
                  entryIndex,
                  fieldKey: primary.key,
                  fieldIndex: 0,
                }) ?? `entry-${entryIndex + 1}:wildcard`,
              kind: primary.kind,
              value: "*",
              dangerous: fieldDangerous(primary, entry),
              sensitivity: primary.sensitivity,
            },
          ];
        }
        return fields.flatMap((field, fieldIndex) => {
          const value = normalizeFieldValue(field, entry, "entry");
          if (!value) {
            return [];
          }
          return [
            {
              opaqueEntryId:
                identity.resolveEntryId?.({
                  entry,
                  entryIndex,
                  fieldKey: field.key,
                  fieldIndex,
                }) ?? `entry-${entryIndex + 1}:${field.key}`,
              kind: field.kind,
              value,
              dangerous: fieldDangerous(field, entry),
              sensitivity: field.sensitivity,
            },
          ];
        });
      });
      return {
        matchable,
        invalid: [],
        disabled: [],
      };
    },
    matchSubject({ subject, entries, context }) {
      const subjectKeys = new Set(
        subject.identifiers.flatMap((identifier) => {
          const field = fields.find((candidate) => candidate.kind === identifier.kind);
          if (!field) {
            return [];
          }
          const value = normalizeFieldValue(field, identifier.value, "subject");
          return value ? [identityMatchKey({ kind: identifier.kind, value })] : [];
        }),
      );
      const matchedEntryIds = entries
        .filter((entry) => {
          const fallback = entry.value === "*" || subjectKeys.has(identityMatchKey(entry));
          return identity.matchEntry?.({ subject, entry, context }) ?? fallback;
        })
        .map((entry) => entry.opaqueEntryId);
      return {
        matched: matchedEntryIds.length > 0,
        matchedEntryIds,
      };
    },
  };
}

export function createIdentitySubject(
  identity: ChannelIngressIdentityDescriptor,
  input: ChannelIngressIdentitySubjectInput,
): ChannelIngressSubject {
  const fields = identityFields(identity);
  const identifiers: InternalMatchMaterial[] = [];
  const primary = fields[0];
  if (input.stableId != null) {
    identifiers.push({
      opaqueId: primary.key,
      kind: primary.kind,
      value: String(input.stableId),
      dangerous: fieldDangerous(primary, String(input.stableId)),
      sensitivity: primary.sensitivity,
    });
  }
  for (const field of fields.slice(1)) {
    const value = input.aliases?.[field.key];
    if (value == null) {
      continue;
    }
    identifiers.push({
      opaqueId: field.key,
      kind: field.kind,
      value: String(value),
      dangerous: fieldDangerous(field, String(value)),
      sensitivity: field.sensitivity,
    });
  }
  return { identifiers };
}

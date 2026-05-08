---
summary: "Plan for shrinking channel plugin ingress code by moving shared authorization wiring into core."
read_when:
  - Refactoring message channel ingress authorization
  - Reviewing PRs that migrate DM, group, command, event, route, or mention gating
  - Adding or changing channel allowlist, pairing, command, or route access helpers
  - Deciding whether channel plugin access logic belongs in core or the plugin
title: "Channel ingress refactor"
sidebarTitle: "Channel ingress refactor"
---

# Channel ingress refactor

Channel ingress should centralize common message-channel authorization logic in
core and keep plugin code focused on platform facts and side effects.

The current ingress kernel is the right foundation: it resolves redacted
allowlist state, builds an ordered access graph, and decides route, sender,
command, event, and mention activation gates. The migration is not complete
until bundled plugins stop rebuilding the same policy envelope around that
kernel.

## Goal

Shrink bundled channel plugins by moving reusable ingress wiring into a shared
core and SDK helper.

Core should own:

- DM policy semantics: `pairing`, `allowlist`, `open`, `disabled`
- group policy semantics: `allowlist`, `open`, `disabled`
- pairing-store reads as DM-only authorization facts
- effective `allowFrom`, `groupAllowFrom`, and store allowlist merging
- access-group expansion and diagnostics
- command owner and group authorizer derivation
- route fact projection helpers
- standard reason, access, `AccessFacts`, and turn-admission projection
- stable redacted diagnostics and gate selectors

Plugins should own:

- webhook verification, transport auth, replay protection, and rate limits
- account and config extraction
- platform sender, room, thread, guild, topic, membership, and route lookup
- platform identity normalization descriptors
- dynamic access-group facts that require platform APIs
- pairing replies and pairing-store writes
- command replies, local acknowledgements, reactions, typing, media, and history
- channel-specific logs and user-facing text

## Non-goals

- Do not move platform API clients or webhook objects into core.
- Do not make core aware of bundled plugin ids beyond generic channel ids and
  plugin-provided descriptors.
- Do not remove low-level ingress APIs. Keep them as an advanced escape hatch.
- Do not break third-party plugins that already consume documented SDK subpaths.
- Do not paper over duplicated plugin logic with more local caches.

## Current state

The shared kernel already exists in core:

- `src/channels/message-access/state.ts` resolves redacted allowlist state.
- `src/channels/message-access/decision.ts` decides route, sender, command,
  event, and activation gates.
- `src/channels/message-access/sender-gates.ts` owns DM and group sender gates.
- `src/channels/message-access/allowlist.ts` owns mutable identifier filtering
  and effective group sender allowlist composition.
- `src/channels/message-access/projection.ts` projects `AccessFacts` and turn
  admission.
- `src/plugin-sdk/channel-ingress.ts` exposes the kernel through the plugin SDK.

The missing layer is the application resolver above the kernel. Current
`resolveChannelIngressAccess(...)` still expects each plugin to prepare fully
shaped inputs:

- selected DM, group, command owner, command group, and pairing allowlists
- effective DM and group allowlists
- runtime group policy
- route facts
- event facts
- command gate options
- legacy access and reason projections

That leaves most migration code in plugins. A large PR that only adds the
kernel plus per-plugin wrappers can improve consistency while still increasing
extension code.

## Repeated plugin patterns

These patterns should be centralized before the migration is considered done.

### Pairing store reads

Many plugins repeat the same rule:

- do not read the store for group messages
- do not read the store for `dmPolicy: "allowlist"`
- do not read the store for `dmPolicy: "open"`
- catch read failures and fail closed to an empty list

The generic helper already exists as
`readStoreAllowFromForDmPolicy(...)`, but plugin wrappers still call it or
reimplement it directly. The high-level ingress resolver should own this by
default and accept an injected `readStoreAllowFrom` callback for tests or
plugin-owned stores.

### Effective allowlists

Plugins repeatedly compute:

- `effectiveAllowFrom = allowFrom + pairingStore` for DM policies that use the
  store
- `effectiveGroupAllowFrom = groupAllowFrom` with optional fallback to
  `allowFrom`
- no pairing-store entries for group sender authorization

This belongs in core. The existing helpers
`mergeDmAllowFromSources(...)`, `resolveGroupAllowFromSources(...)`, and
`resolveEffectiveAllowFromLists(...)` should become implementation details of
the high-level ingress resolver.

### Command authorizers

Plugins repeatedly derive:

- direct command owner allowlist from effective DM `allowFrom`
- group command owner allowlist from configured owner `allowFrom`
- group command sender allowlist from effective group or route sender allowlist
- no DM pairing-store approvals for group commands
- `commands.useAccessGroups !== false`
- `modeWhenAccessGroupsOff` defaults

This is easy to get wrong. Core should provide one command-authorizer derivation
path and tests should lock the DM-store versus group-command boundary.

### Identity adapters

Most plugins add local adapter and subject code around the same concepts:

- one stable sender id
- optional mutable name, email, slug, handle, phone, or group id
- wildcard handling
- redacted entry ids
- `dangerous: true` for mutable identifiers
- `sensitivity: "pii"` for private identifiers

The SDK should offer descriptor helpers so plugins declare identity facts rather
than reimplementing `createChannelIngressMultiIdentifierAdapter(...)` each time.

### Route facts

Route builders are repeated for common cases:

- route disabled
- route allowlist matched or not matched
- nested sender allowlist
- sender deny when route is matched but no sender list is configured

The platform-specific route lookup must remain plugin-owned. The conversion
from lookup result to `RouteGateFacts` should be a shared helper.

### Reason and access projection

Several plugins map ingress reason codes back to legacy strings or
`SenderGroupAccessDecision` shapes. Core should expose standard projections for
the common cases and let plugins override only user-visible text that is truly
channel-specific.

## Target API

Keep `openclaw/plugin-sdk/channel-ingress` as the low-level kernel. Add a
higher-level runtime-oriented SDK subpath for the common message ingress path:

```ts
import {
  defineChannelIngressIdentity,
  resolveChannelMessageIngress,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
```

Use a runtime subpath because the helper can involve config slices, pairing
store callbacks, and route data. Hot channel entrypoints should import it only
from receive paths that already need runtime policy.

### Identity descriptor

Plugins should describe identity material:

```ts
const identity = defineChannelIngressIdentity({
  channelId: "example",
  primary: {
    kind: "stable-id",
    normalize: normalizeExampleUserId,
    sensitivity: "pii",
  },
  aliases: [
    {
      kind: "plugin:example-email",
      normalize: normalizeExampleEmail,
      dangerous: true,
      sensitivity: "pii",
    },
  ],
});
```

The helper should create both:

- the ingress adapter for allowlist entries
- the ingress subject for the inbound sender

It should support simple one-id channels and multi-identifier channels without
forcing every plugin to hand-roll entry ids and match keys.

### Message ingress resolver

The main resolver should accept selected policy and platform facts:

```ts
const result = await resolveChannelMessageIngress({
  channelId: "example",
  accountId,
  identity,
  subject: {
    stableId: senderId,
    aliases: { email: senderEmail },
  },
  conversation: {
    kind: isGroup ? "group" : "direct",
    id: conversationId,
    parentId,
    threadId,
  },
  event: {
    kind: "message",
    authMode: "inbound",
    mayPair: !isGroup,
  },
  policy: {
    dmPolicy,
    groupPolicy,
    groupAllowFromFallbackToAllowFrom,
    mutableIdentifierMatching,
  },
  allowFrom,
  groupAllowFrom,
  routeFacts,
  accessGroups: cfg.accessGroups,
  readStoreAllowFrom,
  command: {
    hasControlCommand,
    allowTextCommands,
    modeWhenAccessGroupsOff,
    useAccessGroups: cfg.commands?.useAccessGroups !== false,
  },
});
```

The resolver should return:

```ts
type ResolvedChannelMessageIngress = {
  state: ChannelIngressState;
  ingress: ChannelIngressDecision;
  access: {
    decision: "allow" | "block" | "pairing";
    reasonCode: DmGroupAccessReasonCode;
    reason: string;
    effectiveAllowFrom: string[];
    effectiveGroupAllowFrom: string[];
  };
  commandAuthorized: boolean | undefined;
  shouldBlockControlCommand: boolean;
  accessFacts: AccessFacts;
};
```

The helper should also expose lower-level derivation helpers for unusual paths:

- `resolveChannelIngressPolicyInputs(...)`
- `deriveChannelIngressCommandAllowlists(...)`
- `projectChannelIngressSenderGroupAccess(...)`
- `projectChannelIngressReason(...)`

Use those only when a channel cannot use the full resolver.

### Route fact helpers

Add small builders:

```ts
routeDisabledFact(...)
routeAllowlistFact(...)
nestedRouteAllowlistFact(...)
routeSenderAllowlistFact(...)
routeDenyWhenSenderEmptyFact(...)
```

These helpers should create stable `RouteGateFacts` without each plugin
repeating `kind`, `gate`, `effect`, `senderPolicy`, `precedence`, and redacted
match objects.

## Migration plan

### Phase 1: Add the high-level helper

- Add `src/plugin-sdk/channel-ingress-runtime.ts`.
- Keep it additive and backwards-compatible.
- Use existing core helpers internally.
- Add export wiring in `package.json`, `scripts/lib/plugin-sdk-entrypoints.json`,
  and `src/plugin-sdk/entrypoints.ts`.
- Add API baseline and subpath tests.
- Document the high-level helper as the default path.

### Phase 2: Lock generic behavior

Add core and SDK tests for:

- DM pairing-store read conditions
- `dmPolicy: "open"` requires wildcard or configured match semantics
- group sender auth never uses DM pairing-store entries
- group command auth never uses DM pairing-store entries
- configured `groupAllowFrom` beats fallback `allowFrom`
- `groupAllowFromFallbackToAllowFrom: false` stays explicit
- route `deny-when-empty` blocks matched routes without sender allowlists
- route `inherit` augments sender allowlists
- route `replace` replaces sender allowlists
- dynamic access-group facts fail closed
- mutable identifiers are ignored unless enabled
- `shouldBlockControlCommand` is derived only from the command gate
- access and reason projection match existing legacy shapes

### Phase 3: Migrate simple plugins first

Start with plugins where the wrapper is mostly boilerplate:

- LINE
- Zalo
- IRC
- Zalo Personal

Target result:

- no local pairing-store read helper
- no local effective allowlist helper
- no local command owner or command group derivation
- no local `resolveChannelIngressAccess(...)` wrapper longer than a small
  config bridge

Each migrated plugin should keep only:

- config extraction
- identity descriptor
- optional route facts
- side effects

### Phase 4: Migrate standard DM and group plugins

Then migrate:

- WhatsApp
- iMessage
- Mattermost
- Microsoft Teams
- Nextcloud Talk

These channels may keep local route lookup and platform matching, but they
should not keep local policy-envelope assembly.

### Phase 5: Migrate complex event and command plugins

Migrate last:

- Slack
- Discord
- Matrix
- Signal
- Google Chat
- Telegram
- QQBot
- QA Channel
- Synology Chat
- Tlon
- Twitch

These channels include combinations of dynamic access groups, route-only
events, origin-subject events, interactive buttons, native commands, or
multi-pass direct and group decisions. They should use the high-level resolver
where possible and narrower derivation helpers where their event model truly
requires custom assembly.

### Phase 6: Fold older helpers

After the high-level resolver has at least two simple and two complex plugin
callers, fold older overlapping helpers into it:

- `src/plugin-sdk/direct-dm-access.ts`
- `src/plugin-sdk/command-auth.ts`
- command-related parts of `src/security/dm-policy-shared.ts`

Keep public exports source-compatible where required, but make them delegate to
the new resolver so semantics cannot drift.

### Phase 7: Update docs

Update plugin docs so the high-level resolver is the recommended path:

- `docs/plugins/sdk-channel-ingress.md`
- `docs/plugins/sdk-subpaths.md`
- channel access docs when visible behavior or config guidance changes

The docs should say:

- use the high-level resolver for normal channel receive paths
- use the low-level state and decision APIs only for advanced or unusual event
  paths
- plugin code should not rebuild DM/group/command policy wiring when the shared
  resolver covers it

## Completion checklist

The refactor is complete when:

- extension production code is net smaller than before the migration
- simple channel access files are deleted or reduced to small config bridges
- no plugin has a new ingress wrapper over about 100 lines unless most of it is
  platform route or identity logic
- pairing-store read rules live in one helper path
- command owner and group derivation lives in one helper path
- group command auth has regression coverage proving DM pairing-store entries
  do not authorize group commands
- route fact builders cover all common route cases
- identity descriptors replace most local adapter factories
- old direct-DM and command-auth SDK helpers delegate to the new resolver
- docs lead with the high-level resolver
- low-level ingress APIs are documented as an escape hatch

## Review checklist

For PRs in this refactor, review these before approving:

- Does the plugin still assemble policy inputs that core could derive?
- Does group auth accidentally include DM pairing-store entries?
- Does command auth use the same owner and group derivation as other channels?
- Does mutable name, email, or slug matching require an explicit dangerous
  matching flag?
- Are route facts platform lookup results, not duplicated policy logic?
- Are dynamic access groups represented as facts and failed closed?
- Are serialized diagnostics redacted?
- Did extension code shrink?
- Did docs describe the new default path?

## Verification commands

Use targeted local tests while iterating:

```sh
pnpm test src/channels/message-access/message-access.test.ts src/channels/message-access/projection.test.ts src/channels/message-access/conformance.test.ts
pnpm test src/plugin-sdk/channel-ingress.test.ts
pnpm test src/security/dm-policy-shared.test.ts src/channels/allow-from.test.ts src/config/runtime-group-policy.test.ts
pnpm test extensions/line/src/bot-handlers.test.ts extensions/zalo/src/monitor.group-policy.test.ts
pnpm test extensions/whatsapp/src/inbound/access-control.test.ts extensions/imessage/src/monitor.gating.test.ts
pnpm test extensions/mattermost/src/mattermost/monitor-auth.test.ts extensions/msteams/src/monitor-handler/message-handler.authz.test.ts
pnpm test extensions/slack/src/monitor/auth.test.ts extensions/discord/src/monitor/dm-command-auth.test.ts
pnpm plugin-sdk:api:check
pnpm build
```

Use Testbox for broad gates when the changed lanes fan out across bundled
plugins.

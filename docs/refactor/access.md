---
summary: "Deletion-first plan for moving generic channel access policy into core while keeping deprecated SDK seams isolated."
read_when:
  - Changing channel ingress, sender access, command authorization, or access-group handling
  - Deciding whether old access helpers are compatibility seams or active runtime APIs
  - Auditing bundled plugin usage of deprecated channel access helpers
title: "Channel access cleanup"
sidebarTitle: "Channel access cleanup"
---

# Channel access cleanup

Goal: centralize generic channel access policy in core and delete duplicated
bundled plugin authorization code. If a core helper adds lines but does not let
bundled plugins delete local access glue, it is not finished.

## Target Architecture

Bundled plugin receive path:

```text
platform event
  -> verify webhook/socket/event authenticity locally
  -> normalize sender/conversation/route/mention facts locally
  -> resolveChannelMessageIngress(...)
  -> use ingress, senderAccess, commandAccess, eventAccess, activationAccess
  -> plugin performs pairing/reply/ack/history/media side effects
  -> turn kernel receives redacted AccessFacts
```

Third-party compatibility path:

```text
old SDK helper call
  -> deprecated SDK shim
  -> shared core resolver or compatibility projector
  -> old return shape preserved
```

Core owns generic policy only:

- allowlist assembly, including pairing-store DM entries
- access-group expansion and fail-closed diagnostics
- redacted ingress state
- route, sender, command, event, and activation gates
- admission mapping
- redacted `AccessFacts` projection
- low-level projectors needed by deprecated SDK shims

Plugins still own transport facts and side effects:

- platform identity normalization inputs
- webhook/socket authenticity checks
- API lookups and membership facts
- pairing replies and command replies
- reactions, typing, media, history, and user-facing copy
- platform-specific setup, repair, doctor, and onboarding behavior

## Hard Gates

This refactor is complete for a PR only when bundled plugin production LOC is
net negative, total branch LOC trends down, bundled production code imports no
deprecated channel access helpers, modern `resolveChannelMessageIngress(...)`
exposes no old compatibility objects, SDK compatibility stays in core/SDK
files, and targeted parity/redaction/command/event/access-group tests pass.

Baseline commands:

```sh
git diff --shortstat -- extensions
git diff --shortstat
pnpm lint:extensions:no-deprecated-channel-access
```

Tests may exercise deprecated helpers only from core or SDK compatibility tests.

## Phase 0: Guardrails

Keep the guard that fails bundled production usage of deprecated access seams:
old direct DM helpers, old command auth helpers, direct pairing-store allowlist
reads, `resolveChannelIngressAccess(...)`, `compat.legacyAccess`, and
deprecated `AccessFacts` fields.

Before each cleanup wave, record extension LOC, total LOC including untracked
files, deprecated-seam guard result, and targeted tests.

## Phase 1: Isolate Compatibility

Keep third-party source compatibility, but make it visibly deprecated and
SDK-only.

Compatibility that may remain: old `AccessFacts` fields, direct DM helper
exports, command/group authorization helper exports, and low-level projectors
used by SDK shims. Public helpers need `@deprecated` comments, replacement
docs, and core/SDK compatibility tests. Bundled plugins must not import them or
read old projections.

## Phase 2: Move Generic Assembly Into Core

Move logic when at least two plugins need it or when a helper deletes plugin
code immediately.

Core helper candidates:

- identity builders for stable IDs, aliases, phones, and multi-identifier
  subjects
- wildcard matching and opaque entry ID generation
- static and dynamic access-group expansion
- DM/group allowlist assembly, fallback policy, and pairing-store reads
- command owner/group allowlists
- route, mention activation, event auth, admission, and redacted diagnostics

Do not move:

- platform API calls, user copy, setup, doctor, repair, webhook verification,
  side effects, or channel-specific migration policy

## Phase 3: Delete Bundled Glue

For each plugin, replace local access DTOs with the modern result:

- `ingress` for dispatch/drop/pairing/skip
- `senderAccess` for sender and conversation authorization
- `commandAccess` for control-command authorization
- `eventAccess` for buttons, reactions, callbacks, and origin-subject events
- `activationAccess` for mention and activation routing
- `accessFacts` for turn context

Delete local code that mostly mirrors those fields:

- local legacy-shaped access result objects
- repeated reason-code translation tables
- duplicated effective allowlist calculations
- recomputed `senderAllowedForCommands`
- local sender/group access projectors
- per-plugin command gate projections
- tests that only assert deleted wrapper shapes

Keep only platform side-effect glue and thin context adapters.

## Plugin Cleanup Order

Use deletion potential, not channel popularity:

| Wave | Plugins                                                           |
| ---- | ----------------------------------------------------------------- |
| 1    | QA Channel, IRC, LINE, Feishu, Synology Chat, Zalo, Zalo Personal |
| 2    | WhatsApp, Signal, iMessage/BlueBubbles, Matrix, Nextcloud Talk    |
| 3    | Slack, Mattermost, Microsoft Teams, Google Chat                   |
| 4    | Discord, Telegram, Twitch, Tlon, Nostr                            |
| 5    | QQBot standalone engine and bridge                                |

Standalone engines may keep a thin bridge when direct core consumption would
break package boundaries. The bridge should still delegate generic access
policy to core where feasible.

## Phase 4: Deprecate Old SDK Seams

Do not delete public compatibility in this PR. Isolate it first. Remove it only
after the public deprecation window closes.

Before removal, old exports need replacement docs, generated SDK deprecation
guidance, compatibility fixtures, modern examples without deprecated fields,
and changelog/migration notes. Remove them only after the deprecation window,
with no bundled production imports and an intentional SDK API baseline change.

## Verification Matrix

For each migrated plugin, cover:

- DM policy: disabled, open, allowlist, pairing, non-pairable events
- group policy: disabled, open, empty allowlist, match, mismatch, fallback
- command policy: sender access separate from command auth, unauthorized control
  commands block
- event policy: callbacks/buttons/reactions never start pairing; route-only and
  origin-subject semantics are explicit
- activation: mention hit dispatches; mention miss skips quietly
- access groups: static groups work; missing, unsupported, or failed dynamic
  groups fail closed
- redaction: state, decisions, diagnostics, and `AccessFacts` do not expose raw
  identities or allowlist entries

Local loop:

```sh
pnpm test src/channels/message-access/message-access.test.ts src/channels/message-access/projection.test.ts src/channels/message-access/conformance.test.ts src/plugin-sdk/channel-ingress.test.ts src/plugin-sdk/channel-ingress-runtime.test.ts src/plugin-sdk/access-groups.test.ts
pnpm test extensions/<channel>/src/...
pnpm plugin-sdk:api:check
pnpm config:docs:check
pnpm exec oxfmt --check --threads=1 <changed files>
git diff --check
```

Use Testbox for broad changed gates, full `pnpm check`, full `pnpm test`,
Docker/E2E/live/package proof, or large cross-plugin fan-out.

## Allowed Leftovers

Allowed leftovers: deprecated public SDK compatibility through the deprecation
window, turn-context/native-command `CommandAuthorized` fields, platform
side-effect glue, platform API lookup results, channel-specific user-facing
copy, and standalone engine bridge code when package boundaries require it.
Everything else is cleanup debt.

## Review Shape

Rewrite commits by layer: core extraction, SDK compatibility, bundled plugin
cleanup waves, tests/guardrails, then docs and generated API metadata. Each
plugin cleanup commit should show deleted local access glue plus targeted tests.

# Issue 168626: isolated Gateway baseline proof

Status: statically prepared; NOT RUN. No production patch, API, schema, permission,
workflow or dependency change. Keep this auxiliary bundle separate from the
rejected sandbox documentation patch and the Slack mention candidate.

Base: `ec9db387c421e0f9a330d862ea3fe5170bf01a8e`.
Branch: `proof/silent-claim-168626` (no new commit yet).

## Authorized execution boundary

Do not execute the runner, fixture, repository scripts or product on the
credentialed Air. The Linux/CI check is an accidental-launch guard, NOT an
isolation boundary. Parent must provide a disposable secretless CI job/container
with no user home, persisted Git credentials, SSH agent, cloud role/metadata
access, Docker socket, credential volumes, real OpenClaw state or model secrets.
Use an independently owned dependency installation and the packageManager pin
(pnpm 12.9.0); Node 26.11.1 is the prepared toolchain version.

Install/build may use dependency network access in that secretless environment.
Run the built proof in a fresh network namespace with external networking disabled
(e.g. Docker `--network none`), leaving container loopback available. Expose no
ports. Use one container per run: the two fixed loopback ports are 18799/18800.
The source plus its own build/dependencies may be read-only; only a fresh output
parent needs write access. Preserve build stdout, exit and timing against the exact
source SHA. A preexisting dist directory is not sufficient build provenance.

Parent-owned CI setup, inside the approved secretless build environment:

```sh
# Verify checkout and packageManager; use an explicit checkout with persist-credentials:false.
git rev-parse HEAD
pnpm install --frozen-lockfile
pnpm build qaRuntime
# Runtime invocation, in the network-isolated container with that exact build:
CI=true node proof/168626/run.mjs baseline /proof-output/base-run ec9db387c421e0f9a330d862ea3fe5170bf01a8e
```

`/proof-output` must exist, while `/proof-output/base-run` must not exist. The
runner refuses reused output/state. Parent can use its existing approved build
and container plumbing; this bundle creates or changes no workflow.

To run the unchanged behavioral assertions against baseline as a red regression,
use `fixed` instead of `baseline`. It must fail specifically in the final silent
case after the three controls succeed. After a future reviewed production repair,
run `fixed` with the exact committed candidate SHA and a new output directory.
The script requires clean tracked src/packages/extensions against that SHA; it
does not create the candidate commit. Capture full build source/artifact provenance
in CI, not just the runner's SHA check.

## What runs

One built `node openclaw.mjs gateway run --allow-unconfigured` child, not a mocked
Gateway, is started with an allowlisted environment. HOME, XDG config/cache,
OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH, TMPDIR, workspace and log files all point
to new task-owned paths. No real environment/auth files are copied. Auth consists
of a generated disposable loopback Gateway token and `synthetic-proof-key` for a
local HTTP responder. `config.json` contains only these disposable fixture values;
do not upload or reuse a running Gateway's auth token.

`config.template.json` selects only proof-local/proof-model, explicitly uses the
openclaw runtime, and disables heartbeat, cron, mDNS and the memory slot. External
network isolation is still required; configuration alone is not containment.

The fixture uses the documented package+manifest, `definePluginEntry`,
`plugins.load.paths`, enablement, allowlist, and `hooks.allowConversationAccess`
contracts. It is loaded normally by the Gateway. Public `plugins.inspect` plus a
registration log and an actual matching hook invocation prove discovery and
execution. There is no injected registry, fake run result, completion marker,
transcript append or direct SQLite access. The plugin writes only a named proof
log; its exact returned object is logged before return. An omitted reply is
`{handled:true}`, never a manufactured NO_REPLY payload.

The WebSocket client uses the existing authenticated loopback CLI connection
contract (protocol 4, operator read/write/admin scopes), with no browser Origin,
no disabled auth/device guard and no operator state. `chat.send`'s actual caller
owner sets ChatType=direct for this supported CLI path as well as Control UI.
This proves shared API/completion behavior; it does not claim a rendered browser
screenshot or a distinct Control UI handshake proof.

Each case creates a new non-main session using public `sessions.create`, calls
real `chat.send`, waits for its own `chat` terminal event, replays exactly the same
idempotent request, and reads public `chat.history`. No internal helper decides
or injects completion. Timeouts are failure bounds; only readiness is polled.
User operations/assertions are never retried to manufacture a passing result.

## Prepared controls and observations

| Case | Hook return | Model boundary | Baseline | Future fixed candidate |
| --- | --- | --- | --- | --- |
| visible | handled + visible reply | zero calls | final + successful replay | same |
| model-visible | undefined | real local HTTP response MODEL_VISIBLE | final + successful replay; visible history | same |
| model-silent | undefined | real local HTTP response NO_REPLY | error + UNAVAILABLE missing-reply replay | must remain error |
| silent (headline, last) | exactly handled:true, no reply property | zero calls | error + UNAVAILABLE missing-reply replay | final + successful replay, zero assistant history rows |

Every case additionally requires exactly one user history entry and one matching
hook invocation, including after replay, bound to the created session and agent.
Visible-claim transcript persistence is deliberately not asserted: that is the
separate #150078 repair. The local HTTP responder is an external-I/O fixture;
none of the Gateway's internal decisions are mocked. Model requests and emitted
response text are retained as evidence.

`baseline-defect-reproduced` means the harness verified the known bad product
outcome; it is not a product-green result. Any missing plugin, auth/setup error,
provider mismatch, early Gateway exit or assertion mismatch yields nonzero exit
and `proof-failed-not-established`. Inspect the failed phase and raw artifacts;
do not report any such failure as reproduction.

Pending after baseline, before publication: actual baseline run and candidate run;
CLI-runner sibling behavior if a shared result type/runner branch is changed;
abort/replaced-run and declined/failed-hook contracts at their existing test owners;
required changed checks and canonical P0-P2 review; fresh duplicate/claim audit.
No new storage/public interface should be introduced to make this fixture pass.

## Artifacts and known preparation limits

`summary.json` contains exact SHA, Node version, timing, per-case requests,
terminal events, replay frames, history and hook/model evidence. Other files:
`frames.json`, `provider-requests.json`, `plugin-inspection.json`, `hook.jsonl`,
`readiness.json`, `launch.json`, `environment-keys.json`, generated `config.json`,
Gateway stdout/stderr and configured Gateway log. Session databases stay inside
the owned output directory; do not upload raw databases when JSON evidence is
sufficient. The runner stops only its own process group and local HTTP server.

No dependencies were installed and no build/schema validation, Gateway boot,
plugin load, model wire exchange, regression or UI execution has been run for this
bundle on Air. Static Node `--check` is parsing, not execution. Initial CI may
identify fixture prerequisites; fix those separately from production. Do not count
fixture setup failure as baseline red. Wall time and CI cost are unknown until run.

## Test-audit rationale and source contracts

- Observable invariant: a documented deliberate plugin-silent claim settles
  successfully, while an ordinary model cannot waive a required direct reply.
- Credible regression: the real hook creates NO_REPLY without carrying host-owned
  intent to shared completion, which maps required+empty to missing and errors.
- Missing stronger proof: existing runner/storage tests do not establish the
  complete installed-plugin -> public chat.send -> terminal/replay/history path.
- No production seam: only public plugin, configuration and Gateway interfaces.
- Root/agents/plugins/Gateway/server-methods/test rules, testing skill and
  test-audit skill were read. Database changes guidance requires design acceptance
  for material public/storage/permission changes; none is proposed here. Gateway
  remains sole state owner, and all session operations go through its API.

Relevant source: src/plugins/before-agent-reply.ts:40;
src/auto-reply/reply/agent-runner-execute.ts:237;
src/auto-reply/reply/agent-runner-result-payloads.ts:135,185;
src/agents/reply-completion.ts:51;
src/auto-reply/reply/agent-runner-failure-reply.ts:445;
src/gateway/server-methods/chat-send-agent-dispatch.ts:627;
src/gateway/server-methods/gateway-client-identity.ts:132;
src/gateway/server/ws-connection/handshake-auth-helpers.ts:201;
docs/plugins/hooks.md:165.

## Reviewed CI wrapper

`ci.mjs` and `.github/workflows/silent-claim-168626-proof.yml` provide the
independent fork-only manual route. The official baseline qaRuntime profile
builds runtime JavaScript, plugin assets and runtime stamps and is also used by
the official plugin Gateway gauntlet. This proves runtime behavior, not complete
declaration emission or release/package qualification. The six-file input bundle
is preserved in the handoff archive; this README is updated only for CI wiring.

The wrapper fetches the exact public source anonymously. Install/build occurs in
a secretless pinned Docker image, then runtime uses a read-only source/root,
network none, fresh synthetic state and no exposed ports. No host credentials or
Docker socket enter a container. Only selected JSON/log artifacts leave runtime;
config, databases and real host state are excluded. Sanitized JSON encoding
escapes Actions command delimiters. Full sanitized build/runtime streams and
selected proof records are retained in the public job log, without artifact/cache
upload. The workflow has contents:read and pinned official actions, and does not
change or dispatch the Slack workflow.

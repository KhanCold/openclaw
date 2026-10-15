// Fork-only evidence fixture; not part of the proposed upstream change.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-inline-yaml-proof-"));
const workspace = path.join(root, "workspace");
const home = path.join(root, "home");
const state = path.join(root, "state");
const emptyBundled = path.join(root, "bundled");
for (const directory of [workspace, home, state, emptyBundled]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

const server = net.createServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const fixtures = [
  {
    name: "indented-yaml",
    metadata:
      "metadata:\n  openclaw:\n    emoji: lobster\n    homepage: https://example.test/indented-yaml",
  },
  {
    name: "json5-control",
    metadata:
      "metadata: {openclaw: {emoji: 'lobster', homepage: 'https://example.test/json5-control'}}",
  },
  {
    name: "json-comment-control",
    metadata:
      'metadata: {"openclaw": {"emoji": "lobster", "homepage": "https://example.test/json-comment-control"}} # display metadata',
  },
  {
    name: "inline-yaml",
    metadata:
      "metadata: {openclaw: {emoji: lobster, homepage: https://example.test/inline-yaml}}",
  },
];
for (const fixture of [...fixtures, { name: "invalid-yaml", metadata: "metadata: {broken: [" }]) {
  const directory = path.join(workspace, "skills", fixture.name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "SKILL.md"),
    `---\nname: ${fixture.name}\ndescription: Synthetic metadata proof\n${fixture.metadata}\n---\nSynthetic instructions.\n`,
  );
}
const configPath = path.join(state, "openclaw.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    agents: { defaults: { workspace } },
    gateway: { mode: "local", port, auth: { mode: "none" } },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
    cron: { enabled: false },
  }),
  { mode: 0o600 },
);
const env = {
  PATH: process.env.PATH,
  HOME: home,
  CI: "true",
  NO_COLOR: "1",
  COREPACK_HOME: process.env.COREPACK_HOME,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_BUNDLED_SKILLS_DIR: emptyBundled,
  OPENCLAW_HIDE_BANNER: "1",
  OPENCLAW_HANDSHAKE_TIMEOUT_MS: "2000",
  NPM_CONFIG_USERCONFIG: "/dev/null",
  NPM_CONFIG_GLOBALCONFIG: "/dev/null",
};
function cli(args) {
  const result = spawnSync("pnpm", ["--silent", "openclaw", ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `CLI process error: ${result.error}`);
  assert.equal(result.status, 0, `CLI failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
try {
  const list = cli(["skills", "list", "--json"]);
  const checks = [];
  for (const fixture of fixtures) {
    const info = cli(["skills", "info", fixture.name, "--json"]);
    for (const [surface, skill] of [
      ["list", list.skills.find((entry) => entry.name === fixture.name)],
      ["info", info],
    ]) {
      checks.push({
        name: `${fixture.name}:${surface}`,
        actual: { name: skill?.name, emoji: skill?.emoji, homepage: skill?.homepage },
        ok:
          skill?.name === fixture.name &&
          skill?.emoji === "lobster" &&
          skill?.homepage === `https://example.test/${fixture.name}`,
      });
    }
  }
  checks.push({
    name: "invalid-yaml:excluded",
    ok: !list.skills.some((entry) => entry.name === "invalid-yaml"),
  });
  const failures = checks.filter((check) => !check.ok).map((check) => check.name);
  console.log(`SKILLS_METADATA_PROOF ${JSON.stringify({ checks, failures })}`);
  assert.deepEqual(failures, [], "Metadata proof failed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

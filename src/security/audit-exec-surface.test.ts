import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { saveExecApprovals } from "../infra/exec-approvals.js";
import { collectExecRuntimeFindings } from "./audit.js";

function hasFinding(
  checkId:
    | "tools.exec.auto_allow_skills_enabled"
    | "tools.exec.allowlist_interpreter_without_strict_inline_eval"
    | "security.exposure.open_channels_with_exec"
    | "tools.exec.security_full_configured"
    | "tools.exec.fs_tools_disabled_but_exec_enabled",
  severity: "warn" | "critical",
  findings: ReturnType<typeof collectExecRuntimeFindings>,
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

describe("security audit exec surface findings", () => {
  // Redirect HOME to a per-test tempdir so saveExecApprovals never touches
  // the real `~/.openclaw/exec-approvals.json` on the host running the suite.
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let tempRoot = "";
  let tempCaseIndex = 0;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-approvals-"));
  });

  beforeEach(async () => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    const tempDir = path.join(tempRoot, `case-${++tempCaseIndex}`);
    await fs.mkdir(path.join(tempDir, ".openclaw"), { recursive: true });
    process.env.HOME = tempDir;
    // Windows uses USERPROFILE for os.homedir()
    process.env.USERPROFILE = tempDir;
  });

  afterEach(() => {
    saveExecApprovals({ version: 1, agents: {} });
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  });

  afterAll(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
  it("warns when exec approvals enable autoAllowSkills", () => {
    saveExecApprovals({
      version: 1,
      defaults: {
        autoAllowSkills: true,
      },
      agents: {},
    });

    expect(
      hasFinding("tools.exec.auto_allow_skills_enabled", "warn", collectExecRuntimeFindings({})),
    ).toBe(true);
  });

  it("warns when interpreter allowlists are present without strictInlineEval", () => {
    saveExecApprovals({
      version: 1,
      agents: {
        main: {
          allowlist: [{ pattern: "/usr/bin/python3" }, { pattern: "/usr/bin/awk" }],
        },
        ops: {
          allowlist: [{ pattern: "/usr/local/bin/node" }, { pattern: "/usr/local/bin/find" }],
        },
      },
    });

    expect(
      hasFinding(
        "tools.exec.allowlist_interpreter_without_strict_inline_eval",
        "warn",
        collectExecRuntimeFindings({
          agents: {
            list: [{ id: "ops" }],
          },
        } satisfies OpenClawConfig),
      ),
    ).toBe(true);
  });

  it("suppresses interpreter allowlist warnings when strictInlineEval is enabled", () => {
    saveExecApprovals({
      version: 1,
      agents: {
        main: {
          allowlist: [{ pattern: "/usr/bin/python3" }, { pattern: "/usr/bin/xargs" }],
        },
      },
    });

    expect(
      hasFinding(
        "tools.exec.allowlist_interpreter_without_strict_inline_eval",
        "warn",
        collectExecRuntimeFindings({
          tools: {
            exec: {
              strictInlineEval: true,
            },
          },
        } satisfies OpenClawConfig),
      ),
    ).toBe(false);
  });

  it("flags open channel access combined with exec-enabled scopes", () => {
    const findings = collectExecRuntimeFindings({
      channels: {
        discord: {
          groupPolicy: "open",
        },
      },
      tools: {
        exec: {
          security: "allowlist",
          host: "gateway",
        },
      },
    } satisfies OpenClawConfig);

    expect(hasFinding("security.exposure.open_channels_with_exec", "warn", findings)).toBe(true);
  });

  it("escalates open channel exec exposure when full exec is configured", () => {
    const findings = collectExecRuntimeFindings({
      channels: {
        slack: {
          dmPolicy: "open",
        },
      },
      tools: {
        exec: {
          security: "full",
        },
      },
    } satisfies OpenClawConfig);

    expect(hasFinding("tools.exec.security_full_configured", "critical", findings)).toBe(true);
    expect(hasFinding("security.exposure.open_channels_with_exec", "critical", findings)).toBe(
      true,
    );
  });

  it("warns when filesystem tools are disabled but exec remains available", () => {
    const findings = collectExecRuntimeFindings({
      tools: {
        allow: ["read", "exec", "process"],
        deny: ["write", "edit", "apply_patch"],
      },
    } satisfies OpenClawConfig);

    const finding = findings.find(
      (entry) => entry.checkId === "tools.exec.fs_tools_disabled_but_exec_enabled",
    );
    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("tools");
    expect(finding?.detail).toContain("runtime=[exec, process]");
    expect(finding?.remediation).toContain("deny exec and process");
  });

  it("does not warn when sandbox filesystem policy constrains exec", () => {
    const findings = collectExecRuntimeFindings({
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            workspaceAccess: "ro",
          },
        },
      },
      tools: {
        allow: ["read", "exec", "process"],
        deny: ["write", "edit", "apply_patch"],
      },
    } satisfies OpenClawConfig);

    expect(hasFinding("tools.exec.fs_tools_disabled_but_exec_enabled", "warn", findings)).toBe(
      false,
    );
  });
});

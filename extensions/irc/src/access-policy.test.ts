import { describe, expect, it, vi } from "vitest";
import { resolveIrcIngressAccess } from "./access-policy.js";
import { resolveIrcGroupMatch } from "./policy.js";
import type { CoreConfig, IrcChannelConfig, IrcInboundMessage } from "./types.js";

function createMessage(overrides: Partial<IrcInboundMessage> = {}): IrcInboundMessage {
  return {
    messageId: "msg-1",
    target: "#ops",
    senderNick: "alice",
    senderUser: "ident",
    senderHost: "example.com",
    text: "/config",
    timestamp: Date.now(),
    isGroup: true,
    ...overrides,
  };
}

async function resolveAccess(params: {
  message?: Partial<IrcInboundMessage>;
  groupPolicy?: "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  groups?: Record<string, IrcChannelConfig>;
  allowNameMatching?: boolean;
  allowTextCommands?: boolean;
  hasControlCommand?: boolean;
  requireMention?: boolean;
  useAccessGroups?: boolean;
}) {
  const message = createMessage(params.message);
  return await resolveIrcIngressAccess({
    accountId: "default",
    message,
    config: {
      channels: { irc: {} },
      commands:
        params.useAccessGroups === undefined
          ? undefined
          : { useAccessGroups: params.useAccessGroups },
    } as CoreConfig,
    dmPolicy: "pairing",
    groupPolicy: params.groupPolicy ?? "allowlist",
    allowFrom: params.allowFrom ?? [],
    groupAllowFrom: params.groupAllowFrom ?? [],
    groupMatch: resolveIrcGroupMatch({
      groups: params.groups ?? { "#ops": {} },
      target: message.target,
    }),
    allowNameMatching: params.allowNameMatching ?? false,
    allowTextCommands: params.allowTextCommands ?? true,
    hasControlCommand: params.hasControlCommand ?? true,
    requireMention: params.requireMention ?? false,
    wasMentioned: false,
    readAllowFromStore: vi.fn(async () => []),
  });
}

describe("irc access policy", () => {
  it("authorizes group commands from stable sender identities", async () => {
    await expect(
      resolveAccess({
        groupAllowFrom: ["alice!ident@example.com"],
      }),
    ).resolves.toMatchObject({
      ingress: { decision: "allow" },
      commandAccess: {
        authorized: true,
        shouldBlockControlCommand: false,
      },
    });
  });

  it("blocks unauthorized group control commands after sender authorization", async () => {
    await expect(
      resolveAccess({
        groupAllowFrom: ["bob!ident@example.com"],
        groups: {
          "#ops": {
            allowFrom: ["alice!ident@example.com"],
          },
        },
      }),
    ).resolves.toMatchObject({
      ingress: { decision: "block" },
      commandAccess: {
        authorized: false,
        shouldBlockControlCommand: true,
      },
    });
  });

  it("requires explicit name matching for bare nick authorization", async () => {
    await expect(resolveAccess({ groupAllowFrom: ["alice"] })).resolves.toMatchObject({
      ingress: { decision: "block" },
      commandAccess: { authorized: false },
    });
    await expect(
      resolveAccess({
        groupAllowFrom: ["alice"],
        allowNameMatching: true,
      }),
    ).resolves.toMatchObject({
      ingress: { decision: "allow" },
      commandAccess: {
        authorized: true,
        shouldBlockControlCommand: false,
      },
    });
  });

  it("preserves command allow mode when access groups are disabled", async () => {
    await expect(
      resolveAccess({
        groupAllowFrom: ["alice!ident@example.com"],
        useAccessGroups: false,
      }),
    ).resolves.toMatchObject({
      commandAccess: {
        authorized: true,
        shouldBlockControlCommand: false,
      },
    });
  });

  it('allows unconfigured channels when groupPolicy is "open"', async () => {
    await expect(
      resolveAccess({
        message: { target: "#random" },
        groupPolicy: "open",
        groups: {},
        hasControlCommand: false,
      }),
    ).resolves.toMatchObject({
      ingress: { decision: "allow" },
    });
  });

  it("honors explicit group disable even in open mode", async () => {
    await expect(
      resolveAccess({
        groupPolicy: "open",
        groups: {
          "#ops": { enabled: false },
        },
      }),
    ).resolves.toMatchObject({
      ingress: { decision: "block" },
      roomGateReason: "channel_disabled",
    });
  });

  it("allows authorized control commands without mention", async () => {
    await expect(
      resolveAccess({
        groupAllowFrom: ["alice!ident@example.com"],
        requireMention: true,
      }),
    ).resolves.toMatchObject({
      ingress: { decision: "allow" },
      commandAccess: { authorized: true },
    });
  });
});

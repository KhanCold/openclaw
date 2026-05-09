import { describe, expect, it, vi } from "vitest";
import { resolveIrcIngressAccess } from "./access-policy.js";
import { resolveIrcGroupMatch } from "./policy.js";
import type { CoreConfig, IrcInboundMessage } from "./types.js";

function createMessage(overrides: Partial<IrcInboundMessage> = {}): IrcInboundMessage {
  return {
    messageId: "msg-1",
    target: "alice",
    senderNick: "alice",
    senderUser: "ident",
    senderHost: "example.com",
    text: "hello",
    timestamp: Date.now(),
    isGroup: false,
    ...overrides,
  };
}

describe("irc inbound policy", () => {
  it("keeps DM allowlist merged with pairing-store entries", async () => {
    const readAllowFromStore = vi.fn(async () => ["alice!ident@example.com"]);

    const resolved = await resolveIrcIngressAccess({
      accountId: "default",
      message: createMessage(),
      config: { channels: { irc: {} } } as CoreConfig,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: ["owner"],
      groupAllowFrom: [],
      groupMatch: resolveIrcGroupMatch({ groups: {}, target: "alice" }),
      allowNameMatching: false,
      allowTextCommands: false,
      hasControlCommand: false,
      requireMention: false,
      wasMentioned: false,
      readAllowFromStore,
    });

    expect(resolved.ingress.decision).toBe("allow");
    expect(readAllowFromStore).toHaveBeenCalledTimes(1);
  });

  it("does not grant group access from pairing-store when explicit groupAllowFrom exists", async () => {
    const readAllowFromStore = vi.fn(async () => ["alice!ident@example.com"]);

    const resolved = await resolveIrcIngressAccess({
      accountId: "default",
      message: createMessage({ target: "#ops", isGroup: true }),
      config: { channels: { irc: {} } } as CoreConfig,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: ["owner"],
      groupAllowFrom: ["group-owner"],
      groupMatch: resolveIrcGroupMatch({ groups: { "#ops": {} }, target: "#ops" }),
      allowNameMatching: false,
      allowTextCommands: false,
      hasControlCommand: false,
      requireMention: false,
      wasMentioned: false,
      readAllowFromStore,
    });

    expect(resolved.ingress.decision).toBe("block");
    expect(readAllowFromStore).not.toHaveBeenCalled();
  });

  it("does not grant group access from pairing-store when groupAllowFrom is empty", async () => {
    const readAllowFromStore = vi.fn(async () => ["alice!ident@example.com"]);

    const resolved = await resolveIrcIngressAccess({
      accountId: "default",
      message: createMessage({ target: "#ops", isGroup: true }),
      config: { channels: { irc: {} } } as CoreConfig,
      dmPolicy: "pairing",
      groupPolicy: "allowlist",
      allowFrom: ["owner"],
      groupAllowFrom: [],
      groupMatch: resolveIrcGroupMatch({ groups: { "#ops": {} }, target: "#ops" }),
      allowNameMatching: false,
      allowTextCommands: false,
      hasControlCommand: false,
      requireMention: false,
      wasMentioned: false,
      readAllowFromStore,
    });

    expect(resolved.ingress.decision).toBe("block");
    expect(readAllowFromStore).not.toHaveBeenCalled();
  });
});

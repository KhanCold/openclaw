import { describe, expect, it, vi } from "vitest";
import {
  defineChannelIngressIdentity,
  resolveChannelMessageIngress,
  routeAllowlistFact,
  routeDisabledFact,
} from "./channel-ingress-runtime.js";

const identity = defineChannelIngressIdentity({
  primary: {
    normalize: (value) => value.trim().toLowerCase(),
    sensitivity: "pii",
  },
});

describe("plugin-sdk/channel-ingress-runtime", () => {
  it("derives DM store allowlists and command authorization", async () => {
    const sender = "Secret-Sender@example.test";
    const readStoreAllowFrom = vi.fn(async () => ["secret-sender@example.test"]);

    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity,
      subject: { stableId: sender },
      conversation: { kind: "direct", id: "dm-1" },
      event: { kind: "message", authMode: "inbound", mayPair: true },
      policy: {
        dmPolicy: "pairing",
        groupPolicy: "disabled",
      },
      allowFrom: [],
      readStoreAllowFrom,
      command: {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
    });

    expect(readStoreAllowFrom).toHaveBeenCalledOnce();
    expect(result.ingress).toMatchObject({
      admission: "dispatch",
      decision: "allow",
    });
    expect(result.senderAccess.effectiveAllowFrom).toEqual(["secret-sender@example.test"]);
    expect(result.commandAccess.authorized).toBe(true);
    expect(JSON.stringify(result.state)).not.toContain(sender);
    expect(JSON.stringify(result.ingress)).not.toContain(sender);
  });

  it("derives group fallback allowlists without reading the DM store", async () => {
    const readStoreAllowFrom = vi.fn(async () => ["owner"]);

    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity,
      subject: { stableId: "owner" },
      conversation: { kind: "group", id: "room-1" },
      event: { kind: "message", authMode: "inbound", mayPair: false },
      policy: {
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        groupAllowFromFallbackToAllowFrom: true,
      },
      allowFrom: ["owner"],
      groupAllowFrom: [],
      readStoreAllowFrom,
      command: {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
    });

    expect(readStoreAllowFrom).not.toHaveBeenCalled();
    expect(result.ingress).toMatchObject({
      admission: "dispatch",
      decision: "allow",
    });
    expect(result.senderAccess.effectiveGroupAllowFrom).toEqual(["owner"]);
    expect(result.commandAccess.authorized).toBe(true);
  });

  it("fails command authorization closed when a route gate stops before command gates run", async () => {
    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity,
      subject: { stableId: "owner" },
      conversation: { kind: "direct", id: "dm-1" },
      event: { kind: "message", authMode: "inbound", mayPair: true },
      policy: {
        dmPolicy: "allowlist",
        groupPolicy: "disabled",
      },
      allowFrom: ["owner"],
      routeFacts: [routeDisabledFact({ id: "route:disabled" })],
      command: {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
      },
    });

    expect(result.ingress).toMatchObject({
      admission: "drop",
      decision: "block",
      reasonCode: "route_blocked",
    });
    expect(result.commandAccess.authorized).toBe(false);
    expect(result.commandAccess.shouldBlockControlCommand).toBe(false);
  });

  it("can fallback command group allowlists without changing sender group fallback", async () => {
    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity,
      subject: { stableId: "owner" },
      conversation: { kind: "group", id: "room-1" },
      event: { kind: "message", authMode: "inbound", mayPair: false },
      policy: {
        dmPolicy: "pairing",
        groupPolicy: "open",
        groupAllowFromFallbackToAllowFrom: false,
      },
      allowFrom: ["owner"],
      groupAllowFrom: [],
      command: {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
        groupOwnerAllowFrom: "none",
        commandGroupAllowFromFallbackToAllowFrom: true,
      },
    });

    expect(result.senderAccess.effectiveGroupAllowFrom).toEqual([]);
    expect(result.commandAccess.authorized).toBe(true);
  });

  it("keeps sender access separate from later command blocks", async () => {
    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity,
      subject: { stableId: "owner" },
      conversation: { kind: "group", id: "room-1" },
      event: { kind: "message", authMode: "inbound", mayPair: false },
      policy: {
        dmPolicy: "pairing",
        groupPolicy: "open",
        groupAllowFromFallbackToAllowFrom: false,
      },
      allowFrom: ["owner"],
      groupAllowFrom: [],
      command: {
        useAccessGroups: true,
        allowTextCommands: true,
        hasControlCommand: true,
        groupOwnerAllowFrom: "none",
        commandGroupAllowFromFallbackToAllowFrom: false,
      },
    });

    expect(result.ingress).toMatchObject({
      admission: "drop",
      decision: "block",
      reasonCode: "control_command_unauthorized",
    });
    expect(result.senderAccess).toMatchObject({
      decision: "allow",
      reasonCode: "group_policy_allowed",
    });
    expect(result.commandAccess.authorized).toBe(false);
    expect(result.commandAccess.shouldBlockControlCommand).toBe(true);
  });

  it("can keep a direct sender gate open while command auth uses owner allowlists", async () => {
    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity,
      subject: { stableId: "guest" },
      conversation: { kind: "direct", id: "dm-1" },
      event: { kind: "button", authMode: "inbound", mayPair: false },
      policy: {
        dmPolicy: "open",
        groupPolicy: "disabled",
      },
      allowFrom: ["*"],
      command: {
        useAccessGroups: true,
        allowTextCommands: false,
        hasControlCommand: true,
        commandOwnerAllowFrom: ["owner"],
      },
    });

    expect(result.ingress).toMatchObject({
      admission: "dispatch",
      decision: "allow",
    });
    expect(result.senderAccess.reasonCode).toBe("dm_policy_open");
    expect(result.commandAccess.authorized).toBe(false);
    expect(result.commandAccess.shouldBlockControlCommand).toBe(false);
  });

  it("does not rematch normalized compatibility entries as different identifier kinds", async () => {
    const prefixedIdentity = defineChannelIngressIdentity({
      primary: {
        key: "user-id",
        normalizeEntry(value) {
          const normalized = value.trim().toLowerCase();
          return normalized.startsWith("users/") ? normalized.replace(/^users\//, "") : normalized;
        },
        normalizeSubject(value) {
          return value
            .trim()
            .toLowerCase()
            .replace(/^users\//, "");
        },
      },
      aliases: [
        {
          key: "email",
          kind: "plugin:test-email",
          normalizeEntry(value) {
            const normalized = value.trim().toLowerCase();
            return normalized.startsWith("users/") || !normalized.includes("@") ? null : normalized;
          },
          normalizeSubject(value) {
            return value.trim().toLowerCase();
          },
          dangerous: true,
        },
      ],
    });

    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity: prefixedIdentity,
      subject: {
        stableId: "users/123",
        aliases: { email: "jane@example.test" },
      },
      conversation: { kind: "direct", id: "dm-1" },
      event: { kind: "message", authMode: "inbound", mayPair: false },
      policy: {
        dmPolicy: "allowlist",
        groupPolicy: "disabled",
        mutableIdentifierMatching: "enabled",
      },
      allowFrom: ["users/jane@example.test"],
    });

    expect(result.senderAccess.effectiveAllowFrom).toEqual(["jane@example.test"]);
    expect(result.senderAccess.decision).toBe("block");
  });

  it("derives matched access-group effective entries without caller expansion", async () => {
    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity,
      subject: { stableId: "operator@example.test" },
      conversation: { kind: "group", id: "room-1" },
      event: { kind: "message", authMode: "inbound", mayPair: false },
      accessGroups: {
        operators: {
          type: "message.senders",
          members: {
            "runtime-test": ["operator@example.test"],
          },
        },
      },
      policy: {
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
      },
      groupAllowFrom: ["accessGroup:operators"],
      command: {
        useAccessGroups: true,
        allowTextCommands: false,
        hasControlCommand: true,
      },
    });

    expect(result.ingress.decision).toBe("allow");
    expect(result.commandAccess.authorized).toBe(true);
    expect(result.senderAccess.effectiveGroupAllowFrom).toEqual([
      "accessGroup:operators",
      "operator@example.test",
    ]);
  });

  it("resolves dynamic access-group memberships inside the runtime resolver", async () => {
    const resolveAccessGroupMembership = vi.fn(async () => true);

    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity,
      subject: { stableId: "operator@example.test" },
      conversation: { kind: "group", id: "room-1" },
      event: { kind: "message", authMode: "inbound", mayPair: false },
      accessGroups: {
        roomAudience: {
          type: "discord.channelAudience",
          guildId: "guild-1",
          channelId: "channel-1",
        },
      },
      policy: {
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
      },
      groupAllowFrom: ["accessGroup:roomAudience"],
      resolveAccessGroupMembership,
    });

    expect(resolveAccessGroupMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "roomAudience",
        channelId: "runtime-test",
        accountId: "default",
      }),
    );
    expect(result.ingress.decision).toBe("allow");
    expect(result.senderAccess.effectiveGroupAllowFrom).toEqual([
      "accessGroup:roomAudience",
      "operator@example.test",
    ]);
  });

  it("fills route sender allowlists from effective group sources", async () => {
    const result = await resolveChannelMessageIngress({
      channelId: "runtime-test",
      accountId: "default",
      identity,
      subject: { stableId: "owner" },
      conversation: { kind: "group", id: "room-1" },
      event: { kind: "message", authMode: "inbound", mayPair: false },
      policy: {
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
        groupAllowFromFallbackToAllowFrom: true,
      },
      allowFrom: ["owner"],
      routeFacts: [
        routeAllowlistFact({
          id: "route:room",
          matched: true,
          senderPolicy: "deny-when-empty",
          senderAllowFromSource: "effective-group",
        }),
      ],
    });

    expect(result.ingress).toMatchObject({
      admission: "dispatch",
      decision: "allow",
    });
    expect(result.state.routeFacts[0]?.senderAllowlist).toMatchObject({
      hasConfiguredEntries: true,
      match: { matched: true },
    });
  });
});

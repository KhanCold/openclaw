import { describe, expect, it } from "vitest";
import { resolveGoogleChatIngressAccess } from "./monitor-ingress.js";

describe("googlechat ingress access", () => {
  it.each([
    {
      name: "blocks raw email entries when dangerous name matching is disabled",
      allowNameMatching: false,
      allowFrom: ["jane@example.com"],
      decision: "block",
    },
    {
      name: "matches raw email entries when dangerous name matching is enabled",
      allowNameMatching: true,
      allowFrom: ["jane@example.com"],
      decision: "allow",
    },
    {
      name: "does not treat users/<email> entries as email allowlist entries",
      allowNameMatching: true,
      allowFrom: ["users/jane@example.com"],
      decision: "block",
    },
    {
      name: "matches user id entries",
      allowNameMatching: false,
      allowFrom: ["users/abc"],
      senderId: "users/abc",
      decision: "allow",
    },
  ])("$name", async ({ allowNameMatching, allowFrom, senderId = "users/123", decision }) => {
    const result = await resolveGoogleChatIngressAccess({
      accountId: "default",
      isGroup: false,
      spaceId: "spaces/AAA",
      senderId,
      senderEmail: "Jane@Example.com",
      allowNameMatching,
      dmPolicy: "allowlist",
      groupPolicy: "disabled",
      routeAllowlistConfigured: false,
      routeMatched: false,
      routeEnabled: true,
      allowFrom,
      groupAllowFrom: [],
    });

    expect(result.senderAccess.decision).toBe(decision);
  });

  it("does not fall back routed group sender allowlists to DM allowFrom", async () => {
    const result = await resolveGoogleChatIngressAccess({
      accountId: "default",
      isGroup: true,
      spaceId: "spaces/AAA",
      senderId: "users/alice",
      senderEmail: "alice@example.com",
      allowNameMatching: false,
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      routeAllowlistConfigured: true,
      routeMatched: true,
      routeEnabled: true,
      allowFrom: ["users/alice"],
      groupAllowFrom: [],
    });

    expect(result.ingress).toMatchObject({
      admission: "drop",
      decision: "block",
      reasonCode: "route_sender_empty",
    });
    expect(result.senderAccess).toMatchObject({
      decision: "block",
      reasonCode: "group_policy_empty_allowlist",
    });
  });
});

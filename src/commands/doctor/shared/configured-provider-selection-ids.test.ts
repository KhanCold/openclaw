// Tests for configured provider selection id collection.
import { describe, expect, it } from "vitest";
import {
  collectConfiguredMediaProviderSelectionIds,
  collectConfiguredModelProviderSelectionIds,
  collectConfiguredProviderSelectionIds,
} from "./configured-provider-selection-ids.js";

describe("collectConfiguredProviderSelectionIds", () => {
  it("returns empty set for empty config", () => {
    const result = collectConfiguredProviderSelectionIds({});
    expect(result.size).toBe(0);
  });

  it("collects provider ids from auth profiles", () => {
    const result = collectConfiguredProviderSelectionIds({
      auth: {
        profiles: {
          main: { provider: "openai" },
          alt: { provider: "anthropic" },
        },
      },
    });
    expect([...result]).toContain("openai");
    expect([...result]).toContain("anthropic");
  });

  it("collects provider ids from models.providers", () => {
    const result = collectConfiguredProviderSelectionIds({
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com" },
          google: { baseUrl: "https://generativelanguage.googleapis.com" },
        },
      },
    });
    expect([...result]).toContain("openai");
    expect([...result]).toContain("google");
  });

  it("collects provider ids from channels.modelByChannel", () => {
    const result = collectConfiguredProviderSelectionIds({
      channels: {
        modelByChannel: {
          openai: {
            telegram: "openai/gpt-4",
            discord: "openai/gpt-3.5",
          },
        },
      },
    });
    expect([...result]).toContain("openai");
  });

  it("extracts provider prefix from model refs", () => {
    const result = collectConfiguredProviderSelectionIds({
      channels: {
        modelByChannel: {
          anthropic: {
            telegram: "anthropic/claude-3",
          },
        },
      },
    });
    expect([...result]).toContain("anthropic");
  });

  it("collects provider ids from non-channel configured model refs", () => {
    const result = collectConfiguredProviderSelectionIds({
      agents: {
        defaults: {
          model: "anthropic/claude-3",
        },
      },
    });
    expect([...result]).toContain("anthropic");
  });

  it("collects media provider ids", () => {
    const result = collectConfiguredProviderSelectionIds({
      tools: {
        media: {
          models: [{ provider: "elevenlabs" }],
        },
      },
    });
    expect([...result]).toContain("elevenlabs");
  });

  it("normalizes provider ids to lowercase", () => {
    const result = collectConfiguredProviderSelectionIds({
      auth: {
        profiles: {
          main: { provider: "OpenAI" },
        },
      },
    });
    expect([...result]).toContain("openai");
  });

  it("deduplicates provider ids", () => {
    const result = collectConfiguredProviderSelectionIds({
      auth: {
        profiles: {
          main: { provider: "openai" },
        },
      },
      models: {
        providers: {
          openai: { baseUrl: "https://api.openai.com" },
        },
      },
    });
    const ids = [...result];
    expect(ids.filter((id) => id === "openai")).toHaveLength(1);
  });

  it("skips empty provider ids", () => {
    const result = collectConfiguredProviderSelectionIds({
      auth: {
        profiles: {
          main: { provider: "" },
          alt: { provider: null },
        },
      },
    });
    expect(result.size).toBe(0);
  });

  it("handles model ref without slash", () => {
    const result = collectConfiguredProviderSelectionIds({
      channels: {
        modelByChannel: {
          openai: {
            telegram: "gpt-4-no-slash",
          },
        },
      },
    });
    // Channel key "openai" is collected directly; model ref without slash does not add extra prefix
    const ids = [...result];
    expect(ids).toContain("openai");
  });
});

describe("collectConfiguredModelProviderSelectionIds", () => {
  it("returns only model-related provider ids", () => {
    const result = collectConfiguredModelProviderSelectionIds({
      auth: {
        profiles: {
          main: { provider: "openai" },
        },
      },
      tools: {
        media: {
          models: [{ provider: "elevenlabs" }],
        },
      },
    });
    expect([...result]).toContain("openai");
    expect([...result]).not.toContain("elevenlabs");
  });
});

describe("collectConfiguredMediaProviderSelectionIds", () => {
  it("returns only media provider ids", () => {
    const result = collectConfiguredMediaProviderSelectionIds({
      auth: {
        profiles: {
          main: { provider: "openai" },
        },
      },
      tools: {
        media: {
          models: [{ provider: "elevenlabs" }],
        },
      },
    });
    expect([...result]).toContain("elevenlabs");
    expect([...result]).not.toContain("openai");
  });

  it("returns empty set when no media config", () => {
    const result = collectConfiguredMediaProviderSelectionIds({});
    expect(result.size).toBe(0);
  });

  it("handles media models without provider", () => {
    const result = collectConfiguredMediaProviderSelectionIds({
      tools: {
        media: {
          models: [{ notProvider: "value" }],
        },
      },
    });
    expect(result.size).toBe(0);
  });
});

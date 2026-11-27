import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDER_PRESENTATION,
  boundUsageProviders,
  providersWithUsage,
  rankProvidersByTokens,
} from "./usageProviders";

describe("PROVIDER_PRESENTATION", () => {
  it("includes Factory Droid with its brand color and ACP registry identity", () => {
    expect(PROVIDER_PRESENTATION.droid).toEqual({
      label: "Factory Droid",
      color: "#ee6018",
      driverKind: ProviderDriverKind.make("acpRegistry"),
      acpRegistryAgentId: "factory-droid",
    });
  });
});

describe("providersWithUsage", () => {
  it("keeps only providers with positive token usage in presentation order", () => {
    const totals = [
      { provider: "droid" as const, totalTokens: 500 },
      { provider: "codex" as const, totalTokens: 0 },
      { provider: "claude" as const, totalTokens: 1_200 },
    ];

    expect(providersWithUsage(totals)).toEqual(["claude", "droid"]);
  });
});

describe("rankProvidersByTokens", () => {
  it("ranks by totalTokens highest first and preserves input order on ties", () => {
    const totals = [
      { provider: "codex" as const, totalTokens: 10 },
      { provider: "claude" as const, totalTokens: 10 },
      { provider: "grok" as const, totalTokens: 20 },
    ];
    const providers = ["claude", "codex", "grok"] as const;

    expect(rankProvidersByTokens(providers, totals)).toEqual(["grok", "claude", "codex"]);
    expect(providers).toEqual(["claude", "codex", "grok"]);
  });
});

describe("boundUsageProviders", () => {
  it("derives enabled bound providers including registry and local ACP agents", () => {
    const bound = boundUsageProviders([
      {
        providers: [
          {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
          },
          {
            driver: ProviderDriverKind.make("cursor"),
            enabled: false,
          },
          {
            driver: ProviderDriverKind.make("acpRegistry"),
            enabled: true,
            usageLimits: {
              checkedAt: "2026-11-27T00:00:00.000Z",
              group: { id: "acpRegistry:factory-droid", label: "Factory Droid" },
              windows: [],
            },
          },
        ],
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
            [ProviderInstanceId.make("claude-disabled")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: false,
              config: {},
            },
            [ProviderInstanceId.make("acp-dsh")]: {
              driver: ProviderDriverKind.make("acpRegistry"),
              enabled: true,
              config: { source: "registry", agentId: "deepseek-harness" },
            },
            [ProviderInstanceId.make("acp-droid-local")]: {
              driver: ProviderDriverKind.make("acpRegistry"),
              enabled: true,
              config: { source: "local", commandPath: "/usr/local/bin/droid" },
            },
            [ProviderInstanceId.make("acp-droid-disabled")]: {
              driver: ProviderDriverKind.make("acpRegistry"),
              enabled: false,
              config: { source: "registry", agentId: "factory-droid" },
            },
          },
        },
      },
    ]);

    expect(bound).toEqual(["codex", "dsh", "droid"]);
  });
});

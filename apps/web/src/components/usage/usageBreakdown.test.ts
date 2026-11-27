import type { MergedUsage, ModelTotals, ProviderTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  cacheHitRate,
  focusMergedUsage,
  groupModelsByProvider,
  normalizeUsageModelName,
  tokensCacheHitRate,
} from "./usageBreakdown";

const makeModel = (
  name: string,
  totalTokens: number,
  overrides: Partial<ModelTotals> = {},
): ModelTotals => ({
  model: name,
  provider: "claude",
  costUsd: 0,
  totalTokens,
  tokens: {
    uncachedInputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 0,
  tokenShare: 0,
  ...overrides,
});

describe("cache hit rate", () => {
  it("counts cache writes as misses and computes overall token cache hit rate", () => {
    const mixed = makeModel("mixed", 4_000_000, {
      tokens: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationTokens: 2_000_000,
        outputTokens: 500_000,
        reasoningTokens: 0,
      },
    });

    expect(cacheHitRate(mixed)).toBe(0.25);
    expect(
      tokensCacheHitRate({
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toBeNull();
  });
});

describe("normalizeUsageModelName", () => {
  it("strips custom:, common relay prefixes, and context window suffixes", () => {
    expect(normalizeUsageModelName("custom:gpt-5.4")).toBe("gpt-5.4");
    expect(normalizeUsageModelName("magpie/apigoto/deepseek-flash")).toBe("deepseek-flash");
    expect(normalizeUsageModelName("custom:qwen-token-plan/qwen3-coder-plus@256k")).toBe(
      "qwen3-coder-plus",
    );
    expect(normalizeUsageModelName("wokey/claude-sonnet-4-6@300k")).toBe("claude-sonnet-4-6");
    expect(normalizeUsageModelName("supergpt/claude-opus-4-6@500k")).toBe("claude-opus-4-6");
    expect(normalizeUsageModelName("daitu/gemini-2.5-pro")).toBe("gemini-2.5-pro");
    expect(normalizeUsageModelName("workbuddy/glm-4.7")).toBe("glm-4.7");
    expect(normalizeUsageModelName("opendesign/claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(normalizeUsageModelName("oc/kimi-k2")).toBe("kimi-k2");
    expect(normalizeUsageModelName("xcli/claude-opus-4")).toBe("claude-opus-4");
    expect(normalizeUsageModelName("openai/gpt-5.4")).toBe("openai/gpt-5.4");
  });
});

describe("groupModelsByProvider", () => {
  const providerTotals: readonly ProviderTotals[] = [
    {
      provider: "droid",
      costUsd: 0,
      totalTokens: 1_500,
      records: 3,
      sessions: 2,
      costShare: 0,
      tokenShare: 0.75,
    },
    {
      provider: "codex",
      costUsd: 0,
      totalTokens: 500,
      records: 1,
      sessions: 1,
      costShare: 0,
      tokenShare: 0.25,
    },
  ];

  const models: readonly ModelTotals[] = [
    makeModel("custom:magpie/claude-sonnet-4-6@256k", 600, {
      provider: "droid",
      tokenShare: 0.3,
      tokens: {
        uncachedInputTokens: 200,
        cachedInputTokens: 300,
        cacheCreationTokens: 0,
        outputTokens: 100,
        reasoningTokens: 0,
      },
    }),
    makeModel("apigoto/claude-sonnet-4-6", 400, {
      provider: "droid",
      tokenShare: 0.2,
      tokens: {
        uncachedInputTokens: 100,
        cachedInputTokens: 200,
        cacheCreationTokens: 0,
        outputTokens: 100,
        reasoningTokens: 0,
      },
    }),
    makeModel("gpt-5.4", 500, {
      provider: "droid",
      tokenShare: 0.25,
      tokens: {
        uncachedInputTokens: 400,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 100,
        reasoningTokens: 0,
      },
    }),
    makeModel("gpt-5.4", 500, {
      provider: "codex",
      tokenShare: 0.25,
      tokens: {
        uncachedInputTokens: 250,
        cachedInputTokens: 250,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
    }),
  ];

  it("merges route-prefixed models within each provider without merging across providers", () => {
    const groups = groupModelsByProvider({
      providers: ["droid", "codex"],
      providerTotals,
      models,
      totalTokens: 2_000,
      mergeRoutes: true,
    });

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      provider: "droid",
      totalTokens: 1_500,
      tokenShare: 0.75,
      peakTokens: 1_000,
    });
    expect(groups[0]?.cacheHitRate).toBeCloseTo(500 / 1_200);
    expect(groups[0]?.models.map((entry) => [entry.displayName, entry.totalTokens])).toEqual([
      ["claude-sonnet-4-6", 1_000],
      ["gpt-5.4", 500],
    ]);
    expect(groups[0]?.models[0]?.rawModels).toEqual([
      "custom:magpie/claude-sonnet-4-6@256k",
      "apigoto/claude-sonnet-4-6",
    ]);
    expect(groups[0]?.models[0]?.cacheHitRate).toBeCloseTo(500 / 800);
    expect(groups[1]?.models[0]).toMatchObject({
      provider: "codex",
      displayName: "gpt-5.4",
      totalTokens: 500,
    });
  });

  it("keeps raw model names separate when mergeRoutes is false and filters by search query", () => {
    const unmerged = groupModelsByProvider({
      providers: ["droid", "codex"],
      providerTotals,
      models,
      totalTokens: 2_000,
      mergeRoutes: false,
    });
    expect(unmerged[0]?.models.map((entry) => entry.displayName)).toEqual([
      "custom:magpie/claude-sonnet-4-6@256k",
      "gpt-5.4",
      "apigoto/claude-sonnet-4-6",
    ]);

    const filtered = groupModelsByProvider({
      providers: ["droid", "codex"],
      providerTotals,
      models,
      totalTokens: 2_000,
      mergeRoutes: true,
      searchQuery: "apigoto",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.provider).toBe("droid");
    expect(filtered[0]?.models.map((entry) => entry.displayName)).toEqual(["claude-sonnet-4-6"]);
  });

  it("focuses merged usage onto a single provider with accurate sessions and token shares", () => {
    const merged: MergedUsage = {
      costUsd: 0,
      totalTokens: 2_000,
      uncachedInputTokens: 950,
      cachedInputTokens: 750,
      cacheCreationTokens: 0,
      outputTokens: 300,
      reasoningTokens: 0,
      records: 4,
      sessions: 3,
      providers: providerTotals,
      models,
      daily: [
        {
          day: "2026-11-27",
          costUsd: 0,
          totalTokens: 2_000,
          byProvider: new Map([
            ["droid", { costUsd: 0, totalTokens: 1_500 }],
            ["codex", { costUsd: 0, totalTokens: 500 }],
          ]),
        },
      ],
      hourly: [],
      categoryCost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, unsplit: 0 },
      speedCost: { standard: 0, fast: 0, ultrafast: 0, premium: 0 },
      costQuality: {
        providerReportedShare: 0,
        modelPricedShare: 0,
        unpricedShare: 1,
        cacheSavingsUsd: 0,
      },
      duplicateSources: [],
      contributingEnvironments: [],
      contractMismatches: [],
    };

    const focused = focusMergedUsage(merged, "droid");
    expect(focused.totalTokens).toBe(1_500);
    expect(focused.sessions).toBe(2);
    expect(focused.uncachedInputTokens).toBe(700);
    expect(focused.cachedInputTokens).toBe(500);
    expect(focused.outputTokens).toBe(300);
    expect(focused.models).toHaveLength(3);
    expect(focused.models[0]?.tokenShare).toBeCloseTo(600 / 1_500);
    expect(focused.daily[0]?.totalTokens).toBe(1_500);
    expect(focused.daily[0]?.byProvider.size).toBe(1);
  });
});

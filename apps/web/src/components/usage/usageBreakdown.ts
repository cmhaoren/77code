import type { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";
import type {
  DailyTotals,
  HourlyTotals,
  MergedUsage,
  ModelTotals,
  ProviderTotals,
} from "@t3tools/shared/usageMerge";

import { msg } from "gt-react";

import type { ShareSegment } from "./UsageShareBar";

const ROUTE_PREFIX_PATTERN =
  /^(?:custom:|(?:magpie|magpie-anthropic|magpie-openai|apigoto|apigoto-1|apigoto-2|qwen-token-plan|wokey|wokeygpt|supergpt|supergpt-2|super5|super5\.5|daitu|daitu-gpt|workbuddy|opendesign|opencode-go|oc|xcli|xcli-gemini|factory|factory-a|factory-g|factory-o|claudezz|kimicode|qoder-cn|cursor|new-provider-1|codex)\/)+/i;
const CONTEXT_SUFFIX_PATTERN = /@\d+k$/i;

/** Strip `custom:`, relay routing prefixes, and trailing `@256k`-style context tags. */
export function normalizeUsageModelName(rawModel: string): string {
  const trimmed = rawModel.trim();
  if (trimmed.length === 0) return trimmed;
  let current = trimmed;
  for (;;) {
    const next = current
      .replace(ROUTE_PREFIX_PATTERN, "")
      .replace(CONTEXT_SUFFIX_PATTERN, "")
      .trim();
    if (next === current || next.length === 0) break;
    current = next;
  }
  return current.length > 0 ? current : trimmed;
}

/** Returns null without input; cache writes count as misses because input was fully processed. */
export function tokensCacheHitRate(
  tokens: Pick<
    UsageTokenTotals,
    "uncachedInputTokens" | "cachedInputTokens" | "cacheCreationTokens"
  >,
): number | null {
  const input = tokens.uncachedInputTokens + tokens.cachedInputTokens + tokens.cacheCreationTokens;
  return input === 0 ? null : tokens.cachedInputTokens / input;
}

export function cacheHitRate({ tokens }: Pick<ModelTotals, "tokens">): number | null {
  return tokensCacheHitRate(tokens);
}

export interface GroupedUsageModel {
  readonly key: string;
  readonly displayName: string;
  readonly rawModels: readonly string[];
  readonly provider: UsageProviderKind;
  readonly totalTokens: number;
  readonly tokens: UsageTokenTotals;
  readonly records: number;
  readonly tokenShare: number;
  readonly cacheHitRate: number | null;
}

export interface ProviderModelGroup {
  readonly provider: UsageProviderKind;
  readonly totalTokens: number;
  readonly tokenShare: number;
  readonly cacheHitRate: number | null;
  readonly peakTokens: number;
  readonly models: readonly GroupedUsageModel[];
}

function addTokens(left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

const EMPTY_TOKENS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export function groupModelsByProvider(input: {
  readonly providers: readonly UsageProviderKind[];
  readonly providerTotals: readonly ProviderTotals[];
  readonly models: readonly ModelTotals[];
  readonly totalTokens: number;
  readonly mergeRoutes: boolean;
  readonly searchQuery?: string;
  readonly providerLabel?: (provider: UsageProviderKind) => string;
}): readonly ProviderModelGroup[] {
  const query = input.searchQuery?.trim().toLowerCase() ?? "";
  const modelsByProvider = new Map<UsageProviderKind, ModelTotals[]>();
  for (const model of input.models) {
    const list = modelsByProvider.get(model.provider);
    if (list) list.push(model);
    else modelsByProvider.set(model.provider, [model]);
  }

  const groups: ProviderModelGroup[] = [];
  for (const provider of input.providers) {
    const providerModels = (modelsByProvider.get(provider) ?? []).toSorted(
      (left, right) =>
        right.totalTokens - left.totalTokens || left.model.localeCompare(right.model),
    );
    const providerTotals = input.providerTotals.find((entry) => entry.provider === provider);
    const providerTokens = providerModels.reduce(
      (acc, entry) => addTokens(acc, entry.tokens),
      EMPTY_TOKENS,
    );

    const groupedMap = new Map<
      string,
      {
        displayName: string;
        rawModels: string[];
        totalTokens: number;
        tokens: UsageTokenTotals;
        records: number;
      }
    >();
    for (const model of providerModels) {
      const displayName = input.mergeRoutes ? normalizeUsageModelName(model.model) : model.model;
      const existing = groupedMap.get(displayName);
      if (existing) {
        if (!existing.rawModels.includes(model.model)) existing.rawModels.push(model.model);
        existing.totalTokens += model.totalTokens;
        existing.tokens = addTokens(existing.tokens, model.tokens);
        existing.records += model.records;
      } else {
        groupedMap.set(displayName, {
          displayName,
          rawModels: [model.model],
          totalTokens: model.totalTokens,
          tokens: model.tokens,
          records: model.records,
        });
      }
    }

    const allGroupedModels: GroupedUsageModel[] = [...groupedMap.values()]
      .toSorted(
        (left, right) =>
          right.totalTokens - left.totalTokens || left.displayName.localeCompare(right.displayName),
      )
      .map((entry) => ({
        key: `${provider}:${entry.displayName}`,
        displayName: entry.displayName,
        rawModels: entry.rawModels,
        provider,
        totalTokens: entry.totalTokens,
        tokens: entry.tokens,
        records: entry.records,
        tokenShare: input.totalTokens === 0 ? 0 : entry.totalTokens / input.totalTokens,
        cacheHitRate: tokensCacheHitRate(entry.tokens),
      }));

    const providerLabelText =
      input.providerLabel?.(provider).toLowerCase() ?? provider.toLowerCase();
    const visibleModels =
      query.length === 0
        ? allGroupedModels
        : allGroupedModels.filter(
            (entry) =>
              providerLabelText.includes(query) ||
              entry.displayName.toLowerCase().includes(query) ||
              entry.rawModels.some((raw) => raw.toLowerCase().includes(query)),
          );

    if (query.length > 0 && visibleModels.length === 0) continue;

    const groupTotalTokens =
      providerTotals?.totalTokens ??
      allGroupedModels.reduce((sum, entry) => sum + entry.totalTokens, 0);
    groups.push({
      provider,
      totalTokens: groupTotalTokens,
      tokenShare:
        providerTotals?.tokenShare ??
        (input.totalTokens === 0 ? 0 : groupTotalTokens / input.totalTokens),
      cacheHitRate: tokensCacheHitRate(providerTokens),
      peakTokens: visibleModels.reduce((peak, entry) => Math.max(peak, entry.totalTokens), 0),
      models: visibleModels,
    });
  }

  return groups;
}

export function focusMergedUsage(merged: MergedUsage, provider: UsageProviderKind): MergedUsage {
  const providerTotals = merged.providers.find((entry) => entry.provider === provider);
  const providerModels = merged.models.filter((model) => model.provider === provider);
  const tokens = providerModels.reduce((acc, entry) => addTokens(acc, entry.tokens), EMPTY_TOKENS);
  const totalTokens =
    providerTotals?.totalTokens ??
    providerModels.reduce((sum, model) => sum + model.totalTokens, 0);
  const costUsd = providerTotals?.costUsd ?? 0;
  const focusPeriod = <T extends DailyTotals | HourlyTotals>(period: T): T => {
    const entry = period.byProvider.get(provider);
    const byProvider = new Map(entry === undefined ? [] : [[provider, entry] as const]);
    return {
      ...period,
      costUsd: entry?.costUsd ?? 0,
      totalTokens: entry?.totalTokens ?? 0,
      byProvider,
    };
  };

  return {
    ...merged,
    costUsd,
    totalTokens,
    uncachedInputTokens: tokens.uncachedInputTokens,
    cachedInputTokens: tokens.cachedInputTokens,
    cacheCreationTokens: tokens.cacheCreationTokens,
    outputTokens: tokens.outputTokens,
    reasoningTokens: tokens.reasoningTokens,
    sessions: providerTotals?.sessions ?? 0,
    providers: providerTotals
      ? [
          {
            ...providerTotals,
            costShare: costUsd > 0 ? 1 : 0,
            tokenShare: totalTokens > 0 ? 1 : 0,
          },
        ]
      : [],
    models: providerModels.map((model) => ({
      ...model,
      tokenShare: totalTokens === 0 ? 0 : model.totalTokens / totalTokens,
      costShare: costUsd === 0 ? 0 : model.costUsd / costUsd,
    })),
    daily: merged.daily.map(focusPeriod),
    hourly: merged.hourly.map(focusPeriod),
  };
}

const ink = (percent: number) =>
  `color-mix(in oklab, var(--foreground) ${percent}%, var(--background))`;

const TYPE_COLORS = {
  input: ink(60),
  cacheRead: ink(30),
  cacheWrite: ink(72),
  output: ink(100),
};

export function tokenTypeSegments(
  tokens: Omit<UsageTokenTotals, "reasoningTokens">,
): readonly ShareSegment[] {
  return [
    { label: msg("Input"), value: tokens.uncachedInputTokens, color: TYPE_COLORS.input },
    { label: msg("Cache read"), value: tokens.cachedInputTokens, color: TYPE_COLORS.cacheRead },
    { label: msg("Cache write"), value: tokens.cacheCreationTokens, color: TYPE_COLORS.cacheWrite },
    { label: msg("Output"), value: tokens.outputTokens, color: TYPE_COLORS.output },
  ];
}

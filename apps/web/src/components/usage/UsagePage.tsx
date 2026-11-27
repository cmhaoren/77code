import { ChatGptUsageButton } from "../settings/ChatGptUsageButton";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  USAGE_CONTRACT_VERSION,
  type EnvironmentId,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  LayersIcon,
  SearchIcon,
} from "lucide-react";
import { T, useGT, useLocale, useMessages } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";
import {
  updatingProvidersLabel,
  usageEnvironmentProgress,
  usageLoadingState,
} from "@t3tools/client-runtime/state/usage-progress";

import {
  isCompatibleUsageContractVersion,
  type DailyTotals,
  type HourlyTotals,
  type MergedUsage,
} from "@t3tools/shared/usageMerge";

import { cn } from "../../lib/utils";
import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveHour12 } from "../../timestampFormat";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { shortcutLabelForCommand } from "../../keybindings";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  enumerateDays,
  enumerateHourStarts,
  formatCount,
  formatDateTimeShort,
  formatDayShort,
  formatHourShort,
  formatPercent,
  formatTokens,
  makeCalendarWindow,
  type UsageCalendarPeriod,
} from "@t3tools/shared/usageFormat";
import { formatUsageContractMismatch, usageSourceMessages } from "@t3tools/shared/usageFormatCopy";
import { Button, InlineButton } from "../ui/button";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { UsageLimitsSection } from "./UsageLimits";
import { UsageProviderChart } from "./UsageProviderChart";
import { UsageModelDialog, type UsageDialogModel } from "./UsageModelDialog";
import { UsageShareBar } from "./UsageShareBar";
import {
  focusMergedUsage,
  groupModelsByProvider,
  tokensCacheHitRate,
  tokenTypeSegments,
  type GroupedUsageModel,
} from "./usageBreakdown";
import {
  METRIC_OPTIONS,
  WINDOW_OPTIONS,
  resolveUsageShortcut,
  type UsageMetric,
} from "./usageShortcuts";
import {
  PROVIDER_ORDER,
  PROVIDER_PRESENTATION,
  boundUsageProviders,
  providersWithUsage,
  rankProvidersByTokens,
} from "./usageProviders";
import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
  type UsagePagePreferences,
} from "./usagePagePreferences";

function isUsageMetric(value: string | null | undefined): value is UsageMetric {
  return METRIC_OPTIONS.some((option) => option.value === value);
}

function isUsageCalendarPeriod(value: string | null | undefined): value is UsageCalendarPeriod {
  return WINDOW_OPTIONS.some((option) => option.period === value);
}

function makeUsageWindow(period: UsageCalendarPeriod): UsageSummaryInput {
  return {
    ...makeCalendarWindow(period),
    boundProvidersOnly: true,
  };
}

const providerLabel = (provider: UsageProviderKind) => PROVIDER_PRESENTATION[provider].label;

function usageLoading(
  showingKept: boolean,
  selectedEnvironments: Parameters<typeof usageLoadingState>[0],
  refreshingUsage: boolean,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
) {
  if (showingKept) {
    return { partial: true, everyProvider: true, providers: new Set<UsageProviderKind>() };
  }
  const state = usageLoadingState(selectedEnvironments, refreshingUsage);
  const providers = new Set([...state.providers].filter((p) => !hiddenProviders.has(p)));
  return {
    partial: state.everyProvider || providers.size > 0,
    everyProvider: state.everyProvider,
    providers,
  };
}

interface SelectedUsageModel {
  readonly key: string;
  readonly model: UsageDialogModel;
}

/** Keep dialog selection outside UsagePage so opening/closing rerenders only its host. */
const selectedUsageModelAtom = Atom.make<SelectedUsageModel | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("usage:selected-model"),
);

function selectUsageModel(selection: SelectedUsageModel | null): void {
  appAtomRegistry.set(selectedUsageModelAtom, selection);
}

function UsageModelDialogHost({
  ...dialogProps
}: Omit<Parameters<typeof UsageModelDialog>[0], "model" | "onClose">) {
  const selection = useAtomValue(selectedUsageModelAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the shared selected-model atom on unmount
  useEffect(() => () => selectUsageModel(null), []);
  if (selection === null) return null;
  return (
    <UsageModelDialog
      {...dialogProps}
      model={selection.model}
      onClose={() => selectUsageModel(null)}
    />
  );
}

export function UsagePage() {
  const [preferences, setPreferences] = useState(readUsagePagePreferences);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const shortcutTitle = (
    option: (typeof METRIC_OPTIONS)[number] | (typeof WINDOW_OPTIONS)[number],
  ) => {
    const shortcut = shortcutLabelForCommand(keybindings, option.command, {
      context: { usagePageOpen: true },
    });
    return shortcut
      ? gt("{label} ({shortcut})", { label: m(option.label), shortcut })
      : m(option.label);
  };
  const [windowSelection, setWindowSelection] = useState(() => ({
    period: preferences.period,
    window: makeUsageWindow(preferences.period),
  }));
  const metric = preferences.metric;
  const showingLimits = metric === "limits";
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const refreshingRef = useRef(false);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentationsWithProviders = useAtomValue(
    environmentPresentations.presentationsWithProvidersAtom,
  );
  const selectedServerConfigs = [...presentationsWithProviders]
    .filter(
      ([environmentId]) =>
        selectedEnvironmentIds === null || selectedEnvironmentIds.has(environmentId),
    )
    .map(([, presentation]) => presentation.serverConfig);
  const hasLoadedServerConfig = selectedServerConfigs.some(
    (config) => config !== null && config !== undefined,
  );
  const boundProviders = boundUsageProviders(selectedServerConfigs);
  const userHiddenProviders = new Set(preferences.hiddenProviders);
  const effectiveHiddenProviders = new Set<UsageProviderKind>(userHiddenProviders);
  if (hasLoadedServerConfig) {
    const boundSet = new Set(boundProviders);
    for (const provider of PROVIDER_ORDER) {
      if (!boundSet.has(provider)) effectiveHiddenProviders.add(provider);
    }
  }
  const { period, window } = windowSelection;
  const {
    merged: answeredUsage,
    environments,
    selectedEnvironments,
    shown,
    isPartial,
    refresh,
  } = useUsage(window, selectedEnvironmentIds, effectiveHiddenProviders);
  const merged = shown?.merged ?? answeredUsage;
  const shownWindow = shown?.window ?? window;
  const shownHourly = shownWindow.resolution === "hour";
  const refreshingUsage = isRefreshing && !showingLimits;
  const showingKept = shown !== null && shown.window !== window;
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const canReadDiagnostics = selectedEnvironments.some(
    (environment) => environment.canReadDiagnostics,
  );

  const providersWithRawData = new Set<UsageProviderKind>();
  for (const environment of selectedEnvironments) {
    for (const bucket of environment.summary?.buckets ?? []) {
      const tokens =
        bucket.totals.uncachedInputTokens +
        bucket.totals.cachedInputTokens +
        bucket.totals.cacheCreationTokens +
        bucket.totals.outputTokens;
      if (tokens > 0) providersWithRawData.add(bucket.provider);
    }
  }
  const availableProviders = hasLoadedServerConfig
    ? boundProviders
    : PROVIDER_ORDER.filter(
        (provider) => boundProviders.includes(provider) || providersWithRawData.has(provider),
      );

  const updatePreferences = (patch: Partial<UsagePagePreferences>) => {
    const nextPreferences = { ...preferences, ...patch };
    setPreferences(nextPreferences);
    saveUsagePagePreferences(nextPreferences);
  };
  const selectWindow = (nextPeriod: UsageCalendarPeriod) => {
    updatePreferences({ period: nextPeriod });
    setWindowSelection({
      period: nextPeriod,
      window: makeUsageWindow(nextPeriod),
    });
  };
  const selectMetric = (nextMetric: UsageMetric) => {
    if (nextMetric === "limits") setLimitsNow(Date.now());
    updatePreferences({ metric: nextMetric });
  };
  const refreshLimits = (automatic = false) =>
    // Settled so the timestamp still advances when a refresh throws.
    settlePromise(() =>
      Promise.all(
        Array.from(presentations, ([environmentId, presentation]) => {
          if (selectedEnvironmentIds !== null && !selectedEnvironmentIds.has(environmentId)) return;
          if (presentation.connection.phase === "connected" && presentation.serverConfig !== null) {
            return refreshUsageLimits(
              environmentId,
              () => refreshProviders({ environmentId, input: {} }),
              automatic,
            );
          }
        }),
      ),
    ).then((result) => {
      setLimitsNow(Date.now());
      if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
    });
  const onUsageKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      isCommandPaletteOpen() ||
      isModelPickerOpen()
    )
      return;

    const command = resolveUsageShortcut(event, keybindings);
    const metricOption = METRIC_OPTIONS.find((option) => option.command === command);
    const periodOption = WINDOW_OPTIONS.find((option) => option.command === command);
    if (!metricOption && !periodOption) return;

    event.preventDefault();
    event.stopPropagation();
    if (metricOption) selectMetric(metricOption.value);
    if (periodOption && !showingLimits) selectWindow(periodOption.period);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window capture keydown listener for usage metric and period shortcuts
  useEffect(() => {
    globalThis.window.addEventListener("keydown", onUsageKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onUsageKeyDown, true);
  }, []);

  const refreshWindow = () => {
    if (refreshingRef.current) return;

    if (showingLimits) {
      refreshingRef.current = true;
      setIsRefreshing(true);
      void refreshLimits().finally(() => {
        refreshingRef.current = false;
        setIsRefreshing(false);
      });
      return;
    }
    const nextWindow = makeUsageWindow(period);
    if (
      nextWindow.sinceDay !== window.sinceDay ||
      nextWindow.untilDay !== window.untilDay ||
      nextWindow.sinceTime !== window.sinceTime ||
      nextWindow.untilTime !== window.untilTime
    ) {
      setWindowSelection({ period, window: nextWindow });
    }
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refresh(nextWindow).finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };

  const days = enumerateDays(shownWindow.sinceDay, shownWindow.untilDay);
  const hours =
    shownWindow.sinceTime === undefined || shownWindow.untilTime === undefined
      ? []
      : enumerateHourStarts(shownWindow.sinceTime, shownWindow.untilTime);
  const showChatGptSharing =
    !effectiveHiddenProviders.has("codex") &&
    [...presentationsWithProviders].some(
      ([id, presentation]) =>
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(id)) &&
        (presentation.serverConfig?.providers ?? []).some(usesChatGptSharing),
    );

  const windowLabel =
    shownHourly && shownWindow.sinceTime !== undefined && shownWindow.untilTime !== undefined
      ? gt("{start} to {end}", {
          start: formatDateTimeShort(shownWindow.sinceTime, shownWindow.timeZone, hour12, locale),
          end: formatDateTimeShort(shownWindow.untilTime, shownWindow.timeZone, hour12, locale),
        })
      : gt("{start} to {end}", {
          start: formatDayShort(shownWindow.sinceDay, locale),
          end: formatDayShort(shownWindow.untilDay, locale),
        });
  const windowOptionLabel = WINDOW_OPTIONS.find((option) => option.period === period)?.label;
  const metricOptionLabel = METRIC_OPTIONS.find((option) => option.value === metric)?.label;
  const topbarContent = (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-2 @4xl/usage-header:flex">
      <WorkspaceBreadcrumb ariaLabel={gt("Usage breadcrumb")} className="min-w-0">
        <WorkspaceBreadcrumbItem>
          <h1>
            <T>Usage</T>
          </h1>
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem className="min-w-10 shrink">
          <UsageEnvironmentFilter
            environments={environments}
            selectedEnvironments={selectedEnvironments}
            selectedEnvironmentIds={selectedEnvironmentIds}
            onSelectionChange={setSelectedEnvironmentIds}
            showUsageStatus={!showingLimits}
            refreshing={refreshingUsage}
            isPartial={isPartial}
            duplicateSources={merged.duplicateSources}
            contractMismatches={merged.contractMismatches}
          />
        </WorkspaceBreadcrumbItem>
        <WorkspaceBreadcrumbSeparator />
        <WorkspaceBreadcrumbItem current className="min-w-10">
          <UsageProviderFilter
            availableProviders={availableProviders}
            hiddenProviders={userHiddenProviders}
            onChange={(next) => updatePreferences({ hiddenProviders: next })}
          />
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {!showingLimits ? (
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground @7xl/usage-header:block">
          {windowLabel}
        </span>
      ) : null}
      <div className="ms-auto hidden shrink-0 items-center justify-end gap-2 @4xl/usage-header:flex">
        {/* Limits are always current, so they have no period. The period sits before the metric
            tabs so dropping it never moves them. */}
        {showingLimits ? null : (
          <ToggleGroup
            aria-label={gt("Usage period")}
            variant="segmented"
            value={[period]}
            onValueChange={(next) => {
              const value = next[0];
              if (isUsageCalendarPeriod(value)) selectWindow(value);
            }}
          >
            {WINDOW_OPTIONS.map((option) => (
              <Toggle key={option.period} value={option.period} title={shortcutTitle(option)}>
                {m(option.label)}
              </Toggle>
            ))}
          </ToggleGroup>
        )}
        <ToggleGroup
          aria-label={gt("Usage metric")}
          variant="segmented"
          value={[metric]}
          onValueChange={(next) => {
            const value = next[0];
            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          {METRIC_OPTIONS.map((option) => (
            <Toggle key={option.value} value={option.value} title={shortcutTitle(option)}>
              {m(option.label)}
            </Toggle>
          ))}
        </ToggleGroup>
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? gt("Refresh limits") : gt("Refresh usage")}
          aria-busy={isRefreshing}
          disabled={isRefreshing || (!showingLimits && !canReadDiagnostics)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
      <div className="ms-auto flex shrink-0 items-center justify-end gap-1 @4xl/usage-header:hidden">
        {showingLimits ? null : (
          <Select
            value={period}
            onValueChange={(value) => {
              if (isUsageCalendarPeriod(value)) selectWindow(value);
            }}
          >
            <SelectTrigger
              aria-label={gt("Usage period")}
              size="compact"
              variant="ghost"
              className="w-auto min-w-0"
            >
              <SelectValue>{windowOptionLabel && m(windowOptionLabel)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {WINDOW_OPTIONS.map((option) => (
                <SelectItem key={option.period} value={option.period} title={shortcutTitle(option)}>
                  {m(option.label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <Select
          value={metric}
          onValueChange={(value) => {
            if (isUsageMetric(value)) selectMetric(value);
          }}
        >
          <SelectTrigger
            aria-label={gt("Usage metric")}
            size="compact"
            variant="ghost"
            className="w-auto min-w-0"
          >
            <SelectValue>{metricOptionLabel && m(metricOptionLabel)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {METRIC_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} title={shortcutTitle(option)}>
                {m(option.label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          onClick={refreshWindow}
          aria-label={showingLimits ? gt("Refresh limits") : gt("Refresh usage")}
          aria-busy={isRefreshing}
          disabled={isRefreshing || (!showingLimits && !canReadDiagnostics)}
          size="icon-sm"
          variant="ghost"
        >
          <RefreshIcon size="sm" refreshing={isRefreshing} />
        </Button>
      </div>
    </div>
  );

  return (
    <AppRouteModal label={gt("Usage")}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="@container/usage-header flex min-h-12 shrink-0 items-center gap-1 border-b ps-5 pe-2">
          {topbarContent}
          <AppRouteModalClose />
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer
            width={showingLimits ? "expanded" : "wide"}
            className={showingLimits ? "gap-4 pt-3 pb-8" : undefined}
          >
            {selectedEnvironments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {environments.length === 0
                  ? showingLimits
                    ? gt("Connect an environment to see limits.")
                    : gt("Connect an environment to see usage.")
                  : showingLimits
                    ? gt("Select an environment to see limits.")
                    : gt("Select an environment to see usage.")}
              </p>
            ) : showingLimits ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    <T>Limits refresh manually to avoid background provider polling.</T>
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={refreshWindow}
                    disabled={isRefreshing}
                  >
                    <RefreshIcon size="xs" refreshing={isRefreshing} />
                    <T>Refresh limits</T>
                  </Button>
                </div>
                <UsageLimitsSection
                  selectedEnvironmentIds={selectedEnvironmentIds}
                  hiddenProviders={effectiveHiddenProviders}
                  now={limitsNow}
                />
              </>
            ) : shown === null ? (
              <UsageSkeleton providers={availableProviders} />
            ) : !canReadDiagnostics ? (
              <div className="space-y-2 py-12 text-center text-sm text-muted-foreground">
                {selectedEnvironments.map((environment) => (
                  <p key={environment.environmentId}>
                    {selectedEnvironments.length > 1
                      ? gt("{environment}: {error}", {
                          environment: environment.label,
                          error: environment.error,
                        })
                      : environment.error}
                  </p>
                ))}
              </div>
            ) : (
              <UsageOverview
                merged={merged}
                shownWindow={shownWindow}
                hour12={hour12}
                days={days}
                hours={hours}
                showingKept={showingKept}
                selectedEnvironments={selectedEnvironments}
                hiddenProviders={effectiveHiddenProviders}
                refreshingUsage={refreshingUsage}
                showChatGptSharing={showChatGptSharing}
                onSelectModel={(model) =>
                  selectUsageModel({
                    key: model.key,
                    model: {
                      model: model.displayName,
                      rawModels: model.rawModels,
                      provider: model.provider,
                      totalTokens: model.totalTokens,
                      tokens: model.tokens,
                      tokenShare: model.tokenShare,
                    },
                  })
                }
              />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
      {showingLimits ? null : (
        <UsageModelDialogHost
          environments={selectedEnvironments}
          chartWindow={{
            days,
            hours,
            resolution: shownHourly ? "hour" : "day",
            timeZone: shownWindow.timeZone,
            referenceTime: shownWindow.untilTime,
            hour12,
          }}
        />
      )}
    </AppRouteModal>
  );
}

function UsageOverview({
  merged,
  shownWindow,
  hour12,
  days,
  hours,
  showingKept,
  selectedEnvironments,
  hiddenProviders,
  refreshingUsage,
  showChatGptSharing,
  onSelectModel,
}: {
  readonly merged: MergedUsage;
  readonly shownWindow: UsageSummaryInput;
  readonly hour12: boolean;
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly showingKept: boolean;
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly refreshingUsage: boolean;
  readonly showChatGptSharing: boolean;
  readonly onSelectModel: (model: GroupedUsageModel) => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const m = useMessages();
  const [breakdown, setBreakdown] = useState<"provider" | "time">("provider");
  const [searchQuery, setSearchQuery] = useState("");
  const [mergeRoutes, setMergeRoutes] = useState(true);
  const [focusedProviderState, setFocusedProviderState] = useState<UsageProviderKind | null>(null);
  const [collapsedProviders, setCollapsedProviders] = useState<ReadonlySet<UsageProviderKind>>(
    () => new Set(),
  );
  const shownHourly = shownWindow.resolution === "hour";
  const loading = usageLoading(showingKept, selectedEnvironments, refreshingUsage, hiddenProviders);
  // Copy the primitive; JSX reads of loading.partial would merge all derivations into one compiler cache
  // scope.
  const loadingPartial = loading.partial === true;
  const loadingProviders = new Set(
    PROVIDER_ORDER.filter((provider) => loading.everyProvider || loading.providers.has(provider)),
  );
  const providersWithData = new Set(providersWithUsage(merged.providers));
  // Only loading.providers excludes hidden providers without data. Filter a fresh array so the compiler can
  // cache independently.
  const activeProviders = [...PROVIDER_ORDER].filter(
    (provider) => providersWithData.has(provider) || loading.providers.has(provider),
  );
  const rankedProviders = rankProvidersByTokens(activeProviders, merged.providers);
  const focusedProvider =
    focusedProviderState !== null && activeProviders.includes(focusedProviderState)
      ? focusedProviderState
      : null;
  const viewMerged = focusedProvider === null ? merged : focusMergedUsage(merged, focusedProvider);
  const visibleProviders = focusedProvider === null ? rankedProviders : [focusedProvider];
  const chartLoadingProviders = new Set(
    visibleProviders.filter((provider) => loadingProviders.has(provider)),
  );
  const sourceMessages = usageSourceMessages(
    selectedEnvironments.flatMap(
      (environment) =>
        environment.summary?.sources.filter(
          (source) => !hiddenProviders.has(source.fingerprint.provider),
        ) ?? [],
    ),
    m,
  );
  const breakdownPeriods: readonly (DailyTotals | HourlyTotals)[] = (
    shownHourly ? viewMerged.hourly : viewMerged.daily
  ).toReversed();
  const providerModelGroups = groupModelsByProvider({
    providers: visibleProviders,
    providerTotals: viewMerged.providers,
    models: viewMerged.models,
    totalTokens: viewMerged.totalTokens,
    mergeRoutes,
    searchQuery,
    providerLabel,
  });
  const totalCacheHit = tokensCacheHitRate(viewMerged);

  const toggleProviderCollapsed = (provider: UsageProviderKind) => {
    setCollapsedProviders((current) => {
      const next = new Set(current);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  };

  return (
    <div aria-busy={loadingPartial} className="flex flex-col gap-6">
      {sourceMessages.map((message) => (
        <p key={message} className="mb-4 text-sm text-muted-foreground">
          {message}
        </p>
      ))}
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p
              className={cn(
                "text-4xl font-semibold text-foreground tabular-nums",
                figureClass(loadingPartial),
              )}
            >
              {formatTokens(viewMerged.totalTokens)}
            </p>
            <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <span className={figureClass(loadingPartial)}>
                {gt("{count, plural, one {{formatted} session} other {{formatted} sessions}}", {
                  count: viewMerged.sessions,
                  formatted: formatCount(viewMerged.sessions, locale),
                })}
              </span>
            </p>
          </div>

          {showChatGptSharing ? (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                <T>ChatGPT shared usage</T>
              </span>
              <ChatGptUsageButton size="xs" />
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            {rankedProviders.map((provider) => {
              const totals = merged.providers.find((entry) => entry.provider === provider);
              const share = totals?.tokenShare ?? 0;
              const providerSessions = totals?.sessions ?? 0;
              const sessionLabel = gt(
                "{count, plural, one {{formatted} session} other {{formatted} sessions}}",
                { count: providerSessions, formatted: formatCount(providerSessions, locale) },
              );
              const providerLoading = loadingProviders.has(provider);
              const awaitingData = providerLoading && !providersWithData.has(provider);
              const isFocused = focusedProvider === provider;
              const isDimmed = focusedProvider !== null && !isFocused;
              return (
                <button
                  key={provider}
                  type="button"
                  aria-pressed={isFocused}
                  onClick={() =>
                    setFocusedProviderState((current) => (current === provider ? null : provider))
                  }
                  className={cn(
                    "-mx-2 flex flex-col gap-1 rounded-lg border px-2 py-1.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    isFocused
                      ? "border-border bg-accent/60"
                      : isDimmed
                        ? "border-transparent opacity-55 hover:bg-muted/40 hover:opacity-100"
                        : "border-transparent hover:bg-muted/40",
                  )}
                >
                  <dl className="flex items-baseline justify-between gap-4">
                    <dt className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{
                          backgroundColor: PROVIDER_PRESENTATION[provider].color,
                        }}
                      />
                      <ProviderMark provider={provider} className="size-4" />
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
                        <span
                          className={cn(
                            "shrink-0 whitespace-nowrap text-2xs text-muted-foreground tabular-nums",
                            figureClass(providerLoading),
                            awaitingData && "invisible",
                          )}
                        >
                          {sessionLabel}
                        </span>
                      </span>
                    </dt>
                    <dd
                      className={cn(
                        "shrink-0 text-sm font-medium text-foreground tabular-nums",
                        figureClass(providerLoading),
                      )}
                    >
                      {awaitingData ? "-" : formatTokens(totals?.totalTokens ?? 0)}
                    </dd>
                  </dl>
                  <p
                    className={cn(
                      "text-xs text-muted-foreground",
                      figureClass(providerLoading),
                      awaitingData && "invisible",
                    )}
                  >
                    {gt("{share} of tokens", {
                      share: formatPercent(share),
                    })}
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">
            {shownHourly ? gt("Hourly processed tokens") : gt("Daily processed tokens")}
          </h2>
          <UsageProviderChart
            providers={visibleProviders}
            loadingProviders={chartLoadingProviders}
            days={days}
            daily={viewMerged.daily}
            hours={hours}
            hourly={viewMerged.hourly}
            referenceTime={shownWindow.untilTime}
            resolution={shownHourly ? "hour" : "day"}
            timeZone={shownWindow.timeZone}
            hour12={hour12}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">
          <T>Totals</T>
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
          <Metric
            loading={loadingPartial}
            label={gt("Processed tokens")}
            value={formatTokens(viewMerged.totalTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={gt("Cached input")}
            value={formatTokens(viewMerged.cachedInputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={gt("Uncached input")}
            value={formatTokens(viewMerged.uncachedInputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={gt("Output", { $context: "output tokens" })}
            value={formatTokens(viewMerged.outputTokens)}
          />
          <Metric
            loading={loadingPartial}
            label={gt("Cache hit")}
            value={totalCacheHit === null ? "-" : formatPercent(totalCacheHit)}
          />
        </dl>
      </section>

      {viewMerged.totalTokens > 0 ? (
        <section className={figureClass(loadingPartial)}>
          <UsageShareBar
            label={gt("Tokens by type")}
            segments={tokenTypeSegments(viewMerged)}
            format={formatTokens}
          />
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">
            <T>Breakdown</T>
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            {breakdown === "provider" ? (
              <>
                <InputGroup className="w-48 sm:w-56">
                  <InputGroupAddon>
                    <SearchIcon aria-hidden />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    size="compact"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={gt("Filter models…")}
                    aria-label={gt("Filter models")}
                  />
                </InputGroup>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="compact"
                        variant={mergeRoutes ? "secondary" : "outline"}
                        aria-pressed={mergeRoutes}
                        onClick={() => setMergeRoutes((current) => !current)}
                      />
                    }
                  >
                    <LayersIcon aria-hidden />
                    {mergeRoutes ? gt("Merged routes") : gt("Raw models")}
                  </TooltipTrigger>
                  <TooltipPopup side="top">
                    {mergeRoutes
                      ? gt("Showing merged route prefixes; click for raw model IDs")
                      : gt("Showing raw model IDs; click to merge route prefixes")}
                  </TooltipPopup>
                </Tooltip>
              </>
            ) : null}
            <ToggleGroup
              aria-label={gt("Usage breakdown")}
              variant="segmented"
              value={[breakdown]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "provider" || value === "time") setBreakdown(value);
              }}
            >
              {(
                [
                  { value: "provider", label: gt("By provider") },
                  { value: "time", label: shownHourly ? gt("Hour") : gt("Day") },
                ] as const
              ).map((option) => (
                <Toggle key={option.value} value={option.value}>
                  {option.label}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
        </div>

        {breakdown === "provider" ? (
          providerModelGroups.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {searchQuery.trim().length > 0 ? (
                <T>No models match your search.</T>
              ) : (
                <T>No activity in this window.</T>
              )}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {providerModelGroups.map((group) => {
                const isCollapsed = collapsedProviders.has(group.provider);
                const providerLoading = loadingProviders.has(group.provider);
                const groupFigures = figureClass(providerLoading);
                const presentation = PROVIDER_PRESENTATION[group.provider];
                return (
                  <section
                    key={group.provider}
                    className="overflow-hidden rounded-lg border border-border/60 bg-card/30"
                  >
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      onClick={() => toggleProviderCollapsed(group.provider)}
                      className="flex w-full items-center justify-between gap-3 border-b border-border/50 bg-muted/30 px-3 py-2 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {isCollapsed ? (
                          <ChevronRightIcon
                            aria-hidden
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                        ) : (
                          <ChevronDownIcon
                            aria-hidden
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                        )}
                        <span
                          aria-hidden
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: presentation.color }}
                        />
                        <ProviderMark provider={group.provider} className="size-4" />
                        <span className="truncate text-sm font-medium text-foreground">
                          {presentation.label}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {gt("{count, plural, one {{count} model} other {{count} models}}", {
                            count: group.models.length,
                          })}
                        </span>
                      </span>
                      <span
                        className={cn(
                          "flex shrink-0 items-center gap-4 text-xs text-muted-foreground tabular-nums",
                          groupFigures,
                        )}
                      >
                        <span className="hidden sm:inline">
                          {group.cacheHitRate === null
                            ? "-"
                            : gt("{rate} cache hit", {
                                rate: formatPercent(group.cacheHitRate),
                              })}
                        </span>
                        <span className="hidden sm:inline">{formatPercent(group.tokenShare)}</span>
                        <span className="text-sm font-medium text-foreground">
                          {formatTokens(group.totalTokens)}
                        </span>
                      </span>
                    </button>

                    {!isCollapsed ? (
                      group.models.length === 0 ? (
                        <p className="px-3 py-4 text-xs text-muted-foreground">
                          <T>No models recorded yet.</T>
                        </p>
                      ) : (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-border/40 text-right text-xs text-muted-foreground">
                              <th className="w-full py-1.5 pr-3 pl-3 text-left font-normal">
                                <T>Model</T>
                              </th>
                              <th className="hidden py-1.5 pl-4 font-normal sm:table-cell">
                                <T>Cache hit</T>
                              </th>
                              <th className="hidden py-1.5 pl-4 font-normal sm:table-cell">
                                <T context="column heading, percentage share">Share</T>
                              </th>
                              <th className="py-1.5 pr-3 pl-4 font-normal">
                                <T>Tokens</T>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.models.map((model) => {
                              const hasBar = model.totalTokens > 0 && group.peakTokens > 0;
                              return (
                                <tr
                                  key={model.key}
                                  className="relative border-b border-border/40 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors last:border-b-0 hover:bg-muted/50 has-focus-visible:bg-muted/50"
                                >
                                  <td className="py-2 pr-3 pl-3 text-left whitespace-normal">
                                    <button
                                      type="button"
                                      onClick={() => onSelectModel(model)}
                                      className={cn(
                                        "flex items-center gap-2 text-left text-foreground outline-none after:absolute after:inset-0",
                                        !hasBar && "py-0.5",
                                      )}
                                    >
                                      <span className="break-all">{model.displayName}</span>
                                      {mergeRoutes && model.rawModels.length > 1 ? (
                                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                          {gt("({count} routes)", {
                                            count: model.rawModels.length,
                                          })}
                                        </span>
                                      ) : null}
                                    </button>
                                    {hasBar ? (
                                      <div
                                        aria-hidden
                                        className={cn("mt-1.5 h-0.5 max-w-48", groupFigures)}
                                      >
                                        <div
                                          className="h-full rounded-full"
                                          style={{
                                            width: `max(0.5rem, ${(model.totalTokens / group.peakTokens) * 100}%)`,
                                            backgroundColor: presentation.color,
                                          }}
                                        />
                                      </div>
                                    ) : null}
                                  </td>
                                  <td
                                    className={cn("hidden py-2 pl-4 sm:table-cell", groupFigures)}
                                  >
                                    {model.cacheHitRate === null
                                      ? "-"
                                      : formatPercent(model.cacheHitRate)}
                                  </td>
                                  <td
                                    className={cn("hidden py-2 pl-4 sm:table-cell", groupFigures)}
                                  >
                                    {formatPercent(model.tokenShare)}
                                  </td>
                                  <td
                                    className={cn(
                                      "py-2 pr-3 pl-4 font-medium text-foreground",
                                      groupFigures,
                                    )}
                                  >
                                    {formatTokens(model.totalTokens)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )
                    ) : null}
                  </section>
                );
              })}
            </div>
          )
        ) : (
          <div
            className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            role="region"
            aria-label={gt("Usage breakdown by time")}
            tabIndex={0}
          >
            <table className="w-full text-sm whitespace-nowrap">
              <colgroup>
                <col className="w-2/5" />
              </colgroup>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-2 pl-2 font-normal">{shownHourly ? gt("Hour") : gt("Day")}</th>
                  {visibleProviders.map((provider) => (
                    <th key={provider} className="py-2 pl-4 text-right font-normal">
                      {PROVIDER_PRESENTATION[provider].label}
                    </th>
                  ))}
                  <th className="py-2 pr-2 pl-4 text-right font-normal">
                    <T>Total</T>
                  </th>
                </tr>
              </thead>
              <tbody>
                {breakdownPeriods.length === 0 ? (
                  <tr>
                    <td
                      colSpan={visibleProviders.length + 2}
                      className="py-6 text-center text-muted-foreground"
                    >
                      <T>No activity in this window.</T>
                    </td>
                  </tr>
                ) : (
                  breakdownPeriods.map((period) => (
                    <tr
                      key={"hourStart" in period ? period.hourStart : period.day}
                      className="border-b border-border/50 transition-colors hover:bg-muted/50"
                    >
                      <td className="py-2 pl-2 text-foreground">
                        {"hourStart" in period
                          ? formatHourShort(period.hourStart, shownWindow.timeZone, hour12, locale)
                          : formatDayShort(period.day, locale)}
                      </td>
                      {visibleProviders.map((provider) => (
                        <td
                          key={provider}
                          className={cn(
                            "py-2 pl-4 text-right text-muted-foreground tabular-nums",
                            figureClass(loadingProviders.has(provider)),
                          )}
                        >
                          {formatTokens(period.byProvider.get(provider)?.totalTokens ?? 0)}
                        </td>
                      ))}
                      <td
                        className={cn(
                          "py-2 pr-2 pl-4 text-right font-medium text-foreground tabular-nums",
                          figureClass(loadingPartial),
                        )}
                      >
                        {formatTokens(period.totalTokens)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const presentation = PROVIDER_PRESENTATION[provider];
  return (
    <ProviderInstanceIcon
      driverKind={presentation.driverKind}
      displayName={presentation.label}
      {...("acpRegistryAgentId" in presentation && presentation.acpRegistryAgentId !== undefined
        ? { acpRegistryAgentId: presentation.acpRegistryAgentId }
        : {})}
      iconClassName={className}
    />
  );
}

function figureClass(loading: boolean) {
  return cn("transition-opacity", loading && "opacity-40 delay-150");
}

function Metric({
  label,
  value,
  loading,
}: {
  readonly label: string;
  readonly value: string;
  readonly loading: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn("text-base font-medium text-foreground tabular-nums", figureClass(loading))}
      >
        {value}
      </dd>
    </div>
  );
}

function UsageCoverageNotice({
  environments,
  duplicateSources,
  contractMismatches,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
}) {
  const gt = useGT();
  const m = useMessages();
  const failed = environments.filter((environment) => environment.error !== null);
  const mismatchByEnvironment = new Map(
    contractMismatches.map((mismatch) => [mismatch.environmentId, mismatch]),
  );
  const incompatible = environments.flatMap((environment) => {
    const mismatch = mismatchByEnvironment.get(environment.environmentId);
    return mismatch === undefined ? [] : [{ environment, mismatch }];
  });
  if (failed.length === 0 && incompatible.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={environment.label}>
          {gt("{environment}: {error}", {
            environment: environment.label,
            error: environment.error,
          })}
        </span>
      ))}
      {incompatible.map(({ environment, mismatch }) => (
        <span key={environment.environmentId}>
          {formatUsageContractMismatch(environment.label, mismatch, m)}
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span>
          {gt("Counted once across environments sharing a transcript directory: {sources}", {
            sources: duplicateSources.join(", "),
          })}
        </span>
      ) : null}
    </div>
  );
}

function UsageEnvironmentFilter({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
  showUsageStatus,
  refreshing,
  isPartial,
  duplicateSources,
  contractMismatches,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironments: readonly EnvironmentUsageStatus[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
  readonly showUsageStatus: boolean;
  readonly refreshing: boolean;
  readonly isPartial: boolean;
  readonly duplicateSources: readonly string[];
  readonly contractMismatches: MergedUsage["contractMismatches"];
}) {
  const gt = useGT();
  const m = useMessages();
  const allSelected = selectedEnvironmentIds === null;
  const label = allSelected
    ? gt("All environments")
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : gt("{count, plural, one {{count} environment} other {{count} environments}}", {
          count: selectedEnvironments.length,
        });
  const hasIssue =
    selectedEnvironments.some((environment) => environment.error !== null) ||
    contractMismatches.length > 0;

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-environment min-w-0 max-w-full">
        <WorkspaceBreadcrumbText>{label}</WorkspaceBreadcrumbText>
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {showUsageStatus && hasIssue ? (
            <CircleAlertIcon
              className="size-3.5 text-warning-foreground"
              aria-label={gt("Some environments could not report usage")}
            />
          ) : (
            <ChevronDownIcon
              className="size-3.5 opacity-60 transition-opacity group-hover/usage-environment:opacity-100 group-focus-visible/usage-environment:opacity-100 group-data-popup-open/usage-environment:opacity-100"
              aria-hidden
            />
          )}
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
        >
          <T>All environments</T>
        </MenuCheckboxItem>
        <MenuSeparator />
        {environments.map((environment) => {
          const checked =
            selectedEnvironmentIds === null ||
            selectedEnvironmentIds.has(environment.environmentId);
          const progress = usageEnvironmentProgress(environment, refreshing);
          const status =
            environment.error !== null
              ? gt("Unavailable")
              : environment.summary !== null &&
                  !isCompatibleUsageContractVersion(
                    environment.summary.contractVersion,
                    USAGE_CONTRACT_VERSION,
                  )
                ? gt("Update required")
                : !environment.isConnected
                  ? gt("Connecting…")
                  : progress.phase === "loading"
                    ? gt("Scanning…")
                    : progress.phase === "stale"
                      ? gt("Refreshing…")
                      : progress.phase === "partway"
                        ? updatingProvidersLabel(progress.providers, providerLabel, m)
                        : gt("Ready", { $context: "environment usage status" });
          return (
            <MenuCheckboxItem
              key={environment.environmentId}
              checked={checked}
              closeOnClick={false}
              onCheckedChange={(nextChecked) => {
                const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                if (nextChecked) next.add(environment.environmentId);
                else next.delete(environment.environmentId);
                onSelectionChange(next.size === environments.length ? null : next);
              }}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="min-w-0 flex-1 truncate">{environment.label}</span>
                {showUsageStatus ? (
                  <span
                    className={cn(
                      "shrink-0 text-xs text-muted-foreground",
                      environment.error !== null && "text-destructive",
                    )}
                  >
                    {status}
                  </span>
                ) : null}
              </span>
            </MenuCheckboxItem>
          );
        })}
        {environments.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            <T>No environments connected.</T>
          </p>
        ) : null}
        {showUsageStatus && isPartial ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            <T>Totals are partial while selected environments scan.</T>
          </p>
        ) : null}
        {showUsageStatus ? (
          <UsageCoverageNotice
            environments={selectedEnvironments}
            duplicateSources={duplicateSources}
            contractMismatches={contractMismatches}
          />
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function UsageProviderFilter({
  availableProviders,
  hiddenProviders,
  onChange,
}: {
  readonly availableProviders: readonly UsageProviderKind[];
  readonly hiddenProviders: ReadonlySet<UsageProviderKind>;
  readonly onChange: (hiddenProviders: readonly UsageProviderKind[]) => void;
}) {
  const gt = useGT();
  const visible = availableProviders.filter((provider) => !hiddenProviders.has(provider));
  const label =
    availableProviders.length === 0
      ? gt("No bound providers")
      : visible.length === availableProviders.length
        ? gt("All providers")
        : visible.length === 0
          ? gt("No providers")
          : visible.length === 1
            ? PROVIDER_PRESENTATION[visible[0]!].label
            : gt("{count, plural, one {{count} provider} other {{count} providers}}", {
                count: visible.length,
              });

  return (
    <Menu>
      <MenuTrigger render={<InlineButton />} className="group/usage-provider min-w-0 max-w-full">
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon
          className="size-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover/usage-provider:opacity-100 group-focus-visible/usage-provider:opacity-100 group-data-popup-open/usage-provider:opacity-100"
          aria-hidden
        />
      </MenuTrigger>
      <MenuPopup align="start">
        {availableProviders.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            <T>No bound providers on selected environments.</T>
          </p>
        ) : (
          <>
            <MenuCheckboxItem
              checked={visible.length === availableProviders.length}
              closeOnClick={false}
              onCheckedChange={(checked) => onChange(checked ? [] : availableProviders)}
            >
              <T>All providers</T>
            </MenuCheckboxItem>
            <MenuSeparator />
            {availableProviders.map((provider) => (
              <MenuCheckboxItem
                key={provider}
                checked={!hiddenProviders.has(provider)}
                closeOnClick={false}
                onCheckedChange={(checked) =>
                  onChange(
                    availableProviders.filter((entry) =>
                      entry === provider ? !checked : hiddenProviders.has(entry),
                    ),
                  )
                }
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderMark provider={provider} className="size-3.5" />
                  <span className="truncate">{PROVIDER_PRESENTATION[provider].label}</span>
                </span>
              </MenuCheckboxItem>
            ))}
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

const DEFAULT_SKELETON_PROVIDERS: readonly UsageProviderKind[] = ["codex", "claude", "droid"];

function UsageSkeleton({ providers }: { readonly providers: readonly UsageProviderKind[] }) {
  const gt = useGT();
  const skeletonProviders = providers.length > 0 ? providers : DEFAULT_SKELETON_PROVIDERS;
  return (
    <>
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1">
            <Skeleton className="h-10 w-36" />
            <Skeleton className="h-4 w-32" />
          </div>
          {skeletonProviders.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex min-h-5 items-center justify-between gap-4">
                <span className="flex items-center gap-2">
                  <Skeleton shape="pill" className="size-2 shrink-0" />
                  <Skeleton shape="pill" className="size-4 shrink-0" />
                  <Skeleton className="h-3.5 w-20" />
                </span>
                <Skeleton className="h-3.5 w-14" />
              </div>
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-24" />
          <div className="flex flex-col gap-1">
            <Skeleton className="ml-16 h-56" />
            <Skeleton className="ml-16 h-4" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-foreground">
          <T>Totals</T>
        </h2>
        <MetricSkeletons
          labels={[
            gt("Processed tokens"),
            gt("Cached input"),
            gt("Uncached input"),
            gt("Output", { $context: "output tokens" }),
            gt("Cache hit"),
          ]}
        />
      </section>

      <section className="flex flex-col gap-2.5">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-2" />
        <Skeleton className="h-4 w-72" />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-foreground">
            <T>Breakdown</T>
          </h2>
          <Skeleton shape="card" className="h-7 w-28" />
        </div>
        <Skeleton className="h-44" />
      </section>
    </>
  );
}

function MetricSkeletons({ labels }: { readonly labels: readonly string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 py-1 md:grid-cols-5">
      {labels.map((label) => (
        <div key={label} className="flex flex-col gap-0.5">
          <span className="text-xs text-muted-foreground">{label}</span>
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  );
}

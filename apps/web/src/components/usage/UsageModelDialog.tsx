import type { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { formatPercent, formatTokens } from "@t3tools/shared/usageFormat";

import { mergeAnsweredUsage, type EnvironmentUsageStatus } from "../../state/usage";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { UsageProviderChart } from "./UsageProviderChart";
import { UsageShareBar } from "./UsageShareBar";
import { cacheHitRate, tokenTypeSegments } from "./usageBreakdown";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export interface UsageChartWindow {
  readonly days: readonly string[];
  readonly hours: readonly string[];
  readonly resolution: "day" | "hour";
  readonly timeZone: string;
  readonly referenceTime: string | undefined;
  readonly hour12: boolean;
}

export interface UsageDialogModel {
  readonly model: string;
  readonly rawModels?: readonly string[];
  readonly provider: UsageProviderKind;
  readonly totalTokens: number;
  readonly tokens: UsageTokenTotals;
  readonly tokenShare: number;
}

export function UsageModelDialog({
  model,
  environments,
  chartWindow,
  onClose,
}: {
  readonly model: UsageDialogModel;
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly chartWindow: UsageChartWindow;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const rawModels = new Set(model.rawModels ?? [model.model]);
  const usage = mergeAnsweredUsage(
    environments,
    (bucket) => bucket.provider === model.provider && rawModels.has(bucket.model),
  );
  const providers = [model.provider];
  const presentation = PROVIDER_PRESENTATION[model.provider];
  const hitRate = cacheHitRate(model);
  const inputTokens =
    model.tokens.uncachedInputTokens +
    model.tokens.cachedInputTokens +
    model.tokens.cacheCreationTokens;
  const stats = [
    { label: gt("Tokens"), value: formatTokens(model.totalTokens) },
    { label: gt("Input"), value: formatTokens(inputTokens) },
    hitRate === null ? null : { label: gt("Cache hit"), value: formatPercent(hitRate) },
    {
      label: gt("Output", { $context: "output tokens" }),
      value: formatTokens(model.tokens.outputTokens),
    },
  ].filter((stat) => stat !== null);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <ProviderInstanceIcon
              driverKind={presentation.driverKind}
              displayName={presentation.label}
              {...("acpRegistryAgentId" in presentation &&
              presentation.acpRegistryAgentId !== undefined
                ? { acpRegistryAgentId: presentation.acpRegistryAgentId }
                : {})}
              iconClassName="size-5"
            />
            <DialogTitle>{model.model}</DialogTitle>
          </div>
          <DialogDescription>
            {presentation.label}
            {` · ${gt("{share} of tokens", { share: formatPercent(model.tokenShare) })}`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-8">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              {stats.map((stat) => (
                <div key={stat.label} className="flex min-w-0 flex-col gap-0.5">
                  <dt className="text-xs text-muted-foreground">{stat.label}</dt>
                  <dd className="text-2xl font-semibold text-foreground tabular-nums">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>

            <UsageProviderChart
              providers={providers}
              days={chartWindow.days}
              daily={usage.daily}
              hours={chartWindow.hours}
              hourly={usage.hourly}
              referenceTime={chartWindow.referenceTime}
              resolution={chartWindow.resolution}
              timeZone={chartWindow.timeZone}
              hour12={chartWindow.hour12}
            />

            <UsageShareBar
              label={gt("Tokens by type")}
              segments={tokenTypeSegments(model.tokens)}
              format={formatTokens}
            />
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

import {
  ProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ServerProvider,
  type UsageProviderKind,
} from "@t3tools/contracts";

import { isDeepSeekHarnessAcpConfig } from "../../providerInstances";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly driverKind: ProviderDriverKind;
  readonly acpRegistryAgentId?: string;
};

export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--contrast-foreground)",
    driverKind: ProviderDriverKind.make("codex"),
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    driverKind: ProviderDriverKind.make("claudeAgent"),
  },
  grok: {
    label: "Grok Build",
    color: "color-mix(in oklab, var(--contrast-foreground) 72%, var(--background))",
    driverKind: ProviderDriverKind.make("grok"),
  },
  cursor: { label: "Cursor", color: "#8b8b8b", driverKind: ProviderDriverKind.make("cursor") },
  opencode: {
    label: "OpenCode",
    color: "#5b9bbd",
    driverKind: ProviderDriverKind.make("opencode"),
  },
  antigravity: {
    label: "Antigravity",
    color: "#8c7bd1",
    driverKind: ProviderDriverKind.make("antigravity"),
  },
  pi: {
    label: "Pi",
    color: "#4d9f8a",
    driverKind: ProviderDriverKind.make("pi"),
  },
  muse: {
    label: "Muse Code",
    color: "#0866ff",
    driverKind: ProviderDriverKind.make("muse"),
  },
  dsh: {
    // oxlint-disable-next-line t3code/no-untranslated-copy -- provider brand name stays English
    label: "DeepSeek Harness",
    color: "#4d6bfe",
    driverKind: ProviderDriverKind.make("acpRegistry"),
    acpRegistryAgentId: "deepseek-harness",
  },
  droid: {
    // oxlint-disable-next-line t3code/no-untranslated-copy -- provider brand name stays English
    label: "Factory Droid",
    color: "#ee6018",
    driverKind: ProviderDriverKind.make("acpRegistry"),
    acpRegistryAgentId: "factory-droid",
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];

const NON_ACP_PROVIDER_BY_DRIVER = new Map<ProviderDriverKind, UsageProviderKind>(
  PROVIDER_ORDER.flatMap((provider) => {
    const entry = PROVIDER_PRESENTATION[provider];
    return entry.driverKind === "acpRegistry" ? [] : [[entry.driverKind, provider]];
  }),
);

const DSH_AGENT_ID_PATTERN = /^(?:deepseek-harness|dsh)$/iu;
const DROID_BINARY_NAME_PATTERN = /^(?:factory-)?droid(?:\.exe|\.cmd|\.bat)?$/iu;

function resolveAcpRegistryUsageProvider(config: unknown): UsageProviderKind | null {
  if (config === null || typeof config !== "object") return null;
  const record = config as Readonly<Record<string, unknown>>;
  if (record.source === "local") {
    if (isDeepSeekHarnessAcpConfig(record)) return "dsh";
    const commandPath = typeof record.commandPath === "string" ? record.commandPath.trim() : "";
    const executable = commandPath.split(/[\\/]/u).pop() ?? "";
    return DROID_BINARY_NAME_PATTERN.test(executable) ? "droid" : null;
  }
  const agentId = typeof record.agentId === "string" ? record.agentId.trim() : "";
  if (agentId === "factory-droid") return "droid";
  if (DSH_AGENT_ID_PATTERN.test(agentId)) return "dsh";
  return null;
}

export interface BoundProviderConfigSource {
  readonly providers?: readonly Pick<ServerProvider, "driver" | "enabled" | "usageLimits">[];
  readonly settings?: {
    readonly providerInstances?: Readonly<
      Record<string, Pick<ProviderInstanceConfig, "driver" | "enabled" | "config">>
    >;
  };
}

export function boundUsageProviders(
  configs: readonly (BoundProviderConfigSource | null | undefined)[],
): readonly UsageProviderKind[] {
  const bound = new Set<UsageProviderKind>();
  for (const config of configs) {
    if (config === null || config === undefined) continue;
    for (const provider of config.providers ?? []) {
      if (!provider.enabled) continue;
      if (provider.driver === "acpRegistry") {
        const groupId = provider.usageLimits?.group?.id;
        if (groupId === "acpRegistry:factory-droid") bound.add("droid");
        else if (groupId === "acpRegistry:deepseek-harness") bound.add("dsh");
        continue;
      }
      const kind = NON_ACP_PROVIDER_BY_DRIVER.get(provider.driver);
      if (kind !== undefined) bound.add(kind);
    }
    for (const instance of Object.values(config.settings?.providerInstances ?? {})) {
      if (!resolveProviderInstanceEnabled(instance)) continue;
      if (instance.driver === "acpRegistry") {
        const kind = resolveAcpRegistryUsageProvider(instance.config);
        if (kind !== null) bound.add(kind);
        continue;
      }
      const kind = NON_ACP_PROVIDER_BY_DRIVER.get(instance.driver);
      if (kind !== undefined) bound.add(kind);
    }
  }
  return PROVIDER_ORDER.filter((provider) => bound.has(provider));
}

export function providersWithUsage(
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const active = new Set(
    totals.filter((entry) => entry.totalTokens > 0).map((entry) => entry.provider),
  );
  return PROVIDER_ORDER.filter((provider) => active.has(provider));
}

export function rankProvidersByTokens(
  providers: readonly UsageProviderKind[],
  totals: readonly {
    readonly provider: UsageProviderKind;
    readonly totalTokens: number;
  }[],
): readonly UsageProviderKind[] {
  const value = (provider: UsageProviderKind) =>
    totals.find((entry) => entry.provider === provider)?.totalTokens ?? 0;
  return providers.toSorted((left, right) => value(right) - value(left));
}

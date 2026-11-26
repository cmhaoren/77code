import {
  EnvironmentId,
  MemoId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type Memo,
  type ModelSelection,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  countActiveMemos,
  createInitialMemoLaunchDraft,
  filterMemos,
  filterSelectableMemoProjects,
  filterSelectableMemoThreads,
  formatMemoBadgeCount,
  getMemoThinkingControl,
  selectMemoLaunchModel,
  selectMemoLaunchProvider,
  selectMemoLaunchThinking,
} from "./memoLaunch.logic";

function makeModel(
  slug: string,
  name: string,
  options?: {
    readonly isDefault?: boolean;
    readonly isCustom?: boolean;
    readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
  },
): ServerProviderModel {
  return {
    slug,
    name,
    isCustom: options?.isCustom ?? false,
    ...(options?.isDefault ? { isDefault: true } : {}),
    capabilities: options?.optionDescriptors
      ? { optionDescriptors: [...options.optionDescriptors] }
      : null,
  };
}

function makeProviderEntry(input: {
  readonly instanceId: string;
  readonly driverKind: string;
  readonly displayName: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly enabled?: boolean;
  readonly isAvailable?: boolean;
  readonly status?: ServerProvider["status"];
}): ProviderInstanceEntry {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const driverKind = ProviderDriverKind.make(input.driverKind);
  const enabled = input.enabled ?? true;
  const isAvailable = input.isAvailable ?? true;
  const status = input.status ?? "ready";
  const snapshot: ServerProvider = {
    instanceId,
    driver: driverKind,
    enabled,
    installed: true,
    version: "1.0.0",
    status,
    auth: { status: "authenticated" },
    checkedAt: "2026-11-26T00:00:00.000Z",
    models: [...input.models],
    slashCommands: [],
    skills: [],
    ...(isAvailable ? {} : { availability: "unavailable" as const }),
  };

  return {
    instanceId,
    driverKind,
    displayName: input.displayName,
    enabled,
    installed: true,
    status,
    isDefault: true,
    isAvailable,
    snapshot,
    models: input.models,
  };
}

const CODEX_EFFORT_DESCRIPTOR: ProviderOptionDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning effort",
  type: "select",
  role: "reasoning",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
};

const CLAUDE_EFFORT_DESCRIPTOR: ProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  role: "reasoning",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
    { id: "max", label: "Max" },
  ],
};

const GEMINI_THOUGHT_DESCRIPTOR: ProviderOptionDescriptor = {
  id: "thought_level",
  label: "Thought level",
  type: "select",
  options: [
    { id: "minimal", label: "Minimal" },
    { id: "high", label: "High", isDefault: true },
  ],
};

const CONTEXT_WINDOW_DESCRIPTOR: ProviderOptionDescriptor = {
  id: "contextWindow",
  label: "Context window",
  type: "select",
  options: [
    { id: "200k", label: "200K", isDefault: true },
    { id: "1m", label: "1M" },
  ],
};

const FAST_MODE_DESCRIPTOR: ProviderOptionDescriptor = {
  id: "fastMode",
  label: "Fast",
  type: "boolean",
  currentValue: false,
};

function makeFixtureEntries(): ReadonlyArray<ProviderInstanceEntry> {
  return [
    makeProviderEntry({
      instanceId: "codex",
      driverKind: "codex",
      displayName: "Codex",
      models: [
        makeModel("gpt-5.4", "GPT-5.4", {
          isDefault: true,
          optionDescriptors: [CODEX_EFFORT_DESCRIPTOR, FAST_MODE_DESCRIPTOR],
        }),
        makeModel("gpt-5.4-mini", "GPT-5.4 Mini", {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select",
              role: "reasoning",
              options: [
                { id: "low", label: "Low", isDefault: true },
                { id: "medium", label: "Medium" },
              ],
            },
          ],
        }),
        makeModel("gpt-5-plain", "GPT-5 Plain"),
      ],
    }),
    makeProviderEntry({
      instanceId: "claudeAgent",
      driverKind: "claudeAgent",
      displayName: "Claude",
      models: [
        makeModel("claude-sonnet-4-6", "Claude Sonnet 4.6", {
          isDefault: true,
          optionDescriptors: [CLAUDE_EFFORT_DESCRIPTOR, CONTEXT_WINDOW_DESCRIPTOR],
        }),
      ],
    }),
    makeProviderEntry({
      instanceId: "antigravity",
      driverKind: "antigravity",
      displayName: "Antigravity",
      models: [
        makeModel("gemini-3-pro", "Gemini 3 Pro", {
          isDefault: true,
          optionDescriptors: [GEMINI_THOUGHT_DESCRIPTOR],
        }),
      ],
    }),
  ];
}

function makeMemo(overrides: Omit<Partial<Memo>, "id"> & { id: string; title: string }): Memo {
  return {
    id: MemoId.make(overrides.id),
    title: overrides.title,
    content: overrides.content ?? "",
    status: overrides.status ?? "todo",
    color: overrides.color ?? "amber",
    source: overrides.source ?? "manual",
    threadId: overrides.threadId ?? null,
    threadTitle: overrides.threadTitle ?? null,
    projectId: overrides.projectId ?? null,
    attachments: overrides.attachments ?? [],
    createdAt: overrides.createdAt ?? "2026-11-26T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-11-26T00:00:00.000Z",
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
  };
}

describe("createInitialMemoLaunchDraft", () => {
  it("always defaults projectId to null and uses the global default provider/model/thinking option", () => {
    const entries = makeFixtureEntries();
    const defaultModelSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
      options: [{ id: "effort", value: "max" }],
    };

    const draft = createInitialMemoLaunchDraft({
      instanceEntries: entries,
      defaultModelSelection,
    });

    expect(draft.projectId).toBeNull();
    expect(draft.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
      options: [
        { id: "effort", value: "max" },
        { id: "contextWindow", value: "200k" },
      ],
    });
  });

  it("falls back to the first enabled healthy provider and populates its default thinking option", () => {
    const entries = [
      makeProviderEntry({
        instanceId: "disabled-one",
        driverKind: "codex",
        displayName: "Disabled",
        enabled: false,
        models: [makeModel("gpt-5.4", "GPT-5.4", { isDefault: true })],
      }),
      ...makeFixtureEntries(),
    ];

    const draft = createInitialMemoLaunchDraft({
      instanceEntries: entries,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("disabled-one"),
        model: "gpt-5.4",
      },
    });

    expect(draft.projectId).toBeNull();
    expect(draft.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("returns null modelSelection when no enabled provider exists", () => {
    const draft = createInitialMemoLaunchDraft({
      instanceEntries: [
        makeProviderEntry({
          instanceId: "disabled-one",
          driverKind: "codex",
          displayName: "Disabled",
          enabled: false,
          models: [makeModel("gpt-5.4", "GPT-5.4", { isDefault: true })],
        }),
      ],
      defaultModelSelection: null,
    });

    expect(draft).toEqual({ projectId: null, modelSelection: null });
  });
});

describe("selectMemoLaunchProvider", () => {
  it("switches provider, picks its default model, and drops stale options from the previous provider", () => {
    const entries = makeFixtureEntries();
    const initial = {
      projectId: ProjectId.make("proj-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
    };

    const next = selectMemoLaunchProvider(initial, ProviderInstanceId.make("antigravity"), entries);

    expect(next.projectId).toBe(ProjectId.make("proj-1"));
    expect(next.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("antigravity"),
      model: "gemini-3-pro",
      options: [{ id: "thought_level", value: "high" }],
    });
  });
});

describe("selectMemoLaunchModel", () => {
  it("reconciles thinking option when switching models on the same provider", () => {
    const entries = makeFixtureEntries();
    const initial = {
      projectId: null,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
    };

    // "high" is unavailable on gpt-5.4-mini -> resets to its default ("low"), and drops fastMode
    const mini = selectMemoLaunchModel(initial, "gpt-5.4-mini", entries);
    expect(mini.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4-mini",
      options: [{ id: "reasoningEffort", value: "low" }],
    });

    // "medium" is valid on both -> preserved when moving back to gpt-5.4
    const withMedium = selectMemoLaunchThinking(mini, "medium", entries);
    const backToFlagship = selectMemoLaunchModel(withMedium, "gpt-5.4", entries);
    expect(backToFlagship.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    });

    // Model with no thinking descriptor yields no options
    const plain = selectMemoLaunchModel(initial, "gpt-5-plain", entries);
    expect(plain.modelSelection).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-plain",
    });
  });
});

describe("selectMemoLaunchThinking & getMemoThinkingControl", () => {
  it("updates active thinking option without dropping unrelated options or duplicating ids", () => {
    const entries = makeFixtureEntries();
    const draft = {
      projectId: null,
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
        options: [
          { id: "effort", value: "high" },
          { id: "contextWindow", value: "1m" },
        ],
      },
    };

    const updated = selectMemoLaunchThinking(draft, "low", entries);
    expect(updated.modelSelection?.options).toEqual([
      { id: "effort", value: "low" },
      { id: "contextWindow", value: "1m" },
    ]);

    // Updating again never duplicates the effort id
    const updatedAgain = selectMemoLaunchThinking(updated, "max", entries);
    expect(updatedAgain.modelSelection?.options).toEqual([
      { id: "effort", value: "max" },
      { id: "contextWindow", value: "1m" },
    ]);

    const control = getMemoThinkingControl(
      entries[1]!,
      "claude-sonnet-4-6",
      updatedAgain.modelSelection?.options,
    );
    expect(control?.kind).toBe("select");
    expect(control?.currentValue).toBe("max");
  });

  it("supports thought_level and returns null when model has no thinking option", () => {
    const entries = makeFixtureEntries();
    const geminiControl = getMemoThinkingControl(entries[2]!, "gemini-3-pro", [
      { id: "thought_level", value: "minimal" },
    ]);
    expect(geminiControl?.kind).toBe("select");
    expect(geminiControl?.descriptor.id).toBe("thought_level");
    expect(geminiControl?.currentValue).toBe("minimal");

    const plainControl = getMemoThinkingControl(entries[0]!, "gpt-5-plain", undefined);
    expect(plainControl).toBeNull();
  });
});

describe("filterSelectableMemoProjects", () => {
  it("excludes archived and scratch projects", () => {
    const envId = EnvironmentId.make("env-1");
    const projects = [
      {
        environmentId: envId,
        id: ProjectId.make("p-active"),
        title: "Active App",
        workspaceRoot: "/work/active",
        archivedAt: null,
      },
      {
        environmentId: envId,
        id: ProjectId.make("p-archived"),
        title: "Old App",
        workspaceRoot: "/work/old",
        archivedAt: "2026-10-01T00:00:00.000Z",
      },
      {
        environmentId: envId,
        id: ProjectId.make("p-scratch-flag"),
        title: "Scratch",
        workspaceRoot: "/tmp/scratch-a",
        isScratch: true as const,
        archivedAt: null,
      },
      {
        environmentId: envId,
        id: ProjectId.make("p-scratch-root"),
        title: "Scratch Root",
        workspaceRoot: "/tmp/scratch-root",
        archivedAt: null,
      },
    ];

    const filtered = filterSelectableMemoProjects(projects, "/tmp/scratch-root");
    expect(filtered.map((project) => project.id)).toEqual([ProjectId.make("p-active")]);
  });
});

describe("countActiveMemos, formatMemoBadgeCount & filterMemos", () => {
  const memos: ReadonlyArray<Memo> = [
    makeMemo({ id: "m1", title: "Fix lint", status: "todo" }),
    makeMemo({ id: "m2", title: "Ship drawer", status: "in_progress" }),
    makeMemo({ id: "m3", title: "Already done", status: "done" }),
  ];

  it("counts non-done memos accurately and caps badge display at 99+", () => {
    expect(countActiveMemos(memos)).toBe(2);
    expect(formatMemoBadgeCount(0)).toBeNull();
    expect(formatMemoBadgeCount(2)).toBe("2");
    expect(formatMemoBadgeCount(99)).toBe("99");
    expect(formatMemoBadgeCount(100)).toBe("99+");
  });

  it("filters memos by all / todo / in_progress / done", () => {
    expect(filterMemos(memos, "all").map((memo) => memo.id)).toEqual([
      MemoId.make("m1"),
      MemoId.make("m2"),
      MemoId.make("m3"),
    ]);
    expect(filterMemos(memos, "todo").map((memo) => memo.id)).toEqual([MemoId.make("m1")]);
    expect(filterMemos(memos, "in_progress").map((memo) => memo.id)).toEqual([MemoId.make("m2")]);
    expect(filterMemos(memos, "done").map((memo) => memo.id)).toEqual([MemoId.make("m3")]);
  });
});

describe("filterSelectableMemoThreads", () => {
  it("filters by environment, excludes archived/deleted threads, matches query, and sorts newest first", () => {
    const threads = [
      {
        id: "t-older",
        environmentId: "env-1",
        projectId: "p-1",
        title: "Fix sidebar badge",
        archivedAt: null,
        deletedAt: null,
        updatedAt: "2026-11-26T08:00:00.000Z",
      },
      {
        id: "t-newer",
        environmentId: "env-1",
        projectId: "p-1",
        title: "Fix memo drawer images",
        archivedAt: null,
        deletedAt: null,
        updatedAt: "2026-11-26T10:00:00.000Z",
      },
      {
        id: "t-archived",
        environmentId: "env-1",
        projectId: "p-1",
        title: "Fix archived thread",
        archivedAt: "2026-11-26T11:00:00.000Z",
        deletedAt: null,
        updatedAt: "2026-11-26T11:00:00.000Z",
      },
      {
        id: "t-deleted",
        environmentId: "env-1",
        projectId: "p-1",
        title: "Fix deleted thread",
        archivedAt: null,
        deletedAt: "2026-11-26T11:00:00.000Z",
        updatedAt: "2026-11-26T11:00:00.000Z",
      },
      {
        id: "t-other-env",
        environmentId: "env-2",
        projectId: "p-2",
        title: "Fix remote thread",
        archivedAt: null,
        deletedAt: null,
        updatedAt: "2026-11-26T12:00:00.000Z",
      },
    ];

    expect(filterSelectableMemoThreads(threads, "env-1").map((t) => t.id)).toEqual([
      "t-newer",
      "t-older",
    ]);
    expect(filterSelectableMemoThreads(threads, "env-1", "memo").map((t) => t.id)).toEqual([
      "t-newer",
    ]);
  });
});

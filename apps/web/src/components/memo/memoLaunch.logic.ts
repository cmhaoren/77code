import {
  DEFAULT_MODEL_BY_PROVIDER,
  type Memo,
  type MemoStatus,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  getDescriptorStringValue,
  isReasoningSelect,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import {
  buildProviderOptionSelectionsFromDescriptors,
  createModelSelection,
  getProviderOptionDescriptors,
  resolveSelectableModel,
} from "@t3tools/shared/model";
import type { AppModelOption } from "../../modelSelection";
import {
  type ProviderInstanceEntry,
  resolveSelectableProviderInstanceEntry,
} from "../../providerInstances";
import { getProviderModelCapabilities } from "../../providerModels";

export type MemoFilter = "all" | MemoStatus;

export interface MemoLaunchDraft {
  readonly projectId: ProjectId | null;
  readonly modelSelection: ModelSelection | null;
}

export type MemoThinkingSelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
export type MemoThinkingBooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

export type MemoThinkingControl =
  | {
      readonly kind: "select";
      readonly descriptor: MemoThinkingSelectDescriptor;
      readonly choices: ReadonlyArray<MemoThinkingSelectDescriptor["options"][number]>;
      readonly currentValue: string | null;
    }
  | {
      readonly kind: "boolean";
      readonly descriptor: MemoThinkingBooleanDescriptor;
      readonly currentValue: boolean;
    };

export interface CreateMemoLaunchDraftInput {
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly defaultModelSelection?: ModelSelection | null | undefined;
  readonly modelOptionsByInstance?: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
}

export interface SelectableMemoProjectLike {
  readonly workspaceRoot: string;
  readonly isScratch?: true;
  readonly archivedAt?: string | null | undefined;
}

export function getSelectableMemoProviderEntries(
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  return instanceEntries.filter((entry) => entry.enabled);
}

function resolveDefaultModelForEntry(
  entry: ProviderInstanceEntry,
  modelOptionsByInstance?: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>,
): string | null {
  const options = modelOptionsByInstance?.get(entry.instanceId);
  if (options && options.length > 0) {
    return (
      options.find((option) => option.isDefault && !option.isCustom)?.slug ??
      options.find((option) => !option.isCustom)?.slug ??
      options[0]?.slug ??
      DEFAULT_MODEL_BY_PROVIDER[entry.driverKind] ??
      null
    );
  }
  return (
    entry.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    entry.models.find((model) => !model.isCustom)?.slug ??
    entry.models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[entry.driverKind] ??
    null
  );
}

function reconcileModelOptions(
  entry: ProviderInstanceEntry,
  model: string,
  previousOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): Array<ProviderOptionSelection> | undefined {
  const caps = getProviderModelCapabilities(entry.models, model, entry.driverKind);
  const descriptors = getProviderOptionDescriptors({
    caps,
    selections: previousOptions,
  });
  return buildProviderOptionSelectionsFromDescriptors(descriptors);
}

export function getMemoThinkingControl(
  entry: ProviderInstanceEntry | null | undefined,
  model: string | null | undefined,
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): MemoThinkingControl | null {
  if (!entry || !model) return null;
  const caps = getProviderModelCapabilities(entry.models, model, entry.driverKind);
  const descriptors = getProviderOptionDescriptors({
    caps,
    selections: options,
  });

  const selection: ModelSelection = {
    instanceId: entry.instanceId,
    model,
    ...(options && options.length > 0 ? { options: [...options] } : {}),
  };

  const reasoningSelect = descriptors.find(isReasoningSelect);
  if (reasoningSelect) {
    const choices = selectableProviderOptionChoices(reasoningSelect);
    if (choices.length > 0) {
      return {
        kind: "select",
        descriptor: reasoningSelect,
        choices,
        currentValue:
          getDescriptorStringValue(reasoningSelect, selection) ?? choices[0]?.id ?? null,
      };
    }
  }

  const thinkingBoolean = descriptors.find(
    (descriptor): descriptor is MemoThinkingBooleanDescriptor =>
      descriptor.type === "boolean" && descriptor.id === "thinking",
  );
  if (thinkingBoolean) {
    return {
      kind: "boolean",
      descriptor: thinkingBoolean,
      currentValue: thinkingBoolean.currentValue === true,
    };
  }

  return null;
}

export function createInitialMemoLaunchDraft(input: CreateMemoLaunchDraftInput): MemoLaunchDraft {
  const selectableEntries = getSelectableMemoProviderEntries(input.instanceEntries);
  const requestedInstanceId = input.defaultModelSelection?.instanceId;
  const chosenEntry =
    resolveSelectableProviderInstanceEntry(input.instanceEntries, requestedInstanceId) ??
    selectableEntries[0];

  if (!chosenEntry) {
    return {
      projectId: null,
      modelSelection: null,
    };
  }

  const matchedRequestedInstance =
    requestedInstanceId !== undefined && chosenEntry.instanceId === requestedInstanceId;
  const modelOptions = input.modelOptionsByInstance?.get(chosenEntry.instanceId);
  const candidateModels =
    modelOptions && modelOptions.length > 0 ? modelOptions : chosenEntry.models;

  const resolvedModel =
    (matchedRequestedInstance
      ? resolveSelectableModel(
          chosenEntry.driverKind,
          input.defaultModelSelection?.model,
          candidateModels,
        )
      : null) ?? resolveDefaultModelForEntry(chosenEntry, input.modelOptionsByInstance);

  if (!resolvedModel) {
    return {
      projectId: null,
      modelSelection: null,
    };
  }

  const options = reconcileModelOptions(
    chosenEntry,
    resolvedModel,
    matchedRequestedInstance ? input.defaultModelSelection?.options : undefined,
  );

  return {
    projectId: null,
    modelSelection: createModelSelection(chosenEntry.instanceId, resolvedModel, options),
  };
}

export function selectMemoLaunchProvider(
  draft: MemoLaunchDraft,
  instanceId: ProviderInstanceId,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
  modelOptionsByInstance?: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>,
): MemoLaunchDraft {
  const nextEntry = instanceEntries.find((entry) => entry.instanceId === instanceId);
  if (!nextEntry) return draft;
  const defaultModel = resolveDefaultModelForEntry(nextEntry, modelOptionsByInstance);
  if (!defaultModel) {
    return {
      ...draft,
      modelSelection: null,
    };
  }
  const options = reconcileModelOptions(nextEntry, defaultModel, undefined);
  return {
    ...draft,
    modelSelection: createModelSelection(nextEntry.instanceId, defaultModel, options),
  };
}

export function selectMemoLaunchModel(
  draft: MemoLaunchDraft,
  model: string,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): MemoLaunchDraft {
  if (!draft.modelSelection) return draft;
  const activeEntry = instanceEntries.find(
    (entry) => entry.instanceId === draft.modelSelection?.instanceId,
  );
  if (!activeEntry) return draft;
  const options = reconcileModelOptions(activeEntry, model, draft.modelSelection.options);
  return {
    ...draft,
    modelSelection: createModelSelection(activeEntry.instanceId, model, options),
  };
}

export function selectMemoLaunchThinking(
  draft: MemoLaunchDraft,
  value: string | boolean,
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>,
): MemoLaunchDraft {
  if (!draft.modelSelection) return draft;
  const activeEntry = instanceEntries.find(
    (entry) => entry.instanceId === draft.modelSelection?.instanceId,
  );
  const control = getMemoThinkingControl(
    activeEntry,
    draft.modelSelection.model,
    draft.modelSelection.options,
  );
  if (!control) return draft;

  if (control.kind === "select") {
    if (typeof value !== "string" || !control.choices.some((choice) => choice.id === value)) {
      return draft;
    }
  } else if (typeof value !== "boolean") {
    return draft;
  }

  const existing = draft.modelSelection.options ?? [];
  let replaced = false;
  const nextOptions: ProviderOptionSelection[] = [];
  for (const option of existing) {
    if (option.id === control.descriptor.id) {
      if (!replaced) {
        nextOptions.push({ id: control.descriptor.id, value });
        replaced = true;
      }
    } else {
      nextOptions.push(option);
    }
  }
  if (!replaced) {
    nextOptions.push({ id: control.descriptor.id, value });
  }

  return {
    ...draft,
    modelSelection: createModelSelection(
      draft.modelSelection.instanceId,
      draft.modelSelection.model,
      nextOptions,
    ),
  };
}

export function filterSelectableMemoProjects<TProject extends SelectableMemoProjectLike>(
  projects: ReadonlyArray<TProject>,
  scratchWorkspaceRoot?: string | null,
): ReadonlyArray<TProject> {
  return projects.filter(
    (project) =>
      (project.archivedAt ?? null) === null && !isScratchProject(project, scratchWorkspaceRoot),
  );
}

export function countActiveMemos(memos: ReadonlyArray<Pick<Memo, "status">>): number {
  let count = 0;
  for (const memo of memos) {
    if (memo.status !== "done") {
      count += 1;
    }
  }
  return count;
}

export function formatMemoBadgeCount(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

export interface SelectableMemoThreadLike {
  readonly id: string;
  readonly environmentId?: string;
  readonly projectId: string;
  readonly title: string;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
  readonly updatedAt: string;
}

export function filterSelectableMemoThreads<TThread extends SelectableMemoThreadLike>(
  threads: ReadonlyArray<TThread>,
  environmentId?: string | null,
  query = "",
): ReadonlyArray<TThread> {
  const normalizedQuery = query.trim().toLowerCase();
  return threads
    .filter((thread) => {
      if (environmentId && thread.environmentId && thread.environmentId !== environmentId) {
        return false;
      }
      if ((thread.archivedAt ?? null) !== null || (thread.deletedAt ?? null) !== null) {
        return false;
      }
      if (normalizedQuery.length > 0 && !thread.title.toLowerCase().includes(normalizedQuery)) {
        return false;
      }
      return true;
    })
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function filterMemos<TMemo extends Pick<Memo, "status">>(
  memos: ReadonlyArray<TMemo>,
  filter: MemoFilter,
): ReadonlyArray<TMemo> {
  if (filter === "all") return memos;
  return memos.filter((memo) => memo.status === filter);
}

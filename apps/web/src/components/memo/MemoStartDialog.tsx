import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type EnvironmentId,
  type Memo,
  type MemoStartResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useGT, useMessages } from "gt-react";
import { BotIcon, BrainCircuitIcon, CpuIcon, FolderIcon, PlayIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { useMergedSettings } from "../../hooks/useSettings";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDisplayModelName } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  createInitialMemoLaunchDraft,
  filterSelectableMemoProjects,
  getMemoThinkingControl,
  getSelectableMemoProviderEntries,
  selectMemoLaunchModel,
  selectMemoLaunchProvider,
  selectMemoLaunchThinking,
  type MemoLaunchDraft,
} from "./memoLaunch.logic";

const NO_PROJECT_SENTINEL = "__memo_no_project__";

export interface MemoStartDialogProps {
  readonly open: boolean;
  readonly memo: Memo | null;
  readonly instanceKey?: string | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStarted: (result: MemoStartResult) => void;
}

function MemoStartDialogContent({
  memo,
  environmentId,
  submitting,
  onSubmittingChange,
  onClose,
  onStarted,
}: {
  readonly memo: Memo;
  readonly environmentId: EnvironmentId;
  readonly submitting: boolean;
  readonly onSubmittingChange: (next: boolean) => void;
  readonly onClose: () => void;
  readonly onStarted: (result: MemoStartResult) => void;
}) {
  const gt = useGT();
  const resolveMessages = useMessages();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const canStart = useAtomValue(serverEnvironment.memosStart.permissionAtom(environmentId));
  const serverSettings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const settings = useMergedSettings(serverSettings);
  const allProjects = useProjects();
  const startMemo = useAtomCommand(serverEnvironment.memosStart, {
    label: "memo start",
    reportFailure: false,
  });

  const envProjects = allProjects.filter((project) => project.environmentId === environmentId);
  const selectableProjects = filterSelectableMemoProjects(
    envProjects,
    serverConfig?.scratchWorkspaceRoot ?? null,
  );

  // Machine-level entries are used for initial draft so projectId ALWAYS starts at null.
  const baseInstanceEntries = providerInstanceEntriesFor(providers, serverSettings, null);
  const baseModelOptionsByInstance = new Map(
    getSelectableMemoProviderEntries(baseInstanceEntries).map((entry) => [
      entry.instanceId,
      getAppModelOptionsForInstance(settings, entry, null),
    ]),
  );

  const [draft, setDraft] = useState<MemoLaunchDraft>(() =>
    createInitialMemoLaunchDraft({
      instanceEntries: baseInstanceEntries,
      defaultModelSelection: serverSettings.defaultModelSelection,
      modelOptionsByInstance: baseModelOptionsByInstance,
    }),
  );

  const instanceEntries = providerInstanceEntriesFor(providers, serverSettings, draft.projectId);
  const selectableProviders = getSelectableMemoProviderEntries(instanceEntries);
  const modelOptionsByInstance = new Map(
    selectableProviders.map((entry) => [
      entry.instanceId,
      getAppModelOptionsForInstance(
        settings,
        entry,
        draft.modelSelection?.instanceId === entry.instanceId ? draft.modelSelection.model : null,
      ),
    ]),
  );

  // Reconcile if providers finish loading after mount OR the currently selected provider was disabled.
  const currentSelectable =
    draft.modelSelection !== null &&
    selectableProviders.some((entry) => entry.instanceId === draft.modelSelection?.instanceId);
  const resolvedProjectDefaults = resolveProjectSettings(serverSettings, draft.projectId).settings;
  const effectiveDraft: MemoLaunchDraft = currentSelectable
    ? draft
    : {
        ...createInitialMemoLaunchDraft({
          instanceEntries,
          defaultModelSelection: resolvedProjectDefaults.defaultModelSelection,
          modelOptionsByInstance,
        }),
        projectId: draft.projectId,
      };

  const activeSelection = effectiveDraft.modelSelection;
  const activeEntry =
    activeSelection !== null
      ? (selectableProviders.find((entry) => entry.instanceId === activeSelection.instanceId) ??
        null)
      : null;

  const activeModelOptions = activeEntry
    ? (modelOptionsByInstance.get(activeEntry.instanceId) ?? [])
    : [];
  const activeModelOption =
    activeSelection !== null
      ? (activeModelOptions.find((option) => option.slug === activeSelection.model) ?? null)
      : null;

  const thinkingControl = getMemoThinkingControl(
    activeEntry,
    activeSelection?.model,
    activeSelection?.options,
  );

  const selectedProjectValue = effectiveDraft.projectId ?? NO_PROJECT_SENTINEL;
  const selectedProject =
    effectiveDraft.projectId !== null
      ? (selectableProjects.find((project) => project.id === effectiveDraft.projectId) ?? null)
      : null;

  const handleProjectChange = (value: string | null) => {
    if (!value) return;
    const nextProjectId = value === NO_PROJECT_SENTINEL ? null : ProjectId.make(value);
    const nextEntries = providerInstanceEntriesFor(providers, serverSettings, nextProjectId);
    const nextSelectable = getSelectableMemoProviderEntries(nextEntries);
    const currentId = effectiveDraft.modelSelection?.instanceId;
    const stillSelectable =
      currentId !== undefined && nextSelectable.some((entry) => entry.instanceId === currentId);
    if (stillSelectable) {
      setDraft({ ...effectiveDraft, projectId: nextProjectId });
      return;
    }
    const nextModelMap = new Map(
      nextSelectable.map((entry) => [
        entry.instanceId,
        getAppModelOptionsForInstance(settings, entry, null),
      ]),
    );
    const nextDefaults = resolveProjectSettings(serverSettings, nextProjectId).settings;
    const reinitialized = createInitialMemoLaunchDraft({
      instanceEntries: nextEntries,
      defaultModelSelection: nextDefaults.defaultModelSelection,
      modelOptionsByInstance: nextModelMap,
    });
    setDraft({
      projectId: nextProjectId,
      modelSelection: reinitialized.modelSelection,
    });
  };

  const handleProviderChange = (value: string | null) => {
    if (!value) return;
    setDraft(
      selectMemoLaunchProvider(
        effectiveDraft,
        ProviderInstanceId.make(value),
        instanceEntries,
        modelOptionsByInstance,
      ),
    );
  };

  const handleModelChange = (value: string | null) => {
    if (!value) return;
    setDraft(selectMemoLaunchModel(effectiveDraft, value, instanceEntries));
  };

  const handleThinkingChange = (value: string | boolean) => {
    setDraft(selectMemoLaunchThinking(effectiveDraft, value, instanceEntries));
  };

  const handleConfirm = async () => {
    if (submitting || !canStart || activeSelection === null) return;
    onSubmittingChange(true);
    const result = await startMemo({
      environmentId,
      input: {
        id: memo.id,
        launch: {
          projectId: effectiveDraft.projectId,
          modelSelection: activeSelection,
        },
      },
    });
    onSubmittingChange(false);
    if (result._tag === "Success") {
      onStarted(result.value);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("启动便签失败"),
        description:
          (error instanceof Error ? thrownErrorMessage(error, resolveMessages) : null) ??
          gt("请稍后重试。"),
      });
    }
  };

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-warning/15 text-warning-foreground ring-1 ring-inset ring-warning/30">
            <PlayIcon className="size-3.5 fill-current" />
          </span>
          <DialogTitle>{gt("确认启动配置")}</DialogTitle>
        </div>
        <DialogDescription>
          {gt("为这条待办便签选择运行环境与模型，确认后将自动创建会话并开始执行。")}
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        <div className="rounded-xl border border-warning/35 bg-warning-surface px-3.5 py-2.5">
          <p className="line-clamp-2 text-sm font-medium text-foreground">{memo.title}</p>
          {memo.content.trim().length > 0 ? (
            <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
              {memo.content.trim()}
            </p>
          ) : null}
        </div>

        {/* 1. 项目（默认无项目） */}
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <FolderIcon className="size-3.5 text-muted-foreground" />
            <span>{gt("项目")}</span>
          </label>
          <Select value={selectedProjectValue} onValueChange={handleProjectChange}>
            <SelectTrigger size="default" className="w-full" aria-label={gt("项目")}>
              <span className="min-w-0 flex-1 truncate text-left">
                {selectedProject ? selectedProject.title : gt("无项目（临时工作区）")}
              </span>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem value={NO_PROJECT_SENTINEL}>
                <span className="flex items-center gap-2 truncate">
                  <span className="truncate">{gt("无项目（临时工作区）")}</span>
                </span>
              </SelectItem>
              {selectableProjects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  <span className="truncate">{project.title}</span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        {/* 2. 供应商 */}
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <CpuIcon className="size-3.5 text-muted-foreground" />
            <span>{gt("供应商")}</span>
          </label>
          <Select
            value={activeEntry?.instanceId ?? ""}
            onValueChange={handleProviderChange}
            disabled={selectableProviders.length === 0}
          >
            <SelectTrigger size="default" className="w-full" aria-label={gt("供应商")}>
              {activeEntry ? (
                <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                  <ProviderInstanceIcon
                    driverKind={activeEntry.driverKind}
                    displayName={activeEntry.displayName}
                    accentColor={activeEntry.accentColor}
                    acpRegistryAgentId={activeEntry.acpRegistryAgentId}
                    acpRegistryIconUrl={activeEntry.acpRegistryIconUrl}
                    size="compact"
                    className="size-4"
                    iconClassName="size-3.5"
                  />
                  <span className="truncate">{activeEntry.displayName}</span>
                </span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
                  {gt("暂无可用供应商")}
                </span>
              )}
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {selectableProviders.map((entry) => (
                <SelectItem key={entry.instanceId} value={entry.instanceId}>
                  <span className="flex min-w-0 items-center gap-2">
                    <ProviderInstanceIcon
                      driverKind={entry.driverKind}
                      displayName={entry.displayName}
                      accentColor={entry.accentColor}
                      acpRegistryAgentId={entry.acpRegistryAgentId}
                      acpRegistryIconUrl={entry.acpRegistryIconUrl}
                      size="compact"
                      className="size-4"
                      iconClassName="size-3.5"
                    />
                    <span className="truncate">{entry.displayName}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        {/* 3. 模型 */}
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <BotIcon className="size-3.5 text-muted-foreground" />
            <span>{gt("模型")}</span>
          </label>
          <Select
            value={activeSelection?.model ?? ""}
            onValueChange={handleModelChange}
            disabled={activeModelOptions.length === 0}
          >
            <SelectTrigger size="default" className="w-full" aria-label={gt("模型")}>
              <span className="min-w-0 flex-1 truncate text-left">
                {activeModelOption
                  ? getDisplayModelName(activeModelOption)
                  : activeSelection?.model || gt("暂无可用模型")}
              </span>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {activeModelOptions.map((option) => (
                <SelectItem key={option.slug} value={option.slug}>
                  <span className="truncate">{getDisplayModelName(option)}</span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        {/* 4. 思考强度 */}
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <BrainCircuitIcon className="size-3.5 text-muted-foreground" />
            <span>{gt("思考强度")}</span>
          </label>
          {thinkingControl === null ? (
            <div className="rounded-lg border border-dashed border-border/80 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
              {gt("该模型不支持思考强度配置")}
            </div>
          ) : thinkingControl.kind === "boolean" ? (
            <div
              className="grid grid-cols-2 gap-1.5 rounded-lg border border-border/80 bg-muted/40 p-1"
              role="radiogroup"
              aria-label={gt("思考强度")}
            >
              {(
                [
                  { value: false, label: gt("关闭") },
                  { value: true, label: gt("开启") },
                ] as const
              ).map((item) => {
                const active = thinkingControl.currentValue === item.value;
                return (
                  <button
                    key={String(item.value)}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => handleThinkingChange(item.value)}
                    className={cn(
                      "cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      active
                        ? "bg-background text-foreground shadow-xs ring-1 ring-inset ring-border/70"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          ) : thinkingControl.choices.length <= 5 ? (
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={gt("思考强度")}>
              {thinkingControl.choices.map((choice) => {
                const active = thinkingControl.currentValue === choice.id;
                return (
                  <button
                    key={choice.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => handleThinkingChange(choice.id)}
                    className={cn(
                      "min-w-0 flex-1 cursor-pointer rounded-lg border px-2.5 py-1.5 text-center text-xs font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      active
                        ? "border-warning/60 bg-warning-surface text-warning-foreground shadow-xs"
                        : "border-border/80 bg-background/70 text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    {choice.label}
                  </button>
                );
              })}
            </div>
          ) : (
            <Select
              value={thinkingControl.currentValue ?? ""}
              onValueChange={(value) => {
                if (value) handleThinkingChange(value);
              }}
            >
              <SelectTrigger size="default" className="w-full" aria-label={gt("思考强度")}>
                <span className="min-w-0 flex-1 truncate text-left">
                  {thinkingControl.choices.find(
                    (choice) => choice.id === thinkingControl.currentValue,
                  )?.label ??
                    thinkingControl.currentValue ??
                    ""}
                </span>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {thinkingControl.choices.map((choice) => (
                  <SelectItem key={choice.id} value={choice.id}>
                    <span className="truncate">{choice.label}</span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        </div>
      </DialogPanel>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
          {gt("取消")}
        </Button>
        <Button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={submitting || !canStart || activeSelection === null}
        >
          {submitting ? <Spinner className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          <span>{gt("确认并开始")}</span>
        </Button>
      </DialogFooter>
    </>
  );
}

export function MemoStartDialog({
  open,
  memo,
  instanceKey,
  environmentId,
  onOpenChange,
  onStarted,
}: MemoStartDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const dialogOpen = open && memo !== null && environmentId !== null;
  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && submitting) return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
      <DialogPopup className="max-w-md" showCloseButton={!submitting}>
        {dialogOpen ? (
          <MemoStartDialogContent
            key={instanceKey ?? memo.id}
            memo={memo}
            environmentId={environmentId}
            submitting={submitting}
            onSubmittingChange={setSubmitting}
            onClose={() => handleDialogOpenChange(false)}
            onStarted={onStarted}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

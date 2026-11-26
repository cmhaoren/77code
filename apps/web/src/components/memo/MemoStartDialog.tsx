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
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useGT, useMessages } from "gt-react";
import {
  BotIcon,
  BrainCircuitIcon,
  CheckIcon,
  CpuIcon,
  FolderIcon,
  ImageIcon,
  MessageSquareIcon,
  PlayIcon,
  PlusCircleIcon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "~/lib/utils";
import { useMergedSettings } from "../../hooks/useSettings";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useProjects, useVisibleThreadShells } from "../../state/entities";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
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
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Select, SelectItem, SelectPopup, SelectTrigger } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import {
  createInitialMemoLaunchDraft,
  filterSelectableMemoProjects,
  filterSelectableMemoThreads,
  getMemoThinkingControl,
  getSelectableMemoProviderEntries,
  selectMemoLaunchModel,
  selectMemoLaunchProvider,
  selectMemoLaunchThinking,
  type MemoLaunchDraft,
} from "./memoLaunch.logic";
import { MEMO_PAPER_PALETTE, MemoPaperFold, MemoPaperTape } from "./memoPaper";

const NO_PROJECT_SENTINEL = "__memo_no_project__";
type MemoStartMode = "new_thread" | "existing_thread";

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
  const allVisibleThreads = useVisibleThreadShells();
  const startMemo = useAtomCommand(serverEnvironment.memosStart, {
    label: "memo start",
    reportFailure: false,
  });

  const [startMode, setStartMode] = useState<MemoStartMode>("new_thread");
  const [threadQuery, setThreadQuery] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<ThreadId | null>(null);
  const [nowMs] = useState(() => Date.now());

  const envProjects = allProjects.filter((project) => project.environmentId === environmentId);
  const projectById = new Map(envProjects.map((project) => [project.id, project]));
  const selectableProjects = filterSelectableMemoProjects(
    envProjects,
    serverConfig?.scratchWorkspaceRoot ?? null,
  );
  const allEnvThreads = filterSelectableMemoThreads(allVisibleThreads, environmentId);
  const selectableThreads = filterSelectableMemoThreads(
    allVisibleThreads,
    environmentId,
    threadQuery,
  );
  const effectiveSelectedThreadId: ThreadId | null =
    selectedThreadId !== null && selectableThreads.some((thread) => thread.id === selectedThreadId)
      ? selectedThreadId
      : (selectableThreads[0]?.id ?? null);

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

  const canConfirm =
    !submitting &&
    canStart &&
    (startMode === "existing_thread"
      ? effectiveSelectedThreadId !== null
      : activeSelection !== null);

  const handleConfirm = async () => {
    if (!canConfirm) return;
    onSubmittingChange(true);
    const result =
      startMode === "existing_thread" && effectiveSelectedThreadId !== null
        ? await startMemo({
            environmentId,
            input: {
              id: memo.id,
              targetThreadId: effectiveSelectedThreadId,
            },
          })
        : activeSelection !== null
          ? await startMemo({
              environmentId,
              input: {
                id: memo.id,
                launch: {
                  projectId: effectiveDraft.projectId,
                  modelSelection: activeSelection,
                },
              },
            })
          : null;
    onSubmittingChange(false);
    if (result === null) return;
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

  const paperPalette = MEMO_PAPER_PALETTE[memo.color];
  const memoExcerpt = memo.content.trim();

  return (
    <>
      <DialogHeader>
        <DialogTitle>{gt("确认启动配置")}</DialogTitle>
        <DialogDescription>
          {startMode === "existing_thread"
            ? gt("选择一个已有会话，确认后将绑定该会话并发送此便签开始执行。")
            : gt("为这条待办便签选择运行环境与模型，确认后将自动创建会话并开始执行。")}
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        {/* Sticky-note preview slip */}
        <div className="px-1 pt-2">
          <div
            className={cn(
              "relative -rotate-1 rounded-lg px-4 pt-4 pb-3 shadow-sm ring-1 ring-inset",
              paperPalette.paper,
            )}
          >
            <MemoPaperTape />
            <MemoPaperFold fold={paperPalette.fold} />
            <p className="line-clamp-2 pr-3 text-sm leading-snug font-semibold tracking-tight text-foreground">
              {memo.title}
            </p>
            {memoExcerpt.length > 0 ? (
              <p className="mt-1 line-clamp-2 text-xs leading-relaxed whitespace-pre-wrap text-foreground/70">
                {memoExcerpt}
              </p>
            ) : null}
            {memo.attachments.length > 0 ? (
              <div className="mt-2.5 inline-flex items-center gap-1 rounded-full bg-background/65 px-2 py-0.5 text-2xs text-muted-foreground shadow-2xs ring-1 ring-foreground/8 dark:bg-background/35">
                <ImageIcon className="size-3 shrink-0" />
                <span>
                  {gt("附带")} {memo.attachments.length} {gt("张图片，启动时一并发送")}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Target mode switcher: New Thread vs Existing Thread */}
        <div
          className="grid grid-cols-2 gap-0.5 rounded-lg bg-foreground/5 p-0.5 ring-1 ring-border/50 ring-inset"
          role="tablist"
          aria-label={gt("启动方式")}
        >
          <button
            type="button"
            role="tab"
            aria-selected={startMode === "new_thread"}
            onClick={() => setStartMode("new_thread")}
            className={cn(
              "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-[color,background-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              startMode === "new_thread"
                ? "bg-popover text-foreground shadow-xs ring-1 ring-border/60 ring-inset dark:bg-foreground/10"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <PlusCircleIcon className="size-3.5 shrink-0" />
            <span>{gt("新建会话")}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={startMode === "existing_thread"}
            onClick={() => setStartMode("existing_thread")}
            className={cn(
              "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-[color,background-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              startMode === "existing_thread"
                ? "bg-popover text-foreground shadow-xs ring-1 ring-border/60 ring-inset dark:bg-foreground/10"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <MessageSquareIcon className="size-3.5 shrink-0" />
            <span>{gt("已有会话")}</span>
            <span
              className={cn(
                "min-w-4 rounded-full px-1 text-center text-3xs leading-4 tabular-nums",
                startMode === "existing_thread"
                  ? "bg-warning/16 text-warning-foreground"
                  : "bg-foreground/6",
              )}
            >
              {allEnvThreads.length}
            </span>
          </button>
        </div>

        {startMode === "existing_thread" ? (
          <div className="space-y-2">
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                size="sm"
                value={threadQuery}
                onChange={(event) => setThreadQuery(event.target.value)}
                placeholder={gt("搜索已有会话标题...")}
                aria-label={gt("搜索已有会话标题...")}
              />
            </InputGroup>

            {selectableThreads.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/80 px-3.5 py-7 text-center text-xs text-muted-foreground">
                <MessageSquareIcon className="size-4 opacity-50" />
                <span>
                  {allEnvThreads.length === 0
                    ? gt("当前环境暂无可用的活跃会话，请切换到「新建会话」。")
                    : gt("没有匹配的活跃会话。")}
                </span>
              </div>
            ) : (
              <div
                className="max-h-60 space-y-0.5 overflow-y-auto rounded-lg p-1 ring-1 ring-border/60 ring-inset"
                role="listbox"
                aria-label={gt("选择已有会话")}
              >
                {selectableThreads.map((thread) => {
                  const selected = thread.id === effectiveSelectedThreadId;
                  const project = projectById.get(thread.projectId) ?? null;
                  const showProjectBadge = project !== null && !project.isScratch;
                  const relativeTime = formatRelativeTimeLabel(
                    thread.updatedAt,
                    nowMs,
                    resolveMessages,
                  );
                  return (
                    <button
                      key={thread.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => setSelectedThreadId(thread.id)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                        selected
                          ? "bg-warning/10 text-foreground ring-1 ring-warning/35 ring-inset"
                          : "text-foreground/90 hover:bg-foreground/5",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex size-4 shrink-0 items-center justify-center rounded-full ring-1 transition-colors ring-inset",
                          selected
                            ? "bg-primary text-primary-foreground ring-primary"
                            : "ring-foreground/20",
                        )}
                      >
                        {selected ? <CheckIcon className="size-2.5 stroke-3" /> : null}
                      </span>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="truncate text-xs font-medium">
                          {thread.title.trim() || gt("未命名会话")}
                        </p>
                        <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                          {showProjectBadge ? (
                            <span className="inline-flex max-w-36 items-center gap-1 truncate rounded-sm bg-foreground/6 px-1.5 py-px text-3xs">
                              <FolderIcon className="size-2.5 shrink-0 opacity-70" />
                              <span className="truncate">{project.title}</span>
                            </span>
                          ) : (
                            <span className="text-3xs opacity-75">{gt("无项目")}</span>
                          )}
                          {relativeTime ? (
                            <span className="truncate tabular-nums">{relativeTime}</span>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
            {/* 1. 项目（默认无项目） */}
            <div className="col-span-2 space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <FolderIcon className="size-3.5" />
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
            <div className="min-w-0 space-y-1.5 max-sm:col-span-2">
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <CpuIcon className="size-3.5" />
                <span>{gt("供应商")}</span>
              </label>
              <Select
                value={activeEntry?.instanceId ?? ""}
                onValueChange={handleProviderChange}
                disabled={selectableProviders.length === 0}
              >
                <SelectTrigger size="default" className="w-full min-w-0" aria-label={gt("供应商")}>
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
            <div className="min-w-0 space-y-1.5 max-sm:col-span-2">
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <BotIcon className="size-3.5" />
                <span>{gt("模型")}</span>
              </label>
              <Select
                value={activeSelection?.model ?? ""}
                onValueChange={handleModelChange}
                disabled={activeModelOptions.length === 0}
              >
                <SelectTrigger size="default" className="w-full min-w-0" aria-label={gt("模型")}>
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
            <div className="col-span-2 space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <BrainCircuitIcon className="size-3.5" />
                <span>{gt("思考强度")}</span>
              </label>
              {thinkingControl === null ? (
                <div className="rounded-lg border border-dashed border-border/80 px-3 py-2 text-xs text-muted-foreground">
                  {gt("该模型不支持思考强度配置")}
                </div>
              ) : thinkingControl.kind === "boolean" ? (
                <div
                  className="grid grid-cols-2 gap-0.5 rounded-lg bg-foreground/5 p-0.5 ring-1 ring-border/50 ring-inset"
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
                          "cursor-pointer rounded-md px-2.5 py-1.5 text-xs font-medium transition-[color,background-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                          active
                            ? "bg-popover text-foreground shadow-xs ring-1 ring-border/60 ring-inset dark:bg-foreground/10"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              ) : thinkingControl.choices.length <= 5 ? (
                <div
                  className="flex gap-0.5 rounded-lg bg-foreground/5 p-0.5 ring-1 ring-border/50 ring-inset"
                  role="radiogroup"
                  aria-label={gt("思考强度")}
                >
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
                          "min-w-0 flex-1 cursor-pointer truncate rounded-md px-2 py-1.5 text-center text-xs font-medium transition-[color,background-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                          active
                            ? "bg-popover text-foreground shadow-xs ring-1 ring-border/60 ring-inset dark:bg-foreground/10"
                            : "text-muted-foreground hover:text-foreground",
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
          </div>
        )}
      </DialogPanel>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
          {gt("取消")}
        </Button>
        <Button type="button" onClick={() => void handleConfirm()} disabled={!canConfirm}>
          {submitting ? (
            <Spinner className="size-3.5" />
          ) : (
            <PlayIcon className="size-3.5 fill-current" />
          )}
          <span>{startMode === "existing_thread" ? gt("发送到此会话") : gt("确认并开始")}</span>
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

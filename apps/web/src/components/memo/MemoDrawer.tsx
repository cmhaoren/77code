import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  MemoError,
  type EnvironmentId,
  type Memo,
  type MemoColor,
  type MemoStartResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useGT, useMessages } from "gt-react";
import {
  CheckCircle2Icon,
  CheckIcon,
  CircleIcon,
  MessageSquareIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  StickyNoteIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { cn } from "~/lib/utils";
import {
  ALLOW_OPERATE_ATOM,
  EMPTY_MEMOS_ATOM,
  useActiveMemoEnvironmentId,
  useMemoDrawerStore,
} from "../../memoDrawerStore";
import { useProject, useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MemoStartDialog } from "./MemoStartDialog";
import {
  countActiveMemos,
  filterMemos,
  formatMemoBadgeCount,
  type MemoFilter,
} from "./memoLaunch.logic";

const MEMO_COLORS: ReadonlyArray<MemoColor> = ["amber", "sage", "sky", "rose", "lavender"];

/**
 * Five tactile sticky-note paper tints built strictly on declared theme tokens
 * (`warning` = amber, `success` = sage, `info` = sky, `error` = rose, `guest` = lavender)
 * so both light and dark modes stay warm, legible, and theme-consistent.
 */
const MEMO_COLOR_PALETTE: Readonly<
  Record<
    MemoColor,
    {
      readonly card: string;
      readonly tape: string;
      readonly accentBar: string;
      readonly dot: string;
    }
  >
> = {
  amber: {
    card: "bg-warning/10 border-warning/30 dark:bg-warning/14 dark:border-warning/35",
    tape: "bg-warning/40 dark:bg-warning/35",
    accentBar: "bg-warning/75 dark:bg-warning/70",
    dot: "bg-warning/80 border-warning",
  },
  sage: {
    card: "bg-success/10 border-success/30 dark:bg-success/14 dark:border-success/35",
    tape: "bg-success/40 dark:bg-success/35",
    accentBar: "bg-success/75 dark:bg-success/70",
    dot: "bg-success/80 border-success",
  },
  sky: {
    card: "bg-info/10 border-info/30 dark:bg-info/14 dark:border-info/35",
    tape: "bg-info/40 dark:bg-info/35",
    accentBar: "bg-info/75 dark:bg-info/70",
    dot: "bg-info/80 border-info",
  },
  rose: {
    card: "bg-error/10 border-error/30 dark:bg-error/14 dark:border-error/35",
    tape: "bg-error/40 dark:bg-error/35",
    accentBar: "bg-error/75 dark:bg-error/70",
    dot: "bg-error/80 border-error",
  },
  lavender: {
    card: "bg-guest/10 border-guest/30 dark:bg-guest/14 dark:border-guest/35",
    tape: "bg-guest/40 dark:bg-guest/35",
    accentBar: "bg-guest/75 dark:bg-guest/70",
    dot: "bg-guest/80 border-guest",
  },
};

const isMemoError = Schema.is(MemoError);

function isThreadNotFoundError(error: unknown): boolean {
  if (isMemoError(error) && error.code === "thread_not_found") {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "MemoError" &&
    "code" in error &&
    error.code === "thread_not_found"
  );
}

function ColorSwatchPicker({
  value,
  onChange,
}: {
  readonly value: MemoColor;
  readonly onChange: (color: MemoColor) => void;
}) {
  const gt = useGT();
  const colorName = (color: MemoColor): string => {
    switch (color) {
      case "amber":
        return gt("暖黄");
      case "sage":
        return gt("薄荷");
      case "sky":
        return gt("晴空");
      case "rose":
        return gt("蔷薇");
      case "lavender":
        return gt("薰衣草");
    }
  };

  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label={gt("便签颜色")}>
      {MEMO_COLORS.map((color) => {
        const active = color === value;
        const palette = MEMO_COLOR_PALETTE[color];
        const label = colorName(color);
        return (
          <Tooltip key={color}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={label}
                  onClick={() => onChange(color)}
                  className={cn(
                    "flex size-4.5 cursor-pointer items-center justify-center rounded-full border transition-transform outline-none hover:scale-110 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    palette.dot,
                    active && "scale-110 border-foreground shadow-xs",
                  )}
                >
                  {active ? <span className="size-1.5 rounded-full bg-background" /> : null}
                </button>
              }
            />
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

function MemoThreadBadge({
  environmentId,
  memo,
  onJumpToThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly memo: Memo;
  readonly onJumpToThread: (threadId: NonNullable<Memo["threadId"]>) => void;
}) {
  const gt = useGT();
  const threadRef = memo.threadId ? scopeThreadRef(environmentId, memo.threadId) : null;
  const threadShell = useThreadShell(threadRef);
  const projectId = threadShell?.projectId ?? memo.projectId;
  const project = useProject(projectId ? scopeProjectRef(environmentId, projectId) : null);

  if (memo.threadId === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-foreground/10 bg-background/55 px-2 py-0.5 text-2xs text-muted-foreground">
        <StickyNoteIcon className="size-3 opacity-75" />
        <span>{gt("独立便签")}</span>
      </span>
    );
  }

  const displayTitle = threadShell?.title?.trim() || memo.threadTitle?.trim() || gt("关联会话");
  const showProjectBadge = project !== null && !project.isScratch;
  const threadUnavailable = threadShell === null || threadShell.archivedAt !== null;

  if (threadUnavailable) {
    const unavailableHint =
      threadShell?.archivedAt !== null && threadShell !== null
        ? gt("原会话已归档，点「开始」可新开会话继续")
        : gt("原会话已移除，点「开始」可新开会话继续");
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex max-w-56 items-center gap-1.5 rounded-full border border-foreground/10 bg-background/45 px-2 py-0.5 text-2xs text-muted-foreground">
              <MessageSquareIcon className="size-3 shrink-0 opacity-60" />
              <span className="min-w-0 truncate line-through opacity-75">{displayTitle}</span>
            </span>
          }
        />
        <TooltipPopup side="top">{unavailableHint}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => {
              if (memo.threadId !== null) {
                onJumpToThread(memo.threadId);
              }
            }}
            className="inline-flex max-w-56 cursor-pointer items-center gap-1.5 rounded-full border border-foreground/12 bg-background/70 px-2 py-0.5 text-2xs text-foreground/85 transition-colors hover:border-foreground/25 hover:bg-background focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none dark:bg-background/45 dark:hover:bg-background/75"
          >
            <MessageSquareIcon className="size-3 shrink-0 text-warning-foreground" />
            <span className="min-w-0 truncate font-medium">{displayTitle}</span>
            {showProjectBadge ? (
              <span className="shrink-0 rounded-sm bg-foreground/8 px-1 py-px text-3xs text-muted-foreground">
                {project.title}
              </span>
            ) : null}
          </button>
        }
      />
      <TooltipPopup side="top">{gt("跳转到关联会话")}</TooltipPopup>
    </Tooltip>
  );
}

function MemoCard({
  environmentId,
  memo,
  busy,
  canOperate,
  nowMs,
  onToggleDone,
  onSaveEdit,
  onDelete,
  onStart,
  onJumpToThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly memo: Memo;
  readonly busy: boolean;
  readonly canOperate: boolean;
  readonly nowMs: number;
  readonly onToggleDone: (memo: Memo) => Promise<void>;
  readonly onSaveEdit: (
    memo: Memo,
    patch: { readonly title: string; readonly content: string; readonly color: MemoColor },
  ) => Promise<boolean>;
  readonly onDelete: (memo: Memo) => Promise<void>;
  readonly onStart: (memo: Memo) => Promise<void>;
  readonly onJumpToThread: (threadId: NonNullable<Memo["threadId"]>) => void;
}) {
  const gt = useGT();
  const resolveMessages = useMessages();
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(memo.title);
  const [editContent, setEditContent] = useState(memo.content);
  const [editColor, setEditColor] = useState<MemoColor>(memo.color);
  const [expanded, setExpanded] = useState(false);

  const palette = MEMO_COLOR_PALETTE[editing ? editColor : memo.color];
  const isDone = memo.status === "done";
  const hasLongContent = memo.content.length > 150 || memo.content.split("\n").length > 4;

  const statusLabel =
    memo.status === "in_progress"
      ? gt("进行中")
      : memo.status === "done"
        ? gt("已完成")
        : gt("待办");

  const statusPillClass =
    memo.status === "in_progress"
      ? "bg-warning/18 text-warning-foreground"
      : memo.status === "done"
        ? "bg-success/16 text-success-foreground"
        : "bg-foreground/8 text-foreground/75 dark:bg-foreground/12 dark:text-foreground/80";

  const relativeTime = formatRelativeTimeLabel(memo.updatedAt, nowMs, resolveMessages);

  const beginEdit = () => {
    setEditTitle(memo.title);
    setEditContent(memo.content);
    setEditColor(memo.color);
    setEditing(true);
  };

  const handleSave = async () => {
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) return;
    const saved = await onSaveEdit(memo, {
      title: trimmedTitle,
      content: editContent,
      color: editColor,
    });
    if (saved) {
      setEditing(false);
    }
  };

  const handleEditKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleSave();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
    }
  };

  return (
    <article
      className={cn(
        "group relative rounded-xl border p-3.5 pt-4 shadow-xs transition-[box-shadow,transform,opacity] hover:shadow-sm",
        palette.card,
        isDone && !editing && "opacity-75",
      )}
    >
      {/* Translucent top washi-tape strip */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute -top-1.5 left-1/2 h-2.5 w-14 -translate-x-1/2 rounded-xs",
          palette.tape,
        )}
      />
      {/* Subtle left accent bar */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-3 bottom-3 left-1.5 w-0.5 rounded-full opacity-75",
          palette.accentBar,
        )}
      />

      {editing ? (
        <div className="space-y-2.5 pl-2">
          <Input
            size="sm"
            value={editTitle}
            onChange={(event) => setEditTitle(event.target.value)}
            onKeyDown={handleEditKeyDown}
            placeholder={gt("便签标题")}
            autoFocus
          />
          <Textarea
            size="sm"
            rows={3}
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
            onKeyDown={handleEditKeyDown}
            placeholder={gt("补充细节或上下文（可选）...")}
          />
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <ColorSwatchPicker value={editColor} onChange={setEditColor} />
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={busy}
              >
                <XIcon className="size-3.5" />
                <span>{gt("取消")}</span>
              </Button>
              <Button
                type="button"
                size="xs"
                onClick={() => void handleSave()}
                disabled={busy || editTitle.trim().length === 0}
              >
                <CheckIcon className="size-3.5" />
                <span>{gt("保存")}</span>
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5 pl-2">
          {/* Top bar: status toggle + status pill + time + actions */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={isDone ? gt("标记为待办") : gt("标记为已完成")}
                      onClick={() => void onToggleDone(memo)}
                      className="mt-px shrink-0 cursor-pointer rounded-full text-foreground/65 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
                    >
                      {isDone ? (
                        <CheckCircle2Icon className="size-4 text-success-foreground" />
                      ) : (
                        <CircleIcon className="size-4" />
                      )}
                    </button>
                  }
                />
                <TooltipPopup side="top">
                  {isDone ? gt("标记为待办") : gt("标记为已完成")}
                </TooltipPopup>
              </Tooltip>

              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-3xs font-medium leading-none",
                  statusPillClass,
                )}
              >
                {statusLabel}
              </span>

              {relativeTime ? (
                <span className="truncate text-2xs text-muted-foreground">{relativeTime}</span>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-0.5 opacity-80 transition-opacity group-hover:opacity-100">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-label={gt("编辑便签")}
                      disabled={busy || !canOperate}
                      onClick={beginEdit}
                    >
                      <PencilIcon className="size-3" />
                    </Button>
                  }
                />
                <TooltipPopup side="top">{gt("编辑")}</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-destructive"
                      aria-label={gt("删除便签")}
                      disabled={busy || !canOperate}
                      onClick={() => void onDelete(memo)}
                    >
                      <Trash2Icon className="size-3" />
                    </Button>
                  }
                />
                <TooltipPopup side="top">{gt("删除")}</TooltipPopup>
              </Tooltip>
            </div>
          </div>

          {/* Note title & body */}
          <div className="space-y-1">
            <h3
              className={cn(
                "wrap-break-word text-sm font-medium leading-snug text-foreground",
                isDone && "line-through opacity-65",
              )}
            >
              {memo.title}
            </h3>
            {memo.content.trim().length > 0 ? (
              <div>
                <p
                  className={cn(
                    "whitespace-pre-wrap wrap-break-word text-xs leading-relaxed text-foreground/80",
                    !expanded && hasLongContent && "line-clamp-4",
                    isDone && "opacity-65",
                  )}
                >
                  {memo.content}
                </p>
                {hasLongContent ? (
                  <button
                    type="button"
                    onClick={() => setExpanded((prev) => !prev)}
                    className="mt-0.5 cursor-pointer text-2xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {expanded ? gt("收起") : gt("展开全文")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Footer: thread binding badge + prominent Start button */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <MemoThreadBadge
              environmentId={environmentId}
              memo={memo}
              onJumpToThread={onJumpToThread}
            />

            {!isDone ? (
              <Button
                type="button"
                size="xs"
                variant="default"
                disabled={busy || !canOperate}
                onClick={() => void onStart(memo)}
              >
                {busy ? (
                  <Spinner className="size-3" />
                ) : (
                  <PlayIcon className="size-3 fill-current" />
                )}
                <span>{gt("开始")}</span>
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </article>
  );
}

export function MemoDrawer() {
  const gt = useGT();
  const resolveMessages = useMessages();
  const navigate = useNavigate();
  const isOpen = useMemoDrawerStore((state) => state.isOpen);
  const setOpen = useMemoDrawerStore((state) => state.setOpen);
  const close = useMemoDrawerStore((state) => state.close);
  const activeEnvironmentId = useActiveMemoEnvironmentId();

  const memosResult = useAtomValue(
    activeEnvironmentId
      ? serverEnvironment.memosLive({ environmentId: activeEnvironmentId, input: {} })
      : EMPTY_MEMOS_ATOM,
  );
  const canOperate = useAtomValue(
    activeEnvironmentId
      ? serverEnvironment.memosCreate.permissionAtom(activeEnvironmentId)
      : ALLOW_OPERATE_ATOM,
  );
  const memos = AsyncResult.getOrElse(memosResult, () => ({ memos: [] })).memos;

  const createMemo = useAtomCommand(serverEnvironment.memosCreate, {
    label: "memo create",
    reportFailure: false,
  });
  const updateMemo = useAtomCommand(serverEnvironment.memosUpdate, {
    label: "memo update",
    reportFailure: false,
  });
  const deleteMemo = useAtomCommand(serverEnvironment.memosDelete, {
    label: "memo delete",
    reportFailure: false,
  });
  const startMemo = useAtomCommand(serverEnvironment.memosStart, {
    label: "memo start",
    reportFailure: false,
  });

  const [filter, setFilter] = useState<MemoFilter>("all");
  const [composerTitle, setComposerTitle] = useState("");
  const [composerContent, setComposerContent] = useState("");
  const [composerColor, setComposerColor] = useState<MemoColor>("amber");
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyMemoId, setBusyMemoId] = useState<string | null>(null);
  const [launchState, setLaunchState] = useState<{
    readonly memo: Memo;
    readonly nonce: number;
  } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  let todoCount = 0;
  let inProgressCount = 0;
  let doneCount = 0;
  for (const memo of memos) {
    if (memo.status === "todo") todoCount += 1;
    else if (memo.status === "in_progress") inProgressCount += 1;
    else doneCount += 1;
  }
  const countsByFilter: Readonly<Record<MemoFilter, number>> = {
    all: memos.length,
    todo: todoCount,
    in_progress: inProgressCount,
    done: doneCount,
  };

  const activeCount = countActiveMemos(memos);
  const activeCountLabel = formatMemoBadgeCount(activeCount);
  const filteredMemos = filterMemos(memos, filter);
  const composerPalette = MEMO_COLOR_PALETTE[composerColor];

  const openLaunchDialog = (memo: Memo) => {
    setLaunchState((prev) => ({ memo, nonce: (prev?.nonce ?? 0) + 1 }));
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setNowMs(Date.now());
    }
    setOpen(nextOpen);
  };

  const navigateToThread = (
    environmentId: EnvironmentId,
    threadId: MemoStartResult["threadId"],
  ) => {
    close();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };

  const reportErrorToast = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description:
        (error instanceof Error ? thrownErrorMessage(error, resolveMessages) : null) ??
        gt("请稍后重试。"),
    });
  };

  const handleCreate = async () => {
    const trimmedTitle = composerTitle.trim();
    if (!activeEnvironmentId || !canOperate || !trimmedTitle || creating) return;
    setCreating(true);
    const result = await createMemo({
      environmentId: activeEnvironmentId,
      input: {
        title: trimmedTitle,
        ...(composerContent.trim().length > 0 ? { content: composerContent.trim() } : {}),
        color: composerColor,
        source: "manual",
      },
    });
    setCreating(false);
    if (result._tag === "Success") {
      setComposerTitle("");
      setComposerContent("");
      setComposerExpanded(false);
      setNowMs(Date.now());
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportErrorToast(gt("添加便签失败"), squashAtomCommandFailure(result));
    }
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void handleCreate();
    }
  };

  const handleToggleDone = async (memo: Memo) => {
    if (!activeEnvironmentId || !canOperate || busyMemoId !== null) return;
    setBusyMemoId(memo.id);
    const result = await updateMemo({
      environmentId: activeEnvironmentId,
      input: {
        id: memo.id,
        status: memo.status === "done" ? "todo" : "done",
      },
    });
    setBusyMemoId(null);
    if (result._tag === "Success") {
      setNowMs(Date.now());
    } else if (!isAtomCommandInterrupted(result)) {
      reportErrorToast(gt("更新便签失败"), squashAtomCommandFailure(result));
    }
  };

  const handleSaveEdit = async (
    memo: Memo,
    patch: { readonly title: string; readonly content: string; readonly color: MemoColor },
  ): Promise<boolean> => {
    if (!activeEnvironmentId || !canOperate || busyMemoId !== null) return false;
    setBusyMemoId(memo.id);
    const result = await updateMemo({
      environmentId: activeEnvironmentId,
      input: {
        id: memo.id,
        title: patch.title,
        content: patch.content,
        color: patch.color,
      },
    });
    setBusyMemoId(null);
    if (result._tag === "Success") {
      setNowMs(Date.now());
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      reportErrorToast(gt("保存便签失败"), squashAtomCommandFailure(result));
    }
    return false;
  };

  const handleDelete = async (memo: Memo) => {
    if (!activeEnvironmentId || !canOperate || busyMemoId !== null) return;
    setBusyMemoId(memo.id);
    const result = await deleteMemo({
      environmentId: activeEnvironmentId,
      input: { id: memo.id },
    });
    setBusyMemoId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportErrorToast(gt("删除便签失败"), squashAtomCommandFailure(result));
    }
  };

  const handleStart = async (memo: Memo) => {
    if (!activeEnvironmentId || !canOperate || busyMemoId !== null) return;
    if (memo.threadId === null) {
      openLaunchDialog(memo);
      return;
    }

    setBusyMemoId(memo.id);
    const result = await startMemo({
      environmentId: activeEnvironmentId,
      input: { id: memo.id },
    });
    setBusyMemoId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: result.value.queued ? gt("会话正在执行中，待办已自动加入队列") : gt("已激活待办"),
      });
      navigateToThread(activeEnvironmentId, result.value.threadId);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      if (isThreadNotFoundError(error)) {
        toastManager.add({
          type: "warning",
          title: gt("原会话已不存在或已归档，请确认配置后新开会话"),
        });
        openLaunchDialog(memo);
        return;
      }
      reportErrorToast(gt("激活待办失败"), error);
    }
  };

  const handleLaunchDialogStarted = (result: MemoStartResult) => {
    setLaunchState(null);
    toastManager.add({
      type: "success",
      title: result.queued ? gt("会话正在执行中，待办已自动加入队列") : gt("已为便签创建会话"),
    });
    if (activeEnvironmentId) {
      navigateToThread(activeEnvironmentId, result.threadId);
    }
  };

  const filterTabs: ReadonlyArray<{ readonly id: MemoFilter; readonly label: string }> = [
    { id: "all", label: gt("全部") },
    { id: "todo", label: gt("待办") },
    { id: "in_progress", label: gt("进行中") },
    { id: "done", label: gt("已完成") },
  ];

  return (
    <Sheet open={isOpen} onOpenChange={handleOpenChange}>
      <SheetPopup side="right" variant="inset" className="overflow-hidden">
        {/* Warm desk header */}
        <div className="shrink-0 border-b border-border/70 bg-warning/6">
          <SheetHeader>
            <div className="flex items-center gap-2.5 pr-8">
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-warning/16 text-warning-foreground shadow-xs ring-1 ring-inset ring-warning/30">
                <StickyNoteIcon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <SheetTitle>{gt("待办便签")}</SheetTitle>
                  {activeCountLabel !== null ? (
                    <Badge size="sm" variant="warning">
                      {activeCountLabel}
                    </Badge>
                  ) : null}
                </div>
                <SheetDescription>
                  {gt("随手记下想法，点「开始」立刻交给 Agent 执行")}
                </SheetDescription>
              </div>
            </div>

            {/* Filter pills */}
            <div
              className="flex items-center gap-1 pt-1"
              role="tablist"
              aria-label={gt("筛选便签")}
            >
              {filterTabs.map((tab) => {
                const active = filter === tab.id;
                const tabCount = countsByFilter[tab.id];
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setFilter(tab.id)}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      active
                        ? "bg-warning/18 text-warning-foreground ring-1 ring-inset ring-warning/35"
                        : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                    )}
                  >
                    <span>{tab.label}</span>
                    <span className="text-3xs opacity-70 tabular-nums">{tabCount}</span>
                  </button>
                );
              })}
            </div>
          </SheetHeader>
        </div>

        {/* Quick-Pin sticky-note composer */}
        <div className="shrink-0 border-b border-border/60 px-5 py-3.5">
          <div
            className={cn(
              "relative rounded-xl border p-3 pt-3.5 shadow-xs transition-colors",
              composerPalette.card,
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute -top-1.5 left-1/2 h-2.5 w-14 -translate-x-1/2 rounded-xs",
                composerPalette.tape,
              )}
            />
            <div className="space-y-2">
              <Input
                size="sm"
                value={composerTitle}
                onFocus={() => setComposerExpanded(true)}
                onChange={(event) => setComposerTitle(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={gt("写一条待办便签...")}
                disabled={!activeEnvironmentId || !canOperate || creating}
              />
              {composerExpanded || composerContent.length > 0 ? (
                <Textarea
                  size="sm"
                  rows={2}
                  value={composerContent}
                  onChange={(event) => setComposerContent(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={gt("补充细节或上下文（可选，Ctrl/Cmd+Enter 贴上）...")}
                  disabled={!activeEnvironmentId || !canOperate || creating}
                />
              ) : null}
              <div className="flex items-center justify-between gap-2 pt-0.5">
                <ColorSwatchPicker value={composerColor} onChange={setComposerColor} />
                <Button
                  type="button"
                  size="xs"
                  disabled={
                    !activeEnvironmentId ||
                    !canOperate ||
                    creating ||
                    composerTitle.trim().length === 0
                  }
                  onClick={() => void handleCreate()}
                >
                  {creating ? <Spinner className="size-3" /> : <PinIcon className="size-3" />}
                  <span>{gt("贴上便签")}</span>
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Sticky-note list */}
        <div className="min-h-0 flex-1">
          <ScrollArea scrollFade className="h-full">
            <div className="space-y-3.5 px-5 py-4">
              {!activeEnvironmentId ? (
                <div className="rounded-xl border border-dashed border-border/80 bg-muted/25 px-4 py-8 text-center text-xs text-muted-foreground">
                  {gt("尚未连接到工作区环境，连接后即可使用待办便签。")}
                </div>
              ) : filteredMemos.length === 0 ? (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-warning/35 bg-warning-surface/60 px-5 py-10 text-center">
                  <span className="mb-2.5 inline-flex size-10 items-center justify-center rounded-2xl bg-warning/14 text-warning-foreground">
                    <StickyNoteIcon className="size-5" />
                  </span>
                  <p className="text-sm font-medium text-foreground">
                    {filter === "all" ? gt("便签墙还是空的") : gt("当前分类下没有便签")}
                  </p>
                  <p className="mt-1 max-w-64 text-xs text-muted-foreground">
                    {filter === "all"
                      ? gt("在上方写下你的下一条灵感或待办，或者让 Agent 帮你记录。")
                      : gt("切换到「全部」查看其它便签，或在上方贴一条新的。")}
                  </p>
                </div>
              ) : (
                filteredMemos.map((memo) => (
                  <MemoCard
                    key={memo.id}
                    environmentId={activeEnvironmentId}
                    memo={memo}
                    busy={busyMemoId === memo.id}
                    canOperate={canOperate}
                    nowMs={nowMs}
                    onToggleDone={handleToggleDone}
                    onSaveEdit={handleSaveEdit}
                    onDelete={handleDelete}
                    onStart={handleStart}
                    onJumpToThread={(threadId) => navigateToThread(activeEnvironmentId, threadId)}
                  />
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Nested inside SheetPopup so Base UI Escape closes only this dialog, not the drawer */}
        <MemoStartDialog
          open={launchState !== null}
          memo={launchState?.memo ?? null}
          instanceKey={launchState ? `${launchState.memo.id}:${launchState.nonce}` : undefined}
          environmentId={activeEnvironmentId}
          onOpenChange={(open) => {
            if (!open) setLaunchState(null);
          }}
          onStarted={handleLaunchDialogStarted}
        />
      </SheetPopup>
    </Sheet>
  );
}

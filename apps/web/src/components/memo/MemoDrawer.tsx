import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  MemoError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  isProviderSendTurnSupportedImageMimeType,
  type ChatAttachmentId,
  type ChatImageAttachment,
  type EnvironmentId,
  type Memo,
  type MemoColor,
  type MemoStartResult,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useGT, useMessages } from "gt-react";
import {
  CheckCircle2Icon,
  CheckIcon,
  CircleIcon,
  ImageIcon,
  ImagePlusIcon,
  MessageSquareIcon,
  PencilIcon,
  PinIcon,
  PlayIcon,
  StickyNoteIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import { useAssetUrlState } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { readFileAsDataUrl } from "../../lib/imageCompression";
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
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { MemoSidebarIcon } from "./MemoSidebarIcon";
import { MemoStartDialog } from "./MemoStartDialog";
import { countActiveMemos, filterMemos, type MemoFilter } from "./memoLaunch.logic";
import { MEMO_COLORS, MEMO_PAPER_PALETTE, MemoPaperFold, MemoPaperTape } from "./memoPaper";

const MAX_MEMO_IMAGE_ATTACHMENTS = 8;
const MEMO_IMAGE_ACCEPT = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.join(",");

interface PendingMemoImage extends UploadChatImageAttachment {
  readonly localKey: string;
}

interface PreviewMemoImage {
  readonly src: string;
  readonly name: string;
}

let pendingMemoImageSeq = 0;

function extensionForImageMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

function extractClipboardImageFiles(clipboardData: DataTransfer | null): ReadonlyArray<File> {
  if (!clipboardData) return [];
  const files: File[] = [];
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind === "file" && item.type.toLowerCase().startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

async function readMemoImageFiles(
  files: ReadonlyArray<File>,
  existingCount: number,
): Promise<{
  readonly added: ReadonlyArray<PendingMemoImage>;
  readonly errors: ReadonlyArray<string>;
}> {
  const added: PendingMemoImage[] = [];
  const errors: string[] = [];
  let remaining = Math.max(0, MAX_MEMO_IMAGE_ATTACHMENTS - existingCount);

  for (const file of files) {
    if (remaining <= 0) {
      errors.push(`每条便签最多支持 ${MAX_MEMO_IMAGE_ATTACHMENTS} 张图片。`);
      break;
    }
    const mimeType = file.type.toLowerCase();
    if (!isProviderSendTurnSupportedImageMimeType(mimeType)) {
      errors.push(
        `不支持的图片格式：${file.name || mimeType || "未知"}（仅支持 PNG/JPG/WebP/GIF）。`,
      );
      continue;
    }
    if (file.size <= 0 || file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      errors.push(`图片「${file.name || "截图"}」超过 10MB 限制。`);
      continue;
    }
    const dataUrl = await readFileAsDataUrl(file).catch(() => null);
    if (!dataUrl) {
      errors.push(`读取图片「${file.name || "截图"}」失败。`);
      continue;
    }
    pendingMemoImageSeq += 1;
    const ext = extensionForImageMimeType(mimeType);
    const trimmedName = file.name.trim();
    const name =
      trimmedName.length > 0 && trimmedName.length <= 255
        ? trimmedName
        : `pasted-image-${pendingMemoImageSeq}.${ext}`;
    added.push({
      localKey: `pending-memo-img-${pendingMemoImageSeq}`,
      type: "image",
      name,
      mimeType,
      sizeBytes: file.size,
      dataUrl,
    });
    remaining -= 1;
  }

  return { added, errors };
}

function MemoPersistedAttachmentThumb({
  environmentId,
  attachment,
  removable = false,
  onRemove,
  onPreview,
}: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatImageAttachment;
  readonly removable?: boolean;
  readonly onRemove?: () => void;
  readonly onPreview: (image: PreviewMemoImage) => void;
}) {
  const gt = useGT();
  const assetUrl = useAssetUrlState(environmentId, {
    _tag: "attachment",
    attachmentId: attachment.id,
    fileName: attachment.name,
    mimeType: attachment.mimeType,
    disposition: "inline",
  });
  const src = assetUrl._tag === "Success" ? assetUrl.url : null;

  return (
    <div className="group/thumb relative size-14 shrink-0 overflow-hidden rounded-md bg-background/70 shadow-xs ring-1 ring-foreground/10 dark:bg-background/40 dark:ring-foreground/12">
      {src ? (
        <button
          type="button"
          onClick={() => onPreview({ src, name: attachment.name })}
          aria-label={attachment.name}
          className="block size-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <img
            src={src}
            alt={attachment.name}
            className="size-full object-cover transition-transform duration-200 motion-safe:group-hover/thumb:scale-105"
          />
        </button>
      ) : (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          <ImageIcon className="size-4 opacity-50" />
        </div>
      )}
      {removable && onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={gt("移除图片")}
          className="absolute top-0.5 right-0.5 inline-flex size-4.5 cursor-pointer items-center justify-center rounded-full bg-popover/90 text-muted-foreground opacity-0 shadow-xs ring-1 ring-border/70 backdrop-blur-xs transition-[opacity,color] outline-none group-hover/thumb:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:opacity-100"
        >
          <XIcon className="size-2.5" />
        </button>
      ) : null}
    </div>
  );
}

function MemoPendingAttachmentThumb({
  attachment,
  onRemove,
  onPreview,
}: {
  readonly attachment: PendingMemoImage;
  readonly onRemove: () => void;
  readonly onPreview: (image: PreviewMemoImage) => void;
}) {
  const gt = useGT();
  return (
    <div className="group/thumb relative size-14 shrink-0 overflow-hidden rounded-md bg-background/70 shadow-xs ring-1 ring-foreground/10 dark:bg-background/40 dark:ring-foreground/12">
      <button
        type="button"
        onClick={() => onPreview({ src: attachment.dataUrl, name: attachment.name })}
        aria-label={attachment.name}
        className="block size-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <img
          src={attachment.dataUrl}
          alt={attachment.name}
          className="size-full object-cover transition-transform duration-200 motion-safe:group-hover/thumb:scale-105"
        />
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={gt("移除图片")}
        className="absolute top-0.5 right-0.5 inline-flex size-4.5 cursor-pointer items-center justify-center rounded-full bg-popover/90 text-muted-foreground opacity-0 shadow-xs ring-1 ring-border/70 backdrop-blur-xs transition-[opacity,color] outline-none group-hover/thumb:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:opacity-100"
      >
        <XIcon className="size-2.5" />
      </button>
    </div>
  );
}

function PaperTitleInput(props: ComponentProps<"input">) {
  return (
    <input
      type="text"
      {...props}
      className="w-full min-w-0 bg-transparent text-sm leading-snug font-semibold text-foreground outline-none placeholder:font-normal placeholder:text-foreground/40 disabled:cursor-not-allowed disabled:opacity-60"
    />
  );
}

function PaperBodyTextarea(props: ComponentProps<"textarea">) {
  return (
    <textarea
      {...props}
      className="field-sizing-content max-h-48 min-h-10 w-full resize-none bg-transparent text-xs leading-relaxed text-foreground/85 outline-none placeholder:text-foreground/40 disabled:cursor-not-allowed disabled:opacity-60"
    />
  );
}

function PaperFooterDivider() {
  return <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-foreground/12" />;
}
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
    <div className="flex items-center gap-0.5" role="radiogroup" aria-label={gt("便签颜色")}>
      {MEMO_COLORS.map((color) => {
        const active = color === value;
        const palette = MEMO_PAPER_PALETTE[color];
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
                    "group/swatch flex size-6 cursor-pointer items-center justify-center rounded-full transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    active
                      ? "ring-2 ring-foreground/35 ring-inset"
                      : "hover:ring-1 hover:ring-foreground/15 hover:ring-inset",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full shadow-2xs ring-1 ring-foreground/15 ring-inset transition-transform motion-safe:group-hover/swatch:scale-110",
                      palette.swatch,
                    )}
                  >
                    {active ? <span className="size-1.5 rounded-full bg-popover" /> : null}
                  </span>
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
      <span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-2 py-0.5 text-2xs text-muted-foreground">
        <StickyNoteIcon className="size-3 opacity-70" />
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
            <span className="inline-flex max-w-56 items-center gap-1.5 rounded-full bg-foreground/5 px-2 py-0.5 text-2xs text-muted-foreground">
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
            className="inline-flex max-w-56 cursor-pointer items-center gap-1.5 rounded-full bg-background/65 px-2 py-0.5 text-2xs text-foreground/85 shadow-2xs ring-1 ring-foreground/8 transition-[background-color,box-shadow,color] hover:bg-background hover:text-foreground hover:ring-foreground/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none dark:bg-background/35 dark:hover:bg-background/60"
          >
            <MessageSquareIcon className="size-3 shrink-0 opacity-70" />
            <span className="min-w-0 truncate font-medium">{displayTitle}</span>
            {showProjectBadge ? (
              <span className="shrink-0 rounded-sm bg-foreground/6 px-1 py-px text-3xs text-muted-foreground">
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
  onPreviewImage,
}: {
  readonly environmentId: EnvironmentId;
  readonly memo: Memo;
  readonly busy: boolean;
  readonly canOperate: boolean;
  readonly nowMs: number;
  readonly onToggleDone: (memo: Memo) => Promise<void>;
  readonly onSaveEdit: (
    memo: Memo,
    patch: {
      readonly title: string;
      readonly content: string;
      readonly color: MemoColor;
      readonly keepAttachmentIds: ReadonlyArray<ChatAttachmentId>;
      readonly attachments: ReadonlyArray<UploadChatImageAttachment>;
    },
  ) => Promise<boolean>;
  readonly onDelete: (memo: Memo) => Promise<void>;
  readonly onStart: (memo: Memo) => Promise<void>;
  readonly onJumpToThread: (threadId: NonNullable<Memo["threadId"]>) => void;
  readonly onPreviewImage: (image: PreviewMemoImage) => void;
}) {
  const gt = useGT();
  const resolveMessages = useMessages();
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(memo.title);
  const [editContent, setEditContent] = useState(memo.content);
  const [editColor, setEditColor] = useState<MemoColor>(memo.color);
  const [editKeptAttachments, setEditKeptAttachments] = useState<
    ReadonlyArray<ChatImageAttachment>
  >(memo.attachments);
  const [editAddedAttachments, setEditAddedAttachments] = useState<ReadonlyArray<PendingMemoImage>>(
    [],
  );
  const [expanded, setExpanded] = useState(false);
  const editFileInputRef = useRef<HTMLInputElement | null>(null);

  const palette = MEMO_PAPER_PALETTE[editing ? editColor : memo.color];
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
      ? "bg-warning/16 text-warning-foreground"
      : memo.status === "done"
        ? "bg-success/14 text-success-foreground"
        : "bg-foreground/6 text-foreground/65";
  const relativeTime = formatRelativeTimeLabel(memo.updatedAt, nowMs, resolveMessages);

  const beginEdit = () => {
    setEditTitle(memo.title);
    setEditContent(memo.content);
    setEditColor(memo.color);
    setEditKeptAttachments(memo.attachments);
    setEditAddedAttachments([]);
    setEditing(true);
  };

  const appendEditImageFiles = async (files: ReadonlyArray<File>) => {
    if (files.length === 0) return;
    const { added, errors } = await readMemoImageFiles(
      files,
      editKeptAttachments.length + editAddedAttachments.length,
    );
    if (added.length > 0) {
      setEditAddedAttachments((prev) => [...prev, ...added]);
    }
    if (errors.length > 0) {
      toastManager.add({
        type: "warning",
        title: gt("部分图片未添加"),
        description: errors[0],
      });
    }
  };

  const handleEditPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = extractClipboardImageFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void appendEditImageFiles(files);
  };

  const handleEditFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    if (files.length > 0) {
      void appendEditImageFiles(files);
    }
  };

  const handleSave = async () => {
    const trimmedTitle = editTitle.trim();
    if (!trimmedTitle) return;
    const saved = await onSaveEdit(memo, {
      title: trimmedTitle,
      content: editContent,
      color: editColor,
      keepAttachmentIds: editKeptAttachments.map((attachment) => attachment.id),
      attachments: editAddedAttachments.map(({ localKey: _localKey, ...upload }) => upload),
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
        "group/memo relative rounded-lg px-4 pt-4.5 pb-3 shadow-xs ring-1 ring-inset transition-[box-shadow,translate,opacity,filter] duration-200 hover:shadow-md motion-safe:hover:-translate-y-px",
        palette.paper,
        editing && "shadow-md ring-2",
        editing && palette.focus,
        isDone && !editing && "opacity-70 saturate-50 hover:opacity-95 hover:saturate-100",
      )}
    >
      <MemoPaperTape />
      <MemoPaperFold fold={palette.fold} />

      {editing ? (
        <div className="space-y-2" onPaste={handleEditPaste}>
          <input
            ref={editFileInputRef}
            type="file"
            accept={MEMO_IMAGE_ACCEPT}
            multiple
            className="hidden"
            onChange={handleEditFileChange}
          />
          <PaperTitleInput
            value={editTitle}
            onChange={(event) => setEditTitle(event.target.value)}
            onKeyDown={handleEditKeyDown}
            placeholder={gt("便签标题")}
            aria-label={gt("便签标题")}
            autoFocus
          />
          <PaperBodyTextarea
            rows={3}
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
            onKeyDown={handleEditKeyDown}
            placeholder={gt("补充细节或上下文（可直接 Ctrl+V 粘贴截图）...")}
            aria-label={gt("便签内容")}
          />
          {editKeptAttachments.length > 0 || editAddedAttachments.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {editKeptAttachments.map((attachment) => (
                <MemoPersistedAttachmentThumb
                  key={attachment.id}
                  environmentId={environmentId}
                  attachment={attachment}
                  removable
                  onRemove={() =>
                    setEditKeptAttachments((prev) =>
                      prev.filter((item) => item.id !== attachment.id),
                    )
                  }
                  onPreview={onPreviewImage}
                />
              ))}
              {editAddedAttachments.map((attachment) => (
                <MemoPendingAttachmentThumb
                  key={attachment.localKey}
                  attachment={attachment}
                  onRemove={() =>
                    setEditAddedAttachments((prev) =>
                      prev.filter((item) => item.localKey !== attachment.localKey),
                    )
                  }
                  onPreview={onPreviewImage}
                />
              ))}
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2 border-t border-dashed border-foreground/12 pt-2.5">
            <div className="flex items-center gap-2">
              <ColorSwatchPicker value={editColor} onChange={setEditColor} />
              <PaperFooterDivider />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={gt("添加图片")}
                      disabled={
                        busy ||
                        editKeptAttachments.length + editAddedAttachments.length >=
                          MAX_MEMO_IMAGE_ATTACHMENTS
                      }
                      onClick={() => editFileInputRef.current?.click()}
                    >
                      <ImagePlusIcon className="size-3.5" />
                    </Button>
                  }
                />
                <TooltipPopup side="top">{gt("添加图片（也支持直接粘贴）")}</TooltipPopup>
              </Tooltip>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                onClick={() => setEditing(false)}
                disabled={busy}
              >
                <span>{gt("取消")}</span>
              </Button>
              <Button
                type="button"
                size="xs"
                onClick={() => void handleSave()}
                disabled={busy || editTitle.trim().length === 0}
              >
                {busy ? <Spinner className="size-3" /> : <CheckIcon className="size-3.5" />}
                <span>{gt("保存")}</span>
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div>
          {/* Status row: completion toggle, status, time, quiet actions */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={isDone ? gt("标记为待办") : gt("标记为已完成")}
                      onClick={() => void onToggleDone(memo)}
                      className="group/check shrink-0 cursor-pointer rounded-full text-foreground/40 transition-colors hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isDone ? (
                        <CheckCircle2Icon className="size-4 text-success-foreground" />
                      ) : (
                        <>
                          <CircleIcon className="size-4 group-hover/check:hidden" />
                          <CheckCircle2Icon className="hidden size-4 group-hover/check:block" />
                        </>
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
                  "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs leading-none font-medium",
                  statusPillClass,
                )}
              >
                {memo.status === "in_progress" ? (
                  <span
                    aria-hidden="true"
                    className="size-1.5 rounded-full bg-warning motion-safe:animate-pulse"
                  />
                ) : null}
                {statusLabel}
              </span>

              {relativeTime ? (
                <span className="truncate text-2xs text-muted-foreground tabular-nums">
                  {relativeTime}
                </span>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within/memo:opacity-100 group-hover/memo:opacity-100 pointer-coarse:opacity-100">
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
          <h3
            className={cn(
              "mt-2.5 text-sm leading-snug font-semibold tracking-tight wrap-break-word text-foreground",
              isDone && "text-foreground/70 line-through decoration-foreground/30",
            )}
          >
            {memo.title}
          </h3>
          {memo.content.trim().length > 0 ? (
            <div className="mt-1.5">
              <p
                className={cn(
                  "text-xs leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground/75",
                  !expanded && hasLongContent && "line-clamp-4",
                )}
              >
                {memo.content}
              </p>
              {hasLongContent ? (
                <button
                  type="button"
                  onClick={() => setExpanded((prev) => !prev)}
                  className="mt-1 cursor-pointer rounded-sm text-2xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none"
                >
                  {expanded ? gt("收起") : gt("展开全文")}
                </button>
              ) : null}
            </div>
          ) : null}

          {/* Persisted image thumbnails */}
          {memo.attachments.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {memo.attachments.map((attachment) => (
                <MemoPersistedAttachmentThumb
                  key={attachment.id}
                  environmentId={environmentId}
                  attachment={attachment}
                  onPreview={onPreviewImage}
                />
              ))}
            </div>
          ) : null}

          {/* Footer: thread binding + Start (todo only) */}
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-dashed border-foreground/12 pt-2.5">
            <MemoThreadBadge
              environmentId={environmentId}
              memo={memo}
              onJumpToThread={onJumpToThread}
            />

            {memo.status === "todo" ? (
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
  const [composerAttachments, setComposerAttachments] = useState<ReadonlyArray<PendingMemoImage>>(
    [],
  );
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyMemoId, setBusyMemoId] = useState<string | null>(null);
  const [launchState, setLaunchState] = useState<{
    readonly memo: Memo;
    readonly nonce: number;
  } | null>(null);
  const [previewImage, setPreviewImage] = useState<PreviewMemoImage | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);

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
  const filteredMemos = filterMemos(memos, filter);
  const composerPalette = MEMO_PAPER_PALETTE[composerColor];

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

  const appendComposerImageFiles = async (files: ReadonlyArray<File>) => {
    if (files.length === 0) return;
    const { added, errors } = await readMemoImageFiles(files, composerAttachments.length);
    if (added.length > 0) {
      setComposerExpanded(true);
      setComposerAttachments((prev) => [...prev, ...added]);
    }
    if (errors.length > 0) {
      toastManager.add({
        type: "warning",
        title: gt("部分图片未添加"),
        description: errors[0],
      });
    }
  };

  const handleComposerPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = extractClipboardImageFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void appendComposerImageFiles(files);
  };

  const handleComposerFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    if (files.length > 0) {
      void appendComposerImageFiles(files);
    }
  };

  const handleCreate = async () => {
    const trimmedTitle = composerTitle.trim();
    if (!activeEnvironmentId || !canOperate || !trimmedTitle || creating) return;
    setCreating(true);
    const uploadAttachments = composerAttachments.map(
      ({ localKey: _localKey, ...upload }) => upload,
    );
    const result = await createMemo({
      environmentId: activeEnvironmentId,
      input: {
        title: trimmedTitle,
        ...(composerContent.trim().length > 0 ? { content: composerContent.trim() } : {}),
        color: composerColor,
        source: "manual",
        ...(uploadAttachments.length > 0 ? { attachments: uploadAttachments } : {}),
      },
    });
    setCreating(false);
    if (result._tag === "Success") {
      setComposerTitle("");
      setComposerContent("");
      setComposerAttachments([]);
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
    patch: {
      readonly title: string;
      readonly content: string;
      readonly color: MemoColor;
      readonly keepAttachmentIds: ReadonlyArray<ChatAttachmentId>;
      readonly attachments: ReadonlyArray<UploadChatImageAttachment>;
    },
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
        keepAttachmentIds: patch.keepAttachmentIds,
        ...(patch.attachments.length > 0 ? { attachments: patch.attachments } : {}),
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
      title: result.queued
        ? gt("会话正在执行中，待办已自动加入队列")
        : result.createdNewThread
          ? gt("已为便签创建会话")
          : gt("已将待办发送到会话"),
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
        {/* Header */}
        <div className="shrink-0 border-b border-border/60 bg-linear-to-b from-warning/7 to-transparent">
          <SheetHeader>
            <div className="flex items-center gap-3 pr-8">
              <span className="inline-flex size-10 shrink-0 -rotate-3 items-center justify-center rounded-lg bg-linear-to-b from-warning/24 to-warning/12 text-warning-foreground shadow-xs ring-1 ring-warning/30 ring-inset">
                <MemoSidebarIcon count={activeCount} className="size-6" />
              </span>
              <div className="min-w-0 flex-1">
                <SheetTitle>{gt("待办便签")}</SheetTitle>
                <SheetDescription>
                  {gt("随手记下想法，点「开始」立刻交给 Agent 执行")}
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>
        </div>

        {/* Quick-Pin composer: a fresh blank sticky note */}
        <div className="shrink-0 px-5 pt-6 pb-4">
          <div
            onPaste={handleComposerPaste}
            className={cn(
              "relative rounded-lg px-4 pt-4.5 pb-3 shadow-xs ring-1 ring-inset transition-[box-shadow,background-color] duration-200 focus-within:shadow-md focus-within:ring-2",
              composerPalette.paper,
              composerPalette.focus,
            )}
          >
            <input
              ref={composerFileInputRef}
              type="file"
              accept={MEMO_IMAGE_ACCEPT}
              multiple
              className="hidden"
              onChange={handleComposerFileChange}
            />
            <MemoPaperTape />
            <MemoPaperFold fold={composerPalette.fold} />
            <div className="space-y-2">
              <PaperTitleInput
                value={composerTitle}
                onFocus={() => setComposerExpanded(true)}
                onChange={(event) => setComposerTitle(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder={gt("写一条待办便签（支持 Ctrl+V 粘贴截图）...")}
                aria-label={gt("便签标题")}
                disabled={!activeEnvironmentId || !canOperate || creating}
              />
              {composerExpanded || composerContent.length > 0 || composerAttachments.length > 0 ? (
                <PaperBodyTextarea
                  rows={2}
                  value={composerContent}
                  onChange={(event) => setComposerContent(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={gt("补充细节或上下文（可选，Ctrl/Cmd+Enter 贴上）...")}
                  aria-label={gt("便签内容")}
                  disabled={!activeEnvironmentId || !canOperate || creating}
                />
              ) : null}
              {composerAttachments.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {composerAttachments.map((attachment) => (
                    <MemoPendingAttachmentThumb
                      key={attachment.localKey}
                      attachment={attachment}
                      onRemove={() =>
                        setComposerAttachments((prev) =>
                          prev.filter((item) => item.localKey !== attachment.localKey),
                        )
                      }
                      onPreview={setPreviewImage}
                    />
                  ))}
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-2 border-t border-dashed border-foreground/12 pt-2.5">
                <div className="flex items-center gap-2">
                  <ColorSwatchPicker value={composerColor} onChange={setComposerColor} />
                  <PaperFooterDivider />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost-muted"
                          aria-label={gt("添加图片")}
                          disabled={
                            !activeEnvironmentId ||
                            !canOperate ||
                            creating ||
                            composerAttachments.length >= MAX_MEMO_IMAGE_ATTACHMENTS
                          }
                          onClick={() => composerFileInputRef.current?.click()}
                        >
                          <ImagePlusIcon className="size-3.5" />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">{gt("添加图片（也支持直接粘贴）")}</TooltipPopup>
                  </Tooltip>
                </div>
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

        {/* Segmented filter bar */}
        <div className="shrink-0 px-5 pb-2">
          <div
            className="grid grid-cols-4 gap-0.5 rounded-lg bg-foreground/5 p-0.5 ring-1 ring-border/50 ring-inset"
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
                    "inline-flex min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium transition-[color,background-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    active
                      ? "bg-popover text-foreground shadow-xs ring-1 ring-border/60 ring-inset dark:bg-foreground/10"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span className="truncate">{tab.label}</span>
                  <span
                    className={cn(
                      "min-w-4 shrink-0 rounded-full px-1 text-center text-3xs leading-4 tabular-nums",
                      active ? "bg-warning/16 text-warning-foreground" : "bg-foreground/6",
                    )}
                  >
                    {tabCount}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Sticky-note list */}
        <div className="min-h-0 flex-1">
          <ScrollArea scrollFade className="h-full">
            <div className="space-y-4 px-5 pt-4 pb-6">
              {!activeEnvironmentId ? (
                <div className="rounded-lg border border-dashed border-border/80 px-4 py-8 text-center text-xs text-muted-foreground">
                  {gt("尚未连接到工作区环境，连接后即可使用待办便签。")}
                </div>
              ) : filteredMemos.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
                  <div aria-hidden="true" className="relative mb-5 h-14 w-18">
                    <span className="absolute top-2 left-0 size-11 -rotate-8 rounded-md bg-linear-to-b from-info/18 to-info/9 shadow-xs ring-1 ring-info/22 ring-inset" />
                    <span className="absolute top-0 right-0 size-12 rotate-4 rounded-md bg-popover shadow-sm">
                      <span className="flex size-full items-center justify-center rounded-md bg-linear-to-b from-warning/22 to-warning/11 text-warning-foreground ring-1 ring-warning/28 ring-inset">
                        <MemoSidebarIcon count={0} className="size-6" />
                      </span>
                    </span>
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    {filter === "all" ? gt("便签墙还是空的") : gt("当前分类下没有便签")}
                  </p>
                  <p className="mt-1.5 max-w-64 text-xs leading-relaxed text-muted-foreground">
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
                    onPreviewImage={setPreviewImage}
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

        {/* Nested image preview dialog so Escape closes only the lightbox */}
        <Dialog
          open={previewImage !== null}
          onOpenChange={(open) => {
            if (!open) setPreviewImage(null);
          }}
        >
          <DialogPopup className="max-w-2xl">
            {previewImage ? (
              <>
                <DialogHeader>
                  <DialogTitle>
                    <span className="flex min-w-0 items-center gap-2 pr-8">
                      <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{previewImage.name}</span>
                    </span>
                  </DialogTitle>
                </DialogHeader>
                <DialogPanel>
                  <div className="flex items-center justify-center overflow-hidden rounded-xl bg-muted/60 p-2 ring-1 ring-border/60 ring-inset">
                    <img
                      src={previewImage.src}
                      alt={previewImage.name}
                      className="max-h-[70vh] max-w-full rounded-lg object-contain shadow-sm"
                    />
                  </div>
                </DialogPanel>
              </>
            ) : null}
          </DialogPopup>
        </Dialog>
      </SheetPopup>
    </Sheet>
  );
}

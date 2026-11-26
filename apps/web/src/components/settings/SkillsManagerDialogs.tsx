import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerManageSkillsInput,
  SkillDiskLocation,
  SkillMatrixEntry,
  SkillMatrixInstance,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { FolderOpenIcon, Link2Icon, RefreshCwIcon } from "lucide-react";
import { useId, useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { getDefaultSyncTargetIds, groupInstancesByDriver } from "./skillsMatrix.logic";

type ImportTargetScope = "universal" | "provider_global" | "instance";
type SkillsTransferMode = "link" | "copy";

type ImportSkillInput = Extract<ServerManageSkillsInput, { readonly action: "import_skill" }>;
type SyncSkillsInput = Extract<ServerManageSkillsInput, { readonly action: "sync_instances" }>;
type DedupeSkillInput = Extract<ServerManageSkillsInput, { readonly action: "dedupe_skill" }>;

function SkillLayerLabel({ layer }: { readonly layer: SkillDiskLocation["layer"] }) {
  const gt = useGT();
  switch (layer) {
    case "universal":
      return <>{gt("真全局")}</>;
    case "provider_global":
      return <>{gt("供应商全局")}</>;
    case "instance_manifest":
      return <>{gt("实例清单")}</>;
  }
}

function InstanceChecklist({
  instances,
  selectedIds,
  disabled,
  onToggle,
}: {
  readonly instances: ReadonlyArray<SkillMatrixInstance>;
  readonly selectedIds: ReadonlySet<ProviderInstanceId>;
  readonly disabled: boolean;
  readonly onToggle: (instanceId: ProviderInstanceId, selected: boolean) => void;
}) {
  const gt = useGT();
  const groups = groupInstancesByDriver(instances);
  if (instances.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        {gt("没有可选的实例。")}
      </p>
    );
  }
  return (
    <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border bg-background/60 p-2">
      {groups.map((group) => (
        <div key={group.key} className="space-y-1">
          <div className="px-1 text-3xs font-semibold text-foreground/75">{group.label}</div>
          {group.instances.map((instance) => (
            <label
              key={instance.instanceId}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-xs hover:bg-muted/50"
            >
              <Checkbox
                checked={selectedIds.has(instance.instanceId)}
                disabled={disabled}
                onCheckedChange={(checked) => onToggle(instance.instanceId, checked === true)}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{instance.displayName}</span>
              {instance.enabled ? null : (
                <span className="shrink-0 text-3xs text-muted-foreground">{gt("已停用")}</span>
              )}
              {instance.readsUniversalPool ? null : (
                <span className="shrink-0 text-3xs text-warning">{gt("不扫描真全局池")}</span>
              )}
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

function ModeChoice({
  value,
  disabled,
  onChange,
}: {
  readonly value: SkillsTransferMode;
  readonly disabled: boolean;
  readonly onChange: (mode: SkillsTransferMode) => void;
}) {
  const gt = useGT();
  return (
    <RadioGroup
      aria-label={gt("写入方式")}
      disabled={disabled}
      value={value}
      onValueChange={(next) => onChange(next as SkillsTransferMode)}
    >
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <Radio value="copy" />
        <span>{gt("复制实体")}</span>
      </label>
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <Radio value="link" />
        <span>{gt("创建联接 (Junction)")}</span>
      </label>
    </RadioGroup>
  );
}

interface ImportSkillDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly instances: ReadonlyArray<SkillMatrixInstance>;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: ImportSkillInput) => Promise<boolean>;
}

export function ImportSkillDialog({
  open,
  environmentId,
  instances,
  busy,
  onOpenChange,
  onSubmit,
}: ImportSkillDialogProps) {
  const gt = useGT();
  const formId = useId();
  const [sourceDirPath, setSourceDirPath] = useState("");
  const [targetScope, setTargetScope] = useState<ImportTargetScope>("universal");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<ProviderInstanceId>>(() => new Set());
  const [mode, setMode] = useState<SkillsTransferMode>("copy");
  const [mountToNonUniversalEnabled, setMountToNonUniversalEnabled] = useState(true);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const canPickFolder =
    typeof window !== "undefined" && typeof window.desktopBridge?.pickFolder === "function";
  const trimmedPath = sourceDirPath.trim();
  const needsInstances = targetScope !== "universal";
  const canSubmit = !busy && trimmedPath.length > 0 && (!needsInstances || selectedIds.size > 0);

  const close = () => {
    onOpenChange(false);
  };

  const toggleInstance = (instanceId: ProviderInstanceId, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(instanceId);
      else next.delete(instanceId);
      return next;
    });
  };

  const chooseFolder = async () => {
    if (!canPickFolder) return;
    setPickerError(null);
    try {
      const picked = await window.desktopBridge?.pickFolder({
        targetEnvironmentId: environmentId,
      });
      if (picked !== null && picked !== undefined) setSourceDirPath(picked);
    } catch (error) {
      const message = error instanceof Error ? error.message : gt("无法打开文件夹选择器。");
      setPickerError(message);
      toastManager.add({ type: "error", title: gt("无法选择文件夹"), description: message });
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    const targetInstanceIds = [...selectedIds];
    const succeeded = await onSubmit({
      action: "import_skill",
      sourceDirPath: trimmedPath,
      targetScope,
      mode,
      ...(targetScope === "universal" ? { mountToNonUniversalEnabled } : { targetInstanceIds }),
    });
    if (!succeeded) return;
    setSourceDirPath("");
    setTargetScope("universal");
    setSelectedIds(new Set());
    setMode("copy");
    setMountToNonUniversalEnabled(true);
    close();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPickerError(null);
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{gt("导入技能")}</DialogTitle>
          <DialogDescription>
            {gt(
              "从已有技能目录导入到真全局池、供应商全局目录或指定实例。来源目录的 SKILL.md 必须包含合法的 name 与 description。",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="skill-import-source">{gt("源文件夹路径")}</Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="skill-import-source"
                  className="min-w-0 flex-1"
                  font="mono"
                  placeholder="~/projects/my-skill"
                  spellCheck={false}
                  value={sourceDirPath}
                  onChange={(event) => setSourceDirPath(event.target.value)}
                />
                {canPickFolder ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void chooseFolder()}
                  >
                    <FolderOpenIcon />
                    {gt("选择文件夹")}
                  </Button>
                ) : null}
              </div>
              {pickerError ? <p className="text-xs text-warning">{pickerError}</p> : null}
            </div>

            <div className="grid gap-1.5">
              <span className="text-xs font-medium">{gt("目标层级")}</span>
              <RadioGroup
                aria-label={gt("目标层级")}
                disabled={busy}
                value={targetScope}
                onValueChange={(next) => setTargetScope(next as ImportTargetScope)}
              >
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 text-xs">
                  <Radio className="mt-0.5" value="universal" />
                  <span className="min-w-0">
                    <span className="block font-medium">{gt("真全局 (~/.agents/skills)")}</span>
                    <span className="block text-muted-foreground">
                      {gt("所有扫描真全局池的实例都会自动看到。")}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 text-xs">
                  <Radio className="mt-0.5" value="provider_global" />
                  <span className="min-w-0">
                    <span className="block font-medium">{gt("指定供应商全局")}</span>
                    <span className="block text-muted-foreground">
                      {gt("写入所选实例所属供应商的全局技能目录。")}
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 text-xs">
                  <Radio className="mt-0.5" value="instance" />
                  <span className="min-w-0">
                    <span className="block font-medium">{gt("指定实例")}</span>
                    <span className="block text-muted-foreground">
                      {gt("只挂载到明确选择的实例。")}
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </div>

            {targetScope === "universal" ? (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border bg-muted/20 px-2.5 py-2">
                <Checkbox
                  className="mt-0.5"
                  checked={mountToNonUniversalEnabled}
                  disabled={busy}
                  onCheckedChange={(checked) => setMountToNonUniversalEnabled(checked === true)}
                />
                <span className="min-w-0 text-xs">
                  <span className="block font-medium">
                    {gt("同时挂载到不自动扫描真全局池的已启用实例")}
                  </span>
                  <span className="block text-muted-foreground">
                    {gt("例如 Antigravity 或隔离实例，会为它们创建联接。")}
                  </span>
                </span>
              </label>
            ) : (
              <div className="grid gap-1.5">
                <span className="text-xs font-medium">{gt("选择目标实例")}</span>
                <InstanceChecklist
                  instances={instances}
                  selectedIds={selectedIds}
                  disabled={busy}
                  onToggle={toggleInstance}
                />
              </div>
            )}

            <div className="grid gap-1.5">
              <span className="text-xs font-medium">{gt("写入方式")}</span>
              <ModeChoice value={mode} disabled={busy} onChange={setMode} />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={busy} onClick={close}>
            {gt("取消")}
          </Button>
          <Button type="submit" form={formId} disabled={!canSubmit}>
            {gt("开始导入")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

interface SyncSkillsDialogProps {
  readonly open: boolean;
  readonly instances: ReadonlyArray<SkillMatrixInstance>;
  readonly sourceInstanceId?: ProviderInstanceId | undefined;
  readonly skillName?: string | undefined;
  readonly entry?: SkillMatrixEntry | undefined;
  readonly initialTargetIds?: ReadonlyArray<ProviderInstanceId> | undefined;
  readonly missingInstanceIds?: ReadonlyArray<ProviderInstanceId> | undefined;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: SyncSkillsInput) => Promise<boolean>;
}

export function SyncSkillsDialog({
  open,
  instances,
  sourceInstanceId,
  skillName,
  entry,
  initialTargetIds,
  missingInstanceIds,
  busy,
  onOpenChange,
  onSubmit,
}: SyncSkillsDialogProps) {
  const gt = useGT();
  const sourceInstance = instances.find((instance) => instance.instanceId === sourceInstanceId);
  const sameDriverGroupKeys =
    sourceInstance !== undefined
      ? new Set([sourceInstance.driverGroupKey])
      : new Set(
          entry === undefined
            ? []
            : instances
                .filter((instance) => entry.ownerGroupLabels.includes(instance.driverGroupLabel))
                .map((instance) => instance.driverGroupKey),
        );
  const sameDriverIds = instances
    .filter(
      (instance) =>
        instance.instanceId !== sourceInstanceId &&
        sameDriverGroupKeys.has(instance.driverGroupKey),
    )
    .map((instance) => instance.instanceId);
  const missingIds =
    missingInstanceIds ??
    (entry === undefined
      ? []
      : instances
          .filter(
            (instance) =>
              instance.instanceId !== sourceInstanceId &&
              entry.cells[instance.instanceId]?.status === "missing",
          )
          .map((instance) => instance.instanceId));
  const defaults =
    initialTargetIds ??
    (entry === undefined && sourceInstance !== undefined
      ? getDefaultSyncTargetIds(instances, sourceInstance.instanceId, true)
      : missingIds);

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<ProviderInstanceId>>(
    () => new Set(defaults),
  );
  const [mode, setMode] = useState<SkillsTransferMode>("link");

  const toggleInstance = (instanceId: ProviderInstanceId, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(instanceId);
      else next.delete(instanceId);
      return next;
    });
  };

  const canSubmit = !busy && selectedIds.size > 0;

  const submit = async () => {
    if (!canSubmit) return;
    const succeeded = await onSubmit({
      action: "sync_instances",
      ...(sourceInstanceId === undefined ? {} : { sourceInstanceId }),
      targetInstanceIds: [...selectedIds],
      ...(skillName === undefined ? {} : { skillNames: [skillName] }),
      mode,
    });
    if (succeeded) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {skillName === undefined
              ? gt("同步实例技能到其他实例")
              : gt("同步技能 {name}", { name: skillName })}
          </DialogTitle>
          <DialogDescription>
            {skillName === undefined
              ? gt("把 {name} 中已就绪的全局技能挂载或复制到其他实例。", {
                  name: sourceInstance?.displayName ?? sourceInstanceId ?? "",
                })
              : gt("选择要同步到的实例。默认推荐创建联接，源实体保持在原位。")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="me-auto text-xs font-medium">{gt("目标实例")}</span>
              <Button
                size="micro"
                variant="outline"
                disabled={busy || sameDriverIds.length === 0}
                onClick={() => setSelectedIds(new Set(sameDriverIds))}
              >
                {gt("全选同供应商")}
              </Button>
              <Button
                size="micro"
                variant="outline"
                disabled={busy || missingIds.length === 0}
                onClick={() => setSelectedIds(new Set(missingIds))}
              >
                {gt("全选缺失实例")}
              </Button>
              <Button
                size="micro"
                variant="ghost"
                disabled={busy || selectedIds.size === 0}
                onClick={() => setSelectedIds(new Set())}
              >
                {gt("清空")}
              </Button>
            </div>
            <InstanceChecklist
              instances={instances.filter((instance) => instance.instanceId !== sourceInstanceId)}
              selectedIds={selectedIds}
              disabled={busy}
              onToggle={toggleInstance}
            />
            <p className="text-3xs text-muted-foreground">
              {gt("已选择 {count} 个实例", { count: selectedIds.size })}
            </p>
            {sameDriverIds.length === 0 && sourceInstance === undefined ? (
              <p className="text-3xs text-muted-foreground">
                {gt("该技能没有可用的同供应商实例，请直接勾选目标。")}
              </p>
            ) : null}
          </div>

          <div className="mt-4 space-y-1.5">
            <span className="text-xs font-medium">{gt("挂载模式")}</span>
            <RadioGroup
              aria-label={gt("挂载模式")}
              disabled={busy}
              value={mode}
              onValueChange={(next) => setMode(next as SkillsTransferMode)}
            >
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <Radio value="link" />
                <span className="inline-flex items-center gap-1">
                  <Link2Icon className="size-3 text-muted-foreground" />
                  {gt("创建联接 (推荐)")}
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <Radio value="copy" />
                <span className="inline-flex items-center gap-1">
                  <RefreshCwIcon className="size-3 text-muted-foreground" />
                  {gt("复制实体")}
                </span>
              </label>
            </RadioGroup>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {gt("取消")}
          </Button>
          <Button disabled={!canSubmit} aria-busy={busy} onClick={() => void submit()}>
            {gt("开始同步")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

interface DedupeConflictDialogProps {
  readonly open: boolean;
  readonly entry: SkillMatrixEntry;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: DedupeSkillInput) => Promise<boolean>;
}

function defaultDedupePath(entry: SkillMatrixEntry): string | null {
  const universal = entry.locations.find((location) => location.layer === "universal");
  if (universal !== undefined) return universal.path;
  return entry.locations[0]?.path ?? null;
}

export function DedupeConflictDialog({
  open,
  entry,
  busy,
  onOpenChange,
  onSubmit,
}: DedupeConflictDialogProps) {
  const gt = useGT();
  const [preferredPath, setPreferredPath] = useState<string | null>(() => defaultDedupePath(entry));

  const canSubmit = !busy && preferredPath !== null;

  const submit = async () => {
    if (!canSubmit) return;
    const succeeded = await onSubmit({
      action: "dedupe_skill",
      skillName: entry.name,
      preferSourcePath: preferredPath,
    });
    if (succeeded) onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{gt("解决内容冲突")}</DialogTitle>
          <DialogDescription>
            {gt(
              "技能 {name} 的多个副本内容不一致，不能自动合并。选择一份作为真全局池的唯一实体源，其余副本会移入同级 _backup 备份。",
              { name: entry.name },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <RadioGroup
            aria-label={gt("保留哪一份副本")}
            disabled={busy}
            value={preferredPath}
            onValueChange={(next) => setPreferredPath(typeof next === "string" ? next : null)}
          >
            {entry.locations.map((location) => (
              <label
                key={location.path}
                className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 text-xs",
                  preferredPath === location.path && "border-primary/50 bg-primary/5",
                )}
              >
                <Radio className="mt-0.5" value={location.path} />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">
                      <SkillLayerLabel layer={location.layer} />
                    </span>
                    <span className="text-muted-foreground">{location.ownerLabel}</span>
                    <span className="text-muted-foreground">
                      {location.isLink ? gt("联接") : gt("实体")}
                    </span>
                  </span>
                  <span className="block break-all font-mono text-3xs text-foreground/80">
                    {location.path}
                  </span>
                  {location.linkTarget ? (
                    <span className="block break-all font-mono text-3xs text-muted-foreground">
                      → {location.linkTarget}
                    </span>
                  ) : null}
                  {location.contentHash ? (
                    <span className="block font-mono text-3xs text-muted-foreground">
                      {gt("内容哈希 {hash}", { hash: location.contentHash.slice(0, 16) })}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </RadioGroup>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {gt("取消")}
          </Button>
          <Button disabled={!canSubmit} aria-busy={busy} onClick={() => void submit()}>
            {gt("保留所选副本并去重")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

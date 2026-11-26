import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerGetSkillsOverviewResult,
  ServerManageSkillsInput,
  ServerManageSkillsResult,
  SkillDiskLocation,
  SkillMatrixCell,
  SkillMatrixCellStatus,
  SkillMatrixDiagnostic,
  SkillMatrixEntry,
  SkillMatrixInstance,
  SkillMatrixScope,
} from "@t3tools/contracts";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useGT } from "gt-react";
import {
  ArrowUpRightIcon,
  ArchiveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  InfoIcon,
  LayersIcon,
  Link2Icon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { m as resolveNow } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatDateTimeTimestamp } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DedupeConflictDialog, ImportSkillDialog, SyncSkillsDialog } from "./SkillsManagerDialogs";
import { SettingsSection } from "./settingsLayout";
import {
  countDuplicateSkills,
  countHiddenDisabledAgentSkills,
  filterSkillEntries,
  getDefaultSyncTargetIds,
  groupInstancesByDriver,
  resolveSkillSourcePath,
} from "./skillsMatrix.logic";

interface SkillsMatrixSectionProps {
  readonly environmentId: EnvironmentId;
}

const SCOPE_TABS: ReadonlyArray<SkillMatrixScope> = ["universal", "agent_global", "builtin"];
// Minus sign avoids shipping an em dash in UI copy.
const MISSING_MARK = "\u2212";

type CellActionMode = "link" | "copy";

interface SyncDialogRequest {
  readonly sourceInstanceId?: ProviderInstanceId;
  readonly skillName?: string;
  readonly entry?: SkillMatrixEntry;
  readonly initialTargetIds?: ReadonlyArray<ProviderInstanceId>;
  readonly missingInstanceIds?: ReadonlyArray<ProviderInstanceId>;
}

interface SkillMatrixActions {
  readonly busy: boolean;
  readonly universalPoolDir: string;
  readonly onLinkUniversalPool: (instance: SkillMatrixInstance) => void;
  readonly onSyncFromInstance: (instance: SkillMatrixInstance) => void;
  readonly onMount: (
    entry: SkillMatrixEntry,
    instance: SkillMatrixInstance,
    mode: CellActionMode,
  ) => void;
  readonly onFix: (entry: SkillMatrixEntry, instance: SkillMatrixInstance) => void;
  readonly onUnmount: (entry: SkillMatrixEntry, instance: SkillMatrixInstance) => void;
  readonly onDedupe: (entry: SkillMatrixEntry) => void;
  readonly onSyncSkill: (entry: SkillMatrixEntry) => void;
  readonly onPromote: (entry: SkillMatrixEntry) => void;
  readonly onDemote: (entry: SkillMatrixEntry, instance: SkillMatrixInstance) => void;
  readonly onBackup: (entry: SkillMatrixEntry) => void;
}

function isSkillMatrixScope(value: string | undefined): value is SkillMatrixScope {
  return value !== undefined && (SCOPE_TABS as ReadonlyArray<string>).includes(value);
}

function normalizePathForCompare(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

function SkillStatusLabel({ status }: { readonly status: SkillMatrixCellStatus }) {
  const gt = useGT();
  switch (status) {
    case "declared_runtime":
      return <>{gt("运行态已声明")}</>;
    case "declared_disk":
      return <>{gt("目录就绪")}</>;
    case "disk_warning":
      return <>{gt("磁盘异常")}</>;
    case "missing":
      return <>{gt("未挂载 / 声明不到")}</>;
    case "not_applicable":
      return <>{gt("不适用")}</>;
  }
}

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

function statusToneClass(status: SkillMatrixCellStatus): string {
  switch (status) {
    case "declared_runtime":
      return "text-success-foreground";
    case "declared_disk":
      return "text-info-foreground";
    case "disk_warning":
      return "text-warning-foreground";
    case "missing":
      return "text-muted-foreground";
    case "not_applicable":
      return "text-muted-foreground/60";
  }
}

function coverageToneClass(entry: SkillMatrixEntry): string {
  if (entry.expectedEnabledCount === 0) return "text-muted-foreground";
  if (entry.coveredEnabledCount < entry.expectedEnabledCount) return "text-warning";
  return "text-success";
}

function InstanceColumnHeader({
  instance,
  actions,
}: {
  readonly instance: SkillMatrixInstance;
  readonly actions: SkillMatrixActions;
}) {
  const gt = useGT();
  return (
    <Menu>
      <MenuTrigger
        aria-label={gt("管理实例 {name}", { name: instance.displayName })}
        className="group inline-flex min-w-0 max-w-[108px] flex-col items-center gap-0.5 rounded-md px-1 py-0.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        render={<button type="button" />}
      >
        <span
          className={cn(
            "max-w-[108px] truncate text-2xs font-medium",
            instance.enabled ? "text-foreground/85" : "text-muted-foreground",
          )}
        >
          {instance.displayName}
        </span>
        {instance.enabled ? (
          <ChevronDownIcon
            className="size-2.5 text-muted-foreground/60 opacity-40 transition-opacity group-hover:opacity-100 group-data-popup-open:opacity-100"
            aria-hidden
          />
        ) : (
          <span className="text-4xs leading-none text-muted-foreground">{gt("已停用")}</span>
        )}
      </MenuTrigger>
      <MenuPopup align="center" className="w-80">
        <div className="space-y-1 px-2 py-1.5">
          <div className="text-xs font-semibold text-foreground">{instance.displayName}</div>
          <div className="text-2xs text-muted-foreground">{instance.driverGroupLabel}</div>
          <div className="break-all font-mono text-3xs text-muted-foreground">
            {instance.driver} · {instance.instanceId}
          </div>
          <div className="text-2xs">
            {instance.readsUniversalPool
              ? gt("原生扫描 ~/.agents/skills 真全局池")
              : gt("不自动扫描 ~/.agents/skills（需显式挂载）")}
          </div>
          <div className="text-3xs text-muted-foreground">
            {instance.enabled ? gt("已启用") : gt("已停用")}
          </div>
          <div className="space-y-0.5 pt-1">
            <div className="text-3xs font-medium text-foreground/80">{gt("实际扫描目录：")}</div>
            {instance.globalSkillDirs.length === 0 ? (
              <div className="text-3xs text-muted-foreground">{gt("无")}</div>
            ) : (
              instance.globalSkillDirs.map((dir) => (
                <div key={dir} className="break-all font-mono text-3xs text-muted-foreground">
                  {dir}
                </div>
              ))
            )}
          </div>
        </div>
        <MenuSeparator />
        {instance.readsUniversalPool ? null : (
          <MenuItem disabled={actions.busy} onClick={() => actions.onLinkUniversalPool(instance)}>
            <Link2Icon />
            {gt("一键联接真全局池")}
          </MenuItem>
        )}
        <MenuItem disabled={actions.busy} onClick={() => actions.onSyncFromInstance(instance)}>
          <RefreshCwIcon />
          {gt("将此实例技能同步到其他实例…")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function CellStatusGlyph({ cell }: { readonly cell: SkillMatrixCell | undefined }) {
  const status = cell?.status ?? "not_applicable";

  if (status === "declared_runtime") {
    return (
      <span className="inline-flex size-4 items-center justify-center">
        <span className="size-2 rounded-full bg-success" />
      </span>
    );
  }
  if (status === "declared_disk") {
    return (
      <span className="inline-flex size-4 items-center justify-center">
        <span className="inline-flex size-2.5 items-center justify-center rounded-full border border-info">
          <span className="size-1 rounded-full bg-info" />
        </span>
      </span>
    );
  }
  if (status === "disk_warning") {
    return (
      <span className="inline-flex size-4 items-center justify-center">
        <TriangleAlertIcon className="size-3 text-warning" />
      </span>
    );
  }
  if (status === "missing") {
    return (
      <span className="inline-flex size-4 items-center justify-center">
        <span className="text-xs leading-none text-muted-foreground/55">{MISSING_MARK}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex size-4 items-center justify-center">
      <span className="text-3xs leading-none text-muted-foreground/30">·</span>
    </span>
  );
}

function CellPathLine({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-3xs font-medium text-foreground/80">{label}</div>
      <div className="break-all font-mono text-3xs text-muted-foreground">{value}</div>
    </div>
  );
}

function SkillCellPopover({
  entry,
  instance,
  cell,
  sharedDirSiblings,
  actions,
}: {
  readonly entry: SkillMatrixEntry;
  readonly instance: SkillMatrixInstance;
  readonly cell: SkillMatrixCell | undefined;
  readonly sharedDirSiblings: ReadonlyArray<string>;
  readonly actions: SkillMatrixActions;
}) {
  const gt = useGT();
  const status = cell?.status ?? "not_applicable";
  const sourcePath = resolveSkillSourcePath(entry);
  const canRemove =
    (status === "declared_disk" || status === "declared_runtime") && cell?.removable === true;
  const nativeUniversalCell =
    (status === "declared_disk" || status === "declared_runtime") && cell?.removable !== true;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              aria-label={gt("管理 {skill} 在 {instance} 的状态", {
                skill: entry.name,
                instance: instance.displayName,
              })}
              render={<Button size="icon-micro" variant="ghost" />}
            />
          }
        >
          <CellStatusGlyph cell={cell} />
        </TooltipTrigger>
        <TooltipPopup side="top">
          <div className="space-y-0.5">
            <div className={cn("font-medium", statusToneClass(status))}>
              <SkillStatusLabel status={status} />
            </div>
            {cell?.reason ? <div className="text-muted-foreground">{cell.reason}</div> : null}
            <div className="text-muted-foreground">{gt("点击管理此格")}</div>
          </div>
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup align="center" padding="compact" side="bottom" width="sm">
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <span className="text-xs font-semibold text-foreground">{instance.displayName}</span>
            <span className={cn("text-2xs font-medium", statusToneClass(status))}>
              <SkillStatusLabel status={status} />
            </span>
          </div>
          <div className="text-3xs text-muted-foreground">
            {instance.driverGroupLabel} · {instance.enabled ? gt("已启用") : gt("已停用")}
          </div>
          {cell?.path ? <CellPathLine label={gt("技能路径")} value={cell.path} /> : null}
          {cell?.sourceDir ? <CellPathLine label={gt("扫描目录")} value={cell.sourceDir} /> : null}
          {cell?.linkTarget ? (
            <CellPathLine label={gt("联接目标")} value={cell.linkTarget} />
          ) : null}
          {cell?.reason ? (
            <p className="text-pretty text-2xs leading-relaxed text-muted-foreground">
              {cell.reason}
            </p>
          ) : null}

          {status === "missing" ? (
            sourcePath === undefined ? (
              <p className="text-2xs text-warning">
                {gt("没有可用的技能源路径，无法挂载到此实例。")}
              </p>
            ) : instance.driver === "antigravity" ? (
              <PopoverClose
                render={<Button size="xs" variant="outline" disabled={actions.busy} />}
                onClick={() => actions.onMount(entry, instance, "link")}
              >
                <Link2Icon />
                {gt("注册到 skills.json")}
              </PopoverClose>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                <PopoverClose
                  render={<Button size="xs" variant="outline" disabled={actions.busy} />}
                  onClick={() => actions.onMount(entry, instance, "link")}
                >
                  <Link2Icon />
                  {gt("挂载到此实例（联接）")}
                </PopoverClose>
                <PopoverClose
                  render={<Button size="xs" variant="ghost" disabled={actions.busy} />}
                  onClick={() => actions.onMount(entry, instance, "copy")}
                >
                  <CopyIcon />
                  {gt("复制到此实例")}
                </PopoverClose>
              </div>
            )
          ) : null}

          {status === "disk_warning" ? (
            cell?.autoFixable === true ? (
              <PopoverClose
                render={<Button size="xs" variant="outline" disabled={actions.busy} />}
                onClick={() => actions.onFix(entry, instance)}
              >
                <WrenchIcon />
                {gt("一键修复此异常")}
              </PopoverClose>
            ) : (
              <p className="text-3xs leading-relaxed text-muted-foreground">
                {gt("该异常需要手动修正 SKILL.md 的 frontmatter 后刷新。")}
              </p>
            )
          ) : null}

          {canRemove ? (
            <div className="space-y-1">
              <PopoverClose
                render={<Button size="xs" variant="destructive-outline" disabled={actions.busy} />}
                onClick={() => actions.onUnmount(entry, instance)}
              >
                <Trash2Icon />
                {gt("从此实例移除")}
              </PopoverClose>
              <p className="text-3xs leading-relaxed text-muted-foreground">
                {gt("联接只会删除联接；实体目录会移入同级 _backup 备份。")}
              </p>
              {sharedDirSiblings.length > 0 ? (
                <p className="text-3xs leading-relaxed text-warning">
                  {gt("注意：该目录与 {names} 共享，移除将同步影响这些实例。", {
                    names: sharedDirSiblings.join("、"),
                  })}
                </p>
              ) : null}
            </div>
          ) : null}

          {nativeUniversalCell ? (
            <p className="text-3xs leading-relaxed text-muted-foreground">
              {gt("来自真全局池原生扫描，请在展开行执行降级或移入备份。")}
            </p>
          ) : null}

          {status === "not_applicable" ? (
            <p className="text-2xs text-muted-foreground">
              {cell?.reason ?? gt("该实例不适用此技能。")}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function SkillDetailRow({
  entry,
  instances,
  actions,
}: {
  readonly entry: SkillMatrixEntry;
  readonly instances: ReadonlyArray<SkillMatrixInstance>;
  readonly actions: SkillMatrixActions;
}) {
  const gt = useGT();
  const sourcePath = resolveSkillSourcePath(entry);
  const demoteTargets = instances.filter(
    (instance) =>
      instance.writableGlobalSkillDir !== undefined &&
      normalizePathForCompare(instance.writableGlobalSkillDir) !==
        normalizePathForCompare(actions.universalPoolDir),
  );

  return (
    <div className="space-y-2.5 border-t bg-muted/20 px-3 py-2.5 text-xs">
      {entry.description ? (
        <p className="text-pretty leading-relaxed text-muted-foreground">{entry.description}</p>
      ) : null}

      <div className="space-y-1">
        <div className="text-2xs font-medium text-foreground/80">
          {gt("磁盘位置 ({count})", { count: entry.locations.length })}
        </div>
        {entry.locations.length === 0 ? (
          <p className="text-2xs text-muted-foreground">{gt("没有可用的磁盘位置记录。")}</p>
        ) : (
          <div className="divide-y divide-border/50 rounded-md border bg-background/70">
            {entry.locations.map((location) => (
              <div key={`${location.path}:${location.layer}`} className="space-y-1 px-2.5 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" size="sm">
                    <SkillLayerLabel layer={location.layer} />
                  </Badge>
                  <span className="text-2xs font-medium text-foreground">
                    {location.ownerLabel}
                  </span>
                  <span className="text-2xs text-muted-foreground">
                    {location.isLink ? gt("联接") : gt("实体")}
                  </span>
                </div>
                <div className="break-all font-mono text-3xs text-muted-foreground">
                  {location.path}
                </div>
                {location.linkTarget ? (
                  <div className="break-all font-mono text-3xs text-muted-foreground">
                    → {location.linkTarget}
                  </div>
                ) : null}
                {location.contentHash ? (
                  <div className="break-all font-mono text-3xs text-muted-foreground/80">
                    {gt("内容哈希：{hash}", { hash: location.contentHash })}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {entry.scope === "builtin" ? (
        <p className="text-2xs text-muted-foreground">
          {gt("该技能为驱动内置技能，不支持同步或移入回收备份。")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {entry.hasDuplicateCopies ? (
            <Button
              size="xs"
              variant="outline"
              disabled={actions.busy}
              onClick={() => actions.onDedupe(entry)}
            >
              <CopyIcon />
              {gt("只保留真全局一份（去重）")}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={actions.busy}
            onClick={() => actions.onSyncSkill(entry)}
          >
            <RefreshCwIcon />
            {gt("同步到其他实例…")}
          </Button>
          {entry.scope === "agent_global" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={actions.busy || sourcePath === undefined}
              onClick={() => actions.onPromote(entry)}
            >
              <ArrowUpRightIcon />
              {gt("提升为真全局")}
            </Button>
          ) : null}
          {entry.scope === "universal" ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={actions.busy || demoteTargets.length === 0}
                  />
                }
              >
                <LayersIcon />
                {gt("降级为供应商专属…")}
              </MenuTrigger>
              <MenuPopup align="start" className="w-72">
                <MenuGroup>
                  <MenuGroupLabel>{gt("选择目标实例")}</MenuGroupLabel>
                  {demoteTargets.map((instance) => (
                    <MenuItem
                      key={instance.instanceId}
                      disabled={actions.busy}
                      onClick={() => actions.onDemote(entry, instance)}
                    >
                      <span className="min-w-0 flex-1 truncate">{instance.displayName}</span>
                      <span className="shrink-0 text-3xs text-muted-foreground">
                        {instance.driverGroupLabel}
                      </span>
                    </MenuItem>
                  ))}
                </MenuGroup>
              </MenuPopup>
            </Menu>
          ) : null}
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={actions.busy}
            onClick={() => actions.onBackup(entry)}
          >
            <ArchiveIcon />
            {gt("移入回收备份 (_backup)")}
          </Button>
        </div>
      )}
    </div>
  );
}

function DiagnosticBanner({ diagnostic }: { readonly diagnostic: SkillMatrixDiagnostic }) {
  const isWarning = diagnostic.severity === "warning";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
              isWarning
                ? "border-warning/40 bg-warning/5 text-warning-foreground"
                : "border-border bg-muted/40 text-muted-foreground",
            )}
          />
        }
      >
        {isWarning ? (
          <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden />
        ) : (
          <InfoIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">{diagnostic.message}</span>
        {diagnostic.detail ? (
          <span className="hidden max-w-64 shrink-0 truncate font-mono text-2xs opacity-80 sm:inline">
            {diagnostic.detail}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="max-w-96 space-y-1">
          <div className="font-medium">{diagnostic.message}</div>
          {diagnostic.detail ? (
            <div className="break-all font-mono text-3xs text-muted-foreground">
              {diagnostic.detail}
            </div>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function SkillsMatrixTable({
  skills,
  instances,
  allInstances,
  checkedAt,
  showOwnerBadges,
  expandedSkills,
  onToggleSkill,
  actions,
}: {
  readonly skills: ReadonlyArray<SkillMatrixEntry>;
  readonly instances: ReadonlyArray<SkillMatrixInstance>;
  readonly allInstances: ReadonlyArray<SkillMatrixInstance>;
  readonly checkedAt: string;
  readonly showOwnerBadges: boolean;
  readonly expandedSkills: Readonly<Record<string, boolean>>;
  readonly onToggleSkill: (name: string) => void;
  readonly actions: SkillMatrixActions;
}) {
  const gt = useGT();
  const timestampFormat = useClientSettings().timestampFormat;
  const checkedLabel = formatDateTimeTimestamp(checkedAt, timestampFormat);
  const groups = groupInstancesByDriver(instances);
  const totalColumns = instances.length + 2;
  const sharedDirSiblingsById = new Map<string, ReadonlyArray<string>>();
  for (const instance of instances) {
    if (instance.driver === "antigravity" || instance.writableGlobalSkillDir === undefined) {
      sharedDirSiblingsById.set(instance.instanceId, []);
      continue;
    }
    const dirKey = normalizePathForCompare(instance.writableGlobalSkillDir);
    const siblings = allInstances
      .filter(
        (other) =>
          other.instanceId !== instance.instanceId &&
          other.driver !== "antigravity" &&
          other.writableGlobalSkillDir !== undefined &&
          normalizePathForCompare(other.writableGlobalSkillDir) === dirKey,
      )
      .map((other) => other.displayName);
    sharedDirSiblingsById.set(instance.instanceId, siblings);
  }

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b bg-muted/40 text-2xs font-medium text-muted-foreground">
              <th rowSpan={2} className="min-w-[180px] px-3 py-1.5 text-left align-bottom">
                {gt("技能")}
              </th>
              <th rowSpan={2} className="w-16 px-2 py-1.5 text-center align-bottom">
                {gt("覆盖")}
              </th>
              {groups.map((group) => (
                <th
                  key={group.key}
                  colSpan={group.instances.length}
                  className="border-l border-border/60 px-2 py-1 text-center text-3xs font-semibold text-foreground/75"
                >
                  {group.label}
                </th>
              ))}
            </tr>
            <tr className="border-b bg-muted/25 text-2xs font-medium text-muted-foreground">
              {groups.flatMap((group) =>
                group.instances.map((instance, idx) => (
                  <th
                    key={instance.instanceId}
                    className={cn(
                      "min-w-[88px] px-1 py-1 text-center font-normal",
                      idx === 0 && "border-l border-border/60",
                    )}
                  >
                    <InstanceColumnHeader instance={instance} actions={actions} />
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {skills.map((entry) => {
              const expanded = expandedSkills[entry.name] === true;
              return (
                <Fragment key={entry.name}>
                  <tr
                    className={cn("transition-colors hover:bg-muted/35", expanded && "bg-muted/25")}
                  >
                    <td className="px-3 py-2 align-middle">
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => onToggleSkill(entry.name)}
                        className="flex w-full min-w-0 flex-wrap items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        {expanded ? (
                          <ChevronDownIcon
                            className="size-3 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                        ) : (
                          <ChevronRightIcon
                            className="size-3 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                        )}
                        <span className="min-w-0 truncate font-mono font-medium text-foreground">
                          {entry.name}
                        </span>
                        {entry.hasDuplicateCopies ? (
                          <Badge variant="warning" size="sm">
                            <CopyIcon />
                            {gt("重复 ×{count}", { count: entry.locations.length })}
                          </Badge>
                        ) : null}
                        {entry.hasContentConflict ? (
                          <Badge variant="error" size="sm">
                            <TriangleAlertIcon />
                            {gt("内容冲突")}
                          </Badge>
                        ) : null}
                        {showOwnerBadges
                          ? entry.ownerGroupLabels.map((label) => (
                              <Badge key={label} variant="outline" size="sm">
                                {label}
                              </Badge>
                            ))
                          : null}
                      </button>
                    </td>
                    <td
                      className={cn(
                        "px-2 py-2 text-center align-middle font-mono text-2xs tabular-nums",
                        coverageToneClass(entry),
                      )}
                    >
                      {entry.coveredEnabledCount}/{entry.expectedEnabledCount}
                    </td>
                    {groups.flatMap((group) =>
                      group.instances.map((instance, idx) => (
                        <td
                          key={instance.instanceId}
                          className={cn(
                            "px-1 py-2 text-center align-middle",
                            idx === 0 && "border-l border-border/40",
                          )}
                        >
                          <SkillCellPopover
                            entry={entry}
                            instance={instance}
                            cell={entry.cells[instance.instanceId]}
                            sharedDirSiblings={sharedDirSiblingsById.get(instance.instanceId) ?? []}
                            actions={actions}
                          />
                        </td>
                      )),
                    )}
                  </tr>
                  {expanded ? (
                    <tr>
                      <td colSpan={totalColumns} className="p-0">
                        <SkillDetailRow entry={entry} instances={instances} actions={actions} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-3 py-1.5 text-3xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-success" />
            {gt("运行态已声明")}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex size-2 items-center justify-center rounded-full border border-info">
              <span className="size-0.5 rounded-full bg-info" />
            </span>
            {gt("目录就绪")}
          </span>
          <span className="inline-flex items-center gap-1">
            <TriangleAlertIcon className="size-2.5 text-warning" aria-hidden />
            {gt("磁盘异常")}
          </span>
          <span>
            {MISSING_MARK} {gt("缺失")}
          </span>
          <span>· {gt("不适用")}</span>
        </div>
        <span className="tabular-nums">{gt("最近检查：{time}", { time: checkedLabel })}</span>
      </div>
    </div>
  );
}

export function SkillsMatrixSection({ environmentId }: SkillsMatrixSectionProps) {
  const gt = useGT();
  const getSkillsOverview = useAtomCommand(serverEnvironment.getSkillsOverview, {
    reportFailure: false,
  });
  const manageSkills = useAtomCommand(serverEnvironment.manageSkills, {
    reportFailure: false,
  });

  const [overview, setOverview] = useState<ServerGetSkillsOverviewResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeScopeTab, setActiveScopeTab] = useState<SkillMatrixScope>("universal");
  const [search, setSearch] = useState("");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [expandedSkills, setExpandedSkills] = useState<Readonly<Record<string, boolean>>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [syncRequest, setSyncRequest] = useState<SyncDialogRequest | null>(null);
  const [dedupeConflictEntry, setDedupeConflictEntry] = useState<SkillMatrixEntry | null>(null);
  const [backupEntry, setBackupEntry] = useState<SkillMatrixEntry | null>(null);
  const loadGeneration = useRef(0);
  const manageInFlight = useRef(false);

  const errorText = useStableCallback(
    (error: unknown, fallback: string) => errorDisplayMessage(error, resolveNow) ?? fallback,
  );

  const loadOverview = useStableCallback(() => {
    const generation = ++loadGeneration.current;
    setIsLoading(true);
    setErrorMessage(null);
    void getSkillsOverview({ environmentId, input: {} }).then((result) => {
      if (loadGeneration.current !== generation) return;
      setIsLoading(false);
      if (result._tag === "Success") {
        setOverview(result.value);
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      setErrorMessage(errorText(squashAtomCommandFailure(result), gt("无法读取技能声明状态。")));
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the global skills overview from the server on mount and environment switch; no reactive atom backs this scan
  useEffect(() => {
    loadOverview();
    return () => {
      loadGeneration.current += 1;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reload only when environmentId changes; loadOverview is a stable callback
  }, [environmentId, loadOverview]);

  const runManage = useStableCallback(
    async (
      key: string,
      input: ServerManageSkillsInput,
    ): Promise<ServerManageSkillsResult | null> => {
      if (manageInFlight.current) return null;
      manageInFlight.current = true;
      const generation = ++loadGeneration.current;
      setIsLoading(false);
      setBusyKey(key);
      const result = await manageSkills({ environmentId, input });
      manageInFlight.current = false;
      if (loadGeneration.current !== generation) {
        setBusyKey(null);
        return null;
      }
      setBusyKey(null);
      if (result._tag === "Success") {
        const value = result.value;
        setOverview(value.overview);
        if (value.skippedConflicts.length > 0) {
          toastManager.add({
            type: "warning",
            title: value.summary,
            description: gt(
              "以下技能存在内容冲突，已跳过：{names}。请在「仅看重复」中展开技能并手动选择保留版本。",
              { names: value.skippedConflicts.join("、") },
            ),
          });
        } else {
          toastManager.add({ type: "success", title: value.summary });
        }
        return value;
      }
      if (isAtomCommandInterrupted(result)) return null;
      toastManager.add({
        type: "error",
        title: gt("技能操作失败"),
        description: errorText(
          squashAtomCommandFailure(result),
          gt("技能操作失败，请查看服务端日志。"),
        ),
      });
      if (
        input.action === "sync_instances" ||
        input.action === "dedupe_all" ||
        input.action === "dedupe_skill" ||
        input.action === "import_skill"
      ) {
        loadOverview();
      }
      return null;
    },
  );

  const allSkills = overview?.skills ?? [];
  const displayedInstances = (overview?.instances ?? []).filter(
    (instance) => includeDisabled || instance.enabled,
  );
  const universalSkills = allSkills.filter((skill) => skill.scope === "universal");
  const agentGlobalSkills = allSkills.filter((skill) => skill.scope === "agent_global");
  const builtinSkills = allSkills.filter((skill) => skill.scope === "builtin");

  const effectiveTab: SkillMatrixScope =
    activeScopeTab === "universal" && universalSkills.length === 0 && agentGlobalSkills.length > 0
      ? "agent_global"
      : activeScopeTab;

  const duplicateStats = countDuplicateSkills(allSkills);
  const hiddenAgentSkillCount = countHiddenDisabledAgentSkills(
    allSkills,
    displayedInstances,
    includeDisabled,
  );

  const issueCountInTab = filterSkillEntries(allSkills, {
    scope: effectiveTab,
    query: "",
    onlyIssues: true,
    onlyDuplicates: false,
    displayedInstances,
    showDisabled: includeDisabled,
  }).length;

  const duplicateCountInTab = filterSkillEntries(allSkills, {
    scope: effectiveTab,
    query: "",
    onlyIssues: false,
    onlyDuplicates: true,
    displayedInstances,
    showDisabled: includeDisabled,
  }).length;

  const visibleSkills = filterSkillEntries(allSkills, {
    scope: effectiveTab,
    query: search,
    onlyIssues: issuesOnly,
    onlyDuplicates: duplicatesOnly,
    displayedInstances,
    showDisabled: includeDisabled,
  });

  const diagnostics = overview?.diagnostics ?? [];

  const toggleSkill = (name: string) => {
    setExpandedSkills((current) => ({ ...current, [name]: !(current[name] ?? false) }));
  };

  const runCellAction = (key: string, input: ServerManageSkillsInput): void => {
    void runManage(key, input);
  };

  const openSyncSkill = (entry: SkillMatrixEntry) => {
    const missingIds = displayedInstances
      .filter((instance) => entry.cells[instance.instanceId]?.status === "missing")
      .map((instance) => instance.instanceId);
    setSyncRequest({
      skillName: entry.name,
      entry,
      missingInstanceIds: missingIds,
      initialTargetIds: missingIds,
    });
  };

  const openSyncFromInstance = (instance: SkillMatrixInstance) => {
    const sourceSkills = allSkills.filter((skill) => {
      if (skill.scope === "builtin") return false;
      const status = skill.cells[instance.instanceId]?.status;
      return status === "declared_disk" || status === "declared_runtime";
    });
    const missingIds = displayedInstances
      .filter(
        (target) =>
          target.instanceId !== instance.instanceId &&
          sourceSkills.some((skill) => skill.cells[target.instanceId]?.status === "missing"),
      )
      .map((target) => target.instanceId);
    setSyncRequest({
      sourceInstanceId: instance.instanceId,
      missingInstanceIds: missingIds,
      initialTargetIds: getDefaultSyncTargetIds(displayedInstances, instance.instanceId, true),
    });
  };

  const actions: SkillMatrixActions = {
    busy: busyKey !== null,
    universalPoolDir: overview?.universalPoolDir ?? "~/.agents/skills",
    onLinkUniversalPool: (instance) => {
      runCellAction(`link_universal_pool:${instance.instanceId}`, {
        action: "link_universal_pool",
        targetInstanceId: instance.instanceId,
      });
    },
    onSyncFromInstance: openSyncFromInstance,
    onMount: (entry, instance, mode) => {
      const sourcePath = resolveSkillSourcePath(entry);
      runCellAction(`mount:${entry.name}:${instance.instanceId}`, {
        action: "mount_to_instance",
        skillName: entry.name,
        targetInstanceId: instance.instanceId,
        mode,
        ...(sourcePath === undefined ? {} : { sourcePath }),
      });
    },
    onFix: (entry, instance) => {
      runCellAction(`fix:${entry.name}:${instance.instanceId}`, {
        action: "fix_instance_warning",
        skillName: entry.name,
        targetInstanceId: instance.instanceId,
      });
    },
    onUnmount: (entry, instance) => {
      runCellAction(`unmount:${entry.name}:${instance.instanceId}`, {
        action: "unmount_from_instance",
        skillName: entry.name,
        targetInstanceId: instance.instanceId,
      });
    },
    onDedupe: (entry) => {
      if (entry.hasContentConflict) {
        setDedupeConflictEntry(entry);
        return;
      }
      runCellAction(`dedupe_skill:${entry.name}`, {
        action: "dedupe_skill",
        skillName: entry.name,
      });
    },
    onSyncSkill: openSyncSkill,
    onPromote: (entry) => {
      const sourcePath = resolveSkillSourcePath(entry);
      if (sourcePath === undefined) return;
      runCellAction(`promote:${entry.name}`, {
        action: "promote_to_universal",
        skillName: entry.name,
        sourcePath,
      });
    },
    onDemote: (entry, instance) => {
      runCellAction(`demote:${entry.name}:${instance.instanceId}`, {
        action: "demote_to_provider",
        skillName: entry.name,
        targetInstanceId: instance.instanceId,
      });
    },
    onBackup: (entry) => {
      setBackupEntry(entry);
    },
  };

  const dedupeAll = async () => {
    const result = await runManage("dedupe_all", { action: "dedupe_all" });
    if (result === null || result.skippedConflicts.length === 0) return;
    setDuplicatesOnly(true);
    const firstSkipped = result.skippedConflicts[0];
    if (firstSkipped === undefined) return;
    setExpandedSkills((current) => ({ ...current, [firstSkipped]: true }));
    const skippedEntry = result.overview.skills.find((skill) => skill.name === firstSkipped);
    if (skippedEntry !== undefined) setActiveScopeTab(skippedEntry.scope);
  };

  const confirmBackup = async () => {
    if (backupEntry === null) return;
    const result = await runManage(`backup_skill:${backupEntry.name}`, {
      action: "backup_skill",
      skillName: backupEntry.name,
    });
    if (result !== null) setBackupEntry(null);
  };

  const tabHint =
    effectiveTab === "universal"
      ? gt("来源：{dir}（跨 Agent 通用池，预期所有已启用实例都应声明到）", {
          dir: overview?.universalPoolDir ?? "~/.agents/skills",
        })
      : effectiveTab === "agent_global"
        ? gt("只校验同供应商各实例的覆盖，其他供应商标记为不适用。展开行可提升为真全局。")
        : gt("各驱动自带的内置技能，仅在该驱动下声明。");

  const renderBody = () => {
    if (overview === null) {
      if (isLoading) {
        return (
          <div
            className="flex items-center gap-2 py-4 text-xs text-muted-foreground"
            aria-busy="true"
          >
            <Spinner size="xs" />
            {gt("正在扫描各 Agent 全局技能目录…")}
          </div>
        );
      }
      return (
        <div className="flex flex-wrap items-center gap-2 py-4 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{errorMessage ?? gt("无法读取技能声明状态。")}</span>
          <Button size="xs" variant="outline" disabled={isLoading} onClick={() => loadOverview()}>
            {gt("重试")}
          </Button>
        </div>
      );
    }

    if (displayedInstances.length === 0) {
      return (
        <p className="py-4 text-xs text-muted-foreground">
          {gt("没有已启用的智能体实例，打开「含已停用实例」查看全部。")}
        </p>
      );
    }

    if (visibleSkills.length === 0) {
      const hasAnyInScope = allSkills.some((skill) => skill.scope === effectiveTab);
      return (
        <p className="py-4 text-xs text-muted-foreground">
          {hasAnyInScope ? gt("当前筛选条件下没有匹配的技能。") : gt("当前分层下暂无技能。")}
        </p>
      );
    }

    return (
      <SkillsMatrixTable
        skills={visibleSkills}
        instances={displayedInstances}
        allInstances={overview.instances}
        checkedAt={overview.checkedAt}
        showOwnerBadges={effectiveTab === "agent_global"}
        expandedSkills={expandedSkills}
        onToggleSkill={toggleSkill}
        actions={actions}
      />
    );
  };

  return (
    <SettingsSection
      id="skills-overview"
      title={gt("技能管理器")}
      headerAction={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            size="xs"
            disabled={overview === null || busyKey !== null}
            onClick={() => setImportOpen(true)}
          >
            <PlusIcon />
            {gt("导入技能")}
          </Button>
          {duplicateStats.total > 0 ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busyKey !== null}
              aria-busy={busyKey === "dedupe_all"}
              onClick={() => void dedupeAll()}
            >
              <CopyIcon />
              {gt("一键去重 ({count})", { count: duplicateStats.total })}
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={isLoading || busyKey !== null}
            aria-busy={isLoading}
            onClick={() => loadOverview()}
          >
            <RefreshIcon refreshing={isLoading} />
            {gt("刷新")}
          </Button>
        </div>
      }
    >
      <div className="space-y-2.5 px-3 py-2.5 sm:px-4">
        <p className="text-pretty text-xs leading-normal text-muted-foreground">
          {gt(
            "按「真全局池 / 供应商专属全局 / 驱动内置」分层展示每个技能在各 Agent 实例中的真实声明状态，并可直接导入、同步、去重和备份（不统计单项目技能）。",
          )}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label={gt("技能分层")}
            variant="segmented"
            value={[effectiveTab]}
            onValueChange={(next) => {
              const selected = next[0];
              if (isSkillMatrixScope(selected)) setActiveScopeTab(selected);
            }}
          >
            <Toggle value="universal">
              {gt("真全局 ({count})", { count: universalSkills.length })}
            </Toggle>
            <Toggle value="agent_global">
              {gt("供应商专属 ({count})", { count: agentGlobalSkills.length })}
            </Toggle>
            <Toggle value="builtin">
              {gt("驱动内置 ({count})", { count: builtinSkills.length })}
            </Toggle>
          </ToggleGroup>

          <Input
            size="compact"
            className="w-44"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={gt("搜索技能或驱动")}
            aria-label={gt("搜索技能")}
            spellCheck={false}
          />

          <Toggle
            variant="outline"
            size="xs"
            pressed={issuesOnly}
            onPressedChange={(pressed) => setIssuesOnly(Boolean(pressed))}
          >
            {gt("仅看缺失/异常 ({count})", { count: issueCountInTab })}
          </Toggle>

          <Toggle
            variant="outline"
            size="xs"
            pressed={duplicatesOnly}
            onPressedChange={(pressed) => setDuplicatesOnly(Boolean(pressed))}
          >
            {gt("仅看重复 ({count})", { count: duplicateCountInTab })}
          </Toggle>

          <Toggle
            variant="outline"
            size="xs"
            pressed={includeDisabled}
            onPressedChange={(pressed) => setIncludeDisabled(Boolean(pressed))}
          >
            {gt("含已停用实例")}
          </Toggle>
        </div>

        {effectiveTab === "agent_global" && !includeDisabled && hiddenAgentSkillCount > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-info/30 bg-info/5 px-2.5 py-1.5 text-2xs text-info-foreground">
            <InfoIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              {gt("另有 {count} 个专属技能仅归属于已停用实例，点击展开「含已停用实例」查看。", {
                count: hiddenAgentSkillCount,
              })}
            </span>
            <Button size="micro" variant="outline" onClick={() => setIncludeDisabled(true)}>
              {gt("含已停用实例")}
            </Button>
          </div>
        ) : null}

        <p className="font-mono text-3xs text-muted-foreground">{tabHint}</p>
      </div>

      {diagnostics.length > 0 ? (
        <div className="space-y-1 px-3 pb-2.5 sm:px-4">
          {diagnostics.map((diagnostic) => (
            <DiagnosticBanner
              key={`${diagnostic.code}:${diagnostic.message}:${diagnostic.detail ?? ""}`}
              diagnostic={diagnostic}
            />
          ))}
        </div>
      ) : null}

      {overview !== null && errorMessage !== null ? (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-warning sm:px-4">
          <span className="min-w-0 flex-1">{errorMessage}</span>
          <Button size="xs" variant="outline" disabled={isLoading} onClick={() => loadOverview()}>
            {gt("重试")}
          </Button>
        </div>
      ) : null}

      <div className="px-3 pb-3 sm:px-4">{renderBody()}</div>

      <ImportSkillDialog
        key={environmentId}
        open={importOpen}
        environmentId={environmentId}
        instances={overview?.instances ?? []}
        busy={busyKey !== null}
        onOpenChange={setImportOpen}
        onSubmit={async (input) => (await runManage("import_skill", input)) !== null}
      />

      {syncRequest !== null ? (
        <SyncSkillsDialog
          open
          instances={displayedInstances}
          sourceInstanceId={syncRequest.sourceInstanceId}
          skillName={syncRequest.skillName}
          entry={syncRequest.entry}
          initialTargetIds={syncRequest.initialTargetIds}
          missingInstanceIds={syncRequest.missingInstanceIds}
          busy={busyKey !== null}
          onOpenChange={(open) => {
            if (!open) setSyncRequest(null);
          }}
          onSubmit={async (input) => (await runManage("sync_instances", input)) !== null}
        />
      ) : null}

      {dedupeConflictEntry !== null ? (
        <DedupeConflictDialog
          open
          entry={dedupeConflictEntry}
          busy={busyKey !== null}
          onOpenChange={(open) => {
            if (!open) setDedupeConflictEntry(null);
          }}
          onSubmit={async (input) => (await runManage("dedupe_skill", input)) !== null}
        />
      ) : null}

      <AlertDialog
        open={backupEntry !== null}
        onOpenChange={(open) => {
          if (!open) setBackupEntry(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("移入回收备份 (_backup)")}</AlertDialogTitle>
            <AlertDialogDescription>
              {gt(
                "将技能 {name} 的实体目录移入同级 _backup 目录，操作完成后可以从磁盘找回。联接只会被移除，不会删除真实目标。",
                { name: backupEntry?.name ?? "" },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={busyKey !== null}
              render={<Button variant="outline" disabled={busyKey !== null} />}
            >
              {gt("取消")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busyKey !== null}
              aria-busy={busyKey?.startsWith("backup_skill:") === true}
              onClick={() => void confirmBackup()}
            >
              <ArchiveIcon />
              {gt("确认移入备份")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

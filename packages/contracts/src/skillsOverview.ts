import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const SkillMatrixScope = Schema.Literals(["universal", "agent_global", "builtin"]);
export type SkillMatrixScope = typeof SkillMatrixScope.Type;

export const SkillMatrixCellStatus = Schema.Literals([
  "declared_runtime",
  "declared_disk",
  "disk_warning",
  "missing",
  "not_applicable",
]);
export type SkillMatrixCellStatus = typeof SkillMatrixCellStatus.Type;

export const SkillMatrixInstance = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  driverGroupKey: Schema.String,
  driverGroupLabel: Schema.String,
  displayName: Schema.String,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  status: Schema.String,
  readsUniversalPool: Schema.Boolean,
  globalSkillDirs: Schema.Array(Schema.String),
  writableGlobalSkillDir: Schema.optional(Schema.String),
});
export type SkillMatrixInstance = typeof SkillMatrixInstance.Type;

export const SkillDiskLocation = Schema.Struct({
  path: Schema.String,
  sourceDir: Schema.String,
  layer: Schema.Literals(["universal", "provider_global", "instance_manifest"]),
  ownerLabel: Schema.String,
  isLink: Schema.Boolean,
  linkTarget: Schema.optional(Schema.String),
  contentHash: Schema.optional(Schema.String),
});
export type SkillDiskLocation = typeof SkillDiskLocation.Type;

export const SkillMatrixCell = Schema.Struct({
  status: SkillMatrixCellStatus,
  path: Schema.optional(Schema.String),
  linkTarget: Schema.optional(Schema.String),
  sourceDir: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  isLink: Schema.optional(Schema.Boolean),
  fromSkillsJson: Schema.optional(Schema.Boolean),
  removable: Schema.optional(Schema.Boolean),
  autoFixable: Schema.optional(Schema.Boolean),
});
export type SkillMatrixCell = typeof SkillMatrixCell.Type;

export const SkillMatrixEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  scope: SkillMatrixScope,
  ownerGroupLabels: Schema.Array(Schema.String),
  canonicalPath: Schema.optional(Schema.String),
  coveredEnabledCount: NonNegativeInt,
  expectedEnabledCount: NonNegativeInt,
  cells: Schema.Record(Schema.String, SkillMatrixCell),
  locations: Schema.Array(SkillDiskLocation).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  hasDuplicateCopies: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  hasContentConflict: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type SkillMatrixEntry = typeof SkillMatrixEntry.Type;

export const SkillMatrixDiagnostic = Schema.Struct({
  severity: Schema.Literals(["warning", "info"]),
  code: Schema.String,
  message: Schema.String,
  detail: Schema.optional(Schema.String),
});
export type SkillMatrixDiagnostic = typeof SkillMatrixDiagnostic.Type;

export const ServerGetSkillsOverviewInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ServerGetSkillsOverviewInput = typeof ServerGetSkillsOverviewInput.Type;

export const ServerGetSkillsOverviewResult = Schema.Struct({
  checkedAt: IsoDateTime,
  universalPoolDir: Schema.String,
  instances: Schema.Array(SkillMatrixInstance),
  skills: Schema.Array(SkillMatrixEntry),
  diagnostics: Schema.Array(SkillMatrixDiagnostic),
});
export type ServerGetSkillsOverviewResult = typeof ServerGetSkillsOverviewResult.Type;

const SkillManageMode = Schema.Literals(["link", "copy"]);

export const ServerManageSkillsInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("mount_to_instance"),
    skillName: TrimmedNonEmptyString,
    sourcePath: Schema.optional(TrimmedNonEmptyString),
    targetInstanceId: ProviderInstanceId,
    mode: Schema.optional(SkillManageMode),
  }),
  Schema.Struct({
    action: Schema.Literal("unmount_from_instance"),
    skillName: TrimmedNonEmptyString,
    targetInstanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    action: Schema.Literal("fix_instance_warning"),
    skillName: TrimmedNonEmptyString,
    targetInstanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    action: Schema.Literal("link_universal_pool"),
    targetInstanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    action: Schema.Literal("sync_instances"),
    sourceInstanceId: Schema.optional(ProviderInstanceId),
    targetInstanceIds: Schema.Array(ProviderInstanceId),
    skillNames: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    mode: Schema.optional(SkillManageMode),
  }),
  Schema.Struct({
    action: Schema.Literal("promote_to_universal"),
    skillName: TrimmedNonEmptyString,
    sourcePath: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("demote_to_provider"),
    skillName: TrimmedNonEmptyString,
    targetInstanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    action: Schema.Literal("import_skill"),
    sourceDirPath: TrimmedNonEmptyString,
    targetScope: Schema.Literals(["universal", "provider_global", "instance"]),
    targetInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
    mode: SkillManageMode,
    mountToNonUniversalEnabled: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal("dedupe_skill"),
    skillName: TrimmedNonEmptyString,
    preferSourcePath: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    action: Schema.Literal("dedupe_all"),
  }),
  Schema.Struct({
    action: Schema.Literal("backup_skill"),
    skillName: TrimmedNonEmptyString,
    targetPath: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type ServerManageSkillsInput = typeof ServerManageSkillsInput.Type;

export const ServerManageSkillsResult = Schema.Struct({
  ok: Schema.Boolean,
  summary: Schema.String,
  affectedPaths: Schema.Array(Schema.String),
  skippedConflicts: Schema.Array(Schema.String),
  overview: ServerGetSkillsOverviewResult,
});
export type ServerManageSkillsResult = typeof ServerManageSkillsResult.Type;

export class SkillsOverviewError extends Schema.TaggedError<SkillsOverviewError>()(
  "SkillsOverviewError",
  {
    message: Schema.String,
  },
) {}

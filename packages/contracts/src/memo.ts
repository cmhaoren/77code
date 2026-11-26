import * as Schema from "effect/Schema";

import { IsoDateTime, MemoId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const MemoStatus = Schema.Literals(["todo", "in_progress", "done"]);
export type MemoStatus = typeof MemoStatus.Type;

export const MemoColor = Schema.Literals(["amber", "sage", "sky", "rose", "lavender"]);
export type MemoColor = typeof MemoColor.Type;

export const MemoSource = Schema.Literals(["manual", "thread"]);
export type MemoSource = typeof MemoSource.Type;

export const Memo = Schema.Struct({
  id: MemoId,
  title: TrimmedNonEmptyString,
  content: Schema.String,
  status: MemoStatus,
  color: MemoColor,
  source: MemoSource,
  threadId: Schema.NullOr(ThreadId),
  threadTitle: Schema.NullOr(Schema.String),
  projectId: Schema.NullOr(ProjectId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type Memo = typeof Memo.Type;

export const MemoListInput = Schema.Struct({});
export type MemoListInput = typeof MemoListInput.Type;

export const MemoListResult = Schema.Struct({
  memos: Schema.Array(Memo),
});
export type MemoListResult = typeof MemoListResult.Type;

export const MemoCreateInput = Schema.Struct({
  title: TrimmedNonEmptyString,
  content: Schema.optional(Schema.String),
  color: Schema.optional(MemoColor),
  source: Schema.optional(MemoSource),
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  threadTitle: Schema.optional(Schema.NullOr(Schema.String)),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
});
export type MemoCreateInput = typeof MemoCreateInput.Type;

export const MemoUpdateInput = Schema.Struct({
  id: MemoId,
  title: Schema.optional(TrimmedNonEmptyString),
  content: Schema.optional(Schema.String),
  status: Schema.optional(MemoStatus),
  color: Schema.optional(MemoColor),
});
export type MemoUpdateInput = typeof MemoUpdateInput.Type;

export const MemoDeleteInput = Schema.Struct({
  id: MemoId,
});
export type MemoDeleteInput = typeof MemoDeleteInput.Type;

export const MemoDeleteResult = Schema.Struct({
  id: MemoId,
  deleted: Schema.Boolean,
});
export type MemoDeleteResult = typeof MemoDeleteResult.Type;

export const MemoMutationResult = Schema.Struct({
  memo: Memo,
});
export type MemoMutationResult = typeof MemoMutationResult.Type;

export const MemoStartLaunchInput = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  modelSelection: ModelSelection,
});
export type MemoStartLaunchInput = typeof MemoStartLaunchInput.Type;

export const MemoStartInput = Schema.Struct({
  id: MemoId,
  launch: Schema.optional(MemoStartLaunchInput),
});
export type MemoStartInput = typeof MemoStartInput.Type;

export const MemoStartResult = Schema.Struct({
  memo: Memo,
  threadId: ThreadId,
  projectId: ProjectId,
  createdNewThread: Schema.Boolean,
  queued: Schema.Boolean,
});
export type MemoStartResult = typeof MemoStartResult.Type;

export const MemoErrorCode = Schema.Literals([
  "not_found",
  "thread_not_found",
  "launch_required",
  "dispatch_failed",
  "storage_failed",
]);
export type MemoErrorCode = typeof MemoErrorCode.Type;

export class MemoError extends Schema.TaggedError<MemoError>()("MemoError", {
  message: Schema.String,
  memoId: Schema.optional(MemoId),
  code: Schema.optional(MemoErrorCode),
  cause: Schema.optional(Schema.Defect()),
}) {}

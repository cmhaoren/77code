import {
  Memo,
  MemoColor,
  MemoDeleteResult,
  MemoId,
  MemoStatus,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as MemoService from "../../../memos/MemoService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const MemoTool = Tool.make("t3_memo", {
  description:
    "Manage sticky-note todos (便签/待办). When the user asks to note a todo/reminder for later, ask briefly if unclear; once clear, add it here (bound to this thread by default). Actions: list, add (title; optional content, color, bindToCurrentThread), update (memoId; optional title, content, status, color), delete (memoId).",
  parameters: Schema.Struct({
    action: Schema.Literals(["list", "add", "update", "delete"]),
    memoId: Schema.optional(MemoId),
    title: Schema.optional(TrimmedNonEmptyString),
    content: Schema.optional(Schema.String),
    status: Schema.optional(MemoStatus),
    color: Schema.optional(MemoColor),
    bindToCurrentThread: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Union([
    Schema.Struct({ memos: Schema.Array(Memo), currentThreadId: Schema.NullOr(ThreadId) }),
    Schema.Struct({ memo: Memo }),
    MemoDeleteResult,
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    MemoService.MemoService,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Manage sticky-note todos")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const MemosToolkit = Toolkit.make(MemoTool);

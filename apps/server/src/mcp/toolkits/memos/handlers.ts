import {
  type MemoCreateInput,
  type MemoError,
  type MemoUpdateInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MemoService from "../../../memos/MemoService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MemosToolkit } from "./tools.ts";

/** A field the chosen action needs. */
const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This action needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);

const memoFailure = (error: MemoError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "thread_not_found"
        ? "thread_not_found"
        : error.code === "dispatch_failed" || error.code === "storage_failed"
          ? "orchestration_error"
          : "invalid_request",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(MemosToolkit, {
  t3_memo: McpToolAccess.either(
    (input) => input.action === "list",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const memos = yield* MemoService.MemoService;
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const { memos: all } = yield* memos.list().pipe(Effect.mapError(memoFailure));
        return {
          memos:
            input.status === undefined ? all : all.filter((memo) => memo.status === input.status),
          currentThreadId: scope.thread?.threadId ?? null,
        };
      }),
    ),
    McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const memos = yield* MemoService.MemoService;
        switch (input.action) {
          case "add": {
            const title = yield* required(input.title, "title");
            const scope = yield* McpInvocationContext.McpInvocationContext;
            const threadId =
              input.bindToCurrentThread === false ? undefined : scope.thread?.threadId;
            const thread =
              threadId === undefined
                ? null
                : yield* ThreadManagementService.ThreadManagementService.pipe(
                    Effect.flatMap((threads) => threads.getThreadShell(threadId)),
                    Effect.orElseSucceed(() => null),
                    Effect.map((shell) =>
                      shell === null || shell.deletedAt !== null ? null : shell,
                    ),
                  );
            const createInput: MemoCreateInput =
              thread === null
                ? {
                    title,
                    source: "manual",
                    threadId: null,
                    threadTitle: null,
                    projectId: null,
                  }
                : {
                    title,
                    source: "thread",
                    threadId,
                    threadTitle: thread.title,
                    projectId: thread.projectId,
                  };
            const { memo } = yield* memos
              .create({
                ...createInput,
                ...(input.content === undefined ? {} : { content: input.content }),
                ...(input.color === undefined ? {} : { color: input.color }),
              })
              .pipe(Effect.mapError(memoFailure));
            return { memo };
          }
          case "update": {
            const memoId = yield* required(input.memoId, "memoId");
            const updateInput: MemoUpdateInput = {
              id: memoId,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.content === undefined ? {} : { content: input.content }),
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.color === undefined ? {} : { color: input.color }),
            };
            const { memo } = yield* memos.update(updateInput).pipe(Effect.mapError(memoFailure));
            return { memo };
          }
          default: {
            const memoId = yield* required(input.memoId, "memoId");
            return yield* memos.delete({ id: memoId }).pipe(Effect.mapError(memoFailure));
          }
        }
      }),
    ),
  ),
});

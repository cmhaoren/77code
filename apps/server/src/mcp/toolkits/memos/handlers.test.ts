import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MemoId,
  type MemoListResult,
  ProjectId,
  ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as MemoService from "../../../memos/MemoService.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as MemosHandlers from "./handlers.ts";
import { MemosToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:memo");
const projectId = ProjectId.make("project:memo");
const providerInstanceId = ProviderInstanceId.make("codex");

type MemoToolParams = Schema.Json;
type MemoToolkitInstance = Effect.Success<typeof MemosToolkit>;

const callMemo = (toolkit: MemoToolkitInstance, params: MemoToolParams) =>
  toolkit.handle("t3_memo", params).pipe(
    Stream.unwrap,
    Stream.runCollect,
    Effect.map((parts) => parts.at(-1)?.result),
  );

type MemoCall = ReturnType<typeof callMemo>;

interface HarnessOptions {
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly threadTitle?: string;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const shell = {
    ...liveThreadShell(threadId, {
      ...(options.runtimeMode === undefined ? {} : { runtimeMode: options.runtimeMode }),
      ...(options.interactionMode === undefined
        ? {}
        : { interactionMode: options.interactionMode }),
    }),
    title: options.threadTitle ?? "Fix login",
    projectId,
  };
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:memo"),
    requestNamespace: "provider:memo",
    thread: {
      threadId,
      providerSessionId: "provider:memo",
      providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (requested) => Effect.succeed(requested === threadId ? shell : null),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
    Layer.mock(ServerSettings.ServerSettingsService)({}),
    SqlitePersistence.layerMemory,
    NodeCrypto.layer,
  );
  const layer = McpToolAccess.HandlersLayer.layer(MemosHandlers.layer).pipe(
    Layer.provideMerge(MemoService.layer),
    Layer.provideMerge(dependencies),
  );
  return { layer };
};

const runMemoTest = <A, E, R>(
  options: HarnessOptions,
  test: (context: {
    readonly call: (params: MemoToolParams) => MemoCall;
    readonly memos: MemoService.MemoService["Service"];
  }) => Effect.Effect<A, E, R>,
) => {
  const { layer } = makeHarness(options);
  return Effect.gen(function* () {
    const toolkit = yield* MemosToolkit;
    const memos = yield* MemoService.MemoService;
    return yield* test({ call: (params) => callMemo(toolkit, params), memos });
  }).pipe(Effect.provide(layer));
};

const expectMemo = (result: unknown) => {
  assert.ok(
    result !== undefined && result !== null && typeof result === "object" && "memo" in result,
  );
  return (result as { readonly memo: Record<string, unknown> }).memo;
};

const expectMemos = (result: unknown) => {
  assert.ok(
    result !== undefined && result !== null && typeof result === "object" && "memos" in result,
  );
  return result as MemoListResult;
};

it.effect("add binds a memo to the calling thread by default", () =>
  runMemoTest({}, ({ call }) =>
    Effect.gen(function* () {
      const result = yield* call({
        action: "add",
        title: "Buy milk",
        content: "Two litres",
        color: "sky",
      });

      expect(expectMemo(result)).toMatchObject({
        title: "Buy milk",
        content: "Two litres",
        color: "sky",
        status: "todo",
        source: "thread",
        threadId,
        threadTitle: "Fix login",
        projectId,
      });
    }),
  ),
);

it.effect("add with bindToCurrentThread false creates an unbound manual memo", () =>
  runMemoTest({}, ({ call }) =>
    Effect.gen(function* () {
      const result = yield* call({
        action: "add",
        title: "Call the bank",
        bindToCurrentThread: false,
      });

      expect(expectMemo(result)).toMatchObject({
        title: "Call the bank",
        source: "manual",
        threadId: null,
        threadTitle: null,
        projectId: null,
      });
    }),
  ),
);

it.effect("add without a title is an invalid request", () =>
  runMemoTest({}, ({ call, memos }) =>
    Effect.gen(function* () {
      const result = yield* call({ action: "add" });

      expect(result).toMatchObject({
        code: "invalid_request",
        message: "This action needs `title`.",
      });
      expect((yield* memos.list()).memos).toEqual([]);
    }),
  ),
);

it.effect("list returns every memo or only the requested status", () =>
  runMemoTest({}, ({ call, memos }) =>
    Effect.gen(function* () {
      const todo = (yield* memos.create({ title: "Todo" })).memo;
      const inProgress = (yield* memos.create({ title: "Doing" })).memo;
      yield* memos.update({ id: inProgress.id, status: "in_progress" });
      const done = (yield* memos.create({ title: "Done" })).memo;
      yield* memos.update({ id: done.id, status: "done" });

      const all = expectMemos(yield* call({ action: "list" }));
      expect(all.memos.map((memo) => memo.id).sort()).toEqual(
        [todo.id, inProgress.id, done.id].sort(),
      );
      expect(all).toMatchObject({ currentThreadId: threadId });

      const onlyDone = expectMemos(yield* call({ action: "list", status: "done" }));
      expect(onlyDone.memos.map((memo) => memo.id)).toEqual([done.id]);
    }),
  ),
);

it.effect("update changes the fields given and maps a missing memo to an invalid request", () =>
  runMemoTest({}, ({ call, memos }) =>
    Effect.gen(function* () {
      const created = (yield* memos.create({ title: "Draft" })).memo;

      const result = yield* call({
        action: "update",
        memoId: created.id,
        title: "Final",
        content: "Ready",
        status: "done",
        color: "sage",
      });
      expect(expectMemo(result)).toMatchObject({
        id: created.id,
        title: "Final",
        content: "Ready",
        status: "done",
        color: "sage",
      });

      expect(expectMemo(yield* call({ action: "update", memoId: created.id }))).toMatchObject({
        title: "Final",
      });
      expect(yield* call({ action: "update" })).toMatchObject({
        code: "invalid_request",
        message: "This action needs `memoId`.",
      });
      expect(
        yield* call({ action: "update", memoId: MemoId.make("memo:missing"), title: "Gone" }),
      ).toMatchObject({ code: "invalid_request", message: "That memo no longer exists." });
    }),
  ),
);

it.effect("delete removes the memo and maps a missing memo id to an invalid request", () =>
  runMemoTest({}, ({ call, memos }) =>
    Effect.gen(function* () {
      const created = (yield* memos.create({ title: "Remove me" })).memo;

      expect(yield* call({ action: "delete", memoId: created.id })).toEqual({
        id: created.id,
        deleted: true,
      });
      expect((yield* memos.list()).memos).toEqual([]);
      expect(yield* call({ action: "delete" })).toMatchObject({
        code: "invalid_request",
        message: "This action needs `memoId`.",
      });
    }),
  ),
);

it.effect("a plan-mode thread can still record a memo", () =>
  runMemoTest({ runtimeMode: "auto", interactionMode: "plan" }, ({ call }) =>
    Effect.gen(function* () {
      const result = yield* call({ action: "add", title: "Remember this after planning" });

      expect(expectMemo(result)).toMatchObject({
        title: "Remember this after planning",
        source: "thread",
        threadId,
      });
    }),
  ),
);

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ManagedPolicySummary,
  MemoError,
  MemoId,
  type MemoListResult,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as SqlClient from "effect/sql/SqlClient";

import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MemoService from "./MemoService.ts";

const isMemoError = Schema.is(MemoError);

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5",
};

const threadShell = (input: {
  readonly projectId: string;
  readonly title: string;
  readonly deletedAt?: string | null;
  readonly archivedAt?: string | null;
}): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make("thread-bound"),
    projectId: ProjectId.make(input.projectId),
    title: input.title,
    deletedAt: input.deletedAt ?? null,
    archivedAt: input.archivedAt ?? null,
  }) as never;

interface HarnessOptions {
  readonly threads?: ReadonlyMap<string, OrchestrationV2ThreadShell | null>;
  readonly delivery?: "started" | "queued" | "steered" | "restarted";
  readonly launchedThreadId?: string;
  readonly scratchProjectId?: string;
  readonly scratchDies?: boolean;
  readonly managedPolicy?: ManagedPolicySummary;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const launchCalls: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const sendCalls: Array<ThreadManagementService.ThreadManagementSendInput> = [];
  const scratchCalls: Array<void> = [];
  const launchedThreadId = ThreadId.make(options.launchedThreadId ?? "thread-launched");
  const scratchProjectId = ProjectId.make(options.scratchProjectId ?? "project-scratch");
  const threads = options.threads ?? new Map();

  const layer = MemoService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        NodeCrypto.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) => {
            launchCalls.push(input);
            return Effect.succeed({
              threadId: launchedThreadId,
              projection: {} as never,
              resumed: false,
            });
          },
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(threads.get(threadId) ?? null),
          sendToThread: (input) => {
            sendCalls.push(input);
            return Effect.succeed({ delivery: options.delivery ?? "started" } as never);
          },
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          ensureScratchProject: options.scratchDies
            ? Effect.die(new Error("The scratch project must not be resolved."))
            : Effect.suspend(() => {
                scratchCalls.push(undefined);
                return Effect.succeed({ projectId: scratchProjectId });
              }),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          managedPolicy: options.managedPolicy,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
      ),
    ),
  );

  return { layer, launchCalls, sendCalls, scratchCalls, launchedThreadId, scratchProjectId };
};

type Harness = ReturnType<typeof makeHarness>;

const run = <A, E>(
  options: HarnessOptions,
  test: (harness: Harness) => Effect.Effect<A, E, MemoService.MemoService | SqlClient.SqlClient>,
) => {
  const harness = makeHarness(options);
  return test(harness).pipe(Effect.provide(harness.layer));
};

const epochMillis = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

describe("buildMemoActivationPrompt", () => {
  it("leads with the title and adds a body that says more", () => {
    assert.equal(
      MemoService.buildMemoActivationPrompt({ title: "Wire the lamps", content: "" }),
      "继续执行便签待办：Wire the lamps",
    );
    assert.equal(
      MemoService.buildMemoActivationPrompt({ title: "Wire the lamps", content: "   " }),
      "继续执行便签待办：Wire the lamps",
    );
    assert.equal(
      MemoService.buildMemoActivationPrompt({
        title: "Wire the lamps",
        content: "Wire the lamps",
      }),
      "继续执行便签待办：Wire the lamps",
    );
    assert.equal(
      MemoService.buildMemoActivationPrompt({
        title: "Wire the lamps",
        content: "  Use the brass ones.  ",
      }),
      "继续执行便签待办：Wire the lamps\n\nUse the brass ones.",
    );
  });
});

describe("MemoService", () => {
  it.effect("creates a memo with defaults and lists it back", () =>
    run({}, () =>
      Effect.gen(function* () {
        const service = yield* MemoService.MemoService;
        const created = yield* service.create({ title: "  Buy milk  ", content: "2 liters" });

        assert.equal(created.memo.title, "Buy milk");
        assert.equal(created.memo.content, "2 liters");
        assert.equal(created.memo.status, "todo");
        assert.equal(created.memo.color, "amber");
        assert.equal(created.memo.source, "manual");
        assert.equal(created.memo.threadId, null);
        assert.equal(created.memo.threadTitle, null);
        assert.equal(created.memo.projectId, null);
        assert.equal(created.memo.startedAt, null);
        assert.equal(created.memo.completedAt, null);
        assert.equal(created.memo.createdAt, created.memo.updatedAt);
        assert.match(
          created.memo.id,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );

        const listed = yield* service.list();
        assert.deepEqual(listed.memos, [created.memo]);
      }),
    ),
  );

  it.effect("keeps thread provenance when a memo is created from a thread", () =>
    run({}, () =>
      Effect.gen(function* () {
        const service = yield* MemoService.MemoService;
        const threadId = ThreadId.make("thread-source");
        const projectId = ProjectId.make("project-source");
        const created = yield* service.create({
          title: "From chat",
          threadId,
          threadTitle: "The chat title",
          projectId,
        });

        assert.equal(created.memo.source, "thread");
        assert.equal(created.memo.threadId, threadId);
        assert.equal(created.memo.threadTitle, "The chat title");
        assert.equal(created.memo.projectId, projectId);
        assert.equal(created.memo.content, "");
      }),
    ),
  );

  it.effect("lists active memos newest first, then done memos by completion", () =>
    run({}, () =>
      Effect.gen(function* () {
        const service = yield* MemoService.MemoService;
        yield* TestClock.setTime(1_000);
        const first = yield* service.create({ title: "First" });
        yield* TestClock.setTime(2_000);
        const second = yield* service.create({ title: "Second" });
        yield* TestClock.setTime(3_000);
        const third = yield* service.create({ title: "Third" });

        yield* TestClock.setTime(4_000);
        yield* service.update({ id: third.memo.id, status: "done" });
        yield* TestClock.setTime(5_000);
        yield* service.update({ id: first.memo.id, title: "First, edited" });

        const active = yield* service.list();
        assert.deepEqual(
          active.memos.map((memo) => memo.id),
          [first.memo.id, second.memo.id, third.memo.id],
        );
        assert.equal(active.memos[0]?.title, "First, edited");

        yield* TestClock.setTime(6_000);
        yield* service.update({ id: third.memo.id, status: "todo" });
        const reopened = yield* service.list();
        assert.deepEqual(
          reopened.memos.map((memo) => memo.id),
          [third.memo.id, first.memo.id, second.memo.id],
        );
      }),
    ),
  );

  it.effect("moves completedAt with the done transition and updates updatedAt", () =>
    run({}, () =>
      Effect.gen(function* () {
        const service = yield* MemoService.MemoService;
        yield* TestClock.setTime(1_000);
        const created = yield* service.create({ title: "Ship it" });

        yield* TestClock.setTime(2_000);
        const started = yield* service.update({ id: created.memo.id, status: "in_progress" });
        assert.equal(started.memo.status, "in_progress");
        assert.equal(started.memo.completedAt, null);
        assert.equal(epochMillis(started.memo.updatedAt), 2_000);

        yield* TestClock.setTime(3_000);
        const done = yield* service.update({ id: created.memo.id, status: "done" });
        assert.equal(done.memo.status, "done");
        assert.notEqual(done.memo.completedAt, null);
        assert.equal(epochMillis(done.memo.completedAt!), 3_000);
        assert.equal(epochMillis(done.memo.updatedAt), 3_000);

        // An edit that does not change the status keeps the completion time.
        const edited = yield* service.update({ id: created.memo.id, content: "Now with notes" });
        assert.equal(edited.memo.content, "Now with notes");
        assert.equal(edited.memo.completedAt, done.memo.completedAt);

        yield* TestClock.setTime(4_000);
        const reopened = yield* service.update({ id: created.memo.id, status: "todo" });
        assert.equal(reopened.memo.status, "todo");
        assert.equal(reopened.memo.completedAt, null);
      }),
    ),
  );

  it.effect("fails update and start for a memo that no longer exists", () =>
    run({}, () =>
      Effect.gen(function* () {
        const service = yield* MemoService.MemoService;
        const missing = MemoId.make("memo-missing");

        const updateError = yield* service.update({ id: missing, title: "Nope" }).pipe(Effect.flip);
        assert.isTrue(isMemoError(updateError));
        assert.equal(updateError.code, "not_found");
        assert.equal(updateError.memoId, missing);

        const startError = yield* service.start({ id: missing }).pipe(Effect.flip);
        assert.isTrue(isMemoError(startError));
        assert.equal(startError.code, "not_found");
      }),
    ),
  );

  it.effect("deletes a memo once and reports whether the row existed", () =>
    run({}, () =>
      Effect.gen(function* () {
        const service = yield* MemoService.MemoService;
        const created = yield* service.create({ title: "Throw away" });

        const deleted = yield* service.delete({ id: created.memo.id });
        assert.deepEqual(deleted, { id: created.memo.id, deleted: true });
        assert.deepEqual((yield* service.list()).memos, []);

        const again = yield* service.delete({ id: created.memo.id });
        assert.deepEqual(again, { id: created.memo.id, deleted: false });
      }),
    ),
  );

  it.effect("pushes a snapshot on subscribe and after every mutation", () =>
    run({}, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* MemoService.MemoService;
          const snapshots = yield* Queue.unbounded<MemoListResult>();
          yield* service.subscribeList().pipe(
            Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
            Effect.forkScoped,
          );

          assert.deepEqual((yield* Queue.take(snapshots)).memos, []);

          const created = yield* service.create({ title: "Live" });
          const afterCreate = yield* Queue.take(snapshots);
          assert.deepEqual(
            afterCreate.memos.map((memo) => memo.id),
            [created.memo.id],
          );

          yield* service.update({ id: created.memo.id, title: "Live, edited" });
          const afterUpdate = yield* Queue.take(snapshots);
          assert.equal(afterUpdate.memos[0]?.title, "Live, edited");

          yield* service.delete({ id: created.memo.id });
          assert.deepEqual((yield* Queue.take(snapshots)).memos, []);
        }),
      ),
    ),
  );

  it.effect("sends a bound memo to its thread and marks it in progress", () =>
    run(
      {
        threads: new Map([
          [
            "thread-bound",
            threadShell({
              projectId: "project-bound",
              title: "A better thread title",
            }),
          ],
        ]),
      },
      (harness) =>
        Effect.gen(function* () {
          const service = yield* MemoService.MemoService;
          yield* TestClock.setTime(7_000);
          const threadId = ThreadId.make("thread-bound");
          const memo = yield* service.create({
            title: "Wire the lamps",
            content: "Use the brass ones.",
            threadId,
            threadTitle: "Old title",
            projectId: ProjectId.make("project-old"),
          });

          const result = yield* service.start({ id: memo.memo.id });

          assert.equal(result.threadId, threadId);
          assert.equal(result.projectId, ProjectId.make("project-bound"));
          assert.isFalse(result.createdNewThread);
          assert.isFalse(result.queued);
          assert.equal(result.memo.status, "in_progress");
          assert.equal(result.memo.threadId, threadId);
          assert.equal(result.memo.threadTitle, "A better thread title");
          assert.equal(result.memo.projectId, ProjectId.make("project-bound"));
          assert.equal(result.memo.completedAt, null);
          assert.notEqual(result.memo.startedAt, null);
          assert.equal(epochMillis(result.memo.updatedAt), 7_000);

          assert.lengthOf(harness.sendCalls, 1);
          assert.equal(
            harness.sendCalls[0]?.text,
            "继续执行便签待办：Wire the lamps\n\nUse the brass ones.",
          );
          assert.equal(harness.sendCalls[0]?.mode, "queue");
          assert.equal(harness.sendCalls[0]?.projectId, ProjectId.make("project-bound"));
          assert.lengthOf(harness.launchCalls, 0);
        }),
    ),
  );

  it.effect("reports a queued delivery when the bound thread is busy", () =>
    run(
      {
        delivery: "queued",
        threads: new Map([
          ["thread-bound", threadShell({ projectId: "project-bound", title: "Busy" })],
        ]),
      },
      () =>
        Effect.gen(function* () {
          const service = yield* MemoService.MemoService;
          const threadId = ThreadId.make("thread-bound");
          const memo = yield* service.create({ title: "Queued work", threadId });
          const result = yield* service.start({ id: memo.memo.id });
          assert.isTrue(result.queued);
        }),
    ),
  );

  it.effect("fails with thread_not_found when the bound thread was deleted or archived", () =>
    run(
      {
        threads: new Map([
          ["thread-gone", null],
          [
            "thread-deleted",
            threadShell({
              projectId: "project-bound",
              title: "Gone",
              deletedAt: "2026-01-01T00:00:00.000Z",
            }),
          ],
          [
            "thread-archived",
            threadShell({
              projectId: "project-bound",
              title: "Archived",
              archivedAt: "2026-01-02T00:00:00.000Z",
            }),
          ],
        ]),
      },
      () =>
        Effect.gen(function* () {
          const service = yield* MemoService.MemoService;
          for (const threadId of ["thread-gone", "thread-deleted", "thread-archived"]) {
            const memo = yield* service.create({
              title: "Orphan",
              threadId: ThreadId.make(threadId),
            });

            const error = yield* service.start({ id: memo.memo.id }).pipe(Effect.flip);
            assert.isTrue(isMemoError(error));
            assert.equal(error.code, "thread_not_found");
            assert.equal(error.memoId, memo.memo.id);
          }
        }),
    ),
  );

  it.effect("requires launch details for a memo that has no thread", () =>
    run({}, () =>
      Effect.gen(function* () {
        const service = yield* MemoService.MemoService;
        const memo = yield* service.create({ title: "Unbound" });

        const error = yield* service.start({ id: memo.memo.id }).pipe(Effect.flip);
        assert.isTrue(isMemoError(error));
        assert.equal(error.code, "launch_required");
        assert.equal(error.memoId, memo.memo.id);
      }),
    ),
  );

  it.effect("launches a new thread in the scratch project and binds the memo to it", () =>
    run({}, (harness) =>
      Effect.gen(function* () {
        const service = yield* MemoService.MemoService;
        yield* TestClock.setTime(9_000);
        const memo = yield* service.create({ title: "Start a thread", content: "Do the thing" });

        const result = yield* service.start({
          id: memo.memo.id,
          launch: { projectId: null, modelSelection },
        });

        assert.isTrue(result.createdNewThread);
        assert.isFalse(result.queued);
        assert.equal(result.threadId, ThreadId.make("thread-launched"));
        assert.equal(result.projectId, ProjectId.make("project-scratch"));
        assert.equal(result.memo.threadId, ThreadId.make("thread-launched"));
        assert.equal(result.memo.threadTitle, "Start a thread");
        assert.equal(result.memo.projectId, ProjectId.make("project-scratch"));
        assert.equal(result.memo.status, "in_progress");
        assert.equal(result.memo.completedAt, null);
        assert.equal(epochMillis(result.memo.startedAt!), 9_000);

        assert.lengthOf(harness.scratchCalls, 1);
        assert.lengthOf(harness.launchCalls, 1);
        const launched = harness.launchCalls[0]!;
        assert.equal(launched.projectId, ProjectId.make("project-scratch"));
        assert.equal(launched.title, "Start a thread");
        assert.equal(launched.titleRenamed, false);
        assert.equal(launched.runtimeMode, "full-access");
        assert.equal(launched.interactionMode, "default");
        assert.deepEqual(launched.workspaceStrategy, { type: "root" });
        assert.deepEqual(launched.modelSelection, modelSelection);
        assert.equal(
          launched.initialMessage?.text,
          "继续执行便签待办：Start a thread\n\nDo the thing",
        );
        assert.equal(launched.createdBy, "user");
        assert.equal(launched.creationSource, "web");
      }),
    ),
  );

  it.effect("launches in an explicit project without resolving the scratch project", () =>
    run({ scratchDies: true }, (harness) =>
      Effect.gen(function* () {
        const service = yield* MemoService.MemoService;
        const memo = yield* service.create({ title: "Explicit" });
        const result = yield* service.start({
          id: memo.memo.id,
          launch: { projectId: ProjectId.make("project-picked"), modelSelection },
        });

        assert.equal(result.projectId, ProjectId.make("project-picked"));
        assert.equal(harness.scratchCalls.length, 0);
        assert.equal(harness.launchCalls[0]?.projectId, ProjectId.make("project-picked"));
      }),
    ),
  );

  it.effect("clamps a launched memo's runtime mode to the managed ceiling", () =>
    run(
      {
        managedPolicy: {
          organization: "Acme",
          lockedSettings: [],
          limits: { maxRuntimeMode: "approval-required" },
        },
      },
      (harness) =>
        Effect.gen(function* () {
          const service = yield* MemoService.MemoService;
          const memo = yield* service.create({ title: "Managed" });
          yield* service.start({
            id: memo.memo.id,
            launch: { projectId: ProjectId.make("project-picked"), modelSelection },
          });
          assert.equal(harness.launchCalls[0]?.runtimeMode, "approval-required");
          assert.equal(harness.launchCalls[0]?.interactionMode, "default");
        }),
    ),
  );
});

import {
  ChatAttachmentId,
  ChatImageAttachment,
  clampManagedRuntimeMode,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  Memo,
  MemoError,
  MemoId,
  type MemoCreateInput,
  type MemoDeleteInput,
  type MemoDeleteResult,
  type MemoListResult,
  type MemoMutationResult,
  type MemoStartInput,
  type MemoStartResult,
  type MemoUpdateInput,
  MessageId,
  type UploadChatImageAttachment,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SecureRandom from "effect/crypto/SecureRandom";

import {
  attachmentRelativePath,
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

interface MemoRow {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly status: string;
  readonly color: string;
  readonly source: string;
  readonly thread_id: string | null;
  readonly thread_title: string | null;
  readonly project_id: string | null;
  readonly attachments_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

export class MemoService extends Context.Service<
  MemoService,
  {
    readonly list: () => Effect.Effect<MemoListResult, MemoError>;
    readonly subscribeList: () => Stream.Stream<MemoListResult, MemoError>;
    readonly create: (input: MemoCreateInput) => Effect.Effect<MemoMutationResult, MemoError>;
    readonly update: (input: MemoUpdateInput) => Effect.Effect<MemoMutationResult, MemoError>;
    readonly delete: (input: MemoDeleteInput) => Effect.Effect<MemoDeleteResult, MemoError>;
    readonly start: (input: MemoStartInput) => Effect.Effect<MemoStartResult, MemoError>;
  }
>()("t3/memos/MemoService") {}

function memoError(
  message: string,
  input?: {
    readonly memoId?: MemoId;
    readonly code?: MemoError["code"];
    readonly cause?: unknown;
  },
): MemoError {
  return new MemoError({
    message,
    ...(input?.memoId === undefined ? {} : { memoId: input.memoId }),
    ...(input?.code === undefined ? {} : { code: input.code }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

/** The prompt a memo sends: its body when it adds detail beyond the title. */
export function buildMemoActivationPrompt(memo: Pick<Memo, "title" | "content">): string {
  const title = memo.title.trim();
  const content = memo.content.trim();
  return content.length > 0 && content !== title
    ? `继续执行便签待办：${title}\n\n${content}`
    : `继续执行便签待办：${title}`;
}

const isoNow = Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.toUtc(now)));

const decodeMemo = Schema.decodeUnknownEffect(Memo);
const decodeStoredAttachments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(ChatImageAttachment)),
);
const encodeStoredAttachments = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(ChatImageAttachment)),
);

const selectAllMemos = (sql: SqlClient.SqlClient) =>
  sql<MemoRow>`
    SELECT
      id,
      title,
      content,
      status,
      color,
      source,
      thread_id,
      thread_title,
      project_id,
      attachments_json,
      created_at,
      updated_at,
      started_at,
      completed_at
    FROM memos
    ORDER BY
      CASE WHEN status = 'done' THEN 1 ELSE 0 END ASC,
      CASE WHEN status = 'done' THEN COALESCE(completed_at, updated_at) ELSE updated_at END DESC,
      updated_at DESC,
      id ASC
  `.pipe(NodeSqliteClient.readOnly);

export const layer = Layer.effect(
  MemoService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const random = yield* SecureRandom.SecureRandom;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    // Slow subscribers need only the newest snapshot; mutations may arrive faster than a list read.
    const changes = yield* PubSub.sliding<void>(1);
    const inFlightStarts = new Set<string>();

    const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

    const persistMemoAttachments = Effect.fn("MemoService.persistAttachments")(function* (
      memoId: MemoId,
      uploads: ReadonlyArray<UploadChatImageAttachment>,
      salt: string,
    ) {
      if (uploads.length === 0) return [] as ReadonlyArray<ChatImageAttachment>;
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true }).pipe(
        Effect.mapError((cause) =>
          memoError("Could not prepare memo attachment storage.", {
            memoId,
            code: "storage_failed",
            cause,
          }),
        ),
      );
      return yield* Effect.forEach(
        uploads.map((attachment, index) => ({ attachment, index })),
        Effect.fn("MemoService.persistAttachment")(function* ({ attachment, index }) {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (parsed === null || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
            return yield* memoError(`Attachment ${attachment.name} has an invalid image payload.`, {
              memoId,
              code: "storage_failed",
            });
          }
          const bytes = yield* Effect.fromResult(Base64.decode(parsed.base64)).pipe(
            Effect.mapError((cause) =>
              memoError(`Attachment ${attachment.name} is not valid base64.`, {
                memoId,
                code: "storage_failed",
                cause,
              }),
            ),
          );
          if (bytes.byteLength !== attachment.sizeBytes) {
            return yield* memoError(
              `Attachment ${attachment.name} size does not match its payload.`,
              { memoId, code: "storage_failed" },
            );
          }
          const rawId = createDeterministicAttachmentId(
            `memo-${memoId}`,
            chatAttachmentStableKey(salt, index, bytes),
          );
          if (rawId === null) {
            return yield* memoError("Could not allocate a memo attachment identifier.", {
              memoId,
              code: "storage_failed",
            });
          }
          const persisted: ChatImageAttachment = {
            type: "image",
            id: ChatAttachmentId.make(rawId),
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          };
          const relPath = attachmentRelativePath(persisted);
          if (relPath === null) {
            return yield* memoError("Could not resolve a memo attachment filename.", {
              memoId,
              code: "storage_failed",
            });
          }
          yield* fileSystem.writeFile(path.join(config.attachmentsDir, relPath), bytes).pipe(
            Effect.mapError((cause) =>
              memoError(`Could not persist attachment ${attachment.name}.`, {
                memoId,
                code: "storage_failed",
                cause,
              }),
            ),
          );
          return persisted;
        }),
        { concurrency: 2 },
      );
    });

    const decodeRow = (row: MemoRow): Effect.Effect<Memo, MemoError> => {
      const decodedAttachments = decodeStoredAttachments(row.attachments_json || "[]");
      const attachments =
        decodedAttachments._tag === "Some" ? decodedAttachments.value : ([] as const);
      return decodeMemo({
        id: row.id,
        title: row.title,
        content: row.content,
        status: row.status,
        color: row.color,
        source: row.source,
        threadId: row.thread_id,
        threadTitle: row.thread_title,
        projectId: row.project_id,
        attachments,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      }).pipe(
        Effect.mapError((cause) =>
          memoError("Could not decode a memo row.", { code: "storage_failed", cause }),
        ),
      );
    };

    const listRows = () =>
      selectAllMemos(sql).pipe(
        Effect.mapError((cause) =>
          memoError("Could not read memos.", { code: "storage_failed", cause }),
        ),
      );

    const list = Effect.fn("MemoService.list")(function* () {
      const rows = yield* listRows();
      const memos = yield* Effect.forEach(rows, decodeRow, { concurrency: 1 });
      return { memos } satisfies MemoListResult;
    });

    const getMemo = (id: MemoId): Effect.Effect<Memo | null, MemoError> =>
      sql<MemoRow>`
        SELECT
          id,
          title,
          content,
          status,
          color,
          source,
          thread_id,
          thread_title,
          project_id,
          attachments_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        FROM memos
        WHERE id = ${id}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) =>
          memoError("Could not read the memo.", { memoId: id, code: "storage_failed", cause }),
        ),
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : decodeRow(rows[0]),
        ),
      );

    const writeMemoRow = (memo: Memo, causeMessage: string): Effect.Effect<void, MemoError> =>
      sql`
        INSERT INTO memos ${sql.insert({
          id: memo.id,
          title: memo.title,
          content: memo.content,
          status: memo.status,
          color: memo.color,
          source: memo.source,
          thread_id: memo.threadId,
          thread_title: memo.threadTitle,
          project_id: memo.projectId,
          attachments_json: encodeStoredAttachments(memo.attachments),
          created_at: memo.createdAt,
          updated_at: memo.updatedAt,
          started_at: memo.startedAt,
          completed_at: memo.completedAt,
        })}
      `.pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          memoError(causeMessage, { memoId: memo.id, code: "storage_failed", cause }),
        ),
      );

    const updateEditableFields = (
      memo: Pick<
        Memo,
        | "id"
        | "title"
        | "content"
        | "status"
        | "color"
        | "attachments"
        | "updatedAt"
        | "completedAt"
      >,
      causeMessage: string,
    ): Effect.Effect<Memo, MemoError> =>
      sql<MemoRow>`
        UPDATE memos SET
          title = ${memo.title},
          content = ${memo.content},
          status = ${memo.status},
          color = ${memo.color},
          attachments_json = ${encodeStoredAttachments(memo.attachments)},
          updated_at = ${memo.updatedAt},
          completed_at = ${memo.completedAt}
        WHERE id = ${memo.id}
        RETURNING
          id, title, content, status, color, source,
          thread_id, thread_title, project_id, attachments_json,
          created_at, updated_at, started_at, completed_at
      `.pipe(
        Effect.mapError((cause) =>
          memoError(causeMessage, { memoId: memo.id, code: "storage_failed", cause }),
        ),
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(
                memoError("That memo no longer exists.", {
                  memoId: memo.id,
                  code: "not_found",
                }),
              )
            : decodeRow(rows[0]),
        ),
      );

    const recordMemoStarted = (
      patch: Pick<
        Memo,
        "id" | "threadId" | "threadTitle" | "projectId" | "startedAt" | "updatedAt"
      >,
      causeMessage: string,
    ): Effect.Effect<Memo, MemoError> =>
      sql<MemoRow>`
        UPDATE memos SET
          status = 'in_progress',
          thread_id = ${patch.threadId},
          thread_title = ${patch.threadTitle},
          project_id = ${patch.projectId},
          started_at = ${patch.startedAt},
          updated_at = ${patch.updatedAt},
          completed_at = NULL
        WHERE id = ${patch.id}
        RETURNING
          id, title, content, status, color, source,
          thread_id, thread_title, project_id, attachments_json,
          created_at, updated_at, started_at, completed_at
      `.pipe(
        Effect.mapError((cause) =>
          memoError(causeMessage, { memoId: patch.id, code: "storage_failed", cause }),
        ),
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(
                memoError("That memo no longer exists.", {
                  memoId: patch.id,
                  code: "not_found",
                }),
              )
            : decodeRow(rows[0]),
        ),
      );

    const newMemoId = Effect.map(random.uuidV4(), (id) => MemoId.make(id));
    const newCommandId = Effect.map(random.uuidV4(), (id) => CommandId.make(`memo:${id}`));
    const newMessageId = Effect.map(random.uuidV4(), (id) => MessageId.make(`memo:${id}`));

    const create: MemoService["Service"]["create"] = Effect.fn("MemoService.create")(
      function* (input) {
        const now = yield* isoNow;
        const id = yield* newMemoId;
        const persistedAttachments =
          input.attachments && input.attachments.length > 0
            ? yield* persistMemoAttachments(id, input.attachments, now)
            : [];
        const memo: Memo = {
          id,
          title: input.title.trim(),
          content: input.content ?? "",
          status: "todo",
          color: input.color ?? "amber",
          source: input.source ?? (input.threadId == null ? "manual" : "thread"),
          threadId: input.threadId ?? null,
          threadTitle: input.threadTitle ?? null,
          projectId: input.projectId ?? null,
          attachments: persistedAttachments,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          completedAt: null,
        };
        yield* writeMemoRow(memo, "Could not save the memo.");
        yield* notifyChanged;
        return { memo };
      },
    );

    const update: MemoService["Service"]["update"] = Effect.fn("MemoService.update")(
      function* (input) {
        const existing = yield* getMemo(input.id);
        if (existing === null) {
          return yield* memoError("That memo no longer exists.", {
            memoId: input.id,
            code: "not_found",
          });
        }
        const now = yield* isoNow;
        const status = input.status ?? existing.status;
        const completedAt =
          status === existing.status ? existing.completedAt : status === "done" ? now : null;
        const keptAttachments =
          input.keepAttachmentIds === undefined
            ? existing.attachments
            : existing.attachments.filter((att) => input.keepAttachmentIds!.includes(att.id));
        const addedAttachments =
          input.attachments && input.attachments.length > 0
            ? yield* persistMemoAttachments(existing.id, input.attachments, now)
            : [];
        const updated = yield* updateEditableFields(
          {
            id: existing.id,
            title: input.title === undefined ? existing.title : input.title.trim(),
            content: input.content ?? existing.content,
            status,
            color: input.color ?? existing.color,
            attachments: [...keptAttachments, ...addedAttachments],
            updatedAt: now,
            completedAt,
          },
          "Could not update the memo.",
        );
        yield* notifyChanged;
        return { memo: updated };
      },
    );

    const deleteMemo: MemoService["Service"]["delete"] = Effect.fn("MemoService.delete")(
      function* (input) {
        const removed = yield* sql<{ readonly id: string }>`
          DELETE FROM memos WHERE id = ${input.id} RETURNING id
        `.pipe(
          Effect.mapError((cause) =>
            memoError("Could not delete the memo.", {
              memoId: input.id,
              code: "storage_failed",
              cause,
            }),
          ),
        );
        const deleted = removed.length > 0;
        if (deleted) yield* notifyChanged;
        return { id: input.id, deleted } satisfies MemoDeleteResult;
      },
    );

    const sendToExistingThread = Effect.fn("MemoService.sendToExistingThread")(function* (
      memo: Memo,
      targetThreadId: NonNullable<Memo["threadId"]>,
      promptText: string,
      now: string,
    ) {
      const thread = yield* threadManagement.getThreadShell(targetThreadId).pipe(
        Effect.mapError((cause) =>
          memoError("Could not read the memo's thread.", {
            memoId: memo.id,
            code: "storage_failed",
            cause,
          }),
        ),
      );
      if (thread === null || thread.deletedAt !== null || thread.archivedAt !== null) {
        return yield* memoError("That memo's thread is archived or no longer exists.", {
          memoId: memo.id,
          code: "thread_not_found",
        });
      }
      const sent = yield* threadManagement
        .sendToThread({
          projectId: thread.projectId,
          commandId: yield* newCommandId,
          threadId: targetThreadId,
          messageId: yield* newMessageId,
          text: promptText,
          attachments: memo.attachments,
          mode: "queue",
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(
          Effect.mapError((cause) =>
            memoError("Could not send the memo to its thread.", {
              memoId: memo.id,
              code: "dispatch_failed",
              cause,
            }),
          ),
        );
      const updated = yield* recordMemoStarted(
        {
          id: memo.id,
          threadId: targetThreadId,
          threadTitle: thread.title.length > 0 ? thread.title : memo.threadTitle,
          projectId: thread.projectId,
          startedAt: now,
          updatedAt: now,
        },
        "Could not update the memo after sending it.",
      );
      yield* notifyChanged;
      return {
        memo: updated,
        threadId: targetThreadId,
        projectId: thread.projectId,
        createdNewThread: false,
        queued: sent.delivery === "queued",
      } satisfies MemoStartResult;
    });

    const runStart = Effect.fn("MemoService.start")(function* (input: MemoStartInput) {
      const memo = yield* getMemo(input.id);
      if (memo === null) {
        return yield* memoError("That memo no longer exists.", {
          memoId: input.id,
          code: "not_found",
        });
      }
      const promptText = buildMemoActivationPrompt(memo);
      const now = yield* isoNow;

      if (input.targetThreadId !== undefined) {
        return yield* sendToExistingThread(memo, input.targetThreadId, promptText, now);
      }

      if (memo.threadId !== null && input.launch === undefined) {
        return yield* sendToExistingThread(memo, memo.threadId, promptText, now);
      }

      if (input.launch !== undefined) {
        const projectId =
          input.launch.projectId === null
            ? (yield* managedFolders.ensureScratchProject.pipe(
                Effect.mapError((cause) =>
                  memoError("Could not create the scratch project for this memo.", {
                    memoId: memo.id,
                    code: "dispatch_failed",
                    cause,
                  }),
                ),
              )).projectId
            : input.launch.projectId;
        const currentSettings = yield* serverSettings.getSettings.pipe(
          Effect.orElseSucceed(() => null),
        );
        const preferredRuntimeMode =
          currentSettings !== null
            ? resolveProjectSettings(currentSettings, projectId).settings.defaultRuntimeMode
            : DEFAULT_RUNTIME_MODE;
        const launched = yield* threadLaunch
          .launch({
            commandId: yield* newCommandId,
            projectId,
            title: memo.title,
            titleRenamed: false,
            modelSelection: input.launch.modelSelection,
            runtimeMode:
              clampManagedRuntimeMode(serverSettings.managedPolicy, preferredRuntimeMode) ??
              DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: yield* newMessageId,
              text: promptText,
              attachments: memo.attachments,
            },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(
            Effect.mapError((cause) =>
              memoError("Could not start the memo in a new thread.", {
                memoId: memo.id,
                code: "dispatch_failed",
                cause,
              }),
            ),
          );
        const updated = yield* recordMemoStarted(
          {
            id: memo.id,
            threadId: launched.threadId,
            threadTitle: memo.title,
            projectId,
            startedAt: now,
            updatedAt: now,
          },
          "Could not update the memo after starting its thread.",
        );
        yield* notifyChanged;
        return {
          memo: updated,
          threadId: launched.threadId,
          projectId,
          createdNewThread: true,
          queued: false,
        };
      }

      return yield* memoError(
        "Select project, provider, and model to start this memo in a new thread.",
        { memoId: memo.id, code: "launch_required" },
      );
    });

    const start: MemoService["Service"]["start"] = (input) =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          if (inFlightStarts.has(input.id)) {
            return Effect.fail(
              memoError("This memo is already starting.", {
                memoId: input.id,
                code: "dispatch_failed",
              }),
            );
          }
          inFlightStarts.add(input.id);
          return Effect.succeed(input.id);
        }),
        () => runStart(input),
        (id) =>
          Effect.sync(() => {
            inFlightStarts.delete(id);
          }),
      );

    const subscribeList: MemoService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading so a mutation that lands during the read still re-lists.
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    return MemoService.of({ list, subscribeList, create, update, delete: deleteMemo, start });
  }),
);

import type { AcpRegistrySettings } from "../settings.ts";
import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { isFactoryDroidInstance, resolveFactoryDir } from "./factoryUsageLimits.ts";

const MAX_SESSION_DIRECTORIES = 256;
const SETTINGS_FILE_SUFFIX = ".settings.json";
const JSONL_TAIL_BYTES = 64 * 1024;
const FILE_READ_CONCURRENCY = 4;

const decodeJsonUnknown = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const readLastJsonlTimestampMs = Effect.fn("droidUsage.readLastJsonlTimestampMs")(function* (
  jsonlPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(jsonlPath).pipe(Effect.orElseSucceed(() => null));
  if (info === null || info.type !== "File") return null;
  const size = Number(info.size);
  if (!Number.isFinite(size) || size <= 0) return null;

  const startOffset = Math.max(0, size - JSONL_TAIL_BYTES);
  const bytesToRead = size - startOffset;

  const text = yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(jsonlPath, { flag: "r" });
      const chunks: Array<Uint8Array> = [];
      let position = BigInt(startOffset);
      let remaining = bytesToRead;
      while (remaining > 0) {
        const chunk = yield* file.readAlloc(remaining, { position });
        if (Option.isNone(chunk) || chunk.value.length === 0) break;
        chunks.push(chunk.value);
        position += BigInt(chunk.value.length);
        remaining -= chunk.value.length;
      }
      return Buffer.concat(chunks).toString("utf8");
    }),
  ).pipe(Effect.orElseSucceed(() => null));

  if (text === null || text.length === 0) return null;

  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    const parsed = Option.getOrUndefined(decodeJsonUnknown(line));
    if (!isPlainObject(parsed)) continue;
    const timestampMs = parseTimestampMs(parsed["timestamp"]);
    if (timestampMs !== null) return timestampMs;
  }
  return null;
});

const readDroidSessionFile = Effect.fn("droidUsage.readDroidSessionFile")(function* (
  filePath: string,
  sessionId: string,
  windowStartMs: number,
): Effect.fn.Return<
  { readonly path: string; readonly records: readonly UsageRecord[] } | null,
  never,
  FileSystem.FileSystem
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (info === null || info.type !== "File") return null;

  const mtimeMs = Option.getOrUndefined(info.mtime)?.getTime();
  if (mtimeMs !== undefined && mtimeMs < windowStartMs) return null;

  const content = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));
  if (content === null) return null;

  const parsed = Option.getOrUndefined(decodeJsonUnknown(content));
  if (!isPlainObject(parsed)) return null;

  // Read only `tokenUsage` (never `inclusiveTokenUsage`) so subagent tokens are not double-counted.
  const tokenUsage = parsed["tokenUsage"];
  if (!isPlainObject(tokenUsage)) return null;

  const uncachedInputTokens = tokenCount(tokenUsage["inputTokens"]);
  const cachedInputTokens = tokenCount(tokenUsage["cacheReadTokens"]);
  const cacheCreationTokens = tokenCount(tokenUsage["cacheCreationTokens"]);
  const outputTokens = tokenCount(tokenUsage["outputTokens"]);
  const reasoningTokens = Math.min(outputTokens, tokenCount(tokenUsage["thinkingTokens"]));
  if (
    uncachedInputTokens === 0 &&
    cachedInputTokens === 0 &&
    cacheCreationTokens === 0 &&
    outputTokens === 0 &&
    reasoningTokens === 0
  ) {
    return null;
  }

  const jsonlPath = `${filePath.slice(0, -SETTINGS_FILE_SUFFIX.length)}.jsonl`;
  const jsonlTimestampMs = yield* readLastJsonlTimestampMs(jsonlPath);
  const timestampMs = jsonlTimestampMs ?? mtimeMs;
  if (timestampMs === undefined) return null;

  const rawModel = parsed["model"];
  const model =
    typeof rawModel === "string" && rawModel.trim().length > 0 ? rawModel.trim() : "unknown";

  return {
    path: filePath,
    records: [
      {
        provider: "droid",
        timestampMs,
        model,
        sessionId,
        totals: {
          uncachedInputTokens,
          cachedInputTokens,
          cacheCreationTokens,
          outputTokens,
          reasoningTokens,
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: `droid:${sessionId}`,
      },
    ],
  };
});

const scanDroidSessionsDir = Effect.fn("droidUsage.scanDroidSessionsDir")(function* (
  sessionsDir: string,
  windowStartMs: number,
): Effect.fn.Return<ProviderUsageScan, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const exists = yield* fileSystem
    .exists(sessionsDir)
    .pipe(Effect.catchCause(() => Effect.succeed(false)));
  if (!exists) {
    return { dir: sessionsDir, files: null };
  }

  const rootEntries = yield* fileSystem
    .readDirectoryEntries(sessionsDir)
    .pipe(Effect.orElseSucceed(() => null));
  if (rootEntries === null) {
    return {
      dir: sessionsDir,
      files: [],
      status: "partial",
      message: "Some Factory Droid history could not be read.",
    };
  }

  const projectDirs = rootEntries
    .filter((entry) => entry.type === "Directory")
    .slice(0, MAX_SESSION_DIRECTORIES);

  const candidates: Array<{ readonly path: string; readonly sessionId: string }> = [];
  for (const projectDir of projectDirs) {
    const projectPath = path.join(sessionsDir, projectDir.name);
    const subEntries = yield* fileSystem
      .readDirectoryEntries(projectPath)
      .pipe(Effect.orElseSucceed(() => []));
    for (const entry of subEntries) {
      if (entry.type !== "File" || !entry.name.endsWith(SETTINGS_FILE_SUFFIX)) continue;
      const sessionId = entry.name.slice(0, -SETTINGS_FILE_SUFFIX.length);
      if (sessionId.length === 0) continue;
      candidates.push({
        path: path.join(projectPath, entry.name),
        sessionId,
      });
    }
  }

  const readFiles = yield* Effect.forEach(
    candidates,
    (candidate) => readDroidSessionFile(candidate.path, candidate.sessionId, windowStartMs),
    { concurrency: FILE_READ_CONCURRENCY },
  );

  return {
    dir: sessionsDir,
    files: readFiles.filter((file) => file !== null),
  };
});

export const droidUsageReader: ProviderUsageReader<
  AcpRegistrySettings,
  FileSystem.FileSystem | Path.Path
> = {
  kind: "scan",
  provider: "droid",
  scan: Effect.fn("droidUsageReader.scan")(function* ({ instances, windowStartMs }) {
    if (instances.length === 0) return [];

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;

    const sessionsDirs = new Set<string>();
    for (const instance of instances) {
      // Only Factory Droid ACP instances (or the unconfigured fallback) own `~/.factory/sessions`.
      if (
        instance.configured &&
        (instance.config === undefined || !isFactoryDroidInstance(instance.config))
      ) {
        continue;
      }
      const rawSessionsDir = path.join(
        resolveFactoryDir(instance.environment, homeDirectory, path),
        "sessions",
      );
      const canonical = yield* fileSystem
        .realPath(rawSessionsDir)
        .pipe(Effect.orElseSucceed(() => rawSessionsDir));
      sessionsDirs.add(canonical);
    }

    if (sessionsDirs.size === 0) return [];

    return yield* Effect.forEach(
      sessionsDirs,
      (sessionsDir) => scanDroidSessionsDir(sessionsDir, windowStartMs),
      { concurrency: "unbounded" },
    );
  }),
};

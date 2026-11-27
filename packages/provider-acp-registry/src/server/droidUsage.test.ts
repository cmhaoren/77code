// @effect-diagnostics nodeBuiltinImport:off - utimes sets deterministic file modification times for mtime window tests.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderUsageInstance } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { AcpRegistrySettings } from "../settings.ts";
import { droidUsageReader } from "./droidUsage.ts";

const settings = (overrides: Partial<AcpRegistrySettings> = {}): AcpRegistrySettings => ({
  source: "registry",
  enabled: true,
  agentId: "factory-droid",
  commandPath: "",
  commandArgs: [],
  authMethodId: "",
  distribution: "auto",
  customModels: [],
  ...overrides,
});

const makeInstance = (
  id: string,
  config: AcpRegistrySettings | undefined,
  environment: NodeJS.ProcessEnv = {},
  configured = true,
): ProviderUsageInstance<AcpRegistrySettings> => ({
  instanceId: ProviderInstanceId.make(id),
  configured,
  config,
  environment,
});

const scanReader = (() => {
  if (droidUsageReader.kind !== "scan") {
    throw new Error("droidUsageReader must be a scan reader");
  }
  return droidUsageReader;
})();

const WINDOW_START_MS = Date.parse("2026-08-01T00:00:00.000Z");

describe("droidUsageReader", () => {
  it("declares scan kind for the droid provider", () => {
    expect(scanReader.provider).toBe("droid");
  });

  it.effect("returns [] when given no instances", () =>
    Effect.gen(function* () {
      const result = yield* scanReader.scan({
        instances: [],
        settings: {} as never,
        windowStartMs: WINDOW_START_MS,
        retentionCutoffMs: 0,
        awaitRefresh: false,
      });
      expect(result).toEqual([]);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/tmp/unused-home"),
    ),
  );

  it.effect("returns files: null when the sessions directory does not exist", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "droid-usage-missing-" });

      const scans = yield* scanReader
        .scan({
          instances: [makeInstance("droid-1", settings())],
          settings: {} as never,
          windowStartMs: WINDOW_START_MS,
          retentionCutoffMs: 0,
          awaitRefresh: false,
        })
        .pipe(Effect.provideService(HostProcess.HomeDirectory, home));

      expect(scans).toEqual([
        {
          dir: path.join(home, ".factory", "sessions"),
          files: null,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads tokenUsage without inclusiveTokenUsage, clamps thinkingTokens, and resolves timestamps",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "droid-usage-reader-" });
        const projectDir = path.join(home, ".factory", "sessions", "-D-dstest");
        yield* fileSystem.makeDirectory(projectDir, { recursive: true });

        const parentMtimeMs = Date.parse("2026-08-10T10:00:00.000Z");
        const childMtimeMs = Date.parse("2026-08-10T11:00:00.000Z");
        const largeMtimeMs = Date.parse("2026-08-10T12:00:00.000Z");
        const parentSettingsPath = path.join(projectDir, "parent-sess.settings.json");
        const parentJsonlPath = path.join(projectDir, "parent-sess.jsonl");
        const childSettingsPath = path.join(projectDir, "child-sess.settings.json");
        const largeSettingsPath = path.join(projectDir, "large-sess.settings.json");
        const largeJsonlPath = path.join(projectDir, "large-sess.jsonl");

        // Parent has inclusiveTokenUsage (including child tokens) which MUST be ignored.
        yield* fileSystem.writeFileString(
          parentSettingsPath,
          JSON.stringify({
            model: "custom:gpt-5.4",
            tokenUsage: {
              inputTokens: 100,
              cacheReadTokens: 200,
              cacheCreationTokens: 50,
              outputTokens: 40,
              thinkingTokens: 10,
            },
            inclusiveTokenUsage: {
              inputTokens: 999,
              cacheReadTokens: 999,
              cacheCreationTokens: 999,
              outputTokens: 999,
              thinkingTokens: 999,
            },
          }),
        );
        const parentJsonlTs = "2026-08-10T09:12:34.567Z";
        yield* fileSystem.writeFileString(
          parentJsonlPath,
          [
            JSON.stringify({ type: "session_start", timestamp: "2026-08-10T09:00:00.000Z" }),
            JSON.stringify({ type: "message", timestamp: parentJsonlTs }),
            JSON.stringify({ type: "note", note: "no timestamp on last line" }),
          ].join("\n") + "\n",
        );

        // Child has no .jsonl, missing model -> "unknown", and thinkingTokens > outputTokens -> clamped.
        yield* fileSystem.writeFileString(
          childSettingsPath,
          JSON.stringify({
            tokenUsage: {
              inputTokens: 30,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 20,
              thinkingTokens: 99,
            },
          }),
        );

        // Large .jsonl (> 64KB) reads only tail slice and picks last valid timestamp.
        yield* fileSystem.writeFileString(
          largeSettingsPath,
          JSON.stringify({
            model: "claude-opus-4-6",
            tokenUsage: { inputTokens: 5, outputTokens: 7 },
          }),
        );
        const largePadLine = JSON.stringify({
          type: "message",
          timestamp: "2026-08-02T00:00:00.000Z",
          text: "x".repeat(2048),
        });
        const largeTailTs = "2026-08-10T15:30:00.000Z";
        yield* fileSystem.writeFileString(
          largeJsonlPath,
          `${Array.from({ length: 40 }, () => largePadLine).join("\n")}\n${JSON.stringify({
            type: "message",
            timestamp: largeTailTs,
          })}\n`,
        );

        yield* Effect.promise(async () => {
          await NodeFSP.utimes(parentSettingsPath, parentMtimeMs / 1000, parentMtimeMs / 1000);
          await NodeFSP.utimes(childSettingsPath, childMtimeMs / 1000, childMtimeMs / 1000);
          await NodeFSP.utimes(largeSettingsPath, largeMtimeMs / 1000, largeMtimeMs / 1000);
        });

        const scans = yield* scanReader
          .scan({
            instances: [makeInstance("droid-1", settings())],
            settings: {} as never,
            windowStartMs: WINDOW_START_MS,
            retentionCutoffMs: 0,
            awaitRefresh: false,
          })
          .pipe(Effect.provideService(HostProcess.HomeDirectory, home));

        expect(scans).toHaveLength(1);
        const records = scans[0]!.files!.flatMap((file) => file.records);
        expect(records).toHaveLength(3);

        const bySession = new Map(records.map((record) => [record.sessionId, record]));
        expect(bySession.get("parent-sess")).toEqual({
          provider: "droid",
          timestampMs: Date.parse(parentJsonlTs),
          model: "custom:gpt-5.4",
          sessionId: "parent-sess",
          totals: {
            uncachedInputTokens: 100,
            cachedInputTokens: 200,
            cacheCreationTokens: 50,
            outputTokens: 40,
            reasoningTokens: 10,
          },
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: "droid:parent-sess",
        });

        expect(bySession.get("child-sess")).toEqual({
          provider: "droid",
          timestampMs: childMtimeMs,
          model: "unknown",
          sessionId: "child-sess",
          totals: {
            uncachedInputTokens: 30,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 20,
            reasoningTokens: 20,
          },
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: "droid:child-sess",
        });

        expect(bySession.get("large-sess")?.timestampMs).toBe(Date.parse(largeTailTs));

        // Combined totals reflect tokenUsage sum, never inclusiveTokenUsage.
        const totalInput = records.reduce(
          (sum, record) => sum + record.totals.uncachedInputTokens,
          0,
        );
        expect(totalInput).toBe(100 + 30 + 5);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "skips zero-token sessions, .bak files, corrupt JSON, and stale mtime files gracefully",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "droid-usage-skip-" });
        const projectDir = path.join(home, ".factory", "sessions", "-D-dstest");
        yield* fileSystem.makeDirectory(projectDir, { recursive: true });

        const recentMtimeSec = Date.parse("2026-08-10T10:00:00.000Z") / 1000;
        const staleMtimeSec = Date.parse("2026-07-01T10:00:00.000Z") / 1000;

        yield* fileSystem.writeFileString(
          path.join(projectDir, "zero.settings.json"),
          JSON.stringify({
            model: "gpt-5",
            tokenUsage: {
              inputTokens: 0,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              thinkingTokens: 0,
            },
          }),
        );
        yield* fileSystem.writeFileString(
          path.join(projectDir, "backup.settings.json.bak"),
          JSON.stringify({ tokenUsage: { inputTokens: 500, outputTokens: 100 } }),
        );
        yield* fileSystem.writeFileString(
          path.join(projectDir, "corrupt.settings.json"),
          "{ invalid json",
        );
        const stalePath = path.join(projectDir, "stale.settings.json");
        yield* fileSystem.writeFileString(
          stalePath,
          JSON.stringify({ tokenUsage: { inputTokens: 500, outputTokens: 100 } }),
        );
        const validPath = path.join(projectDir, "valid.settings.json");
        yield* fileSystem.writeFileString(
          validPath,
          JSON.stringify({ model: "gpt-5", tokenUsage: { inputTokens: 12, outputTokens: 8 } }),
        );
        yield* fileSystem.writeFileString(path.join(projectDir, "valid.jsonl"), "not-json\n");

        yield* Effect.promise(async () => {
          await NodeFSP.utimes(stalePath, staleMtimeSec, staleMtimeSec);
          await NodeFSP.utimes(validPath, recentMtimeSec, recentMtimeSec);
        });

        const scans = yield* scanReader
          .scan({
            instances: [makeInstance("droid-1", settings())],
            settings: {} as never,
            windowStartMs: WINDOW_START_MS,
            retentionCutoffMs: 0,
            awaitRefresh: false,
          })
          .pipe(Effect.provideService(HostProcess.HomeDirectory, home));

        expect(scans).toHaveLength(1);
        const records = scans[0]!.files!.flatMap((file) => file.records);
        expect(records).toHaveLength(1);
        expect(records[0]?.sessionId).toBe("valid");
        expect(records[0]?.timestampMs).toBe(recentMtimeSec * 1000);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores non-Droid ACP instances and deduplicates shared sessions directories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "droid-usage-dedupe-" });
      const dshHome = path.join(home, ".dsh-ignored");
      const droidProjectDir = path.join(home, ".factory", "sessions", "-D-proj");
      yield* fileSystem.makeDirectory(droidProjectDir, { recursive: true });
      yield* fileSystem.makeDirectory(path.join(dshHome, "sessions", "-D-other"), {
        recursive: true,
      });

      const mtimeMs = Date.parse("2026-08-10T10:00:00.000Z");
      const droidSettings = path.join(droidProjectDir, "s1.settings.json");
      yield* fileSystem.writeFileString(
        droidSettings,
        JSON.stringify({ model: "gpt-5", tokenUsage: { inputTokens: 10, outputTokens: 20 } }),
      );
      yield* fileSystem.writeFileString(
        path.join(dshHome, "sessions", "-D-other", "dsh-file.settings.json"),
        JSON.stringify({ model: "gpt-5", tokenUsage: { inputTokens: 999, outputTokens: 999 } }),
      );
      yield* Effect.promise(() => NodeFSP.utimes(droidSettings, mtimeMs / 1000, mtimeMs / 1000));

      // Only non-Droid instances -> returns []
      const onlyDsh = yield* scanReader
        .scan({
          instances: [
            makeInstance("dsh", settings({ agentId: "deepseek-harness" }), {
              FACTORY_HOME: dshHome,
            }),
            makeInstance("invalid", undefined),
          ],
          settings: {} as never,
          windowStartMs: WINDOW_START_MS,
          retentionCutoffMs: 0,
          awaitRefresh: false,
        })
        .pipe(Effect.provideService(HostProcess.HomeDirectory, home));
      expect(onlyDsh).toEqual([]);

      // Multiple Droid instances pointing to the same ~/.factory/sessions -> scanned once
      const multipleDroid = yield* scanReader
        .scan({
          instances: [
            makeInstance("dsh", settings({ agentId: "deepseek-harness" }), {
              FACTORY_HOME: dshHome,
            }),
            makeInstance("droid-w1", settings()),
            makeInstance("droid-w2", settings({ source: "local", commandPath: "droid" })),
            makeInstance("droid-disabled", settings({ enabled: false }), {
              FACTORY_HOME: dshHome,
            }),
          ],
          settings: {} as never,
          windowStartMs: WINDOW_START_MS,
          retentionCutoffMs: 0,
          awaitRefresh: false,
        })
        .pipe(Effect.provideService(HostProcess.HomeDirectory, home));

      expect(multipleDroid).toHaveLength(1);
      expect(multipleDroid[0]!.files!.flatMap((file) => file.records)).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

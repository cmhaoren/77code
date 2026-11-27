import { EnvironmentId, USAGE_CONTRACT_VERSION, UsageDay } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UsageModelDialog } from "./UsageModelDialog";

describe("UsageModelDialog", () => {
  it("exposes pure token stats without currency or pricing actions", async () => {
    await using _screen = await render(
      <UsageModelDialog
        model={{
          model: "claude-sonnet-4-5",
          provider: "claude",
          totalTokens: 1_200_000,
          tokens: {
            uncachedInputTokens: 100_000,
            cachedInputTokens: 900_000,
            cacheCreationTokens: 0,
            outputTokens: 200_000,
            reasoningTokens: 0,
          },
          tokenShare: 0.75,
        }}
        environments={[]}
        chartWindow={{
          days: [],
          hours: [],
          resolution: "day",
          timeZone: "UTC",
          referenceTime: undefined,
          hour12: false,
        }}
        onClose={() => {}}
      />,
    );

    const dialog = page.getByRole("dialog");
    for (const [label, value] of [
      ["Tokens", "1.2M"],
      ["Input", "1M"],
      ["Cache hit", "90.0%"],
      ["Output", "200K"],
    ] as const) {
      await expect
        .element(dialog.getByRole("term").getByText(label, { exact: true }))
        .toBeVisible();
      await expect
        .element(dialog.getByRole("definition").getByText(value, { exact: true }).first())
        .toBeVisible();
    }

    expect(dialog.element().textContent).not.toContain("Set price");
    expect(dialog.element().textContent).not.toContain("Per 1M tokens");
  });

  it("aggregates matching raw route buckets when rawModels are supplied", async () => {
    await using _screen = await render(
      <UsageModelDialog
        model={{
          model: "gpt-5.4",
          rawModels: ["custom:gpt-5.4", "magpie/gpt-5.4@256k"],
          provider: "droid",
          totalTokens: 700,
          tokens: {
            uncachedInputTokens: 400,
            cachedInputTokens: 200,
            cacheCreationTokens: 0,
            outputTokens: 100,
            reasoningTokens: 0,
          },
          tokenShare: 1,
        }}
        environments={[
          {
            environmentId: EnvironmentId.make("local"),
            label: "Local",
            isPending: false,
            canReadDiagnostics: true,
            isConnected: true,
            error: null,
            summary: {
              contractVersion: USAGE_CONTRACT_VERSION,
              readAt: "2026-11-27T00:00:00.000Z",
              timeZone: "UTC",
              sinceDay: UsageDay.make("2026-11-27"),
              untilDay: UsageDay.make("2026-11-27"),
              pricing: {
                status: "unavailable",
                source: "none",
                fetchedAt: null,
                knownModels: 0,
              },
              scanDurationMs: 1,
              sources: [
                {
                  fingerprint: {
                    hostId: "host",
                    provider: "droid",
                    resolvedHomePath: "/home/.factory/sessions",
                    volumeId: "vol",
                  },
                  status: "ok",
                  scannedFiles: 1,
                  skippedFiles: 0,
                  malformedRecords: 0,
                  distinctSessions: 1,
                  message: null,
                },
              ],
              buckets: [
                {
                  day: UsageDay.make("2026-11-27"),
                  provider: "droid",
                  model: "custom:gpt-5.4",
                  totals: {
                    uncachedInputTokens: 250,
                    cachedInputTokens: 100,
                    cacheCreationTokens: 0,
                    outputTokens: 50,
                    reasoningTokens: 0,
                  },
                  costUsd: 0,
                  cacheSavingsUsd: 0,
                  costSource: "unpriced",
                  records: 1,
                  unpricedRecords: 1,
                  sessions: 1,
                },
                {
                  day: UsageDay.make("2026-11-27"),
                  provider: "droid",
                  model: "magpie/gpt-5.4@256k",
                  totals: {
                    uncachedInputTokens: 150,
                    cachedInputTokens: 100,
                    cacheCreationTokens: 0,
                    outputTokens: 50,
                    reasoningTokens: 0,
                  },
                  costUsd: 0,
                  cacheSavingsUsd: 0,
                  costSource: "unpriced",
                  records: 1,
                  unpricedRecords: 1,
                  sessions: 1,
                },
              ],
            },
          },
        ]}
        chartWindow={{
          days: ["2026-11-27"],
          hours: [],
          resolution: "day",
          timeZone: "UTC",
          referenceTime: undefined,
          hour12: false,
        }}
        onClose={() => {}}
      />,
    );

    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("Factory Droid · 100.0% of tokens")).toBeVisible();
    await expect.element(dialog.getByRole("cell", { name: "700" })).toBeVisible();
  });
});

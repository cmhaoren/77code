import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerGetSkillsOverviewResult,
  type ServerManageSkillsInput,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SkillsMatrixSection } from "./SkillsMatrixSection";

const state = vi.hoisted(() => ({
  overview: null as ServerGetSkillsOverviewResult | null,
  manageCalls: [] as Array<ServerManageSkillsInput>,
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => {
    return async (payload: { readonly input?: unknown }) => {
      if (
        payload.input !== null &&
        typeof payload.input === "object" &&
        "action" in payload.input
      ) {
        const actionInput = payload.input as ServerManageSkillsInput;
        state.manageCalls.push(actionInput);
        return {
          _tag: "Success" as const,
          value: {
            ok: true,
            summary: "ok",
            affectedPaths: [],
            skippedConflicts: [],
            overview: state.overview!,
          },
        };
      }
      void command;
      return {
        _tag: "Success" as const,
        value: state.overview!,
      };
    };
  }) as never,
}));

vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: vi.fn() } };
});

function makeOverview(): ServerGetSkillsOverviewResult {
  return {
    checkedAt: IsoDateTime.make("2026-11-26T02:00:00.000Z"),
    universalPoolDir: "C:\\Users\\test\\.agents\\skills",
    instances: [
      {
        instanceId: ProviderInstanceId.make("dsh"),
        driver: ProviderDriverKind.make("acpRegistry"),
        driverGroupKey: "acpRegistry:dsh",
        driverGroupLabel: "DeepSeek Harness",
        displayName: "DSH",
        enabled: true,
        installed: true,
        status: "ready",
        readsUniversalPool: true,
        globalSkillDirs: ["C:\\Users\\test\\.dsh\\skills", "C:\\Users\\test\\.agents\\skills"],
        writableGlobalSkillDir: "C:\\Users\\test\\.dsh\\skills",
      },
      {
        instanceId: ProviderInstanceId.make("antigravity"),
        driver: ProviderDriverKind.make("antigravity"),
        driverGroupKey: "antigravity",
        driverGroupLabel: "Antigravity",
        displayName: "AGY",
        enabled: true,
        installed: true,
        status: "ready",
        readsUniversalPool: false,
        globalSkillDirs: ["C:\\Users\\test\\.gemini\\config\\skills"],
        writableGlobalSkillDir: "C:\\Users\\test\\.gemini\\config\\skills",
      },
    ],
    skills: [
      {
        name: "lantu",
        description: "Lantu skill",
        scope: "universal",
        ownerGroupLabels: [],
        canonicalPath: "D:\\lantu\\skills\\lantu",
        coveredEnabledCount: NonNegativeInt.make(1),
        expectedEnabledCount: NonNegativeInt.make(2),
        cells: {
          dsh: {
            status: "declared_disk",
            path: "C:\\Users\\test\\.agents\\skills\\lantu\\SKILL.md",
            sourceDir: "C:\\Users\\test\\.agents\\skills",
            isLink: true,
            linkTarget: "D:\\lantu\\skills\\lantu",
            removable: false,
          },
          antigravity: {
            status: "missing",
            reason: "未挂载",
          },
        },
        locations: [
          {
            path: "C:\\Users\\test\\.agents\\skills\\lantu",
            sourceDir: "C:\\Users\\test\\.agents\\skills",
            layer: "universal",
            ownerLabel: "Universal pool",
            isLink: true,
            linkTarget: "D:\\lantu\\skills\\lantu",
            contentHash: "abcdef1234567890",
          },
        ],
        hasDuplicateCopies: false,
        hasContentConflict: false,
      },
    ],
    diagnostics: [],
  };
}

it("opens the demote-to-provider menu and cell popover without Base UI errors", async () => {
  state.overview = makeOverview();
  state.manageCalls = [];

  await using screen = await render(
    <SkillsMatrixSection environmentId={EnvironmentId.make("local")} />,
  );

  // Expand the lantu row via its toggle button
  await screen.getByRole("button", { name: /lantu/i }).click();

  // Click "降级为供应商专属…" — previously crashed with Base UI error #31 (MenuGroupLabel outside MenuGroup)
  await screen.getByRole("button", { name: /降级为供应商专属/i }).click();
  await expect.element(page.getByText("选择目标实例")).toBeInTheDocument();

  // Select DSH as demote target
  await page.getByRole("menuitem", { name: /DSH/i }).click();
  expect(state.manageCalls).toContainEqual({
    action: "demote_to_provider",
    skillName: "lantu",
    targetInstanceId: ProviderInstanceId.make("dsh"),
  });

  // Also verify opening the instance header menu & cell popover cleanly
  await screen.getByRole("button", { name: /管理实例 AGY/i }).click();
  await expect
    .element(page.getByRole("menuitem", { name: /一键联接真全局池/i }))
    .toBeInTheDocument();
});

import {
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
  type SkillDiskLocation,
  type SkillMatrixCell,
  type SkillMatrixEntry,
  type SkillMatrixInstance,
  type SkillMatrixScope,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countDuplicateSkills,
  countHiddenDisabledAgentSkills,
  filterSkillEntries,
  getDefaultSyncTargetIds,
  groupInstancesByDriver,
  resolveSkillSourcePath,
} from "./skillsMatrix.logic";

function makeInstance(input: {
  readonly instanceId: string;
  readonly driverGroupKey: string;
  readonly driverGroupLabel: string;
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly readsUniversalPool?: boolean;
}): SkillMatrixInstance {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driverGroupKey),
    driverGroupKey: input.driverGroupKey,
    driverGroupLabel: input.driverGroupLabel,
    displayName: input.displayName ?? input.instanceId,
    enabled: input.enabled ?? true,
    installed: true,
    status: "ready",
    readsUniversalPool: input.readsUniversalPool ?? true,
    globalSkillDirs: [],
    writableGlobalSkillDir: `C:\\skills\\${input.instanceId}`,
  };
}

function makeLocation(
  input: Partial<SkillDiskLocation> & {
    readonly path: string;
    readonly layer: SkillDiskLocation["layer"];
  },
): SkillDiskLocation {
  return {
    path: input.path,
    sourceDir: input.sourceDir ?? `C:\\skills\\${input.layer}`,
    layer: input.layer,
    ownerLabel: input.ownerLabel ?? input.layer,
    isLink: input.isLink ?? false,
    ...(input.linkTarget === undefined ? {} : { linkTarget: input.linkTarget }),
    ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
  };
}

function makeSkill(input: {
  readonly name: string;
  readonly scope?: SkillMatrixScope;
  readonly description?: string;
  readonly ownerGroupLabels?: ReadonlyArray<string>;
  readonly cells?: Record<string, SkillMatrixCell>;
  readonly locations?: ReadonlyArray<SkillDiskLocation>;
  readonly canonicalPath?: string;
  readonly hasDuplicateCopies?: boolean;
  readonly hasContentConflict?: boolean;
}): SkillMatrixEntry {
  return {
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    scope: input.scope ?? "universal",
    ownerGroupLabels: input.ownerGroupLabels ?? [],
    ...(input.canonicalPath === undefined ? {} : { canonicalPath: input.canonicalPath }),
    coveredEnabledCount: NonNegativeInt.make(0),
    expectedEnabledCount: NonNegativeInt.make(1),
    cells: input.cells ?? {},
    locations: input.locations ?? [],
    hasDuplicateCopies: input.hasDuplicateCopies ?? false,
    hasContentConflict: input.hasContentConflict ?? false,
  };
}

const codex = makeInstance({
  instanceId: "codex",
  driverGroupKey: "codex",
  driverGroupLabel: "Codex",
});
const claude = makeInstance({
  instanceId: "claude",
  driverGroupKey: "claude",
  driverGroupLabel: "Claude",
});
const antigravityDisabled = makeInstance({
  instanceId: "antigravity_disabled",
  driverGroupKey: "antigravity",
  driverGroupLabel: "Antigravity",
  enabled: false,
});

describe("filterSkillEntries", () => {
  const skills = [
    makeSkill({
      name: "alpha",
      description: "Search helper",
      cells: { codex: { status: "missing" } },
      hasDuplicateCopies: true,
    }),
    makeSkill({ name: "beta", cells: { codex: { status: "declared_disk" } } }),
    makeSkill({
      name: "gamma",
      scope: "agent_global",
      ownerGroupLabels: ["Claude"],
      cells: { claude: { status: "declared_runtime" } },
      hasDuplicateCopies: true,
      hasContentConflict: true,
    }),
    makeSkill({ name: "delta", scope: "builtin", ownerGroupLabels: ["Codex"] }),
  ];
  const base = {
    scope: "universal" as const,
    onlyIssues: false,
    onlyDuplicates: false,
    displayedInstances: [codex, claude],
  };

  it("keeps only the selected scope", () => {
    expect(filterSkillEntries(skills, { ...base, query: "" }).map((skill) => skill.name)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(
      filterSkillEntries(skills, { ...base, scope: "builtin", query: "" }).map(
        (skill) => skill.name,
      ),
    ).toEqual(["delta"]);
  });

  it("matches the query against name, description and owner labels", () => {
    expect(
      filterSkillEntries(skills, { ...base, query: "HELPER" }).map((skill) => skill.name),
    ).toEqual(["alpha"]);
    expect(
      filterSkillEntries(skills, {
        ...base,
        scope: "agent_global",
        query: "  claude ",
      }).map((skill) => skill.name),
    ).toEqual(["gamma"]);
    expect(filterSkillEntries(skills, { ...base, query: "missing" })).toEqual([]);
  });

  it("combines issue and duplicate filters with the active tab", () => {
    expect(
      filterSkillEntries(skills, { ...base, query: "", onlyIssues: true }).map(
        (skill) => skill.name,
      ),
    ).toEqual(["alpha"]);
    expect(
      filterSkillEntries(skills, { ...base, query: "", onlyDuplicates: true }).map(
        (skill) => skill.name,
      ),
    ).toEqual(["alpha"]);
    expect(
      filterSkillEntries(skills, {
        ...base,
        scope: "agent_global",
        query: "",
        onlyDuplicates: true,
      }).map((skill) => skill.name),
    ).toEqual(["gamma"]);
  });

  it("hides disabled-only agent_global skills when showDisabled is false", () => {
    const disabledOnlySkill = makeSkill({
      name: "disabled-only",
      scope: "agent_global",
      ownerGroupLabels: ["Antigravity"],
      cells: {
        codex: { status: "not_applicable" },
        claude: { status: "not_applicable" },
        antigravity_disabled: { status: "declared_disk" },
      },
    });
    expect(
      filterSkillEntries([...skills, disabledOnlySkill], {
        ...base,
        scope: "agent_global",
        query: "",
        showDisabled: false,
      }).map((skill) => skill.name),
    ).toEqual(["gamma"]);
    expect(
      filterSkillEntries([...skills, disabledOnlySkill], {
        ...base,
        scope: "agent_global",
        query: "",
        showDisabled: true,
        displayedInstances: [codex, claude, antigravityDisabled],
      }).map((skill) => skill.name),
    ).toEqual(["gamma", "disabled-only"]);
  });

  it("checks issues only against the displayed instances", () => {
    const hiddenIssue = makeSkill({
      name: "hidden-issue",
      cells: {
        codex: { status: "declared_disk" },
        antigravity_disabled: { status: "missing" },
      },
    });
    expect(
      filterSkillEntries([hiddenIssue], {
        ...base,
        query: "",
        onlyIssues: true,
      }),
    ).toEqual([]);
    expect(
      filterSkillEntries([hiddenIssue], {
        ...base,
        query: "",
        onlyIssues: true,
        displayedInstances: [codex, antigravityDisabled],
      }),
    ).toEqual([hiddenIssue]);
  });
});

describe("countHiddenDisabledAgentSkills", () => {
  const skills = [
    makeSkill({
      name: "hidden-agent-skill",
      scope: "agent_global",
      ownerGroupLabels: ["Antigravity"],
      cells: { codex: { status: "not_applicable" } },
    }),
    makeSkill({
      name: "visible-agent-skill",
      scope: "agent_global",
      ownerGroupLabels: ["Codex"],
      cells: { codex: { status: "missing" } },
    }),
    makeSkill({ name: "universal-skill", cells: { codex: { status: "missing" } } }),
    makeSkill({
      name: "builtin-skill",
      scope: "builtin",
      cells: { codex: { status: "not_applicable" } },
    }),
  ];

  it("counts agent skills whose owning instances are all hidden", () => {
    expect(countHiddenDisabledAgentSkills(skills, [codex], false)).toBe(1);
    expect(countHiddenDisabledAgentSkills(skills, [codex], true)).toBe(0);
  });

  it("counts every owned agent skill when no instance is displayed", () => {
    expect(countHiddenDisabledAgentSkills(skills, [], false)).toBe(2);
  });
});

describe("countDuplicateSkills", () => {
  it("counts duplicate skills and the subset with content conflicts", () => {
    const skills = [
      makeSkill({ name: "dedupe-clean", hasDuplicateCopies: true }),
      makeSkill({ name: "dedupe-conflict", hasDuplicateCopies: true, hasContentConflict: true }),
      makeSkill({ name: "unique" }),
    ];
    expect(countDuplicateSkills(skills)).toEqual({ total: 2, conflicts: 1 });
    expect(countDuplicateSkills([])).toEqual({ total: 0, conflicts: 0 });
  });
});

describe("groupInstancesByDriver", () => {
  it("keeps the incoming order and groups instances by driver", () => {
    const codexB = makeInstance({
      instanceId: "codex_b",
      driverGroupKey: "codex",
      driverGroupLabel: "Codex",
    });
    const groups = groupInstancesByDriver([codex, claude, codexB]);
    expect(groups.map((group) => group.key)).toEqual(["codex", "claude"]);
    expect(groups.map((group) => group.label)).toEqual(["Codex", "Claude"]);
    expect(groups[0]?.instances.map((instance) => instance.instanceId)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("codex_b"),
    ]);
    expect(groupInstancesByDriver([])).toEqual([]);
  });
});

describe("getDefaultSyncTargetIds", () => {
  const codexB = makeInstance({
    instanceId: "codex_b",
    driverGroupKey: "codex",
    driverGroupLabel: "Codex",
  });

  it("selects every other instance in the same driver group", () => {
    expect(getDefaultSyncTargetIds([codex, codexB, claude], "codex", true)).toEqual([
      ProviderInstanceId.make("codex_b"),
    ]);
  });

  it("selects every other instance when same-driver is off", () => {
    expect(getDefaultSyncTargetIds([codex, codexB, claude], "codex", false)).toEqual([
      ProviderInstanceId.make("codex_b"),
      ProviderInstanceId.make("claude"),
    ]);
  });

  it("returns no same-driver targets when the source is unknown", () => {
    expect(getDefaultSyncTargetIds([codex, codexB], "removed", true)).toEqual([]);
    expect(getDefaultSyncTargetIds([codex, codexB], "removed", false)).toEqual([
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("codex_b"),
    ]);
  });
});

describe("resolveSkillSourcePath", () => {
  it("prefers the true universal pool location", () => {
    const entry = makeSkill({
      name: "alpha",
      canonicalPath: "C:\\fallback",
      locations: [
        makeLocation({ path: "C:\\codex\\alpha", layer: "provider_global" }),
        makeLocation({ path: "C:\\agents\\alpha", layer: "universal" }),
      ],
    });
    expect(resolveSkillSourcePath(entry)).toBe("C:\\agents\\alpha");
  });

  it("uses the first non-link entity location when the pool copy is absent", () => {
    const entry = makeSkill({
      name: "alpha",
      canonicalPath: "C:\\fallback",
      locations: [
        makeLocation({
          path: "C:\\claude\\alpha",
          layer: "provider_global",
          isLink: true,
          linkTarget: "C:\\agents\\alpha",
        }),
        makeLocation({ path: "C:\\codex\\alpha", layer: "provider_global" }),
      ],
    });
    expect(resolveSkillSourcePath(entry)).toBe("C:\\codex\\alpha");
  });

  it("falls back to the canonical path when no entity location exists", () => {
    const entry = makeSkill({
      name: "alpha",
      canonicalPath: "C:\\fallback",
      locations: [
        makeLocation({
          path: "C:\\claude\\alpha",
          layer: "provider_global",
          isLink: true,
          linkTarget: "C:\\agents\\alpha",
        }),
      ],
    });
    expect(resolveSkillSourcePath(entry)).toBe("C:\\fallback");
    expect(resolveSkillSourcePath(makeSkill({ name: "empty" }))).toBeUndefined();
  });
});

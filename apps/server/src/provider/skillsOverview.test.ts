// @effect-diagnostics-next-line nodeBuiltinImport:off -- Antigravity profile directory fixture.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Test fixture setup in temp directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Test fixture path assembly.
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  DEFAULT_SERVER_SETTINGS,
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerManageSkillsInput,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";
import { buildSkillsOverview } from "./skillsOverview.ts";

const decodeManageSkillsInput = Schema.decodeUnknownSync(ServerManageSkillsInput);

function makeProvider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly enabled?: boolean;
  readonly skills?: ServerProvider["skills"];
}): ServerProvider {
  return {
    driver: ProviderDriverKind.make(input.driver),
    instanceId: ProviderInstanceId.make(input.instanceId),
    displayName: input.displayName,
    enabled: input.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: IsoDateTime.make("2026-11-25T00:00:00.000Z"),
    models: [],
    slashCommands: [],
    skills: input.skills ?? [],
  };
}

async function writeSkill(rootDir: string, folderName: string, name: string, description: string) {
  const dir = NodePath.join(rootDir, folderName);
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
    "utf8",
  );
  return dir;
}

async function createJunction(linkPath: string, targetPath: string) {
  await NodeFSP.mkdir(NodePath.dirname(linkPath), { recursive: true });
  await NodeFSP.symlink(NodePath.resolve(targetPath), linkPath, "junction");
}

function antigravityProfileDir(stateDir: string, instanceId: string) {
  const key = NodeCrypto.createHash("sha256").update(instanceId).digest("hex");
  return NodePath.join(stateDir, "providers", "antigravity", key);
}

async function makeTempRoot(prefix: string) {
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
}

describe("buildSkillsOverview", () => {
  it.effect(
    "separates universal pool vs agent-specific global vs builtin, flags non-absolute Windows skills.json, and ignores backup dirs",
    () =>
      Effect.gen(function* () {
        const tempRoot = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skills-overview-v2-")),
        );
        return yield* Effect.ensuring(
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const w2Home = NodePath.join(tempRoot, "factory-w2");

            // 1. Universal pool: ego-browser + tdd + ignored backup dir
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".agents", "skills"),
                "ego-browser",
                "ego-browser",
                "Browser automation skill",
              ),
            );
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".agents", "skills"),
                "tdd",
                "tdd",
                "Test-driven development",
              ),
            );
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".agents", "skills"),
                "old.backup-2026",
                "old-backup",
                "Should be ignored",
              ),
            );

            // 2. Factory W1 has ego-browser in .factory/skills (plus reads ~/.agents/skills for tdd)
            //    W2 has FACTORY_HOME_OVERRIDE with no .factory/skills and no .agents/skills
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".factory", "skills"),
                "ego-browser",
                "ego-browser",
                "Browser automation skill",
              ),
            );

            // 3. Codex-only agent_global skill: should NOT mark AGY/W1/W2 as missing!
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".codex", "skills"),
                "codex-only",
                "codex-only",
                "Codex specific skill",
              ),
            );

            // 4. Antigravity skills.json with absolute path for ego-browser AND non-absolute ~/ for broken-dir
            const absCustomDir = NodePath.join(userHome, "abs-ego-skills");
            yield* Effect.promise(() =>
              writeSkill(absCustomDir, "ego-browser", "ego-browser", "Browser automation skill"),
            );
            const tildeCustomDir = NodePath.join(userHome, "tilde-skills");
            yield* Effect.promise(() =>
              writeSkill(tildeCustomDir, "tilde-only", "tilde-only", "Tilde registered skill"),
            );
            const geminiConfigDir = NodePath.join(userHome, ".gemini", "config");
            yield* Effect.promise(() => NodeFSP.mkdir(geminiConfigDir, { recursive: true }));
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(geminiConfigDir, "skills.json"),
                JSON.stringify({
                  entries: [{ path: absCustomDir }, { path: "~/tilde-skills" }],
                }),
                "utf8",
              ),
            );

            const settings: ServerSettings = {
              ...DEFAULT_SERVER_SETTINGS,
              providerInstances: {
                ...DEFAULT_SERVER_SETTINGS.providerInstances,
                [ProviderInstanceId.make("W1")]: {
                  driver: ProviderDriverKind.make("acpRegistry"),
                  displayName: "W1",
                  enabled: true,
                  config: { agentId: "factory-droid" },
                },
                [ProviderInstanceId.make("W2")]: {
                  driver: ProviderDriverKind.make("acpRegistry"),
                  displayName: "W2",
                  enabled: true,
                  config: { agentId: "factory-droid" },
                  environment: [{ name: "FACTORY_HOME_OVERRIDE", value: w2Home, sensitive: false }],
                },
              } as ServerSettings["providerInstances"],
            };

            const providers: ReadonlyArray<ServerProvider> = [
              makeProvider({
                instanceId: "antigravity",
                driver: "antigravity",
                displayName: "AGY",
                skills: [
                  {
                    name: "agy-customizations",
                    description: "Built-in Antigravity guide",
                    path: "C:/agy/builtin/skills/agy-customizations/SKILL.md",
                    enabled: true,
                  },
                ],
              }),
              makeProvider({
                instanceId: "W1",
                driver: "acpRegistry",
                displayName: "W1",
              }),
              makeProvider({
                instanceId: "W2",
                driver: "acpRegistry",
                displayName: "W2",
              }),
              makeProvider({
                instanceId: "codex",
                driver: "codex",
                displayName: "Codex",
                skills: [
                  {
                    name: "codex-only",
                    description: "Codex specific skill",
                    path: NodePath.join(userHome, ".codex", "skills", "codex-only", "SKILL.md"),
                    enabled: true,
                  },
                ],
              }),
            ];

            const overview = yield* buildSkillsOverview({
              providers,
              settings,
              stateDir,
              userHome,
              envPath: `C:\\Windows\\System32;${userHome}\\.local/share/ego\\active_version_dir`,
              platform: "win32",
            });

            // Ignored backup dir must not appear
            expect(overview.skills.find((entry) => entry.name === "old-backup")).toBeUndefined();

            // Universal skill: ego-browser (AGY via abs skills.json, W1 via .factory/skills, Codex via ~/.agents/skills; W2 missing)
            const ego = overview.skills.find((entry) => entry.name === "ego-browser");
            expect(ego?.scope).toBe("universal");
            expect(ego?.coveredEnabledCount).toBe(3);
            expect(ego?.expectedEnabledCount).toBe(4);
            expect(ego?.cells.antigravity?.status).toBe("declared_disk");
            expect(ego?.cells.W1?.status).toBe("declared_disk");
            expect(ego?.cells.codex?.status).toBe("declared_disk");
            expect(ego?.cells.W2?.status).toBe("missing");

            // Universal skill: tdd (W1 & Codex read ~/.agents/skills; AGY & isolated W2 do not!)
            const tdd = overview.skills.find((entry) => entry.name === "tdd");
            expect(tdd?.scope).toBe("universal");
            expect(tdd?.cells.W1?.status).toBe("declared_disk");
            expect(tdd?.cells.codex?.status).toBe("declared_disk");
            expect(tdd?.cells.antigravity?.status).toBe("missing");
            expect(tdd?.cells.W2?.status).toBe("missing");

            // Agent-specific global skill: codex-only (only Codex expects it; AGY/W1/W2 are not_applicable!)
            const codexOnly = overview.skills.find((entry) => entry.name === "codex-only");
            expect(codexOnly?.scope).toBe("agent_global");
            expect(codexOnly?.ownerGroupLabels).toEqual(["Codex"]);
            expect(codexOnly?.coveredEnabledCount).toBe(1);
            expect(codexOnly?.expectedEnabledCount).toBe(1);
            expect(codexOnly?.cells.codex?.status).toBe("declared_runtime");
            expect(codexOnly?.cells.antigravity?.status).toBe("not_applicable");
            expect(codexOnly?.cells.W1?.status).toBe("not_applicable");
            expect(codexOnly?.cells.W2?.status).toBe("not_applicable");

            // Non-absolute ~/ path in Windows Antigravity skills.json -> disk_warning + diagnostic!
            const tildeOnly = overview.skills.find((entry) => entry.name === "tilde-only");
            expect(tildeOnly?.scope).toBe("agent_global");
            expect(tildeOnly?.cells.antigravity?.status).toBe("disk_warning");
            expect(tildeOnly?.cells.antigravity?.reason).toContain("绝对路径");

            // Builtin skill
            const agyBuiltin = overview.skills.find((entry) => entry.name === "agy-customizations");
            expect(agyBuiltin?.scope).toBe("builtin");
            expect(agyBuiltin?.cells.antigravity?.status).toBe("declared_runtime");
            expect(agyBuiltin?.cells.W1?.status).toBe("not_applicable");

            // Diagnostics
            expect(overview.diagnostics.some((d) => d.code === "path_mixed_slashes")).toBe(true);
            expect(
              overview.diagnostics.some((d) => d.code === "isolated_profile_missing_skills"),
            ).toBe(true);
            expect(
              overview.diagnostics.some((d) => d.code === "isolated_profile_no_universal_pool"),
            ).toBe(true);
            expect(
              overview.diagnostics.some((d) => d.code === "antigravity_skills_json_non_absolute"),
            ).toBe(true);
          }),
          Effect.promise(() => NodeFSP.rm(tempRoot, { recursive: true, force: true })),
        );
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {}),
      ),
  );

  it.effect(
    "reads only the instance profile skills.json while that profile exists, and falls back globally without it",
    () =>
      Effect.gen(function* () {
        const tempRoot = yield* Effect.promise(() => makeTempRoot("t3-skills-overview-isolation-"));
        return yield* Effect.ensuring(
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const profileDir = antigravityProfileDir(stateDir, "antigravity");
            yield* Effect.promise(() =>
              NodeFSP.mkdir(NodePath.join(profileDir, "config"), { recursive: true }),
            );

            const globalOnlyDir = yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(tempRoot, "external"),
                "global-only",
                "global-only",
                "Only declared in the global manifest",
              ),
            );
            const geminiConfigDir = NodePath.join(userHome, ".gemini", "config");
            yield* Effect.promise(() => NodeFSP.mkdir(geminiConfigDir, { recursive: true }));
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(geminiConfigDir, "skills.json"),
                JSON.stringify({ entries: [{ path: NodePath.dirname(globalOnlyDir) }] }),
                "utf8",
              ),
            );

            const providers = [
              makeProvider({
                instanceId: "antigravity",
                driver: "antigravity",
                displayName: "AGY",
              }),
            ];
            const first = yield* buildSkillsOverview({
              providers,
              settings: DEFAULT_SERVER_SETTINGS,
              stateDir,
              userHome,
              envPath: "",
              platform: "win32",
            });
            expect(first.skills.find((entry) => entry.name === "global-only")).toBeUndefined();

            yield* Effect.promise(() => NodeFSP.rm(profileDir, { recursive: true, force: true }));
            const fallback = yield* buildSkillsOverview({
              providers,
              settings: DEFAULT_SERVER_SETTINGS,
              stateDir,
              userHome,
              envPath: "",
              platform: "win32",
            });
            expect(fallback.skills.find((entry) => entry.name === "global-only")?.scope).toBe(
              "agent_global",
            );
          }),
          Effect.promise(() => NodeFSP.rm(tempRoot, { recursive: true, force: true })),
        );
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {}),
      ),
  );

  it.effect("keeps a junction child of a skills.json parent as a disk warning on Windows", () =>
    Effect.gen(function* () {
      const tempRoot = yield* Effect.promise(() => makeTempRoot("t3-skills-overview-junction-"));
      return yield* Effect.ensuring(
        Effect.gen(function* () {
          const userHome = NodePath.join(tempRoot, "home");
          const stateDir = NodePath.join(tempRoot, "state");
          const profileDir = antigravityProfileDir(stateDir, "antigravity");
          yield* Effect.promise(() =>
            NodeFSP.mkdir(NodePath.join(profileDir, "config"), { recursive: true }),
          );

          const declaredParent = NodePath.join(tempRoot, "declared-parent");
          yield* Effect.promise(() =>
            writeSkill(declaredParent, "real-skill", "real-skill", "A real directory"),
          );
          const junctionTarget = yield* Effect.promise(() =>
            writeSkill(
              NodePath.join(tempRoot, "external"),
              "linked-skill",
              "linked-skill",
              "A junction target",
            ),
          );
          yield* Effect.promise(() =>
            createJunction(NodePath.join(declaredParent, "linked-skill"), junctionTarget),
          );
          yield* Effect.promise(() =>
            NodeFSP.writeFile(
              NodePath.join(profileDir, "config", "skills.json"),
              JSON.stringify({ entries: [{ path: declaredParent }] }),
              "utf8",
            ),
          );

          const overview = yield* buildSkillsOverview({
            providers: [
              makeProvider({
                instanceId: "antigravity",
                driver: "antigravity",
                displayName: "AGY",
              }),
            ],
            settings: DEFAULT_SERVER_SETTINGS,
            stateDir,
            userHome,
            envPath: "",
            platform: "win32",
          });

          const real = overview.skills.find((entry) => entry.name === "real-skill");
          expect(real?.cells.antigravity?.status).toBe("declared_disk");
          const linked = overview.skills.find((entry) => entry.name === "linked-skill");
          expect(linked?.cells.antigravity?.status).toBe("disk_warning");
          expect(linked?.cells.antigravity?.isLink).toBe(true);
          expect(linked?.cells.antigravity?.fromSkillsJson).toBe(true);
          expect(linked?.cells.antigravity?.reason).toContain("联接");
        }),
        Effect.promise(() => NodeFSP.rm(tempRoot, { recursive: true, force: true })),
      );
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {}),
    ),
  );

  it.effect("scans Factory Droid's singular .agent/skills directory", () =>
    Effect.gen(function* () {
      const tempRoot = yield* Effect.promise(() => makeTempRoot("t3-skills-overview-factory-"));
      return yield* Effect.ensuring(
        Effect.gen(function* () {
          const userHome = NodePath.join(tempRoot, "home");
          const stateDir = NodePath.join(tempRoot, "state");
          yield* Effect.promise(() =>
            writeSkill(
              NodePath.join(userHome, ".agent", "skills"),
              "singular-agent-skill",
              "singular-agent-skill",
              "Only found under the singular .agent directory",
            ),
          );
          const settings: ServerSettings = {
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              ...DEFAULT_SERVER_SETTINGS.providerInstances,
              [ProviderInstanceId.make("W1")]: {
                driver: ProviderDriverKind.make("acpRegistry"),
                displayName: "W1",
                enabled: true,
                config: { agentId: "factory-droid" },
              },
            } as ServerSettings["providerInstances"],
          };

          const overview = yield* buildSkillsOverview({
            providers: [
              makeProvider({
                instanceId: "W1",
                driver: "acpRegistry",
                displayName: "W1",
              }),
            ],
            settings,
            stateDir,
            userHome,
            envPath: "",
            platform: "win32",
          });

          expect(
            overview.instances.find((instance) => instance.instanceId === "W1")?.globalSkillDirs,
          ).toContain(NodePath.join(userHome, ".agent", "skills"));
          const singular = overview.skills.find((entry) => entry.name === "singular-agent-skill");
          expect(singular?.cells.W1?.status).toBe("declared_disk");
        }),
        Effect.promise(() => NodeFSP.rm(tempRoot, { recursive: true, force: true })),
      );
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {}),
    ),
  );

  it.effect("computes duplicate copies and content conflicts from every physical location", () =>
    Effect.gen(function* () {
      const tempRoot = yield* Effect.promise(() => makeTempRoot("t3-skills-overview-duplicates-"));
      return yield* Effect.ensuring(
        Effect.gen(function* () {
          const userHome = NodePath.join(tempRoot, "home");
          const stateDir = NodePath.join(tempRoot, "state");
          const universal = NodePath.join(userHome, ".agents", "skills");

          yield* Effect.promise(() =>
            writeSkill(universal, "alpha", "alpha", "Same content everywhere"),
          );
          yield* Effect.promise(() =>
            writeSkill(
              NodePath.join(userHome, ".codex", "skills"),
              "alpha",
              "alpha",
              "Same content everywhere",
            ),
          );
          yield* Effect.promise(() => writeSkill(universal, "beta", "beta", "Universal content"));
          yield* Effect.promise(() =>
            writeSkill(
              NodePath.join(userHome, ".claude", "skills"),
              "beta",
              "beta",
              "Conflicting provider content",
            ),
          );
          yield* Effect.promise(() =>
            writeSkill(universal, "delta", "delta", "Junction-only duplicate"),
          );
          yield* Effect.promise(() =>
            createJunction(
              NodePath.join(userHome, ".codex", "skills", "delta"),
              NodePath.join(universal, "delta"),
            ),
          );
          yield* Effect.promise(() =>
            writeSkill(universal, "gamma", "gamma", "Not a true redundant copy"),
          );
          yield* Effect.promise(() =>
            createJunction(
              NodePath.join(userHome, ".claude", "skills", "gamma"),
              NodePath.join(universal, "gamma"),
            ),
          );

          const overview = yield* buildSkillsOverview({
            providers: [
              makeProvider({ instanceId: "codex", driver: "codex", displayName: "Codex" }),
              makeProvider({
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                displayName: "Claude",
              }),
            ],
            settings: DEFAULT_SERVER_SETTINGS,
            stateDir,
            userHome,
            envPath: "",
            platform: "win32",
          });

          const alpha = overview.skills.find((entry) => entry.name === "alpha");
          expect(alpha?.hasDuplicateCopies).toBe(true);
          expect(alpha?.hasContentConflict).toBe(false);
          expect(alpha?.locations.length).toBe(2);
          expect(
            new Set(alpha?.locations.map((location) => location.path.toLowerCase())).size,
          ).toBe(alpha?.locations.length);
          expect(alpha?.locations.map((location) => location.layer)).toEqual(
            expect.arrayContaining(["universal", "provider_global"]),
          );
          expect(alpha?.cells.codex?.isLink).toBe(false);
          expect(alpha?.cells.codex?.removable).toBe(true);

          const beta = overview.skills.find((entry) => entry.name === "beta");
          expect(beta?.hasDuplicateCopies).toBe(true);
          expect(beta?.hasContentConflict).toBe(true);
          expect(
            new Set(beta?.locations.flatMap((location) => location.contentHash ?? [])).size,
          ).toBe(2);

          const deltaEntry = overview.skills.find((entry) => entry.name === "delta");
          expect(deltaEntry?.hasDuplicateCopies).toBe(true);
          expect(deltaEntry?.hasContentConflict).toBe(false);
          expect(
            deltaEntry?.locations.some(
              (location) => location.ownerLabel === "Codex" && location.isLink,
            ),
          ).toBe(true);

          const gammaEntry = overview.skills.find((entry) => entry.name === "gamma");
          expect(gammaEntry?.hasDuplicateCopies).toBe(false);
          expect(gammaEntry?.cells.claudeAgent?.isLink).toBe(true);
        }),
        Effect.promise(() => NodeFSP.rm(tempRoot, { recursive: true, force: true })),
      );
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {}),
    ),
  );

  it.effect(
    "flags external-junction + independent copy as duplicate, marks universal junctions non-removable, and sets autoFixable accurately",
    () =>
      Effect.gen(function* () {
        const tempRoot = yield* Effect.promise(() =>
          makeTempRoot("t3-skills-overview-regressions-"),
        );
        return yield* Effect.ensuring(
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const universal = NodePath.join(userHome, ".agents", "skills");
            const externalRepo = yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(tempRoot, "external-repo"),
                "lantu",
                "lantu",
                "External canonical skill",
              ),
            );
            yield* Effect.promise(() =>
              createJunction(NodePath.join(universal, "lantu"), externalRepo),
            );
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".claude", "skills"),
                "lantu",
                "lantu",
                "External canonical skill",
              ),
            );
            const brokenDir = NodePath.join(userHome, ".codex", "skills", "broken-fm");
            yield* Effect.promise(() => NodeFSP.mkdir(brokenDir, { recursive: true }));
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(brokenDir, "SKILL.md"),
                "# Missing frontmatter\n",
                "utf8",
              ),
            );

            const overview = yield* buildSkillsOverview({
              providers: [
                makeProvider({ instanceId: "codex", driver: "codex", displayName: "Codex" }),
                makeProvider({
                  instanceId: "claudeAgent",
                  driver: "claudeAgent",
                  displayName: "Claude",
                }),
              ],
              settings: DEFAULT_SERVER_SETTINGS,
              stateDir,
              userHome,
              envPath: "",
              platform: "win32",
            });

            const lantu = overview.skills.find((entry) => entry.name === "lantu");
            expect(lantu?.hasDuplicateCopies).toBe(true);
            expect(lantu?.cells.codex?.removable).toBe(false);
            expect(lantu?.cells.claudeAgent?.removable).toBe(true);

            const broken = overview.skills.find((entry) => entry.name === "broken-fm");
            expect(broken?.cells.codex?.status).toBe("disk_warning");
            expect(broken?.cells.codex?.autoFixable).toBe(false);
          }),
          Effect.promise(() => NodeFSP.rm(tempRoot, { recursive: true, force: true })),
        );
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {}),
      ),
  );
});

describe("ServerManageSkillsInput", () => {
  it("decodes every management action", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const inputs = [
      { action: "mount_to_instance", skillName: "one", targetInstanceId: instanceId },
      { action: "unmount_from_instance", skillName: "one", targetInstanceId: instanceId },
      { action: "fix_instance_warning", skillName: "one", targetInstanceId: instanceId },
      { action: "link_universal_pool", targetInstanceId: instanceId },
      {
        action: "sync_instances",
        targetInstanceIds: [instanceId],
      },
      {
        action: "promote_to_universal",
        skillName: "one",
        sourcePath: "C:/skills/one",
      },
      { action: "demote_to_provider", skillName: "one", targetInstanceId: instanceId },
      {
        action: "import_skill",
        sourceDirPath: "C:/skills/one",
        targetScope: "universal",
        mode: "copy",
      },
      { action: "dedupe_skill", skillName: "one" },
      { action: "dedupe_all" },
      { action: "backup_skill", skillName: "one" },
    ] as const;

    for (const input of inputs) {
      expect(decodeManageSkillsInput(input).action).toBe(input.action);
    }
  });
});

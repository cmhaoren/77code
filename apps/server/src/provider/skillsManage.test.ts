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
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { manageSkills } from "./skillsManage.ts";

function makeProvider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly enabled?: boolean;
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
    skills: [],
  };
}

function factorySettings(input: {
  readonly instanceId: string;
  readonly agentId: string;
  readonly factoryHomeOverride?: string;
  readonly enabled?: boolean;
}): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      ...DEFAULT_SERVER_SETTINGS.providerInstances,
      [ProviderInstanceId.make(input.instanceId)]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        displayName: input.instanceId,
        enabled: input.enabled ?? true,
        config: { agentId: input.agentId },
        ...(input.factoryHomeOverride === undefined
          ? {}
          : {
              environment: [
                {
                  name: "FACTORY_HOME_OVERRIDE",
                  value: input.factoryHomeOverride,
                  sensitive: false,
                },
              ],
            }),
      },
    } as ServerSettings["providerInstances"],
  };
}

async function makeTempRoot(prefix: string) {
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
}

async function writeSkill(
  rootDir: string,
  folderName: string,
  name: string,
  description: string,
  body = `# ${name}\n`,
) {
  const dir = NodePath.join(rootDir, folderName);
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
    "utf8",
  );
  return dir;
}

async function createJunction(linkPath: string, targetPath: string) {
  await NodeFSP.mkdir(NodePath.dirname(linkPath), { recursive: true });
  await NodeFSP.symlink(NodePath.resolve(targetPath), linkPath, "junction");
}

async function isLink(targetPath: string) {
  try {
    return (await NodeFSP.lstat(targetPath)).isSymbolicLink();
  } catch {
    return false;
  }
}

async function exists(targetPath: string) {
  try {
    await NodeFSP.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readSkillFile(dirPath: string) {
  return NodeFSP.readFile(NodePath.join(dirPath, "SKILL.md"), "utf8");
}

async function readManifest(manifestPath: string): Promise<{
  readonly entries?: ReadonlyArray<{ readonly path: string }>;
}> {
  return JSON.parse(await NodeFSP.readFile(manifestPath, "utf8")) as {
    readonly entries?: ReadonlyArray<{ readonly path: string }>;
  };
}

function forwardPath(targetPath: string) {
  return NodePath.resolve(targetPath).replace(/\\/g, "/");
}

function antigravityProfileDir(stateDir: string, instanceId: string) {
  const key = NodeCrypto.createHash("sha256").update(instanceId).digest("hex");
  return NodePath.join(stateDir, "providers", "antigravity", key);
}

function withTempRoot<A, E, R>(
  prefix: string,
  use: (tempRoot: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.promise(() => makeTempRoot(prefix)),
    use,
    (tempRoot) => Effect.promise(() => NodeFSP.rm(tempRoot, { recursive: true, force: true })),
  );
}

function withHost<A, E>(effect: Effect.Effect<A, E, never>) {
  return effect.pipe(
    Effect.provideService(HostProcess.Platform, "win32"),
    Effect.provideService(HostProcess.Environment, {}),
  );
}

describe("manageSkills", () => {
  it.effect(
    "mounts through Antigravity skills.json and copies into a normal provider directory",
    () =>
      withHost(
        withTempRoot("t3-skills-manage-mount-", (tempRoot) =>
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const external = NodePath.join(tempRoot, "external");
            const providers = [
              makeProvider({
                instanceId: "antigravity",
                driver: "antigravity",
                displayName: "AGY",
              }),
              makeProvider({ instanceId: "codex", driver: "codex", displayName: "Codex" }),
            ];
            const agySource = yield* Effect.promise(() =>
              writeSkill(external, "agy-skill", "agy-skill", "AGY mounted skill"),
            );
            const codexSource = yield* Effect.promise(() =>
              writeSkill(external, "codex-copy", "codex-copy", "Codex copied skill"),
            );

            const agy = yield* manageSkills(
              {
                action: "mount_to_instance",
                skillName: "agy-skill",
                sourcePath: agySource,
                targetInstanceId: ProviderInstanceId.make("antigravity"),
              },
              {
                providers,
                settings: DEFAULT_SERVER_SETTINGS,
                stateDir,
                userHome,
                platform: "win32",
              },
            );
            const profileDir = antigravityProfileDir(stateDir, "antigravity");
            const manifest = yield* Effect.promise(() =>
              readManifest(NodePath.join(profileDir, "config", "skills.json")),
            );
            expect(manifest.entries?.map((entry) => entry.path)).toContain(forwardPath(agySource));
            expect(
              yield* Effect.promise(() =>
                exists(NodePath.join(profileDir, "config", "skills", "agy-skill")),
              ),
            ).toBe(false);
            expect(
              agy.overview.skills.find((entry) => entry.name === "agy-skill")?.cells.antigravity
                ?.status,
            ).toBe("declared_disk");

            const codex = yield* manageSkills(
              {
                action: "mount_to_instance",
                skillName: "codex-copy",
                sourcePath: codexSource,
                targetInstanceId: ProviderInstanceId.make("codex"),
                mode: "copy",
              },
              {
                providers,
                settings: DEFAULT_SERVER_SETTINGS,
                stateDir,
                userHome,
                platform: "win32",
              },
            );
            const copiedDir = NodePath.join(userHome, ".codex", "skills", "codex-copy");
            expect(yield* Effect.promise(() => isLink(copiedDir))).toBe(false);
            expect(yield* Effect.promise(() => readSkillFile(copiedDir))).toContain("codex-copy");
            expect(
              codex.overview.skills.find((entry) => entry.name === "codex-copy")?.cells.codex
                ?.status,
            ).toBe("declared_disk");
          }),
        ),
      ),
  );

  it.effect(
    "unmounts a normal provider entity into its backup and removes only an Antigravity junction",
    () =>
      withHost(
        withTempRoot("t3-skills-manage-unmount-", (tempRoot) =>
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const external = NodePath.join(tempRoot, "external");
            const providers = [
              makeProvider({
                instanceId: "antigravity",
                driver: "antigravity",
                displayName: "AGY",
              }),
              makeProvider({ instanceId: "codex", driver: "codex", displayName: "Codex" }),
            ];
            const codexSource = yield* Effect.promise(() =>
              writeSkill(external, "codex-removable", "codex-removable", "Remove me"),
            );
            yield* manageSkills(
              {
                action: "mount_to_instance",
                skillName: "codex-removable",
                sourcePath: codexSource,
                targetInstanceId: ProviderInstanceId.make("codex"),
                mode: "copy",
              },
              {
                providers,
                settings: DEFAULT_SERVER_SETTINGS,
                stateDir,
                userHome,
                platform: "win32",
              },
            );
            const codexDir = NodePath.join(userHome, ".codex", "skills", "codex-removable");
            const unmounted = yield* manageSkills(
              {
                action: "unmount_from_instance",
                skillName: "codex-removable",
                targetInstanceId: ProviderInstanceId.make("codex"),
              },
              {
                providers,
                settings: DEFAULT_SERVER_SETTINGS,
                stateDir,
                userHome,
                platform: "win32",
              },
            );
            expect(yield* Effect.promise(() => exists(codexDir))).toBe(false);
            const codexBackups = yield* Effect.promise(() =>
              NodeFSP.readdir(NodePath.join(userHome, ".codex", "skills", "_backup")),
            );
            expect(codexBackups.some((name) => name.startsWith("codex-removable-"))).toBe(true);
            expect(unmounted.affectedPaths.length).toBeGreaterThan(0);

            const profileDir = antigravityProfileDir(stateDir, "antigravity");
            const agyTarget = yield* Effect.promise(() =>
              writeSkill(external, "agy-mounted", "agy-mounted", "Keep the target"),
            );
            const agyLink = NodePath.join(profileDir, "config", "skills", "agy-mounted");
            yield* Effect.promise(() => createJunction(agyLink, agyTarget));
            yield* manageSkills(
              {
                action: "unmount_from_instance",
                skillName: "agy-mounted",
                targetInstanceId: ProviderInstanceId.make("antigravity"),
              },
              {
                providers,
                settings: DEFAULT_SERVER_SETTINGS,
                stateDir,
                userHome,
                platform: "win32",
              },
            );
            expect(yield* Effect.promise(() => exists(agyLink))).toBe(false);
            expect(yield* Effect.promise(() => readSkillFile(agyTarget))).toContain("agy-mounted");
          }),
        ),
      ),
  );

  it.effect(
    "refuses to remove an Antigravity skills.json entry that is a shared parent directory",
    () =>
      withHost(
        withTempRoot("t3-skills-manage-shared-", (tempRoot) =>
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const sharedParent = NodePath.join(tempRoot, "shared-skills");
            const agents = [
              makeProvider({
                instanceId: "antigravity",
                driver: "antigravity",
                displayName: "AGY",
              }),
            ];
            yield* Effect.promise(() => writeSkill(sharedParent, "one", "one", "First"));
            yield* Effect.promise(() => writeSkill(sharedParent, "two", "two", "Second"));
            const profileDir = antigravityProfileDir(stateDir, "antigravity");
            yield* Effect.promise(() =>
              NodeFSP.mkdir(NodePath.join(profileDir, "config"), { recursive: true }),
            );
            const manifestPath = NodePath.join(profileDir, "config", "skills.json");
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                manifestPath,
                JSON.stringify({ entries: [{ path: sharedParent }] }),
                "utf8",
              ),
            );

            const error = yield* Effect.flip(
              manageSkills(
                {
                  action: "unmount_from_instance",
                  skillName: "one",
                  targetInstanceId: ProviderInstanceId.make("antigravity"),
                },
                {
                  providers: agents,
                  settings: DEFAULT_SERVER_SETTINGS,
                  stateDir,
                  userHome,
                  platform: "win32",
                },
              ),
            );
            expect(error.message).toContain("共享");
            const manifest = yield* Effect.promise(() => readManifest(manifestPath));
            expect(manifest.entries).toHaveLength(1);
          }),
        ),
      ),
  );

  it.effect(
    "fixes Antigravity tilde paths and replaces a junction with its real parent registration",
    () =>
      withHost(
        withTempRoot("t3-skills-manage-fix-", (tempRoot) =>
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const providers = [
              makeProvider({
                instanceId: "antigravity",
                driver: "antigravity",
                displayName: "AGY",
              }),
            ];
            const realSkill = yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, "real-parent"),
                "junction-skill",
                "junction-skill",
                "Real skill",
              ),
            );
            const profileDir = antigravityProfileDir(stateDir, "antigravity");
            const manifestPath = NodePath.join(profileDir, "config", "skills.json");
            const junctionPath = NodePath.join(profileDir, "config", "skills", "junction-skill");
            yield* Effect.promise(() =>
              NodeFSP.mkdir(NodePath.dirname(manifestPath), { recursive: true }),
            );
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                manifestPath,
                JSON.stringify({ entries: [{ path: "~/broken-parent" }] }),
                "utf8",
              ),
            );
            yield* Effect.promise(() => createJunction(junctionPath, realSkill));

            yield* manageSkills(
              {
                action: "fix_instance_warning",
                skillName: "junction-skill",
                targetInstanceId: ProviderInstanceId.make("antigravity"),
              },
              {
                providers,
                settings: DEFAULT_SERVER_SETTINGS,
                stateDir,
                userHome,
                platform: "win32",
              },
            );

            const manifest = yield* Effect.promise(() => readManifest(manifestPath));
            const entryPaths = manifest.entries?.map((entry) => entry.path) ?? [];
            expect(entryPaths).toContain(forwardPath(NodePath.join(userHome, "broken-parent")));
            expect(entryPaths).toContain(forwardPath(realSkill));
            expect(entryPaths.some((entryPath) => entryPath.includes("~/"))).toBe(false);
            expect(yield* Effect.promise(() => exists(junctionPath))).toBe(false);
            expect(yield* Effect.promise(() => exists(realSkill))).toBe(true);
          }),
        ),
      ),
  );

  it.effect(
    "links the universal pool for isolated Factory, Antigravity manifests, and non-pool providers",
    () =>
      withHost(
        withTempRoot("t3-skills-manage-link-pool-", (tempRoot) =>
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const factoryHome = NodePath.join(tempRoot, "factory-home");
            const external = NodePath.join(tempRoot, "external");
            const universal = NodePath.join(userHome, ".agents", "skills");
            yield* Effect.promise(() =>
              writeSkill(universal, "shared-skill", "shared-skill", "From universal"),
            );
            const linkedTarget = yield* Effect.promise(() =>
              writeSkill(external, "agy-linked", "agy-linked", "Linked target"),
            );
            yield* Effect.promise(() =>
              createJunction(NodePath.join(universal, "agy-linked"), linkedTarget),
            );
            const settings = factorySettings({
              instanceId: "W2",
              agentId: "factory-droid",
              factoryHomeOverride: factoryHome,
            });
            const providers = [
              makeProvider({ instanceId: "W2", driver: "acpRegistry", displayName: "W2" }),
              makeProvider({
                instanceId: "antigravity",
                driver: "antigravity",
                displayName: "AGY",
              }),
              makeProvider({
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                displayName: "Claude",
              }),
            ];

            const factory = yield* manageSkills(
              {
                action: "link_universal_pool",
                targetInstanceId: ProviderInstanceId.make("W2"),
              },
              { providers, settings, stateDir, userHome, platform: "win32" },
            );
            const factoryPoolLink = NodePath.join(factoryHome, ".agents", "skills");
            expect(yield* Effect.promise(() => isLink(factoryPoolLink))).toBe(true);
            expect(
              yield* Effect.promise(() =>
                NodeFSP.realpath(factoryPoolLink).then((value) => value.toLowerCase()),
              ),
            ).toBe((yield* Effect.promise(() => NodeFSP.realpath(universal))).toLowerCase());
            expect(factory.ok).toBe(true);
            expect(
              factory.overview.skills.find((entry) => entry.name === "shared-skill")
                ?.hasDuplicateCopies,
            ).toBe(false);

            yield* manageSkills(
              {
                action: "link_universal_pool",
                targetInstanceId: ProviderInstanceId.make("antigravity"),
              },
              { providers, settings, stateDir, userHome, platform: "win32" },
            );
            const profileDir = antigravityProfileDir(stateDir, "antigravity");
            const manifest = yield* Effect.promise(() =>
              readManifest(NodePath.join(profileDir, "config", "skills.json")),
            );
            const entryPaths = manifest.entries?.map((entry) => entry.path) ?? [];
            expect(entryPaths).toContain(forwardPath(universal));
            expect(entryPaths).toContain(forwardPath(linkedTarget));

            yield* manageSkills(
              {
                action: "link_universal_pool",
                targetInstanceId: ProviderInstanceId.make("claudeAgent"),
              },
              { providers, settings, stateDir, userHome, platform: "win32" },
            );
            const claudeSkillsDir = NodePath.join(userHome, ".claude", "skills");
            expect(
              yield* Effect.promise(() => isLink(NodePath.join(claudeSkillsDir, "shared-skill"))),
            ).toBe(true);
            expect(
              yield* Effect.promise(() => isLink(NodePath.join(claudeSkillsDir, "agy-linked"))),
            ).toBe(true);
          }),
        ),
      ),
  );

  it.effect("syncs all disk skills from a source instance and mounts explicit skill names", () =>
    withHost(
      withTempRoot("t3-skills-manage-sync-", (tempRoot) =>
        Effect.gen(function* () {
          const userHome = NodePath.join(tempRoot, "home");
          const stateDir = NodePath.join(tempRoot, "state");
          const codexSkills = NodePath.join(userHome, ".codex", "skills");
          yield* Effect.promise(() =>
            writeSkill(codexSkills, "sync-a", "sync-a", "First synced skill"),
          );
          yield* Effect.promise(() =>
            writeSkill(codexSkills, "sync-b", "sync-b", "Second synced skill"),
          );
          const providers = [
            makeProvider({ instanceId: "codex", driver: "codex", displayName: "Codex" }),
            makeProvider({
              instanceId: "claudeAgent",
              driver: "claudeAgent",
              displayName: "Claude",
            }),
            makeProvider({ instanceId: "cursor", driver: "cursor", displayName: "Cursor" }),
          ];
          const options = {
            providers,
            settings: DEFAULT_SERVER_SETTINGS,
            stateDir,
            userHome,
            platform: "win32" as const,
          };

          const synced = yield* manageSkills(
            {
              action: "sync_instances",
              sourceInstanceId: ProviderInstanceId.make("codex"),
              targetInstanceIds: [ProviderInstanceId.make("claudeAgent")],
            },
            options,
          );
          expect(
            yield* Effect.promise(() =>
              isLink(NodePath.join(userHome, ".claude", "skills", "sync-a")),
            ),
          ).toBe(true);
          expect(
            yield* Effect.promise(() =>
              isLink(NodePath.join(userHome, ".claude", "skills", "sync-b")),
            ),
          ).toBe(true);
          expect(
            synced.overview.skills.find((entry) => entry.name === "sync-a")?.cells.claudeAgent
              ?.status,
          ).toBe("declared_disk");

          yield* manageSkills(
            {
              action: "sync_instances",
              sourceInstanceId: ProviderInstanceId.make("codex"),
              targetInstanceIds: [ProviderInstanceId.make("cursor")],
              skillNames: ["sync-b"],
            },
            options,
          );
          const cursorSkills = NodePath.join(userHome, ".cursor", "skills");
          expect(yield* Effect.promise(() => isLink(NodePath.join(cursorSkills, "sync-b")))).toBe(
            true,
          );
          expect(yield* Effect.promise(() => exists(NodePath.join(cursorSkills, "sync-a")))).toBe(
            false,
          );
        }),
      ),
    ),
  );

  it.effect(
    "promotes a real entity to the universal pool without leaving a duplicate, and rejects paths outside the whitelist",
    () =>
      withHost(
        withTempRoot("t3-skills-manage-promote-", (tempRoot) =>
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const universal = NodePath.join(userHome, ".agents", "skills");
            const codexSource = yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".codex", "skills"),
                "promote-codex",
                "promote-codex",
                "Codex source",
              ),
            );
            const claudeSource = yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".claude", "skills"),
                "promote-claude",
                "promote-claude",
                "Claude source",
              ),
            );
            const providers = [
              makeProvider({ instanceId: "codex", driver: "codex", displayName: "Codex" }),
              makeProvider({
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                displayName: "Claude",
              }),
            ];
            const options = {
              providers,
              settings: DEFAULT_SERVER_SETTINGS,
              stateDir,
              userHome,
              platform: "win32" as const,
            };

            yield* manageSkills(
              {
                action: "promote_to_universal",
                skillName: "promote-codex",
                sourcePath: codexSource,
              },
              options,
            );
            expect(yield* Effect.promise(() => exists(codexSource))).toBe(false);
            expect(
              yield* Effect.promise(() => readSkillFile(NodePath.join(universal, "promote-codex"))),
            ).toContain("Codex source");

            yield* manageSkills(
              {
                action: "promote_to_universal",
                skillName: "promote-claude",
                sourcePath: claudeSource,
              },
              options,
            );
            expect(yield* Effect.promise(() => isLink(claudeSource))).toBe(true);
            expect(yield* Effect.promise(() => readSkillFile(claudeSource))).toContain(
              "Claude source",
            );

            const outside = yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(tempRoot, "outside"),
                "escaped",
                "escaped",
                "Outside the whitelist",
              ),
            );
            const error = yield* Effect.flip(
              manageSkills(
                {
                  action: "promote_to_universal",
                  skillName: "escaped",
                  sourcePath: outside,
                },
                options,
              ),
            );
            expect(error.message).toContain("白名单");
            expect(yield* Effect.promise(() => exists(outside))).toBe(true);
          }),
        ),
      ),
  );

  it.effect(
    "demotes a universal entity into Antigravity's global skills directory and registers it",
    () =>
      withHost(
        withTempRoot("t3-skills-manage-demote-", (tempRoot) =>
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const universal = NodePath.join(userHome, ".agents", "skills");
            yield* Effect.promise(() =>
              writeSkill(universal, "demote-me", "demote-me", "Move to AGY"),
            );
            const providers = [
              makeProvider({
                instanceId: "antigravity",
                driver: "antigravity",
                displayName: "AGY",
              }),
            ];
            const result = yield* manageSkills(
              {
                action: "demote_to_provider",
                skillName: "demote-me",
                targetInstanceId: ProviderInstanceId.make("antigravity"),
              },
              {
                providers,
                settings: DEFAULT_SERVER_SETTINGS,
                stateDir,
                userHome,
                platform: "win32",
              },
            );

            const targetDir = NodePath.join(userHome, ".gemini", "config", "skills", "demote-me");
            expect(yield* Effect.promise(() => readSkillFile(targetDir))).toContain("demote-me");
            expect(yield* Effect.promise(() => exists(NodePath.join(universal, "demote-me")))).toBe(
              false,
            );
            const profileDir = antigravityProfileDir(stateDir, "antigravity");
            const manifest = yield* Effect.promise(() =>
              readManifest(NodePath.join(profileDir, "config", "skills.json")),
            );
            expect(manifest.entries?.map((entry) => entry.path)).toContain(forwardPath(targetDir));
            expect(
              result.overview.skills.find((entry) => entry.name === "demote-me")?.cells.antigravity
                ?.status,
            ).toBe("declared_disk");
          }),
        ),
      ),
  );

  it.effect(
    "imports a validated skill into the universal pool, an explicit provider, and enabled non-pool providers",
    () =>
      withHost(
        withTempRoot("t3-skills-manage-import-", (tempRoot) =>
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const external = NodePath.join(tempRoot, "external");
            const universal = NodePath.join(userHome, ".agents", "skills");
            const source = yield* Effect.promise(() =>
              writeSkill(external, "imported", "imported", "Imported skill"),
            );
            const providers = [
              makeProvider({
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                displayName: "Claude",
              }),
            ];
            const options = {
              providers,
              settings: DEFAULT_SERVER_SETTINGS,
              stateDir,
              userHome,
              platform: "win32" as const,
            };

            yield* manageSkills(
              {
                action: "import_skill",
                sourceDirPath: source,
                targetScope: "universal",
                mode: "copy",
                mountToNonUniversalEnabled: true,
              },
              options,
            );
            expect(
              yield* Effect.promise(() => readSkillFile(NodePath.join(universal, "imported"))),
            ).toContain("Imported skill");
            expect(
              yield* Effect.promise(() =>
                isLink(NodePath.join(userHome, ".claude", "skills", "imported")),
              ),
            ).toBe(true);

            const providerSource = yield* Effect.promise(() =>
              writeSkill(
                external,
                "instance-import",
                "instance-import",
                "Imported into one provider",
              ),
            );
            yield* manageSkills(
              {
                action: "import_skill",
                sourceDirPath: providerSource,
                targetScope: "provider_global",
                targetInstanceIds: [ProviderInstanceId.make("claudeAgent")],
                mode: "copy",
              },
              options,
            );
            const providerImport = NodePath.join(userHome, ".claude", "skills", "instance-import");
            expect(yield* Effect.promise(() => isLink(providerImport))).toBe(false);
            expect(yield* Effect.promise(() => readSkillFile(providerImport))).toContain(
              "Imported into one provider",
            );

            const invalidSource = NodePath.join(external, "invalid");
            yield* Effect.promise(() => NodeFSP.mkdir(invalidSource, { recursive: true }));
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(invalidSource, "SKILL.md"),
                "---\nname: invalid\n---\n# Missing description\n",
                "utf8",
              ),
            );
            const error = yield* Effect.flip(
              manageSkills(
                {
                  action: "import_skill",
                  sourceDirPath: invalidSource,
                  targetScope: "universal",
                  mode: "copy",
                },
                options,
              ),
            );
            expect(error.message).toContain("frontmatter");
          }),
        ),
      ),
  );

  it.effect(
    "blocks conflicting dedupe unless a preferred source is chosen, then leaves one universal entity",
    () =>
      withHost(
        withTempRoot("t3-skills-manage-dedupe-", (tempRoot) =>
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const universal = NodePath.join(userHome, ".agents", "skills");
            const codexSkills = NodePath.join(userHome, ".codex", "skills");
            yield* Effect.promise(() =>
              writeSkill(universal, "dup", "dup", "Universal copy", "# Universal\n"),
            );
            const providerCopy = yield* Effect.promise(() =>
              writeSkill(codexSkills, "dup", "dup", "Provider copy", "# Provider\n"),
            );
            const providers = [
              makeProvider({ instanceId: "codex", driver: "codex", displayName: "Codex" }),
            ];
            const options = {
              providers,
              settings: DEFAULT_SERVER_SETTINGS,
              stateDir,
              userHome,
              platform: "win32" as const,
            };

            const conflict = yield* Effect.flip(
              manageSkills({ action: "dedupe_skill", skillName: "dup" }, options),
            );
            expect(conflict.message).toContain("内容");
            expect(conflict.message).toContain(providerCopy);

            const result = yield* manageSkills(
              {
                action: "dedupe_skill",
                skillName: "dup",
                preferSourcePath: providerCopy,
              },
              options,
            );
            expect(
              yield* Effect.promise(() => readSkillFile(NodePath.join(universal, "dup"))),
            ).toContain("# Provider");
            const universalBackups = yield* Effect.promise(() =>
              NodeFSP.readdir(NodePath.join(universal, "_backup")),
            );
            expect(universalBackups.some((name) => name.startsWith("dup-"))).toBe(true);
            expect(yield* Effect.promise(() => exists(providerCopy))).toBe(false);
            const codexBackups = yield* Effect.promise(() =>
              NodeFSP.readdir(NodePath.join(codexSkills, "_backup")),
            );
            expect(codexBackups.some((name) => name.startsWith("dup-"))).toBe(true);
            const entry = result.overview.skills.find((candidate) => candidate.name === "dup");
            expect(entry?.hasContentConflict).toBe(false);
            expect(entry?.hasDuplicateCopies).toBe(false);
          }),
        ),
      ),
  );

  it.effect(
    "dedupes safe skills, skips conflicts, backs up links without touching their target, and rejects outside backup paths",
    () =>
      withHost(
        withTempRoot("t3-skills-manage-dedupe-all-", (tempRoot) =>
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const universal = NodePath.join(userHome, ".agents", "skills");
            const claudeSkills = NodePath.join(userHome, ".claude", "skills");
            yield* Effect.promise(() =>
              writeSkill(universal, "alpha", "alpha", "Shared alpha", "# Alpha\n"),
            );
            yield* Effect.promise(() =>
              writeSkill(claudeSkills, "alpha", "alpha", "Shared alpha", "# Alpha\n"),
            );
            yield* Effect.promise(() =>
              writeSkill(universal, "beta", "beta", "Universal beta", "# Beta\n"),
            );
            yield* Effect.promise(() =>
              writeSkill(claudeSkills, "beta", "beta", "Conflicting beta", "# Other beta\n"),
            );
            const providers = [
              makeProvider({
                instanceId: "claudeAgent",
                driver: "claudeAgent",
                displayName: "Claude",
              }),
            ];
            const options = {
              providers,
              settings: DEFAULT_SERVER_SETTINGS,
              stateDir,
              userHome,
              platform: "win32" as const,
            };

            const result = yield* manageSkills({ action: "dedupe_all" }, options);
            expect(result.skippedConflicts).toContain("beta");
            expect(yield* Effect.promise(() => isLink(NodePath.join(claudeSkills, "alpha")))).toBe(
              true,
            );
            const claudeBackups = yield* Effect.promise(() =>
              NodeFSP.readdir(NodePath.join(claudeSkills, "_backup")),
            );
            expect(claudeBackups.some((name) => name.startsWith("alpha-"))).toBe(true);
            expect(yield* Effect.promise(() => isLink(NodePath.join(claudeSkills, "beta")))).toBe(
              false,
            );
            const openBeta = result.overview.skills.find((entry) => entry.name === "beta");
            expect(openBeta?.hasContentConflict).toBe(true);

            const backupMe = yield* Effect.promise(() =>
              writeSkill(universal, "backup-me", "backup-me", "Backup me"),
            );
            yield* manageSkills(
              {
                action: "backup_skill",
                skillName: "backup-me",
                targetPath: backupMe,
              },
              options,
            );
            expect(yield* Effect.promise(() => exists(backupMe))).toBe(false);
            const universalBackups = yield* Effect.promise(() =>
              NodeFSP.readdir(NodePath.join(universal, "_backup")),
            );
            expect(universalBackups.some((name) => name.startsWith("backup-me-"))).toBe(true);

            const linkTarget = yield* Effect.promise(() =>
              writeSkill(universal, "link-target", "link-target", "Keep the real target"),
            );
            const backupLink = NodePath.join(claudeSkills, "backup-link");
            yield* Effect.promise(() => createJunction(backupLink, linkTarget));
            yield* manageSkills(
              {
                action: "backup_skill",
                skillName: "backup-link",
                targetPath: backupLink,
              },
              options,
            );
            expect(yield* Effect.promise(() => exists(backupLink))).toBe(false);
            expect(yield* Effect.promise(() => readSkillFile(linkTarget))).toContain(
              "Keep the real target",
            );

            const outside = yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(tempRoot, "outside"),
                "outside-skill",
                "outside-skill",
                "No",
              ),
            );
            const error = yield* Effect.flip(
              manageSkills(
                {
                  action: "backup_skill",
                  skillName: "outside-skill",
                  targetPath: outside,
                },
                options,
              ),
            );
            expect(error.message).toContain("白名单");
            expect(yield* Effect.promise(() => exists(outside))).toBe(true);
          }),
        ),
      ),
  );

  it.effect(
    "blocks path traversal, profile-root backup, and junction-escape writes; fixes skills.json junctions; and keeps multi-Antigravity dedupe, tilde import, sync skips, and demote cleanup safe",
    () =>
      withHost(
        withTempRoot("t3-skills-manage-hardening-", (tempRoot) =>
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const universal = NodePath.join(userHome, ".agents", "skills");
            const external = NodePath.join(tempRoot, "external");

            const agy1 = makeProvider({
              instanceId: "antigravity",
              driver: "antigravity",
              displayName: "AGY1",
            });
            const agy2 = makeProvider({
              instanceId: "antigravity_2",
              driver: "antigravity",
              displayName: "AGY2",
            });
            const codex = makeProvider({
              instanceId: "codex",
              driver: "codex",
              displayName: "Codex",
            });
            const claude = makeProvider({
              instanceId: "claudeAgent",
              driver: "claudeAgent",
              displayName: "Claude",
            });
            const cursor = makeProvider({
              instanceId: "cursor",
              driver: "cursor",
              displayName: "Cursor",
            });
            const providers = [agy1, agy2, codex, claude, cursor];
            const options = {
              providers,
              settings: DEFAULT_SERVER_SETTINGS,
              stateDir,
              userHome,
              platform: "win32" as const,
            };

            // 1. Path traversal skillName rejected
            const traversalErr = yield* Effect.flip(
              manageSkills(
                {
                  action: "unmount_from_instance",
                  skillName: "../escape",
                  targetInstanceId: ProviderInstanceId.make("codex"),
                },
                options,
              ),
            );
            expect(traversalErr.message).toContain("非法");

            // 2. Profile directory outside config/skills rejected for backup
            const agy1Profile = antigravityProfileDir(stateDir, "antigravity");
            yield* Effect.promise(() =>
              NodeFSP.mkdir(NodePath.join(agy1Profile, "config"), { recursive: true }),
            );
            const profileBackupErr = yield* Effect.flip(
              manageSkills(
                {
                  action: "backup_skill",
                  skillName: "config",
                  targetPath: NodePath.join(agy1Profile, "config"),
                },
                options,
              ),
            );
            expect(profileBackupErr.message).toContain("白名单");

            // 3. Junction escape inside universal pool rejected
            const externalLantu = yield* Effect.promise(() =>
              writeSkill(external, "lantu", "lantu", "External repo skill"),
            );
            yield* Effect.promise(() =>
              writeSkill(externalLantu, "nested", "nested", "Nested outside whitelist"),
            );
            yield* Effect.promise(() =>
              createJunction(NodePath.join(universal, "lantu"), externalLantu),
            );
            const escapeErr = yield* Effect.flip(
              manageSkills(
                {
                  action: "backup_skill",
                  skillName: "nested",
                  targetPath: NodePath.join(universal, "lantu", "nested"),
                },
                options,
              ),
            );
            expect(escapeErr.message).toContain("白名单");

            // 4. fix_instance_warning repairs a Windows Junction discovered via skills.json
            //    without deleting the universal pool junction, and throws on no-op.
            const agy1Manifest = NodePath.join(agy1Profile, "config", "skills.json");
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                agy1Manifest,
                JSON.stringify({ entries: [{ path: forwardPath(universal) }] }),
                "utf8",
              ),
            );
            const fixed = yield* manageSkills(
              {
                action: "fix_instance_warning",
                skillName: "lantu",
                targetInstanceId: ProviderInstanceId.make("antigravity"),
              },
              options,
            );
            expect(
              fixed.overview.skills.find((entry) => entry.name === "lantu")?.cells.antigravity
                ?.status,
            ).toBe("declared_disk");
            expect(yield* Effect.promise(() => isLink(NodePath.join(universal, "lantu")))).toBe(
              true,
            );
            const noopErr = yield* Effect.flip(
              manageSkills(
                {
                  action: "fix_instance_warning",
                  skillName: "lantu",
                  targetInstanceId: ProviderInstanceId.make("antigravity"),
                },
                options,
              ),
            );
            expect(noopErr.message).toContain("没有可自动修复");

            // 5. Multi-Antigravity dedupe updates BOTH instances' skills.json
            const agy2Profile = antigravityProfileDir(stateDir, "antigravity_2");
            yield* Effect.promise(() =>
              NodeFSP.mkdir(NodePath.join(agy2Profile, "config"), { recursive: true }),
            );
            yield* Effect.promise(() =>
              writeSkill(universal, "shared-agy", "shared-agy", "Shared"),
            );
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".gemini", "config", "skills"),
                "shared-agy",
                "shared-agy",
                "Shared",
              ),
            );
            yield* manageSkills({ action: "dedupe_skill", skillName: "shared-agy" }, options);
            const agy1After = yield* Effect.promise(() => readManifest(agy1Manifest));
            const agy2After = yield* Effect.promise(() =>
              readManifest(NodePath.join(agy2Profile, "config", "skills.json")),
            );
            const expectedUniversal = forwardPath(NodePath.join(universal, "shared-agy"));
            expect(agy1After.entries?.map((e) => e.path)).toContain(expectedUniversal);
            expect(agy2After.entries?.map((e) => e.path)).toContain(expectedUniversal);

            // 6. import_skill expands ~/ paths
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, "tilde-src"),
                "tilde-imported",
                "tilde-imported",
                "From tilde path",
              ),
            );
            yield* manageSkills(
              {
                action: "import_skill",
                sourceDirPath: "~/tilde-src/tilde-imported",
                targetScope: "universal",
                mode: "copy",
              },
              options,
            );
            expect(
              yield* Effect.promise(() =>
                readSkillFile(NodePath.join(universal, "tilde-imported")),
              ),
            ).toContain("From tilde path");

            // 7. sync_instances skips already-present skills & universal skills on readsUniversalPool targets
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".claude", "skills"),
                "only-claude",
                "only-claude",
                "Claude exclusive",
              ),
            );
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".cursor", "skills"),
                "only-claude",
                "only-claude",
                "Already on cursor",
              ),
            );
            const syncRes = yield* manageSkills(
              {
                action: "sync_instances",
                sourceInstanceId: ProviderInstanceId.make("claudeAgent"),
                targetInstanceIds: [
                  ProviderInstanceId.make("cursor"),
                  ProviderInstanceId.make("codex"),
                ],
              },
              options,
            );
            expect(syncRes.ok).toBe(true);
            expect(
              yield* Effect.promise(() =>
                isLink(NodePath.join(userHome, ".codex", "skills", "only-claude")),
              ),
            ).toBe(true);

            // 8. demote_to_provider replaces existing link at target and removes dangling links elsewhere
            yield* Effect.promise(() =>
              writeSkill(universal, "demote-linked", "demote-linked", "Demote me"),
            );
            yield* Effect.promise(() =>
              createJunction(
                NodePath.join(userHome, ".claude", "skills", "demote-linked"),
                NodePath.join(universal, "demote-linked"),
              ),
            );
            yield* Effect.promise(() =>
              createJunction(
                NodePath.join(userHome, ".cursor", "skills", "demote-linked"),
                NodePath.join(universal, "demote-linked"),
              ),
            );
            yield* manageSkills(
              {
                action: "demote_to_provider",
                skillName: "demote-linked",
                targetInstanceId: ProviderInstanceId.make("claudeAgent"),
              },
              options,
            );
            expect(
              yield* Effect.promise(() =>
                isLink(NodePath.join(userHome, ".claude", "skills", "demote-linked")),
              ),
            ).toBe(false);
            expect(
              yield* Effect.promise(() =>
                exists(NodePath.join(userHome, ".cursor", "skills", "demote-linked")),
              ),
            ).toBe(false);

            // 9. demote_to_provider also supports demoting a universal pool Junction (like lantu)
            //    without touching the external canonical repo!
            const externalDemoteLink = yield* Effect.promise(() =>
              writeSkill(external, "lantu-demote", "lantu-demote", "External linked skill"),
            );
            const universalLantuLink = NodePath.join(universal, "lantu-demote");
            yield* Effect.promise(() => createJunction(universalLantuLink, externalDemoteLink));
            const demotedLinkRes = yield* manageSkills(
              {
                action: "demote_to_provider",
                skillName: "lantu-demote",
                targetInstanceId: ProviderInstanceId.make("claudeAgent"),
              },
              options,
            );
            expect(demotedLinkRes.ok).toBe(true);
            expect(yield* Effect.promise(() => exists(universalLantuLink))).toBe(false);
            expect(yield* Effect.promise(() => exists(externalDemoteLink))).toBe(true);
            expect(
              yield* Effect.promise(() =>
                isLink(NodePath.join(userHome, ".claude", "skills", "lantu-demote")),
              ),
            ).toBe(true);
            expect(
              demotedLinkRes.overview.skills.find((entry) => entry.name === "lantu-demote")?.scope,
            ).toBe("agent_global");
          }),
        ),
      ),
  );
});

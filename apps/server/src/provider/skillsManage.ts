// @effect-diagnostics-next-line nodeBuiltinImport:off -- Skill management is inherently a filesystem service.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure path normalization inside the filesystem service.
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type ServerGetSkillsOverviewResult,
  type ServerManageSkillsInput,
  type ServerManageSkillsResult,
  type ServerProvider,
  type ServerSettings,
  SkillsOverviewError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  buildSkillsOverview,
  type BuildSkillsOverviewInput,
  computeSkillContentHash,
  expandHome,
  type InstanceSkillSpec,
  isIgnoredSkillDirName,
  parseSkillFrontmatter,
  resolveInstanceSkillSpec,
} from "./skillsOverview.ts";

const isSkillsOverviewError = Schema.is(SkillsOverviewError);
const manageSkillsSemaphore = Semaphore.makeUnsafe(1);

interface ManageContext {
  readonly overview: ServerGetSkillsOverviewResult;
  readonly overviewInput: BuildSkillsOverviewInput;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
  readonly stateDir: string;
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
  readonly universalPoolDir: string;
  readonly specs: ReadonlyArray<InstanceSkillSpec>;
  readonly specsById: ReadonlyMap<string, InstanceSkillSpec>;
  readonly allowedWriteRoots: ReadonlyArray<string>;
  readonly allowedManifestPaths: ReadonlySet<string>;
}

interface ManageOutcome {
  readonly summary: string;
  readonly affectedPaths: ReadonlyArray<string>;
  readonly skippedConflicts?: ReadonlyArray<string>;
}

interface SkillMetadata {
  readonly content: string;
  readonly contentHash: string;
  readonly name?: string;
  readonly description?: string;
  readonly hasValidFrontmatter: boolean;
}

interface DedupeRoot {
  readonly spec: InstanceSkillSpec;
  readonly root: string;
  readonly backupRoot: string;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function skillsError(message: string): SkillsOverviewError {
  return new SkillsOverviewError({ message });
}

function normalizeKey(platform: NodeJS.Platform, targetPath: string): string {
  const resolved = NodePath.resolve(targetPath);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function pathIsWithin(platform: NodeJS.Platform, rootPath: string, candidatePath: string): boolean {
  const root = normalizeKey(platform, rootPath);
  const candidate = normalizeKey(platform, candidatePath);
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

function assertSafeSkillName(skillName: string): string {
  const trimmed = skillName.trim();
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.toLowerCase() === "_backup" ||
    /[\\/:\0]/u.test(trimmed) ||
    NodePath.basename(trimmed) !== trimmed
  ) {
    throw skillsError(`非法的技能名称：${skillName}`);
  }
  return trimmed;
}

function assertWritable(
  context: ManageContext,
  targetPath: string,
  description = "目标路径",
): string {
  const resolved = NodePath.resolve(targetPath);
  if (!context.allowedWriteRoots.some((root) => pathIsWithin(context.platform, root, resolved))) {
    throw skillsError(`拒绝越界操作：${description} ${resolved} 不在允许的技能根目录白名单内`);
  }
  return resolved;
}

async function assertWritableAncestorRealpath(
  context: ManageContext,
  targetPath: string,
  description = "目标路径",
): Promise<string> {
  const resolved = assertWritable(context, targetPath, description);
  const matchedRoots = context.allowedWriteRoots.filter((root) =>
    pathIsWithin(context.platform, root, resolved),
  );
  const allowedRealRoots = await Promise.all(
    context.allowedWriteRoots.map((root) => realpathOrResolved(root)),
  );
  const checkWithinAllowed = (realCandidate: string) => {
    if (!allowedRealRoots.some((root) => pathIsWithin(context.platform, root, realCandidate))) {
      throw skillsError(
        `拒绝软链穿透写入：${description} 的真实目录 ${realCandidate} 超出白名单范围`,
      );
    }
  };

  for (const matchedRoot of matchedRoots) {
    // Check existing ancestors from dirname(resolved) up to matchedRoot (inclusive).
    // Once we step above matchedRoot, the managed root does not exist yet so no symlink inside it can escape.
    let cursor = NodePath.dirname(resolved);
    while (pathIsWithin(context.platform, matchedRoot, cursor)) {
      try {
        const realAncestor = await NodeFSP.realpath(cursor);
        checkWithinAllowed(realAncestor);
        return resolved;
      } catch (error) {
        if (isSkillsOverviewError(error)) throw error;
        const parent = NodePath.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
    }
    // If resolved itself is the matchedRoot and already exists, verify its realpath too.
    if (normalizeKey(context.platform, resolved) === normalizeKey(context.platform, matchedRoot)) {
      try {
        const realSelf = await NodeFSP.realpath(resolved);
        checkWithinAllowed(realSelf);
      } catch (error) {
        if (isSkillsOverviewError(error)) throw error;
      }
    }
  }
  return resolved;
}

function assertAllowedManifest(context: ManageContext, manifestPath: string): string {
  const resolved = NodePath.resolve(manifestPath);
  if (!context.allowedManifestPaths.has(normalizeKey(context.platform, resolved))) {
    throw skillsError(`拒绝越界操作：skills.json ${resolved} 不在允许的实例清单白名单内`);
  }
  return resolved;
}

function assertNotManagedRoot(context: ManageContext, targetPath: string): void {
  const key = normalizeKey(context.platform, targetPath);
  if (context.allowedWriteRoots.some((root) => normalizeKey(context.platform, root) === key)) {
    throw skillsError(`拒绝将技能根目录本身作为操作对象：${targetPath}`);
  }
}

function pathHasBackupSegment(targetPath: string): boolean {
  return NodePath.resolve(targetPath)
    .split(/[\\/]+/u)
    .some((segment) => segment.toLowerCase() === "_backup");
}

function forwardSlashPath(targetPath: string): string {
  return NodePath.resolve(targetPath).replace(/\\/g, "/");
}

function stripWindowsLinkPrefix(rawTarget: string): string {
  if (rawTarget.startsWith("\\\\?\\")) return rawTarget.slice(4);
  if (rawTarget.startsWith("\\??\\")) return rawTarget.slice(4);
  return rawTarget;
}

async function lstatOrUndefined(targetPath: string) {
  try {
    return await NodeFSP.lstat(targetPath);
  } catch {
    return undefined;
  }
}

async function statOrUndefined(targetPath: string) {
  try {
    return await NodeFSP.stat(targetPath);
  } catch {
    return undefined;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  return (await lstatOrUndefined(targetPath)) !== undefined;
}

async function isDirectoryPath(targetPath: string): Promise<boolean> {
  return (await statOrUndefined(targetPath))?.isDirectory() === true;
}

async function isLinkPath(targetPath: string): Promise<boolean> {
  return (await lstatOrUndefined(targetPath))?.isSymbolicLink() === true;
}

async function readSkillMetadata(dirPath: string): Promise<SkillMetadata> {
  const content = await NodeFSP.readFile(NodePath.join(dirPath, "SKILL.md"), "utf8");
  const parsed = parseSkillFrontmatter(content);
  return {
    content,
    contentHash: computeSkillContentHash(content),
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.description !== undefined ? { description: parsed.description } : {}),
    hasValidFrontmatter: parsed.hasValidFrontmatter,
  };
}

async function hashSkillDirectory(dirPath: string): Promise<string | undefined> {
  try {
    return (await readSkillMetadata(dirPath)).contentHash;
  } catch {
    return undefined;
  }
}

async function skillDirectoryExists(dirPath: string): Promise<boolean> {
  if (!(await isDirectoryPath(dirPath))) return false;
  return pathExists(NodePath.join(dirPath, "SKILL.md"));
}

function asSkillDirectory(inputPath: string, userHome: string): string {
  const resolved = NodePath.resolve(expandHome(inputPath, userHome));
  return NodePath.basename(resolved).toLowerCase() === "skill.md"
    ? NodePath.dirname(resolved)
    : resolved;
}

async function requireSkillDirectory(dirPath: string, description: string): Promise<string> {
  if (!(await isDirectoryPath(dirPath))) {
    throw skillsError(`${description}不是目录：${dirPath}`);
  }
  const metadataPath = NodePath.join(dirPath, "SKILL.md");
  if (!(await pathExists(metadataPath))) {
    throw skillsError(`${description}缺少 SKILL.md：${dirPath}`);
  }
  return dirPath;
}

async function copySkillDirectory(sourceDir: string, destinationDir: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(destinationDir), { recursive: true });
  await NodeFSP.cp(sourceDir, destinationDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
}

async function moveEntity(sourceDir: string, destinationDir: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(destinationDir), { recursive: true });
  try {
    await NodeFSP.rename(sourceDir, destinationDir);
    return;
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : "";
    if (code !== "EXDEV") throw error;
  }
  await copySkillDirectory(sourceDir, destinationDir);
  await NodeFSP.rm(sourceDir, { recursive: true, force: true });
}

async function removeLink(linkPath: string): Promise<void> {
  try {
    await NodeFSP.unlink(linkPath);
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? String((error as { readonly code?: unknown }).code)
        : "";
    if (code !== "EPERM" && code !== "EISDIR") throw error;
    await NodeFSP.rmdir(linkPath);
  }
}

async function createDirectoryLink(
  context: ManageContext,
  linkPath: string,
  targetPath: string,
): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(linkPath), { recursive: true });
  await NodeFSP.symlink(
    NodePath.resolve(targetPath),
    linkPath,
    context.platform === "win32" ? "junction" : "dir",
  );
}

async function readLinkDestination(linkPath: string): Promise<string> {
  const rawTarget = await NodeFSP.readlink(linkPath);
  const absolute = NodePath.resolve(NodePath.dirname(linkPath), stripWindowsLinkPrefix(rawTarget));
  try {
    return await NodeFSP.realpath(absolute);
  } catch {
    return absolute;
  }
}

async function realpathOrResolved(targetPath: string): Promise<string> {
  try {
    return await NodeFSP.realpath(targetPath);
  } catch {
    return NodePath.resolve(targetPath);
  }
}

function timestampSuffix(): string {
  // @effect-diagnostics-next-line globalDate:off -- Backup directory names need a human-readable wall-clock suffix.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function uniqueBackupPath(rootDir: string, name: string): Promise<string> {
  const backupDir = NodePath.join(rootDir, "_backup");
  const baseName = `${name}-${timestampSuffix()}`;
  let candidate = NodePath.join(backupDir, baseName);
  let counter = 2;
  while (await pathExists(candidate)) {
    candidate = NodePath.join(backupDir, `${baseName}-${counter}`);
    counter += 1;
  }
  return candidate;
}

async function backupEntity(
  context: ManageContext,
  sourcePath: string,
  backupRoot: string,
): Promise<string> {
  await assertWritableAncestorRealpath(context, sourcePath, "备份来源");
  await assertWritableAncestorRealpath(context, backupRoot, "备份根目录");
  assertNotManagedRoot(context, sourcePath);
  const destination = await uniqueBackupPath(backupRoot, NodePath.basename(sourcePath));
  await assertWritableAncestorRealpath(context, destination, "备份目标");
  await moveEntity(sourcePath, destination);
  return destination;
}

async function removeSkillLocation(
  context: ManageContext,
  targetPath: string,
  backupRoot: string,
  linkOnly: boolean,
): Promise<{ readonly removedPath: string; readonly backupPath?: string }> {
  await assertWritableAncestorRealpath(context, targetPath);
  if (await isLinkPath(targetPath)) {
    await removeLink(targetPath);
    return { removedPath: targetPath };
  }
  if (linkOnly) {
    throw skillsError(`目标不是联接，拒绝仅删除联接：${targetPath}`);
  }
  const backupPath = await backupEntity(context, targetPath, backupRoot);
  return { removedPath: targetPath, backupPath };
}

async function findSkillDirectoryInRoot(
  rootDir: string,
  skillName: string,
): Promise<string | undefined> {
  const directPath = NodePath.join(rootDir, skillName);
  if (await skillDirectoryExists(directPath)) return directPath;

  let entries: ReadonlyArray<string>;
  try {
    entries = await NodeFSP.readdir(rootDir);
  } catch {
    return undefined;
  }
  for (const entryName of entries) {
    if (isIgnoredSkillDirName(entryName)) {
      continue;
    }
    const candidate = NodePath.join(rootDir, entryName);
    if (!(await skillDirectoryExists(candidate))) continue;
    try {
      const metadata = await readSkillMetadata(candidate);
      if (metadata.name === skillName || entryName === skillName) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function listSkillDirectories(rootDir: string): Promise<ReadonlyArray<string>> {
  let entries: ReadonlyArray<string>;
  try {
    entries = await NodeFSP.readdir(rootDir);
  } catch {
    return [];
  }
  const results: Array<string> = [];
  for (const entryName of entries) {
    if (isIgnoredSkillDirName(entryName)) {
      continue;
    }
    const candidate = NodePath.join(rootDir, entryName);
    if (await skillDirectoryExists(candidate)) results.push(candidate);
  }
  return results;
}

interface RawManifestEntry {
  readonly path: string;
  readonly [key: string]: unknown;
}

interface RawManifest {
  readonly entries?: ReadonlyArray<RawManifestEntry>;
  readonly [key: string]: unknown;
}

async function readManifestFile(manifestPath: string): Promise<RawManifest> {
  let raw: string;
  try {
    raw = await NodeFSP.readFile(manifestPath, "utf8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw skillsError(`skills.json 不是合法 JSON：${manifestPath}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw skillsError(`skills.json 顶层必须是对象：${manifestPath}`);
  }
  const record = parsed as Record<string, unknown>;
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  const entries = rawEntries.flatMap((entry): ReadonlyArray<RawManifestEntry> => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const path = (entry as { readonly path?: unknown }).path;
    return typeof path === "string" ? [{ ...(entry as Record<string, unknown>), path }] : [];
  });
  return { ...record, entries };
}

async function writeManifestFile(
  context: ManageContext,
  manifestPath: string,
  manifest: RawManifest,
): Promise<void> {
  const resolved = assertAllowedManifest(context, manifestPath);
  const parentDir = NodePath.dirname(resolved);
  await NodeFSP.mkdir(parentDir, { recursive: true });
  // On macOS/Linux, prepareAntigravityProfile symlinks <profileDir>/config/skills.json to
  // ~/.gemini/config/skills.json. Break the symlink (copy-on-write) before writing so a
  // per-instance edit never mutates the shared global manifest.
  if (await isLinkPath(resolved)) {
    await removeLink(resolved);
  }
  // @effect-diagnostics-next-line globalDate:off -- Unique temp filename for atomic manifest replace.
  const tempPath = NodePath.join(parentDir, `.skills.json.${process.pid}.${Date.now()}.tmp`);
  await NodeFSP.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  try {
    await NodeFSP.rename(tempPath, resolved);
  } catch (error) {
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function manifestEntryResolvedPath(context: ManageContext, rawPath: string): string {
  return NodePath.resolve(expandHome(rawPath, context.userHome));
}

async function addManifestPaths(
  context: ManageContext,
  manifestPath: string,
  pathsToAdd: ReadonlyArray<string>,
): Promise<{ readonly changed: boolean; readonly entries: ReadonlyArray<RawManifestEntry> }> {
  assertAllowedManifest(context, manifestPath);
  const manifest = await readManifestFile(manifestPath);
  const entries = [...(manifest.entries ?? [])];
  const existingKeys = new Set(
    entries.map((entry) =>
      normalizeKey(context.platform, manifestEntryResolvedPath(context, entry.path)),
    ),
  );
  let changed = false;
  for (const pathToAdd of pathsToAdd) {
    const resolved = NodePath.resolve(pathToAdd);
    const key = normalizeKey(context.platform, resolved);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);
    entries.push({ path: forwardSlashPath(resolved) });
    changed = true;
  }
  if (changed) {
    await writeManifestFile(context, manifestPath, { ...manifest, entries });
  }
  return { changed, entries };
}

async function countSkillDirectories(parentDir: string): Promise<number> {
  if (await pathExists(NodePath.join(parentDir, "SKILL.md"))) return 1;
  let entries: ReadonlyArray<string>;
  try {
    entries = await NodeFSP.readdir(parentDir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const entryName of entries) {
    if (isIgnoredSkillDirName(entryName)) continue;
    if (await pathExists(NodePath.join(parentDir, entryName, "SKILL.md"))) count += 1;
  }
  return count;
}

async function removeManifestSkillEntry(
  context: ManageContext,
  manifestPath: string,
  skillName: string,
): Promise<{ readonly changed: boolean; readonly removed: ReadonlyArray<string> }> {
  const manifest = await readManifestFile(manifestPath);
  const kept: Array<RawManifestEntry> = [];
  const removed: Array<string> = [];
  for (const entry of manifest.entries ?? []) {
    const resolvedDir = manifestEntryResolvedPath(context, entry.path);
    let directSkill = false;
    if (await pathExists(NodePath.join(resolvedDir, "SKILL.md"))) {
      const metadata = await readSkillMetadata(resolvedDir).catch(() => undefined);
      directSkill = NodePath.basename(resolvedDir) === skillName || metadata?.name === skillName;
    }
    const childSkill =
      !directSkill && (await findSkillDirectoryInRoot(resolvedDir, skillName)) !== undefined;
    if (!directSkill && !childSkill) {
      kept.push(entry);
      continue;
    }
    const skillCount = await countSkillDirectories(resolvedDir);
    if (skillCount > 1) {
      throw skillsError(
        `拒绝移除 Antigravity 共享父目录条目：${entry.path} 下包含 ${skillCount} 个技能，移除会误删其他技能`,
      );
    }
    removed.push(entry.path);
  }
  if (removed.length > 0) {
    const updated: RawManifest = { ...manifest, entries: kept };
    await writeManifestFile(context, manifestPath, updated);
  }
  return { changed: removed.length > 0, removed };
}

async function resolveSkillSourceDirectory(
  context: ManageContext,
  skillName: string,
  sourcePath?: string,
): Promise<string> {
  if (sourcePath !== undefined) {
    const resolved = asSkillDirectory(sourcePath, context.userHome);
    return requireSkillDirectory(resolved, "源技能目录");
  }

  const universalCandidate = await findSkillDirectoryInRoot(context.universalPoolDir, skillName);
  if (universalCandidate !== undefined) return universalCandidate;

  const entry = context.overview.skills.find((skill) => skill.name === skillName);
  const orderedLocations = [...(entry?.locations ?? [])].toSorted((left, right) => {
    const leftRank = left.layer === "universal" ? 0 : left.isLink ? 2 : 1;
    const rightRank = right.layer === "universal" ? 0 : right.isLink ? 2 : 1;
    return leftRank - rightRank;
  });
  for (const location of orderedLocations) {
    if (await skillDirectoryExists(location.path)) return location.path;
  }
  if (entry?.canonicalPath !== undefined) {
    const canonical = asSkillDirectory(entry.canonicalPath, context.userHome);
    if (await skillDirectoryExists(canonical)) return canonical;
  }
  throw skillsError(`未找到技能 ${skillName} 的源目录`);
}

function requireSpec(context: ManageContext, instanceId: string): InstanceSkillSpec {
  const spec = context.specsById.get(instanceId);
  if (spec === undefined) throw skillsError(`未找到供应商实例 ${instanceId}`);
  return spec;
}

function requireAntigravitySpec(spec: InstanceSkillSpec): {
  readonly profileDir: string;
  readonly manifestPath: string;
} {
  if (
    spec.driver !== "antigravity" ||
    spec.profileDir === undefined ||
    spec.manifestPath === undefined
  ) {
    throw skillsError(`实例 ${spec.instanceId} 不是具有 profile 清单的 Antigravity 实例`);
  }
  return { profileDir: spec.profileDir, manifestPath: spec.manifestPath };
}

async function mountSkill(
  context: ManageContext,
  input: {
    readonly skillName: string;
    readonly sourcePath?: string;
    readonly targetInstanceId: string;
    readonly mode: "link" | "copy";
  },
): Promise<ManageOutcome> {
  const targetSpec = requireSpec(context, input.targetInstanceId);
  const sourceDir = await resolveSkillSourceDirectory(context, input.skillName, input.sourcePath);
  await requireSkillDirectory(sourceDir, "源技能目录");
  const realSourceDir = await NodeFSP.realpath(sourceDir);

  if (targetSpec.driver === "antigravity") {
    const { manifestPath } = requireAntigravitySpec(targetSpec);
    // Antigravity skills.json supports registering a single skill directory directly (containing SKILL.md),
    // which avoids dragging sibling skills from a shared parent directory and allows clean unmounting.
    const manifest = await addManifestPaths(context, manifestPath, [realSourceDir]);
    return {
      summary: `已将 ${input.skillName} 注册到 Antigravity skills.json`,
      affectedPaths: manifest.changed ? [manifestPath, realSourceDir] : [manifestPath],
    };
  }

  const destination = NodePath.join(
    targetSpec.writableGlobalSkillDir,
    NodePath.basename(sourceDir),
  );
  await assertWritableAncestorRealpath(context, destination, "挂载目标");
  if (await pathExists(destination)) {
    if (
      (await isLinkPath(destination)) &&
      normalizeKey(context.platform, await realpathOrResolved(destination)) ===
        normalizeKey(context.platform, await realpathOrResolved(realSourceDir))
    ) {
      return {
        summary: `${input.skillName} 已挂载到 ${targetSpec.displayName}`,
        affectedPaths: [destination],
      };
    }
    throw skillsError(`挂载目标已存在，拒绝覆盖：${destination}`);
  }
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  if (input.mode === "copy") {
    await copySkillDirectory(realSourceDir, destination);
  } else {
    await createDirectoryLink(context, destination, realSourceDir);
  }
  return {
    summary: `已将 ${input.skillName} ${input.mode === "copy" ? "复制" : "联接"}到 ${targetSpec.displayName}`,
    affectedPaths: [destination],
  };
}

async function isAntigravityProfileSkillsShared(
  context: ManageContext,
  profileDir: string,
  writableGlobalSkillDir: string,
): Promise<boolean> {
  const profileSkillsDir = NodePath.join(profileDir, "config", "skills");
  if (!(await isLinkPath(profileSkillsDir))) return false;
  const target = await realpathOrResolved(profileSkillsDir);
  const shared = await realpathOrResolved(writableGlobalSkillDir);
  return normalizeKey(context.platform, target) === normalizeKey(context.platform, shared);
}

async function unmountSkill(
  context: ManageContext,
  skillName: string,
  targetInstanceId: string,
): Promise<ManageOutcome> {
  const targetSpec = requireSpec(context, targetInstanceId);
  if (targetSpec.driver === "antigravity") {
    const { profileDir, manifestPath } = requireAntigravitySpec(targetSpec);
    const manifestResult = await removeManifestSkillEntry(context, manifestPath, skillName);
    const profileSkillsDir = NodePath.join(profileDir, "config", "skills");
    const profileSkillsShared = await isAntigravityProfileSkillsShared(
      context,
      profileDir,
      targetSpec.writableGlobalSkillDir,
    );
    let removedLinkPath: string | undefined;
    if (!profileSkillsShared) {
      const linkPath = await assertWritableAncestorRealpath(
        context,
        NodePath.join(profileSkillsDir, skillName),
        "Antigravity 联接",
      );
      if (await isLinkPath(linkPath)) {
        await removeLink(linkPath);
        removedLinkPath = linkPath;
      }
    }
    if (removedLinkPath === undefined && !manifestResult.changed) {
      throw skillsError(
        profileSkillsShared
          ? `Antigravity 实例 ${targetSpec.displayName} 未在私有 skills.json 中挂载 ${skillName}（共享 ~/.gemini/config/skills 目录请使用「移入回收备份」或「去重」）`
          : `Antigravity 实例 ${targetSpec.displayName} 未挂载技能 ${skillName}`,
      );
    }
    return {
      summary: `已从 Antigravity 实例 ${targetSpec.displayName} 卸载 ${skillName}`,
      affectedPaths: [
        ...(removedLinkPath !== undefined ? [removedLinkPath] : []),
        ...(manifestResult.changed ? [manifestPath] : []),
      ],
    };
  }

  const candidateRoots = dedupeRootsForSpec(context, targetSpec).filter(
    (entry) =>
      normalizeKey(context.platform, entry.root) !==
      normalizeKey(context.platform, context.universalPoolDir),
  );
  for (const candidateRoot of candidateRoots) {
    const rootDir = await assertWritableAncestorRealpath(
      context,
      candidateRoot.root,
      "供应商技能目录",
    );
    const skillPath = await findSkillDirectoryInRoot(rootDir, skillName);
    if (skillPath === undefined) continue;
    assertNotManagedRoot(context, skillPath);
    const result = await removeSkillLocation(context, skillPath, candidateRoot.backupRoot, false);
    return {
      summary: `已从 ${targetSpec.displayName} 卸载 ${skillName}`,
      affectedPaths: [
        result.removedPath,
        ...(result.backupPath === undefined ? [] : [result.backupPath]),
      ],
    };
  }
  throw skillsError(`实例 ${targetSpec.displayName} 未找到技能 ${skillName}`);
}

async function fixInstanceWarning(
  context: ManageContext,
  skillName: string,
  targetInstanceId: string,
): Promise<ManageOutcome> {
  const targetSpec = requireSpec(context, targetInstanceId);
  const { profileDir, manifestPath } = requireAntigravitySpec(targetSpec);
  assertAllowedManifest(context, manifestPath);
  const manifest = await readManifestFile(manifestPath);
  const rawEntries = manifest.entries ?? [];
  const entries: Array<RawManifestEntry> = [];
  const entryKeys = new Set<string>();
  let manifestChanged = false;

  for (const entry of rawEntries) {
    const trimmed = entry.path.trim();
    const isTilde = trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\");
    const nextPath = isTilde ? forwardSlashPath(expandHome(trimmed, context.userHome)) : entry.path;
    const key = normalizeKey(context.platform, manifestEntryResolvedPath(context, nextPath));
    if (entryKeys.has(key)) {
      manifestChanged = true;
      continue;
    }
    entryKeys.add(key);
    if (isTilde && nextPath !== entry.path) {
      manifestChanged = true;
      entries.push({ ...entry, path: nextPath });
    } else {
      entries.push(entry);
    }
  }

  const profileSkillsShared = await isAntigravityProfileSkillsShared(
    context,
    profileDir,
    targetSpec.writableGlobalSkillDir,
  );
  const profileLinkPath = NodePath.join(profileDir, "config", "skills", skillName);
  const affectedPaths: Array<string> = [];
  let linkToRemove: string | undefined;

  if (await isLinkPath(profileLinkPath)) {
    const target = await readLinkDestination(profileLinkPath);
    const targetKey = normalizeKey(context.platform, target);
    if (!entryKeys.has(targetKey)) {
      entries.push({ path: forwardSlashPath(target) });
      entryKeys.add(targetKey);
      manifestChanged = true;
    }
    // Only delete the link inside profileDir/config/skills if it is private to this instance.
    // When linked to shared ~/.gemini/config/skills, registering the real target in skills.json
    // already supersedes the warning without touching sibling Antigravity instances.
    if (!profileSkillsShared) {
      await assertWritableAncestorRealpath(context, profileLinkPath, "Antigravity 联接");
      linkToRemove = profileLinkPath;
    }
  }

  // Also inspect the current overview cell: a Windows Junction inside ~/.agents/skills or
  // ~/.gemini/config/skills discovered via skills.json must be fixed by registering its real
  // target directory directly in skills.json (never deleting the universal pool junction).
  const currentCell = context.overview.skills.find((entry) => entry.name === skillName)?.cells[
    targetInstanceId
  ];
  if (currentCell?.linkTarget !== undefined && currentCell.path !== undefined) {
    const cellSkillDir = asSkillDirectory(currentCell.path, context.userHome);
    const realTarget = await realpathOrResolved(cellSkillDir);
    if (await skillDirectoryExists(realTarget)) {
      const targetKey = normalizeKey(context.platform, realTarget);
      if (!entryKeys.has(targetKey)) {
        entries.push({ path: forwardSlashPath(realTarget) });
        entryKeys.add(targetKey);
        manifestChanged = true;
      }
    }
  }

  if (manifestChanged) {
    await writeManifestFile(context, manifestPath, { ...manifest, entries });
    affectedPaths.push(manifestPath);
  }
  if (linkToRemove !== undefined) {
    await removeLink(linkToRemove);
    affectedPaths.push(linkToRemove);
  }

  if (affectedPaths.length === 0) {
    throw skillsError(
      `Antigravity 实例 ${targetSpec.displayName} 的技能 ${skillName} 没有可自动修复的 ~/ 路径或联接异常`,
    );
  }

  return {
    summary: `已修复 Antigravity 实例 ${targetSpec.displayName} 的技能 ${skillName} 路径与联接`,
    affectedPaths: [...new Set(affectedPaths)],
  };
}

async function linkUniversalPool(
  context: ManageContext,
  targetInstanceId: string,
): Promise<ManageOutcome> {
  const targetSpec = requireSpec(context, targetInstanceId);
  if (targetSpec.isFactoryDroid && targetSpec.factoryHomeOverride !== undefined) {
    const linkPath = await assertWritableAncestorRealpath(
      context,
      NodePath.join(targetSpec.factoryHomeOverride, ".agents", "skills"),
      "Factory 隔离实例全局池联接",
    );
    await NodeFSP.mkdir(context.universalPoolDir, { recursive: true });
    if (await pathExists(linkPath)) {
      if (
        (await isLinkPath(linkPath)) &&
        normalizeKey(context.platform, await realpathOrResolved(linkPath)) ===
          normalizeKey(context.platform, await realpathOrResolved(context.universalPoolDir))
      ) {
        return {
          summary: `Factory 隔离实例 ${targetSpec.displayName} 已联接真全局池`,
          affectedPaths: [linkPath],
        };
      }
      throw skillsError(`Factory 隔离实例的 .agents/skills 已存在且不是全局池联接：${linkPath}`);
    }
    await NodeFSP.mkdir(NodePath.dirname(linkPath), { recursive: true });
    await createDirectoryLink(context, linkPath, context.universalPoolDir);
    return {
      summary: `已将 Factory 隔离实例 ${targetSpec.displayName} 的 .agents/skills 联接到真全局池`,
      affectedPaths: [linkPath],
    };
  }

  if (targetSpec.driver === "antigravity") {
    const { manifestPath } = requireAntigravitySpec(targetSpec);
    const pathsToAdd: Array<string> = [context.universalPoolDir];
    let entries: ReadonlyArray<string>;
    try {
      entries = await NodeFSP.readdir(context.universalPoolDir);
    } catch {
      entries = [];
    }
    for (const entryName of entries) {
      if (isIgnoredSkillDirName(entryName)) continue;
      const entryPath = NodePath.join(context.universalPoolDir, entryName);
      if (!(await isLinkPath(entryPath))) continue;
      const target = await readLinkDestination(entryPath);
      if (await skillDirectoryExists(target)) {
        pathsToAdd.push(target);
      }
    }
    await addManifestPaths(context, manifestPath, pathsToAdd);
    return {
      summary: `已把真全局池及联接技能的真实目录写入 Antigravity ${targetSpec.displayName} 的 skills.json`,
      affectedPaths: [manifestPath],
    };
  }

  if (targetSpec.readsUniversalPool) {
    return {
      summary: `${targetSpec.displayName} 已自动读取真全局池，无需挂载`,
      affectedPaths: [],
    };
  }

  const writableRoot = await assertWritableAncestorRealpath(
    context,
    targetSpec.writableGlobalSkillDir,
    "供应商技能目录",
  );
  if (
    normalizeKey(context.platform, writableRoot) ===
    normalizeKey(context.platform, context.universalPoolDir)
  ) {
    return {
      summary: `${targetSpec.displayName} 的全局目录就是真全局池`,
      affectedPaths: [],
    };
  }
  const affectedPaths: Array<string> = [];
  for (const skillDir of await listSkillDirectories(context.universalPoolDir)) {
    const entryName = NodePath.basename(skillDir);
    const destination = NodePath.join(writableRoot, entryName);
    if (await pathExists(destination)) continue;
    await assertWritableAncestorRealpath(context, destination, "技能挂载目标");
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await createDirectoryLink(context, destination, skillDir);
    affectedPaths.push(destination);
  }
  return {
    summary: `已将真全局池技能挂载到 ${targetSpec.displayName}`,
    affectedPaths,
  };
}

async function syncInstances(
  context: ManageContext,
  request: Extract<ServerManageSkillsInput, { readonly action: "sync_instances" }>,
): Promise<ManageOutcome> {
  if (request.targetInstanceIds.length === 0) {
    throw skillsError("sync_instances 至少需要一个目标实例");
  }
  const targets = [...new Set(request.targetInstanceIds.map((instanceId) => String(instanceId)))];
  for (const target of targets) requireSpec(context, target);

  const skillsToMount: Array<{
    readonly name: string;
    readonly sourcePath: string;
    readonly scope?: "universal" | "agent_global" | "builtin";
  }> = [];
  if (request.skillNames !== undefined && request.skillNames.length > 0) {
    for (const rawSkillName of request.skillNames) {
      const skillName = assertSafeSkillName(rawSkillName);
      const sourceInstanceId =
        request.sourceInstanceId === undefined ? undefined : String(request.sourceInstanceId);
      const entry = context.overview.skills.find((skill) => skill.name === skillName);
      const source = await resolveSkillSourceDirectory(
        context,
        skillName,
        sourceInstanceId === undefined
          ? undefined
          : sourcePathFromInstance(context, sourceInstanceId, skillName),
      );
      skillsToMount.push({
        name: skillName,
        sourcePath: source,
        ...(entry === undefined ? {} : { scope: entry.scope }),
      });
    }
  } else {
    if (request.sourceInstanceId === undefined) {
      throw skillsError("sync_instances 未提供 skillNames 时必须提供 sourceInstanceId");
    }
    const sourceInstanceId = String(request.sourceInstanceId);
    requireSpec(context, sourceInstanceId);
    for (const entry of context.overview.skills) {
      if (entry.scope === "builtin") continue;
      const cell = entry.cells[sourceInstanceId];
      if (
        (cell?.status !== "declared_disk" && cell?.status !== "declared_runtime") ||
        cell.path === undefined
      ) {
        continue;
      }
      skillsToMount.push({
        name: entry.name,
        sourcePath: asSkillDirectory(cell.path, context.userHome),
        scope: entry.scope,
      });
    }
  }

  const affectedPaths: Array<string> = [];
  let mountedCount = 0;
  let skippedCount = 0;
  for (const target of targets) {
    if (target === String(request.sourceInstanceId)) continue;
    const targetSpec = requireSpec(context, target);
    for (const skill of skillsToMount) {
      if (skill.scope === "universal" && targetSpec.readsUniversalPool) {
        skippedCount += 1;
        continue;
      }
      const existingCell = context.overview.skills.find((entry) => entry.name === skill.name)
        ?.cells[target];
      if (existingCell?.status === "declared_disk" || existingCell?.status === "declared_runtime") {
        skippedCount += 1;
        continue;
      }
      if (targetSpec.driver !== "antigravity") {
        const destination = NodePath.join(
          targetSpec.writableGlobalSkillDir,
          NodePath.basename(skill.sourcePath),
        );
        if (await pathExists(destination)) {
          skippedCount += 1;
          continue;
        }
      }
      const outcome = await mountSkill(context, {
        skillName: skill.name,
        sourcePath: skill.sourcePath,
        targetInstanceId: target,
        mode: request.mode ?? "link",
      });
      affectedPaths.push(...outcome.affectedPaths);
      mountedCount += 1;
    }
  }
  return {
    summary:
      skippedCount > 0
        ? `已同步 ${mountedCount} 项到 ${targets.length} 个实例（跳过 ${skippedCount} 项已就绪技能）`
        : `已同步 ${mountedCount} 项到 ${targets.length} 个实例`,
    affectedPaths: [...new Set(affectedPaths)],
  };
}

function sourcePathFromInstance(
  context: ManageContext,
  instanceId: string,
  skillName: string,
): string | undefined {
  const cell = context.overview.skills.find((entry) => entry.name === skillName)?.cells[instanceId];
  if (
    (cell?.status !== "declared_disk" && cell?.status !== "declared_runtime") ||
    cell.path === undefined
  ) {
    return undefined;
  }
  return asSkillDirectory(cell.path, context.userHome);
}

function owningSpecForPath(
  context: ManageContext,
  targetPath: string,
): InstanceSkillSpec | undefined {
  const ranked = context.specs.flatMap((spec) => {
    const matched = spec.dirs.filter((dir) => pathIsWithin(context.platform, dir, targetPath));
    if (matched.length === 0) return [];
    return [{ spec, specificity: Math.max(...matched.map((dir) => dir.length)) }];
  });
  return ranked.toSorted((left, right) => right.specificity - left.specificity)[0]?.spec;
}

async function antigravitySpecsSharingDir(
  context: ManageContext,
  dirPath: string,
): Promise<ReadonlyArray<InstanceSkillSpec>> {
  const targetRealKey = normalizeKey(context.platform, await realpathOrResolved(dirPath));
  const matches: Array<InstanceSkillSpec> = [];
  for (const spec of context.specs) {
    if (spec.driver !== "antigravity" || spec.manifestPath === undefined) continue;
    const candidateDirs = [
      spec.writableGlobalSkillDir,
      ...(spec.profileDir ? [NodePath.join(spec.profileDir, "config", "skills")] : []),
    ];
    for (const candidateDir of candidateDirs) {
      const candidateRealKey = normalizeKey(
        context.platform,
        await realpathOrResolved(candidateDir),
      );
      if (candidateRealKey === targetRealKey) {
        matches.push(spec);
        break;
      }
    }
  }
  return matches;
}

async function promoteToUniversal(
  context: ManageContext,
  skillName: string,
  sourcePathInput: string,
): Promise<ManageOutcome> {
  const sourcePath = await assertWritableAncestorRealpath(
    context,
    asSkillDirectory(sourcePathInput, context.userHome),
    "待提升技能目录",
  );
  assertNotManagedRoot(context, sourcePath);
  if (pathIsWithin(context.platform, context.universalPoolDir, sourcePath)) {
    throw skillsError(`技能 ${skillName} 已位于真全局池`);
  }
  if (await isLinkPath(sourcePath)) {
    throw skillsError(`技能 ${skillName} 的来源是联接，无法提升为真全局实体`);
  }
  await requireSkillDirectory(sourcePath, "待提升技能目录");
  const destination = await assertWritableAncestorRealpath(
    context,
    NodePath.join(context.universalPoolDir, skillName),
    "真全局池目标",
  );
  assertNotManagedRoot(context, destination);
  const affectedPaths: Array<string> = [];
  const owner = owningSpecForPath(context, sourcePath);
  const sharedAgySpecs = await antigravitySpecsSharingDir(context, NodePath.dirname(sourcePath));

  if (await pathExists(destination)) {
    if (await isLinkPath(destination)) {
      throw skillsError(`真全局池目标 ${destination} 是联接，拒绝覆盖`);
    }
    const [sourceHash, destinationHash] = await Promise.all([
      hashSkillDirectory(sourcePath),
      hashSkillDirectory(destination),
    ]);
    if (
      sourceHash === undefined ||
      destinationHash === undefined ||
      sourceHash !== destinationHash
    ) {
      throw skillsError(`真全局池已存在内容不同的技能 ${skillName}，拒绝覆盖`);
    }
    const backupRoot = owner?.writableGlobalSkillDir ?? context.universalPoolDir;
    const backupPath = await backupEntity(context, sourcePath, backupRoot);
    affectedPaths.push(backupPath);
  } else {
    await moveEntity(sourcePath, destination);
    affectedPaths.push(destination);
  }

  if (sharedAgySpecs.length > 0) {
    for (const agySpec of sharedAgySpecs) {
      const { manifestPath } = requireAntigravitySpec(agySpec);
      await addManifestPaths(context, manifestPath, [destination]);
      affectedPaths.push(manifestPath);
    }
  } else if (owner?.driver === "antigravity") {
    const { manifestPath } = requireAntigravitySpec(owner);
    await addManifestPaths(context, manifestPath, [destination]);
    affectedPaths.push(manifestPath);
  } else if (owner !== undefined && !owner.readsUniversalPool) {
    if (!(await pathExists(sourcePath))) {
      await assertWritableAncestorRealpath(context, sourcePath, "技能回链路径");
      await createDirectoryLink(context, sourcePath, destination);
      affectedPaths.push(sourcePath);
    }
  }

  return {
    summary: `已将 ${skillName} 提升到真全局池`,
    affectedPaths: [...new Set(affectedPaths)],
  };
}

async function demoteToProvider(
  context: ManageContext,
  skillName: string,
  targetInstanceId: string,
): Promise<ManageOutcome> {
  const targetSpec = requireSpec(context, targetInstanceId);
  const foundSource = await findSkillDirectoryInRoot(context.universalPoolDir, skillName);
  if (foundSource === undefined) {
    throw skillsError(`真全局池中不存在技能 ${skillName}`);
  }
  const sourcePath = await assertWritableAncestorRealpath(context, foundSource, "真全局池技能目录");
  if (await isLinkPath(sourcePath)) {
    throw skillsError(`真全局池中的技能 ${skillName} 是联接，无法降级实体`);
  }
  await requireSkillDirectory(sourcePath, "真全局池技能目录");
  const sourceRealKey = normalizeKey(context.platform, await realpathOrResolved(sourcePath));
  const destination = await assertWritableAncestorRealpath(
    context,
    NodePath.join(targetSpec.writableGlobalSkillDir, NodePath.basename(sourcePath)),
    "供应商目标目录",
  );
  assertNotManagedRoot(context, destination);
  if (normalizeKey(context.platform, destination) === normalizeKey(context.platform, sourcePath)) {
    throw skillsError(`目标实例 ${targetSpec.displayName} 的全局目录就是真全局池`);
  }
  const affectedPaths: Array<string> = [];
  if (await pathExists(destination)) {
    if (
      (await isLinkPath(destination)) &&
      normalizeKey(context.platform, await realpathOrResolved(destination)) === sourceRealKey
    ) {
      await removeLink(destination);
      affectedPaths.push(destination);
    } else {
      throw skillsError(`目标目录已存在，拒绝覆盖：${destination}`);
    }
  }
  await moveEntity(sourcePath, destination);
  affectedPaths.push(destination);

  // Clean up any links in other provider directories that pointed at the moved universal entity
  // so they are not left dangling.
  const sourcePathKey = normalizeKey(context.platform, sourcePath);
  for (const spec of context.specs) {
    for (const dedupeRoot of dedupeRootsForSpec(context, spec)) {
      if (
        normalizeKey(context.platform, dedupeRoot.root) ===
        normalizeKey(context.platform, context.universalPoolDir)
      ) {
        continue;
      }
      const candidate = NodePath.join(dedupeRoot.root, NodePath.basename(sourcePath));
      if (
        normalizeKey(context.platform, candidate) === normalizeKey(context.platform, destination)
      ) {
        continue;
      }
      if (!(await isLinkPath(candidate))) continue;
      const linkTarget = await readLinkDestination(candidate).catch(() => undefined);
      if (
        linkTarget !== undefined &&
        (normalizeKey(context.platform, linkTarget) === sourcePathKey ||
          normalizeKey(context.platform, linkTarget) === sourceRealKey)
      ) {
        await assertWritableAncestorRealpath(context, candidate, "悬空联接清理");
        await removeLink(candidate);
        affectedPaths.push(candidate);
      }
    }
  }

  if (targetSpec.driver === "antigravity") {
    const { manifestPath } = requireAntigravitySpec(targetSpec);
    await addManifestPaths(context, manifestPath, [destination]);
    affectedPaths.push(manifestPath);
  }
  return {
    summary: `已将 ${skillName} 从真全局池降级到 ${targetSpec.displayName}`,
    affectedPaths: [...new Set(affectedPaths)],
  };
}

async function importSkill(
  context: ManageContext,
  request: Extract<ServerManageSkillsInput, { readonly action: "import_skill" }>,
): Promise<ManageOutcome> {
  const sourceDir = asSkillDirectory(request.sourceDirPath, context.userHome);
  await requireSkillDirectory(sourceDir, "导入来源");
  const metadata = await readSkillMetadata(sourceDir);
  if (
    !metadata.hasValidFrontmatter ||
    metadata.name === undefined ||
    metadata.description === undefined ||
    metadata.name.trim().length === 0 ||
    metadata.description.trim().length === 0
  ) {
    throw skillsError(`导入来源的 SKILL.md frontmatter 必须包含合法的 name 和 description`);
  }
  const skillName = assertSafeSkillName(metadata.name.trim());
  const realSourceDir = await NodeFSP.realpath(sourceDir);
  const affectedPaths: Array<string> = [];

  if (request.targetScope === "universal") {
    const destination = await assertWritableAncestorRealpath(
      context,
      NodePath.join(context.universalPoolDir, skillName),
      "导入目标",
    );
    if (await pathExists(destination)) {
      const existingHash = await hashSkillDirectory(destination);
      if (existingHash !== metadata.contentHash) {
        throw skillsError(`真全局池已存在内容不同的技能 ${skillName}，拒绝导入覆盖`);
      }
    } else {
      await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
      if (request.mode === "copy") {
        await copySkillDirectory(realSourceDir, destination);
      } else {
        await createDirectoryLink(context, destination, realSourceDir);
      }
      affectedPaths.push(destination);
    }

    if (request.mountToNonUniversalEnabled === true) {
      for (const spec of context.specs) {
        if (!spec.enabled || spec.readsUniversalPool) continue;
        if (
          normalizeKey(context.platform, spec.writableGlobalSkillDir) ===
          normalizeKey(context.platform, context.universalPoolDir)
        ) {
          continue;
        }
        const outcome = await mountSkill(context, {
          skillName,
          sourcePath: destination,
          targetInstanceId: String(spec.instanceId),
          mode: "link",
        });
        affectedPaths.push(...outcome.affectedPaths);
      }
    }
  } else if (request.targetScope === "provider_global") {
    const targetIds = [
      ...new Set((request.targetInstanceIds ?? []).map((instanceId) => String(instanceId))),
    ];
    if (targetIds.length === 0) {
      throw skillsError("导入到供应商全局作用域时必须提供 targetInstanceIds");
    }
    const seenGlobalDirs = new Set<string>();
    for (const targetInstanceId of targetIds) {
      const targetSpec = requireSpec(context, targetInstanceId);
      if (targetSpec.driver === "antigravity") {
        const globalDestination = await assertWritableAncestorRealpath(
          context,
          NodePath.join(targetSpec.writableGlobalSkillDir, skillName),
          "Antigravity 供应商全局目录",
        );
        const dirKey = normalizeKey(context.platform, globalDestination);
        if (request.mode === "copy" && !seenGlobalDirs.has(dirKey)) {
          seenGlobalDirs.add(dirKey);
          if (await pathExists(globalDestination)) {
            const existingHash = await hashSkillDirectory(globalDestination);
            if (existingHash !== metadata.contentHash) {
              throw skillsError(`目标目录已存在内容不同的技能 ${skillName}：${globalDestination}`);
            }
          } else {
            await copySkillDirectory(realSourceDir, globalDestination);
            affectedPaths.push(globalDestination);
          }
        }
        const { manifestPath } = requireAntigravitySpec(targetSpec);
        const registerPath = request.mode === "copy" ? globalDestination : realSourceDir;
        await addManifestPaths(context, manifestPath, [registerPath]);
        affectedPaths.push(manifestPath);
        continue;
      }
      const globalDirKey = normalizeKey(context.platform, targetSpec.writableGlobalSkillDir);
      if (seenGlobalDirs.has(globalDirKey)) continue;
      seenGlobalDirs.add(globalDirKey);
      const outcome = await mountSkill(context, {
        skillName,
        sourcePath: realSourceDir,
        targetInstanceId,
        mode: request.mode,
      });
      affectedPaths.push(...outcome.affectedPaths);
    }
  } else {
    const targetIds = [
      ...new Set((request.targetInstanceIds ?? []).map((instanceId) => String(instanceId))),
    ];
    if (targetIds.length === 0) {
      throw skillsError("导入到实例作用域时必须提供 targetInstanceIds");
    }
    for (const targetInstanceId of targetIds) {
      const outcome = await mountSkill(context, {
        skillName,
        sourcePath: realSourceDir,
        targetInstanceId,
        mode: request.mode,
      });
      affectedPaths.push(...outcome.affectedPaths);
    }
  }

  return {
    summary: `已导入技能 ${skillName}`,
    affectedPaths: [...new Set(affectedPaths)],
  };
}

function dedupeRootsForSpec(context: ManageContext, spec: InstanceSkillSpec): DedupeRoot[] {
  const roots: Array<{ root: string; backupRoot: string }> = [
    {
      root: spec.writableGlobalSkillDir,
      backupRoot: spec.writableGlobalSkillDir,
    },
  ];
  if (spec.driver === "antigravity" && spec.profileDir !== undefined) {
    roots.push({
      root: NodePath.join(spec.profileDir, "config", "skills"),
      backupRoot: NodePath.join(spec.profileDir, "config", "skills"),
    });
  }
  if (spec.isFactoryDroid) {
    const factoryHome = spec.factoryHomeOverride ?? context.userHome;
    if (spec.factoryHomeOverride !== undefined) {
      roots.push({
        root: NodePath.join(factoryHome, ".agents", "skills"),
        backupRoot: NodePath.join(factoryHome, ".agents", "skills"),
      });
    }
    roots.push({
      root: NodePath.join(factoryHome, ".agent", "skills"),
      backupRoot: NodePath.join(factoryHome, ".agent", "skills"),
    });
  }
  return roots.map(({ root, backupRoot }) => ({ spec, root, backupRoot }));
}

async function dedupeSkill(
  context: ManageContext,
  skillName: string,
  preferSourcePath?: string,
): Promise<ManageOutcome> {
  const entry = context.overview.skills.find((skill) => skill.name === skillName);
  if (entry === undefined) {
    throw skillsError(`未找到技能 ${skillName}`);
  }
  if (entry.hasContentConflict && preferSourcePath === undefined) {
    throw skillsError(
      `技能 ${skillName} 的多个副本内容冲突，拒绝自动去重：${entry.locations
        .map((location) => `${location.path} (${location.contentHash ?? "unknown"})`)
        .join(", ")}`,
    );
  }

  const existingUniversal = await findSkillDirectoryInRoot(context.universalPoolDir, skillName);
  const universalPath = await assertWritableAncestorRealpath(
    context,
    existingUniversal ?? NodePath.join(context.universalPoolDir, skillName),
    "真全局池技能目录",
  );
  let universalExists = await pathExists(universalPath);
  const affectedPaths: Array<string> = [];

  if (preferSourcePath !== undefined) {
    const preferredDir = asSkillDirectory(preferSourcePath, context.userHome);
    await requireSkillDirectory(preferredDir, "指定保留副本");
    if (
      normalizeKey(context.platform, preferredDir) !== normalizeKey(context.platform, universalPath)
    ) {
      if (universalExists) {
        if (await isLinkPath(universalPath)) {
          await removeLink(universalPath);
        } else {
          const backupPath = await backupEntity(context, universalPath, context.universalPoolDir);
          affectedPaths.push(backupPath);
        }
      }
      const realPreferred = await NodeFSP.realpath(preferredDir);
      await copySkillDirectory(realPreferred, universalPath);
      affectedPaths.push(universalPath);
      universalExists = true;
    }
  } else if (!universalExists) {
    const fallback = entry.locations.find((location) => !location.isLink);
    if (fallback === undefined) {
      throw skillsError(`真全局池中不存在技能 ${skillName} 的实体副本`);
    }
    const fallbackDir = fallback.path;
    await requireSkillDirectory(fallbackDir, "真全局池回填来源");
    await copySkillDirectory(await NodeFSP.realpath(fallbackDir), universalPath);
    affectedPaths.push(universalPath);
    universalExists = true;
  } else if (await isLinkPath(universalPath)) {
    // Keep a valid universal Junction/symlink intact when it points to an external canonical source
    // (e.g. ego-browser installer or a live plugin repo like lantu) so upstream updates stay live.
    const target = await readLinkDestination(universalPath);
    if (!(await skillDirectoryExists(target))) {
      throw skillsError(`真全局池联接目标无效：${universalPath} -> ${target}`);
    }
  }

  if (!universalExists) {
    throw skillsError(`无法建立真全局池实体技能 ${skillName}`);
  }
  const universalRealPath = await realpathOrResolved(universalPath);

  // Track physical directories shared by any non-universal instance (e.g. w2/.factory/skills -> ~/.factory/skills)
  // so deduping a readsUniversalPool sibling (W1) does not break isolated instances sharing the same directory.
  const nonUniversalSharedRealRoots = new Set<string>();
  for (const candidateSpec of context.specs) {
    if (candidateSpec.readsUniversalPool || candidateSpec.driver === "antigravity") continue;
    for (const candidateRoot of dedupeRootsForSpec(context, candidateSpec)) {
      const candidateReal = await realpathOrResolved(candidateRoot.root);
      nonUniversalSharedRealRoots.add(normalizeKey(context.platform, candidateReal));
    }
  }

  const processedRealPaths = new Set<string>();
  for (const spec of context.specs) {
    for (const dedupeRoot of dedupeRootsForSpec(context, spec)) {
      const root = await assertWritableAncestorRealpath(context, dedupeRoot.root, "供应商技能目录");
      const realRoot = await realpathOrResolved(root);
      const realRootKey = normalizeKey(context.platform, realRoot);
      if (
        normalizeKey(context.platform, root) ===
          normalizeKey(context.platform, context.universalPoolDir) ||
        realRootKey ===
          normalizeKey(context.platform, await realpathOrResolved(context.universalPoolDir))
      ) {
        continue;
      }
      const duplicatePath = await findSkillDirectoryInRoot(root, skillName);
      if (
        duplicatePath === undefined ||
        normalizeKey(context.platform, duplicatePath) ===
          normalizeKey(context.platform, universalPath)
      ) {
        continue;
      }
      const duplicateRealKey = normalizeKey(
        context.platform,
        NodePath.join(realRoot, NodePath.basename(duplicatePath)),
      );
      if (processedRealPaths.has(duplicateRealKey)) continue;
      processedRealPaths.add(duplicateRealKey);
      await assertWritableAncestorRealpath(context, duplicatePath);
      assertNotManagedRoot(context, duplicatePath);

      const needsReference =
        spec.driver !== "antigravity" &&
        (!spec.readsUniversalPool || nonUniversalSharedRealRoots.has(realRootKey));

      const duplicateIsLink = await isLinkPath(duplicatePath);
      if (
        !duplicateIsLink &&
        normalizeKey(context.platform, await realpathOrResolved(duplicatePath)) ===
          normalizeKey(context.platform, universalRealPath)
      ) {
        continue;
      }
      if (duplicateIsLink) {
        const destination = await realpathOrResolved(duplicatePath);
        if (
          needsReference &&
          normalizeKey(context.platform, destination) ===
            normalizeKey(context.platform, universalRealPath)
        ) {
          continue;
        }
        await removeLink(duplicatePath);
        affectedPaths.push(duplicatePath);
      } else {
        const backupPath = await backupEntity(context, duplicatePath, dedupeRoot.backupRoot);
        affectedPaths.push(backupPath);
      }

      if (spec.driver === "antigravity") {
        // Update ALL Antigravity instances sharing this directory (e.g. ~/.gemini/config/skills)
        // so sibling instances do not lose access to the skill after dedupe.
        const affectedAgySpecs = await antigravitySpecsSharingDir(context, root);
        const specsToUpdate = affectedAgySpecs.length > 0 ? affectedAgySpecs : [spec];
        for (const agySpec of specsToUpdate) {
          const { manifestPath } = requireAntigravitySpec(agySpec);
          await addManifestPaths(context, manifestPath, [universalRealPath]);
          affectedPaths.push(manifestPath);
        }
      } else if (needsReference) {
        await assertWritableAncestorRealpath(context, duplicatePath, "技能回链路径");
        await createDirectoryLink(context, duplicatePath, universalRealPath);
        affectedPaths.push(duplicatePath);
      }
    }
  }

  return {
    summary: `已将 ${skillName} 归并为真全局池唯一实体源`,
    affectedPaths: [...new Set(affectedPaths)],
  };
}

async function dedupeAll(context: ManageContext): Promise<ManageOutcome> {
  const skippedConflicts: Array<string> = [];
  const affectedPaths: Array<string> = [];
  let deduped = 0;
  for (const entry of context.overview.skills) {
    if (!entry.hasDuplicateCopies) continue;
    if (entry.hasContentConflict) {
      skippedConflicts.push(entry.name);
      continue;
    }
    const outcome = await dedupeSkill(context, entry.name);
    affectedPaths.push(...outcome.affectedPaths);
    deduped += 1;
  }
  return {
    summary: `已完成安全去重 ${deduped} 个技能，跳过 ${skippedConflicts.length} 个冲突技能`,
    affectedPaths: [...new Set(affectedPaths)],
    skippedConflicts,
  };
}

async function backupSkill(
  context: ManageContext,
  skillName: string,
  targetPath?: string,
): Promise<ManageOutcome> {
  let resolvedTarget: string;
  if (targetPath !== undefined) {
    resolvedTarget = await assertWritableAncestorRealpath(
      context,
      asSkillDirectory(targetPath, context.userHome),
      "备份目标",
    );
  } else {
    const universalCandidate = await findSkillDirectoryInRoot(context.universalPoolDir, skillName);
    if (universalCandidate !== undefined) {
      resolvedTarget = await assertWritableAncestorRealpath(
        context,
        universalCandidate,
        "备份目标",
      );
    } else {
      const location = context.overview.skills
        .find((entry) => entry.name === skillName)
        ?.locations.find((candidate) => candidate.path !== undefined);
      if (location === undefined) {
        throw skillsError(`未找到技能 ${skillName} 的可备份位置`);
      }
      resolvedTarget = await assertWritableAncestorRealpath(context, location.path, "备份目标");
    }
  }
  assertNotManagedRoot(context, resolvedTarget);
  if (pathHasBackupSegment(resolvedTarget)) {
    throw skillsError(`拒绝将 _backup 备份目录本身作为操作对象：${resolvedTarget}`);
  }
  if (!(await pathExists(resolvedTarget))) {
    throw skillsError(`备份目标不存在：${resolvedTarget}`);
  }
  if (await isLinkPath(resolvedTarget)) {
    await removeLink(resolvedTarget);
    return {
      summary: `已移除 ${skillName} 的联接，未触碰真实目标`,
      affectedPaths: [resolvedTarget],
    };
  }
  await requireSkillDirectory(resolvedTarget, "备份目标");
  const backupRoot = NodePath.dirname(resolvedTarget);
  const backupPath = await backupEntity(context, resolvedTarget, backupRoot);
  return {
    summary: `已将 ${skillName} 备份到 ${backupPath}`,
    affectedPaths: [resolvedTarget, backupPath],
  };
}

async function makeContext(
  overview: ServerGetSkillsOverviewResult,
  options: BuildSkillsOverviewInput,
  userHome: string,
  platform: NodeJS.Platform,
): Promise<ManageContext> {
  const stateDir = options.stateDir;
  const specs = await Promise.all(
    options.providers.map((provider) =>
      resolveInstanceSkillSpec({
        provider,
        settings: options.settings,
        stateDir,
        userHome,
        platform,
      }),
    ),
  );
  const universalPoolDir = NodePath.resolve(NodePath.join(userHome, ".agents", "skills"));
  const allowedWriteRoots = new Set<string>([universalPoolDir]);
  const allowedManifestPaths = new Set<string>();
  for (const spec of specs) {
    allowedWriteRoots.add(NodePath.resolve(spec.writableGlobalSkillDir));
    if (spec.profileDir !== undefined) {
      allowedWriteRoots.add(NodePath.resolve(NodePath.join(spec.profileDir, "config", "skills")));
    }
    if (spec.manifestPath !== undefined) {
      allowedManifestPaths.add(normalizeKey(platform, spec.manifestPath));
    }
    if (spec.isFactoryDroid) {
      const factoryHome = spec.factoryHomeOverride ?? userHome;
      if (spec.factoryHomeOverride !== undefined) {
        allowedWriteRoots.add(NodePath.resolve(NodePath.join(factoryHome, ".agents", "skills")));
      }
      allowedWriteRoots.add(NodePath.resolve(NodePath.join(factoryHome, ".agent", "skills")));
    }
  }
  const specsById = new Map(specs.map((spec) => [String(spec.instanceId), spec] as const));
  return {
    overview,
    overviewInput: options,
    providers: options.providers,
    settings: options.settings,
    stateDir,
    userHome,
    platform,
    universalPoolDir,
    specs,
    specsById,
    allowedWriteRoots: [...allowedWriteRoots],
    allowedManifestPaths,
  };
}

async function executeAction(
  context: ManageContext,
  request: ServerManageSkillsInput,
): Promise<ManageOutcome> {
  switch (request.action) {
    case "mount_to_instance":
      return mountSkill(context, {
        skillName: assertSafeSkillName(request.skillName),
        ...(request.sourcePath === undefined ? {} : { sourcePath: request.sourcePath }),
        targetInstanceId: String(request.targetInstanceId),
        mode: request.mode ?? "link",
      });
    case "unmount_from_instance":
      return unmountSkill(
        context,
        assertSafeSkillName(request.skillName),
        String(request.targetInstanceId),
      );
    case "fix_instance_warning":
      return fixInstanceWarning(
        context,
        assertSafeSkillName(request.skillName),
        String(request.targetInstanceId),
      );
    case "link_universal_pool":
      return linkUniversalPool(context, String(request.targetInstanceId));
    case "sync_instances":
      return syncInstances(context, request);
    case "promote_to_universal":
      return promoteToUniversal(
        context,
        assertSafeSkillName(request.skillName),
        request.sourcePath,
      );
    case "demote_to_provider":
      return demoteToProvider(
        context,
        assertSafeSkillName(request.skillName),
        String(request.targetInstanceId),
      );
    case "import_skill":
      return importSkill(context, request);
    case "dedupe_skill":
      return dedupeSkill(context, assertSafeSkillName(request.skillName), request.preferSourcePath);
    case "dedupe_all":
      return dedupeAll(context);
    case "backup_skill":
      return backupSkill(context, assertSafeSkillName(request.skillName), request.targetPath);
  }
}

export const manageSkills = Effect.fn("SkillsManage.manage")(function* (
  request: ServerManageSkillsInput,
  options: BuildSkillsOverviewInput,
) {
  return yield* manageSkillsSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const userHome = options.userHome ?? NodeOS.homedir();
      const platform = options.platform ?? (yield* HostProcess.Platform);
      const hostEnv = yield* HostProcess.Environment;
      const envPath = options.envPath ?? hostEnv.PATH ?? hostEnv.Path;
      const overviewInput: BuildSkillsOverviewInput = {
        ...options,
        userHome,
        platform,
        ...(envPath === undefined ? {} : { envPath }),
      };
      const before = yield* buildSkillsOverview(overviewInput);
      const outcome = yield* Effect.tryPromise({
        try: async () => {
          const context = await makeContext(before, overviewInput, userHome, platform);
          return executeAction(context, request);
        },
        catch: (cause) =>
          isSkillsOverviewError(cause)
            ? cause
            : new SkillsOverviewError({ message: errorMessage(cause) }),
      });
      const overview = yield* buildSkillsOverview(overviewInput);
      return {
        ok: true,
        summary: outcome.summary,
        affectedPaths: [...outcome.affectedPaths],
        skippedConflicts: [...(outcome.skippedConflicts ?? [])],
        overview,
      } satisfies ServerManageSkillsResult;
    }),
  );
});

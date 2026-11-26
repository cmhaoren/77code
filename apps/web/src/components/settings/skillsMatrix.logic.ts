import type {
  ProviderInstanceId,
  SkillMatrixEntry,
  SkillMatrixInstance,
  SkillMatrixScope,
} from "@t3tools/contracts";

export interface SkillFilterOptions {
  readonly scope: SkillMatrixScope;
  readonly query: string;
  readonly onlyIssues: boolean;
  readonly onlyDuplicates: boolean;
  readonly displayedInstances: ReadonlyArray<SkillMatrixInstance>;
  readonly showDisabled?: boolean;
}

export interface DuplicateSkillCounts {
  readonly total: number;
  readonly conflicts: number;
}

export interface DriverInstanceGroup {
  readonly key: string;
  readonly label: string;
  readonly instances: ReadonlyArray<SkillMatrixInstance>;
}

function hasIssueInDisplayedInstances(
  entry: SkillMatrixEntry,
  instances: ReadonlyArray<SkillMatrixInstance>,
): boolean {
  return instances.some((instance) => {
    const status = entry.cells[instance.instanceId]?.status;
    return status === "missing" || status === "disk_warning";
  });
}

export function filterSkillEntries(
  skills: ReadonlyArray<SkillMatrixEntry>,
  options: SkillFilterOptions,
): ReadonlyArray<SkillMatrixEntry> {
  const query = options.query.trim().toLowerCase();
  return skills.filter((skill) => {
    if (skill.scope !== options.scope) return false;
    if (options.scope === "agent_global" && options.showDisabled === false) {
      const ownedByDisplayedInstance = options.displayedInstances.some((instance) => {
        const status = skill.cells[instance.instanceId]?.status;
        return status !== undefined && status !== "not_applicable";
      });
      if (!ownedByDisplayedInstance) return false;
    }
    if (options.onlyIssues && !hasIssueInDisplayedInstances(skill, options.displayedInstances)) {
      return false;
    }
    if (options.onlyDuplicates && !skill.hasDuplicateCopies) return false;
    if (query.length === 0) return true;
    return (
      skill.name.toLowerCase().includes(query) ||
      (skill.description?.toLowerCase().includes(query) ?? false) ||
      skill.ownerGroupLabels.some((label) => label.toLowerCase().includes(query))
    );
  });
}

export function countHiddenDisabledAgentSkills(
  skills: ReadonlyArray<SkillMatrixEntry>,
  displayedInstances: ReadonlyArray<SkillMatrixInstance>,
  showDisabled: boolean,
): number {
  if (showDisabled) return 0;
  let count = 0;
  for (const skill of skills) {
    if (skill.scope !== "agent_global") continue;
    const ownedByDisplayedInstance = displayedInstances.some((instance) => {
      const status = skill.cells[instance.instanceId]?.status;
      return status !== undefined && status !== "not_applicable";
    });
    if (!ownedByDisplayedInstance) count += 1;
  }
  return count;
}

export function countDuplicateSkills(
  skills: ReadonlyArray<SkillMatrixEntry>,
): DuplicateSkillCounts {
  let total = 0;
  let conflicts = 0;
  for (const skill of skills) {
    if (!skill.hasDuplicateCopies) continue;
    total += 1;
    if (skill.hasContentConflict) conflicts += 1;
  }
  return { total, conflicts };
}

export function groupInstancesByDriver(
  instances: ReadonlyArray<SkillMatrixInstance>,
): ReadonlyArray<DriverInstanceGroup> {
  const groups: Array<{
    readonly key: string;
    readonly label: string;
    readonly instances: Array<SkillMatrixInstance>;
  }> = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const instance of instances) {
    let group = byKey.get(instance.driverGroupKey);
    if (group === undefined) {
      group = {
        key: instance.driverGroupKey,
        label: instance.driverGroupLabel,
        instances: [],
      };
      byKey.set(instance.driverGroupKey, group);
      groups.push(group);
    }
    group.instances.push(instance);
  }
  return groups;
}

export function getDefaultSyncTargetIds(
  instances: ReadonlyArray<SkillMatrixInstance>,
  sourceInstanceId: string,
  sameDriverOnly: boolean,
): ReadonlyArray<ProviderInstanceId> {
  const source = instances.find((instance) => instance.instanceId === sourceInstanceId);
  if (source === undefined) {
    return sameDriverOnly ? [] : instances.map((instance) => instance.instanceId);
  }
  return instances
    .filter(
      (instance) =>
        instance.instanceId !== source.instanceId &&
        (!sameDriverOnly || instance.driverGroupKey === source.driverGroupKey),
    )
    .map((instance) => instance.instanceId);
}

export function resolveSkillSourcePath(entry: SkillMatrixEntry): string | undefined {
  const universal = entry.locations.find((location) => location.layer === "universal");
  if (universal !== undefined) return universal.path;
  const entity = entry.locations.find((location) => !location.isLink);
  if (entity !== undefined) return entity.path;
  return entry.canonicalPath;
}

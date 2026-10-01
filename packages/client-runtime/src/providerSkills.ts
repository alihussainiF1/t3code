import {
  resolveSkillsForProvider,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
  type SkillConfig,
} from "@t3tools/contracts";

export type ProviderSkillSourceKind =
  | "app"
  | "repo"
  | "project"
  | "personal"
  | "system"
  | "library"
  | "other";

/** Scope given to T3 library skills in composer lists. */
export const LIBRARY_SKILL_SCOPE = "t3-library";

/**
 * The provider's own skills followed by the T3 library skills this provider
 * receives on the thread. The server delivers library skills to every
 * provider and dispatches `$<id>` for them, so the composer can offer them
 * everywhere. A provider skill with the same name wins, matching what the
 * provider itself runs.
 */
export function withLibrarySkills(
  providerSkills: ReadonlyArray<ServerProviderSkill>,
  library: Readonly<Record<string, SkillConfig>> | undefined,
  driver: string,
  disabledForThread?: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderSkill> {
  if (!library) return providerSkills;
  const resolved = resolveSkillsForProvider(library, driver, disabledForThread);
  if (resolved.length === 0) return providerSkills;
  const providerNames = new Set(providerSkills.map((skill) => skill.name.trim().toLowerCase()));
  return [
    ...providerSkills,
    ...resolved
      .filter(({ id }) => !providerNames.has(id))
      .map(({ id, config }): ServerProviderSkill => ({
        name: id,
        path: `${LIBRARY_SKILL_SCOPE}:${id}`,
        scope: LIBRARY_SKILL_SCOPE,
        enabled: true,
        ...(config.description ? { description: config.description } : {}),
        ...(config.name !== id ? { displayName: config.name } : {}),
      })),
  ];
}

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

export function dedupeProviderSkillsByName(
  skills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSkill[] {
  const seenNames = new Set<string>();
  return skills.filter((skill) => {
    const normalizedName = skill.name.trim().toLowerCase();
    if (seenNames.has(normalizedName)) {
      return false;
    }
    seenNames.add(normalizedName);
    return true;
  });
}

/**
 * Whether a composer pick can start this skill. A skill switched off in the
 * provider's settings will not run, and one the provider reserves for the
 * agent (Claude Code's `user-invocable: false`) rejects a user invocation.
 * Everything else, including skills the agent may not start on its own, is
 * fair game: the server dispatches the pick in the provider's native form.
 */
export function isProviderSkillUserInvocable(
  skill: Pick<ServerProviderSkill, "enabled" | "userInvocable">,
): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu
    ? dedupeProviderSkillsByName(skills.filter(isProviderSkillUserInvocable))
    : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case LIBRARY_SKILL_SCOPE:
      return "library";
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}

function resolveProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string | null | undefined,
) {
  if (!cwd) return undefined;
  return provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
}

export function resolveProviderSkillsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["skills"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.skills ?? provider.skills;
}

export function resolveProviderSlashCommandsForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["slashCommands"] {
  return resolveProviderWorkspaceSnapshot(provider, cwd)?.slashCommands ?? provider.slashCommands;
}

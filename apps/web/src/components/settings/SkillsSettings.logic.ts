import type {
  DiscoveredSkill,
  SkillConfig,
  SkillDiscoverySource,
  SkillGalleryEntry,
} from "@t3tools/contracts";

/** Where a library skill came from, for its row. */
export function skillSourceLabel(source: SkillConfig["source"]): string {
  switch (source.type) {
    case "local":
      return "Created in T3";
    case "github":
      return `GitHub · ${source.owner}/${source.repo}${source.path ? `/${source.path}` : ""}`;
    case "imported":
      return `Imported · ${source.path}`;
  }
}

/** Skills installed from a repository or folder can be refreshed from it. */
export function skillCanUpdate(source: SkillConfig["source"]): boolean {
  return source.type !== "local";
}

export type GalleryInstallState = "installable" | "installed" | "name-taken";

/**
 * A gallery tile's state: installed when the library holds this exact
 * folder, blocked when another skill already uses the name.
 */
export function galleryInstallState(
  entry: SkillGalleryEntry,
  skills: Readonly<Record<string, SkillConfig>>,
): GalleryInstallState {
  const existing = skills[entry.id];
  if (!existing) return "installable";
  const source = existing.source;
  return source.type === "github" &&
    entry.url ===
      `https://github.com/${source.owner}/${source.repo}/tree/${source.ref || "main"}/${source.path}`
    ? "installed"
    : "name-taken";
}

export const SKILL_DISCOVERY_SOURCE_LABELS: Readonly<Record<SkillDiscoverySource, string>> = {
  "claude-user": "Claude Code",
  "claude-project": "Claude Code (project)",
  "codex-user": "Codex",
  "agents-user": "~/.agents",
  "agents-project": "Project .agents",
};

/** Discovered folders an "Import all" would bring in: valid and not imported yet. */
export function importableDiscoveredSkills(
  skills: ReadonlyArray<DiscoveredSkill>,
): ReadonlyArray<DiscoveredSkill> {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (skill.note !== undefined || skill.importedAs !== undefined) return false;
    // The same name in two roots imports once; the first root wins, as on the server.
    const key = skill.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it.
---

# My skill

Step-by-step instructions the agent follows when this skill applies.
`;

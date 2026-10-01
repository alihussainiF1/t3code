// @effect-diagnostics nodeBuiltinImport:off - realpath dedupe across symlinked roots
/**
 * SkillDiscovery - finds skills the user already installed for a provider
 * CLI, so the Skills page can offer to import them into the T3 library.
 *
 * Only the conventional one-folder-per-skill roots are read; provider plugin
 * caches and Codex's bundled `.system` skills are not user skills.
 *
 * @module skills/SkillDiscovery
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { SkillDiscoverySource } from "@t3tools/contracts";

import { parseSkillFrontmatter } from "./SkillFrontmatter.ts";

export interface SkillDiscoveryRoot {
  readonly source: SkillDiscoverySource;
  readonly directory: string;
}

export interface DiscoveredSkillFolder {
  readonly source: SkillDiscoverySource;
  /** Absolute folder path. */
  readonly path: string;
  readonly name: string;
  readonly description: string;
  /** Set when the folder cannot be imported. */
  readonly error?: string;
}

/** Skill roots the provider CLIs read, user scope first. */
export function skillDiscoveryRoots(input: {
  readonly homeDirectory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string | undefined;
}): ReadonlyArray<SkillDiscoveryRoot> {
  const claudeConfigDir =
    input.environment.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(input.homeDirectory, ".claude");
  const codexHome =
    input.environment.CODEX_HOME?.trim() || NodePath.join(input.homeDirectory, ".codex");
  return [
    { source: "claude-user", directory: NodePath.join(claudeConfigDir, "skills") },
    { source: "codex-user", directory: NodePath.join(codexHome, "skills") },
    { source: "agents-user", directory: NodePath.join(input.homeDirectory, ".agents", "skills") },
    ...(input.cwd
      ? ([
          { source: "claude-project", directory: NodePath.join(input.cwd, ".claude", "skills") },
          { source: "agents-project", directory: NodePath.join(input.cwd, ".agents", "skills") },
        ] as const)
      : []),
  ];
}

const MAX_SKILL_MD_BYTES = 1_000_000;

/**
 * Every `<root>/<folder>/SKILL.md`. Unreadable roots are skipped; folders
 * with invalid frontmatter are reported with an error so the UI can say why
 * they cannot be imported. The same folder reached through two roots (a
 * symlinked `~/.claude/skills`) is listed once.
 */
export async function discoverSkillFolders(
  roots: ReadonlyArray<SkillDiscoveryRoot>,
): Promise<ReadonlyArray<DiscoveredSkillFolder>> {
  const found: DiscoveredSkillFolder[] = [];
  const seenRealPaths = new Set<string>();
  for (const root of roots) {
    const entries = await NodeFSP.readdir(root.directory).catch((): string[] => []);
    for (const entry of entries.toSorted()) {
      if (entry.startsWith(".")) continue;
      const folder = NodePath.join(root.directory, entry);
      const skillFile = NodePath.join(folder, "SKILL.md");
      const stat = await NodeFSP.stat(skillFile).catch(() => undefined);
      if (!stat?.isFile() || stat.size > MAX_SKILL_MD_BYTES) continue;
      const realPath = await NodeFSP.realpath(folder).catch(() => folder);
      if (seenRealPaths.has(realPath)) continue;
      seenRealPaths.add(realPath);
      const contents = await NodeFSP.readFile(skillFile, "utf8").catch(() => undefined);
      if (contents === undefined) continue;
      const parsed = parseSkillFrontmatter(contents);
      found.push(
        parsed.ok
          ? {
              source: root.source,
              path: folder,
              name: parsed.name,
              description: parsed.description,
            }
          : {
              source: root.source,
              path: folder,
              name: entry,
              description: "",
              error: parsed.error,
            },
      );
    }
  }
  return found;
}

// @effect-diagnostics nodeBuiltinImport:off - staging dirs, renames, and junction symlinks
/**
 * SkillDelivery - hands a session's library skills to its provider.
 *
 * Every session gets one delivery root, shared by sessions with the same
 * skill set: `<runtime>/<key>/skills/<id>` links to the library folder, and
 * `<runtime>/<key>/.claude-plugin/plugin.json` makes the root a Claude Code
 * plugin. Nothing is written into the user's project or provider homes.
 *
 * Per provider (verified against the CLIs where installed):
 *  - Claude: the root is passed as a local plugin (SDK `plugins`). Skills are
 *    published as `/t3:<id>` with the alias `/<id>`, and symlinked skill
 *    folders load.
 *  - Codex: `skills/extraRoots/set` on the session's app-server adds
 *    `<root>/skills` as a user skill root (Codex follows the links), so `$id`
 *    resolves natively.
 *  - OpenCode: `skills.paths` in the spawned server's OPENCODE_CONFIG_CONTENT.
 *    An external server (`serverUrl`) is the user's own and gets the index
 *    instead.
 *  - Cursor, Grok, Antigravity: their ACP agents have no per-session skill
 *    root, and their user skill folders belong to the user, so they receive a
 *    compact index (name, description, SKILL.md path) with each prompt's
 *    runtime instructions and read the file when a skill applies.
 *
 * @module skills/SkillDelivery
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Plugin name Claude Code namespaces delivered skills under (`/t3:<id>`). */
export const CLAUDE_SKILL_PLUGIN_NAME = "t3";

export interface DeliveredSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Absolute path of the skill's SKILL.md in the library. */
  readonly skillFile: string;
}

export interface SessionSkills {
  /** Plugin root for Claude. */
  readonly root: string;
  /** Folder holding one link per skill; the skill root for Codex and OpenCode. */
  readonly skillsDirectory: string;
  readonly skills: ReadonlyArray<DeliveredSkill>;
}

/** Stable key for a skill set, so sessions with the same set share a root. */
export function skillDeliveryKey(ids: ReadonlyArray<string>): string {
  return NodeCrypto.createHash("sha256")
    .update([...ids].toSorted().join("\n"))
    .digest("hex")
    .slice(0, 16);
}

const MAX_INDEX_DESCRIPTION = 300;

/**
 * Instructions listing the skills for providers without native delivery.
 * Only the index travels with each prompt; the agent reads a SKILL.md when it
 * needs it, which keeps the per-turn cost to one line per skill.
 */
export function buildSkillIndexInstructions(skills: ReadonlyArray<DeliveredSkill>): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => {
    const description = skill.description.replaceAll(/\s+/g, " ").trim();
    const short =
      description.length > MAX_INDEX_DESCRIPTION
        ? `${description.slice(0, MAX_INDEX_DESCRIPTION - 1)}…`
        : description;
    return `- ${skill.id}: ${short} (${skill.skillFile})`;
  });
  return `<skills>
The user installed these skills. Each is a folder whose SKILL.md holds instructions, and may bundle scripts and resources next to it. When a task matches a skill's description, or the user writes $<name>, read that SKILL.md first and follow it; resolve relative paths in it against the skill's folder.
${lines.join("\n")}
</skills>`;
}

/**
 * Adds `paths` to `skills.paths` of an OpenCode config JSON, keeping
 * everything else the user configured. Unparseable content is returned
 * unchanged: OpenCode would reject it either way, and T3 must not mask that.
 */
export function withOpenCodeSkillPaths(
  configContent: string,
  paths: ReadonlyArray<string>,
): string {
  if (paths.length === 0) return configContent;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configContent);
  } catch {
    return configContent;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return configContent;
  const config = parsed as Record<string, unknown>;
  const skills =
    typeof config.skills === "object" && config.skills !== null && !Array.isArray(config.skills)
      ? (config.skills as Record<string, unknown>)
      : {};
  const existing = Array.isArray(skills.paths)
    ? skills.paths.filter((entry): entry is string => typeof entry === "string")
    : [];
  return JSON.stringify({
    ...config,
    skills: {
      ...skills,
      paths: [...existing, ...paths.filter((path) => !existing.includes(path))],
    },
  });
}

/**
 * Create (or reuse) the delivery root for `ids`. Built in a staging folder and
 * renamed into place, so a session never sees a half-built root and two
 * sessions racing on the same set both end up with a complete one.
 */
export async function materializeSkillDeliveryRoot(input: {
  readonly runtimeDirectory: string;
  readonly libraryDirectory: string;
  readonly ids: ReadonlyArray<string>;
}): Promise<{ readonly root: string; readonly skillsDirectory: string }> {
  const root = NodePath.join(input.runtimeDirectory, skillDeliveryKey(input.ids));
  const skillsDirectory = NodePath.join(root, "skills");
  const complete = await NodeFSP.stat(NodePath.join(root, ".claude-plugin", "plugin.json"))
    .then(() => true)
    .catch(() => false);
  if (complete) return { root, skillsDirectory };

  await NodeFSP.mkdir(input.runtimeDirectory, { recursive: true });
  const staging = await NodeFSP.mkdtemp(NodePath.join(input.runtimeDirectory, ".staging-"));
  try {
    await NodeFSP.mkdir(NodePath.join(staging, ".claude-plugin"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(staging, "skills"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(staging, ".claude-plugin", "plugin.json"),
      `${JSON.stringify(
        {
          name: CLAUDE_SKILL_PLUGIN_NAME,
          description: "Skills from the T3 Code skill library.",
        },
        null,
        2,
      )}\n`,
    );
    for (const id of input.ids) {
      // Junctions on Windows need no privileges; the type is ignored elsewhere.
      await NodeFSP.symlink(
        NodePath.join(input.libraryDirectory, id),
        NodePath.join(staging, "skills", id),
        "junction",
      );
    }
    await NodeFSP.rename(staging, root).catch(async (cause: NodeJS.ErrnoException) => {
      // Another session finished the same root first.
      if (cause.code !== "EEXIST" && cause.code !== "ENOTEMPTY") throw cause;
    });
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
  return { root, skillsDirectory };
}

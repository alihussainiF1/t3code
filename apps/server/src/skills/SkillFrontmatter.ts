/**
 * SkillFrontmatter - parses and validates a SKILL.md for the skill library.
 *
 * The Agent Skills format requires YAML frontmatter with `name` and
 * `description`. Library skills are stricter than provider discovery (which
 * tolerates missing descriptions) because every provider's progressive
 * disclosure works off the description: a skill without one is never picked.
 *
 * @module skills/SkillFrontmatter
 */
import { parse as parseYamlDocument } from "yaml";

const FRONTMATTER_PATTERN = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESCRIPTION_LENGTH = 1024;

export type SkillFrontmatterResult =
  | { readonly ok: true; readonly name: string; readonly description: string }
  | { readonly ok: false; readonly error: string };

/** Parse SKILL.md text and check the fields every provider relies on. */
export function parseSkillFrontmatter(contents: string): SkillFrontmatterResult {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return {
      ok: false,
      error: "SKILL.md must start with YAML frontmatter between --- lines.",
    };
  }
  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch (cause) {
    return {
      ok: false,
      error: `Frontmatter is not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Frontmatter must be a YAML mapping." };
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!name) return { ok: false, error: "Frontmatter needs a `name`." };
  if (!description) return { ok: false, error: "Frontmatter needs a `description`." };
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: `The description is ${description.length} characters; keep it under ${MAX_DESCRIPTION_LENGTH}.`,
    };
  }
  if (skillIdFromName(name) === undefined) {
    return {
      ok: false,
      error: "The name needs at least one letter or digit.",
    };
  }
  return { ok: true, name, description };
}

/**
 * The library id (and folder name) for a skill name. Agent Skills names are
 * already in this form; anything else is lowercased and hyphenated so every
 * provider can invoke it as `$<id>`. Undefined when nothing usable remains.
 */
export function skillIdFromName(name: string): string | undefined {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return SKILL_ID_PATTERN.test(slug) ? slug : undefined;
}

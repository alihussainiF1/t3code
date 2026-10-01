import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * Skills: Agent Skills (a folder with a `SKILL.md` carrying `name` and
 * `description` frontmatter, plus optional scripts and resources) that the
 * user manages once in T3 and every provider session receives. T3 owns the
 * library: files live under the server's state directory and the index lives
 * in settings; provider adapters only deliver the resolved set natively or as
 * an instruction index.
 */

/**
 * Key of one `settings.skills` entry and the skill's folder name. The Agent
 * Skills name grammar (lowercase letters, digits, hyphens), so every provider
 * can invoke it as `$<id>` or `/<id>` without renaming.
 */
export const SkillId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
).pipe(Schema.brand("SkillId"));
export type SkillId = typeof SkillId.Type;

/** Where a library skill came from, so it can be updated from the same place. */
export const SkillSource = Schema.Union([
  /** Written in T3's editor. */
  Schema.Struct({ type: Schema.Literal("local") }),
  /** Fetched from a GitHub repository (folder `path` at `ref`). */
  Schema.Struct({
    type: Schema.Literal("github"),
    owner: TrimmedNonEmptyString,
    repo: TrimmedNonEmptyString,
    /** Branch, tag, or commit. Empty means the default branch. */
    ref: Schema.String,
    /** Folder inside the repository holding SKILL.md; empty for the root. */
    path: Schema.String,
  }),
  /** Copied from a provider's skill folder on this machine. */
  Schema.Struct({ type: Schema.Literal("imported"), path: TrimmedNonEmptyString }),
]);
export type SkillSource = typeof SkillSource.Type;

export const SkillConfig = Schema.Struct({
  /** Mirrors the SKILL.md frontmatter; refreshed whenever the file is written. */
  name: TrimmedNonEmptyString,
  description: Schema.String,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  /**
   * Provider drivers that receive this skill. Absent means every provider;
   * an empty list means none.
   */
  providers: Schema.optionalKey(Schema.Array(ProviderDriverKind)),
  source: SkillSource,
  updatedAt: IsoDateTime,
});
export type SkillConfig = typeof SkillConfig.Type;

// ── Gallery ─────────────────────────────────────────────────────────────

export const SkillGalleryEntry = Schema.Struct({
  id: SkillId,
  description: Schema.String,
  /** Who publishes it, for display. */
  publisher: Schema.String,
  /** github.com URL of the skill folder, passed to `skills.install`. */
  url: Schema.String,
});
export type SkillGalleryEntry = typeof SkillGalleryEntry.Type;

const anthropicSkill = (id: string, description: string): SkillGalleryEntry => ({
  id: id as SkillId,
  description,
  publisher: "Anthropic",
  url: `https://github.com/anthropics/skills/tree/main/skills/${id}`,
});
const openAiSkill = (id: string, description: string): SkillGalleryEntry => ({
  id: id as SkillId,
  description,
  publisher: "OpenAI",
  url: `https://github.com/openai/skills/tree/main/skills/.curated/${id}`,
});

/**
 * One-click installs from the public skill repositories. Static so the
 * gallery renders without a network round trip; installing fetches the
 * folder fresh from GitHub.
 */
export const SKILL_GALLERY: ReadonlyArray<SkillGalleryEntry> = [
  anthropicSkill(
    "frontend-design",
    "Distinctive, intentional visual design for new or reshaped UI.",
  ),
  anthropicSkill("skill-creator", "Create, improve, and evaluate skills."),
  anthropicSkill("mcp-builder", "Build high-quality MCP servers for external APIs and services."),
  anthropicSkill(
    "webapp-testing",
    "Test local web apps with Playwright: screenshots, logs, UI checks.",
  ),
  anthropicSkill(
    "doc-coauthoring",
    "A structured workflow for writing specs, proposals, and docs.",
  ),
  anthropicSkill("pdf", "Read, merge, split, fill, and create PDF files."),
  anthropicSkill("docx", "Create and edit Word documents."),
  anthropicSkill("xlsx", "Read, edit, and build spreadsheets, including formulas and charts."),
  anthropicSkill("pptx", "Create and edit slide decks."),
  anthropicSkill("canvas-design", "Create posters and static visual art as PNG or PDF."),
  anthropicSkill(
    "web-artifacts-builder",
    "Build multi-component HTML artifacts with React and Tailwind.",
  ),
  openAiSkill("playwright", "Automate a real browser from the terminal with playwright-cli."),
  openAiSkill("gh-fix-ci", "Debug and fix failing GitHub Actions checks on a PR."),
  openAiSkill("gh-address-comments", "Address review comments on the current branch's PR."),
  openAiSkill("security-best-practices", "Language- and framework-specific security reviews."),
  openAiSkill("jupyter-notebook", "Scaffold and edit Jupyter notebooks."),
  openAiSkill("sentry", "Inspect Sentry issues and recent production errors."),
  openAiSkill("linear", "Read and manage Linear issues and projects."),
  openAiSkill("figma", "Turn Figma designs into code through the Figma MCP server."),
  openAiSkill("vercel-deploy", "Deploy apps and sites to Vercel."),
];

// ── Install / edit / update / delete ────────────────────────────────────

export const SkillInstallInput = Schema.Struct({
  /**
   * A GitHub URL: a repository, or a `tree/<ref>/<path>` folder URL. A folder
   * with a SKILL.md installs that skill; otherwise every skill folder below
   * it is installed.
   */
  url: TrimmedNonEmptyString,
});
export type SkillInstallInput = typeof SkillInstallInput.Type;

export const SkillInstallResult = Schema.Struct({
  skillIds: Schema.Array(SkillId),
  /** Skill folders that were found but not installed, with the reason. */
  skipped: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
});
export type SkillInstallResult = typeof SkillInstallResult.Type;

export const SkillReadInput = Schema.Struct({ skillId: SkillId });
export type SkillReadInput = typeof SkillReadInput.Type;

export const SkillReadResult = Schema.Struct({
  content: Schema.String,
  /** Absolute path of SKILL.md on the server. */
  path: Schema.String,
  /** Other files in the skill folder, relative to it. */
  files: Schema.Array(Schema.String),
});
export type SkillReadResult = typeof SkillReadResult.Type;

export const SkillSaveInput = Schema.Struct({
  /** Absent creates a new skill named by the frontmatter. */
  skillId: Schema.optionalKey(SkillId),
  content: Schema.String,
  /** Provider allowlist to store with it; null allows every provider, absent keeps the current one. */
  providers: Schema.optionalKey(Schema.NullOr(Schema.Array(ProviderDriverKind))),
});
export type SkillSaveInput = typeof SkillSaveInput.Type;

export const SkillSaveResult = Schema.Struct({ skillId: SkillId });
export type SkillSaveResult = typeof SkillSaveResult.Type;

export const SkillUpdateInput = Schema.Struct({ skillId: SkillId });
export type SkillUpdateInput = typeof SkillUpdateInput.Type;

export const SkillDeleteInput = Schema.Struct({ skillId: SkillId });
export type SkillDeleteInput = typeof SkillDeleteInput.Type;

// ── Discovery of skills already installed for the provider CLIs ─────────

export const SkillDiscoverySource = Schema.Literals([
  "claude-user",
  "claude-project",
  "codex-user",
  "agents-user",
  "agents-project",
]);
export type SkillDiscoverySource = typeof SkillDiscoverySource.Type;

export const DiscoveredSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  source: SkillDiscoverySource,
  /** Absolute path of the skill folder. */
  path: Schema.String,
  /** Id of the library skill with the same name, when already imported. */
  importedAs: Schema.optionalKey(SkillId),
  /** Why the folder cannot be imported (invalid frontmatter). */
  note: Schema.optionalKey(Schema.String),
});
export type DiscoveredSkill = typeof DiscoveredSkill.Type;

export const SkillDiscoverInput = Schema.Struct({
  /** Project directory to look for `.claude/skills` and `.agents/skills` in. */
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SkillDiscoverInput = typeof SkillDiscoverInput.Type;

export const SkillDiscoverResult = Schema.Struct({
  skills: Schema.Array(DiscoveredSkill),
});
export type SkillDiscoverResult = typeof SkillDiscoverResult.Type;

export const SkillImportInput = Schema.Struct({
  /** Folders from a discovery result. Paths discovery did not report are rejected. */
  paths: Schema.Array(TrimmedNonEmptyString),
  cwd: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SkillImportInput = typeof SkillImportInput.Type;

export class SkillError extends Schema.TaggedError<SkillError>()("SkillError", {
  skillId: Schema.optional(Schema.String),
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * The library skills a provider of `driver` receives on a thread: enabled,
 * allowed for that driver, and not turned off for the thread. Shared by the
 * server (delivery) and clients (composer menu) so both agree.
 */
export function resolveSkillsForProvider(
  skills: Readonly<Record<string, SkillConfig>>,
  driver: string,
  disabledForThread: ReadonlyArray<string> = [],
): ReadonlyArray<{ readonly id: SkillId; readonly config: SkillConfig }> {
  const disabled = new Set(disabledForThread);
  return Object.entries(skills)
    .filter(
      ([id, config]) =>
        config.enabled &&
        !disabled.has(id) &&
        (config.providers === undefined || config.providers.some((kind) => kind === driver)),
    )
    .map(([id, config]) => ({ id: id as SkillId, config }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

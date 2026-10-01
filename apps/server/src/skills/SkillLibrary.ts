// @effect-diagnostics nodeBuiltinImport:off - atomic folder swaps and lstat-aware copies
/**
 * SkillLibrary - the T3-managed skill library and its delivery to sessions.
 *
 * T3 is the source of truth: skill folders live under `<state>/skills/<id>`,
 * the index (name, description, enabled, provider allowlist, source) lives in
 * `settings.skills`, and provider adapters receive the resolved set through
 * `SkillDelivery`. Files are only written here, so every install, edit,
 * update, and import goes through the same validation.
 *
 * @module skills/SkillLibrary
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import {
  type DiscoveredSkill,
  type ProviderDriverKind,
  resolveSkillsForProvider,
  type SkillConfig,
  type SkillDeleteInput,
  type SkillDiscoverInput,
  type SkillDiscoverResult,
  SkillError,
  type SkillId,
  type SkillImportInput,
  type SkillInstallInput,
  type SkillInstallResult,
  type SkillReadInput,
  type SkillReadResult,
  type SkillSaveInput,
  type SkillSaveResult,
  type SkillSource,
  type SkillUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  findSkillFolders,
  gitHubTarballUrl,
  type GitHubSkillLocation,
  parseGitHubSkillUrl,
  parseTarArchive,
  type PlannedSkillFile,
  planSkillFiles,
  stripArchiveRoot,
} from "./SkillArchive.ts";
import {
  type DeliveredSkill,
  materializeSkillDeliveryRoot,
  type SessionSkills,
} from "./SkillDelivery.ts";
import { discoverSkillFolders, skillDiscoveryRoots } from "./SkillDiscovery.ts";
import { parseSkillFrontmatter, skillIdFromName } from "./SkillFrontmatter.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ResolveSessionSkillsInput {
  readonly provider: ProviderDriverKind;
  readonly disabledForThread: ReadonlyArray<string>;
}

export class SkillLibrary extends Context.Service<
  SkillLibrary,
  {
    /**
     * The skills a new provider session receives, with their delivery root
     * built. Undefined when there are none. Never fails: delivery problems
     * are logged and the session starts without library skills.
     */
    readonly resolveForSession: (
      input: ResolveSessionSkillsInput,
    ) => Effect.Effect<SessionSkills | undefined>;
    readonly install: (input: SkillInstallInput) => Effect.Effect<SkillInstallResult, SkillError>;
    readonly read: (input: SkillReadInput) => Effect.Effect<SkillReadResult, SkillError>;
    readonly save: (input: SkillSaveInput) => Effect.Effect<SkillSaveResult, SkillError>;
    readonly update: (input: SkillUpdateInput) => Effect.Effect<void, SkillError>;
    readonly remove: (input: SkillDeleteInput) => Effect.Effect<void, SkillError>;
    readonly discover: (input: SkillDiscoverInput) => Effect.Effect<SkillDiscoverResult>;
    readonly importSkills: (
      input: SkillImportInput,
    ) => Effect.Effect<SkillInstallResult, SkillError>;
  }
>()("t3/skills/SkillLibrary") {}

export interface SkillLibraryOptions {
  readonly fetch?: FetchLike;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
}

const fail = (operation: string, detail: string, skillId?: string) =>
  new SkillError({ operation, detail, ...(skillId ? { skillId } : {}) });

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_IMPORT_FILES = 2_000;
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

const sameSource = (left: SkillSource, right: SkillSource) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Regular files of a local skill folder, for import. Links are followed only
 * when they resolve inside the folder; anything else is rejected so an import
 * cannot pull files from elsewhere on the machine into the library.
 */
async function readLocalSkillFiles(folder: string): Promise<ReadonlyArray<PlannedSkillFile>> {
  const root = await NodeFSP.realpath(folder);
  const files: PlannedSkillFile[] = [];
  let bytes = 0;
  const walk = async (directory: string, relative: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const absolute = NodePath.join(directory, entry.name);
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const real = await NodeFSP.realpath(absolute);
      if (real !== root && !real.startsWith(`${root}${NodePath.sep}`)) {
        throw new Error(`'${entryRelative}' links outside the skill folder.`);
      }
      const stat = await NodeFSP.stat(real);
      if (stat.isDirectory()) {
        if (!entry.isSymbolicLink()) await walk(absolute, entryRelative);
        continue;
      }
      if (!stat.isFile()) continue;
      bytes += stat.size;
      if (files.length >= MAX_IMPORT_FILES || bytes > MAX_IMPORT_BYTES) {
        throw new Error("The skill folder is too large to import.");
      }
      files.push({
        path: entryRelative,
        data: await NodeFSP.readFile(real),
        executable: (stat.mode & 0o111) !== 0,
      });
    }
  };
  await walk(root, "");
  return files;
}

async function listSkillFiles(folder: string): Promise<ReadonlyArray<string>> {
  const files: string[] = [];
  const walk = async (directory: string, relative: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (files.length >= 200) return;
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(NodePath.join(directory, entry.name), entryRelative);
      else if (entryRelative !== "SKILL.md") files.push(entryRelative);
    }
  };
  await walk(folder, "");
  return files.toSorted();
}

export const make = (options: SkillLibraryOptions = {}) =>
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const config = yield* ServerConfig;
    const libraryDirectory = NodePath.join(config.stateDir, "skills");
    const runtimeDirectory = NodePath.join(config.stateDir, "skills-runtime");
    const fetchImpl: FetchLike =
      options.fetch ??
      // @effect-diagnostics-next-line globalFetch:off
      ((input, init) => fetch(input, init));
    const environment = options.environment ?? process.env;
    const homeDirectory = options.homeDirectory ?? NodeOS.homedir();
    // Installs read the index, write folders, then write the index; two at
    // once would each miss the other's entries.
    const writeLock = yield* Semaphore.make(1);

    const io = <A>(operation: string, run: () => Promise<A>, skillId?: string) =>
      Effect.tryPromise({ try: run, catch: (cause) => fail(operation, describe(cause), skillId) });

    const getSkills = settingsService.getSettings.pipe(
      Effect.map((settings) => settings.skills as Readonly<Record<string, SkillConfig>>),
      Effect.mapError((cause) => fail("read-settings", cause.message)),
    );
    const patchSkills = (patch: Record<string, SkillConfig | null>) =>
      settingsService
        .updateSettings({ skills: patch as Record<SkillId, SkillConfig | null> })
        .pipe(Effect.mapError((cause) => fail("write-settings", cause.message)));
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    /** Replace `<library>/<id>` with `files` atomically (staging + rename). */
    const writeSkillFolder = (id: string, files: ReadonlyArray<PlannedSkillFile>) =>
      io(
        "write-skill",
        async () => {
          await NodeFSP.mkdir(libraryDirectory, { recursive: true });
          const staging = await NodeFSP.mkdtemp(NodePath.join(libraryDirectory, ".staging-"));
          try {
            for (const file of files) {
              const target = NodePath.join(staging, ...file.path.split("/"));
              // planSkillFiles already confines paths; this guards local imports too.
              if (!target.startsWith(`${staging}${NodePath.sep}`)) {
                throw new Error(`'${file.path}' leaves the skill folder.`);
              }
              await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
              await NodeFSP.writeFile(target, file.data, { mode: file.executable ? 0o755 : 0o644 });
            }
            const destination = NodePath.join(libraryDirectory, id);
            const previous = `${staging}-previous`;
            const hadPrevious = await NodeFSP.rename(destination, previous)
              .then(() => true)
              .catch(() => false);
            await NodeFSP.rename(staging, destination);
            if (hadPrevious) await NodeFSP.rm(previous, { recursive: true, force: true });
          } finally {
            await NodeFSP.rm(staging, { recursive: true, force: true });
          }
        },
        id,
      );

    /**
     * Validate and write a batch of candidate skills, then index them in one
     * settings write. A candidate whose name another source already owns is
     * skipped rather than overwriting someone else's skill.
     */
    const installCandidates = (
      candidates: ReadonlyArray<{
        readonly label: string;
        readonly source: SkillSource;
        readonly files: ReadonlyArray<PlannedSkillFile>;
        /** Keep this id (updates), regardless of the frontmatter name. */
        readonly id?: string;
      }>,
      initialSkipped: SkillInstallResult["skipped"] = [],
    ) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* getSkills;
          const skipped = [...initialSkipped];
          const installed: string[] = [];
          const patch: Record<string, SkillConfig> = {};
          const updatedAt = yield* nowIso;
          for (const candidate of candidates) {
            const skillFile = candidate.files.find((file) => file.path === "SKILL.md");
            const parsed = skillFile
              ? parseSkillFrontmatter(new TextDecoder().decode(skillFile.data))
              : ({ ok: false, error: "The folder has no SKILL.md." } as const);
            if (!parsed.ok) {
              skipped.push({ path: candidate.label, reason: parsed.error });
              continue;
            }
            const id = candidate.id ?? skillIdFromName(parsed.name);
            if (!id) {
              skipped.push({ path: candidate.label, reason: "The skill name is not usable." });
              continue;
            }
            const current = existing[id] ?? patch[id];
            if (
              current &&
              candidate.id === undefined &&
              !sameSource(current.source, candidate.source)
            ) {
              skipped.push({
                path: candidate.label,
                reason: `A skill named "${id}" is already installed.`,
              });
              continue;
            }
            yield* writeSkillFolder(id, candidate.files);
            patch[id] = {
              name: parsed.name,
              description: parsed.description,
              enabled: current?.enabled ?? true,
              ...(current?.providers !== undefined ? { providers: current.providers } : {}),
              source: candidate.source,
              updatedAt,
            };
            installed.push(id);
          }
          if (installed.length > 0) yield* patchSkills(patch);
          return { skillIds: installed as SkillId[], skipped } satisfies SkillInstallResult;
        }),
      );

    const fetchGitHubArchive = (location: GitHubSkillLocation) =>
      io("download", async () => {
        const response = await fetchImpl(gitHubTarballUrl(location), {
          headers: { "user-agent": "t3code" },
        });
        if (response.status === 404) {
          throw new Error(
            `github.com/${location.owner}/${location.repo} was not found, or it is private.`,
          );
        }
        if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
        const compressed = new Uint8Array(await response.arrayBuffer());
        const archive = NodeZlib.gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES });
        return stripArchiveRoot(parseTarArchive(archive));
      });

    const installFromGitHub = (location: GitHubSkillLocation, keepId?: string) =>
      Effect.gen(function* () {
        const entries = yield* fetchGitHubArchive(location);
        const folders = findSkillFolders(entries, location.path);
        if (folders.length === 0) {
          return yield* fail(
            "install",
            `No SKILL.md found in ${location.path ? `'${location.path}'` : "the repository"}.`,
          );
        }
        if (keepId !== undefined && (folders.length !== 1 || folders[0] !== location.path)) {
          return yield* fail("update", "The skill folder is no longer in the repository.", keepId);
        }
        const skipped: Array<{ path: string; reason: string }> = [];
        const candidates = folders.flatMap((folder) => {
          const plan = planSkillFiles(entries, folder);
          if (!plan.ok) {
            skipped.push({ path: folder || "/", reason: plan.error });
            return [];
          }
          return [
            {
              label: folder || "/",
              source: { type: "github" as const, ...location, path: folder },
              files: plan.files,
              ...(keepId !== undefined ? { id: keepId } : {}),
            },
          ];
        });
        return yield* installCandidates(candidates, skipped);
      });

    const install = (input: SkillInstallInput) =>
      Effect.gen(function* () {
        const location = parseGitHubSkillUrl(input.url);
        if (!location) {
          return yield* fail(
            "install",
            "Enter a GitHub repository or folder URL, like https://github.com/owner/repo/tree/main/skills/name.",
          );
        }
        const result = yield* installFromGitHub(location);
        if (result.skillIds.length === 0) {
          return yield* fail(
            "install",
            result.skipped.map((entry) => `${entry.path}: ${entry.reason}`).join("\n") ||
              "Nothing was installed.",
          );
        }
        return result;
      });

    const requireSkill = (skillId: string, operation: string) =>
      Effect.gen(function* () {
        const skill = (yield* getSkills)[skillId];
        if (!skill) return yield* fail(operation, `No skill "${skillId}" in the library.`, skillId);
        return skill;
      });

    const read = (input: SkillReadInput) =>
      Effect.gen(function* () {
        yield* requireSkill(input.skillId, "read");
        const folder = NodePath.join(libraryDirectory, input.skillId);
        const skillFile = NodePath.join(folder, "SKILL.md");
        const content = yield* io("read", () => NodeFSP.readFile(skillFile, "utf8"), input.skillId);
        const files = yield* io("read", () => listSkillFiles(folder), input.skillId);
        return { content, path: skillFile, files } satisfies SkillReadResult;
      });

    const save = (input: SkillSaveInput) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const parsed = parseSkillFrontmatter(input.content);
          if (!parsed.ok) return yield* fail("save", parsed.error, input.skillId);
          const id = skillIdFromName(parsed.name)!;
          const skills = yield* getSkills;
          if (input.skillId !== undefined) {
            const current = skills[input.skillId];
            if (!current) {
              return yield* fail(
                "save",
                `No skill "${input.skillId}" in the library.`,
                input.skillId,
              );
            }
            // The folder name is the skill's identity for Claude Code and the
            // `$id` every composer inserts, so it cannot drift from the name.
            if (id !== input.skillId) {
              return yield* fail(
                "save",
                `Keep the name "${input.skillId}"; to rename a skill, create a new one.`,
                input.skillId,
              );
            }
          } else if (skills[id]) {
            return yield* fail("save", `A skill named "${id}" already exists.`, id);
          }
          const target = NodePath.join(libraryDirectory, id, "SKILL.md");
          yield* io(
            "save",
            async () => {
              await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
              await NodeFSP.writeFile(target, input.content);
            },
            id,
          );
          const current = skills[id];
          const providers =
            input.providers === undefined ? current?.providers : (input.providers ?? undefined);
          yield* patchSkills({
            [id]: {
              name: parsed.name,
              description: parsed.description,
              enabled: current?.enabled ?? true,
              ...(providers !== undefined ? { providers } : {}),
              source: current?.source ?? { type: "local" },
              updatedAt: yield* nowIso,
            },
          });
          return { skillId: id as SkillId } satisfies SkillSaveResult;
        }),
      );

    const update = (input: SkillUpdateInput) =>
      Effect.gen(function* () {
        const skill = yield* requireSkill(input.skillId, "update");
        if (skill.source.type === "github") {
          const { type: _type, ...location } = skill.source;
          const result = yield* installFromGitHub(location, input.skillId);
          if (result.skillIds.length === 0) {
            return yield* fail(
              "update",
              result.skipped[0]?.reason ?? "The skill could not be updated.",
              input.skillId,
            );
          }
          return;
        }
        if (skill.source.type === "imported") {
          const folder = skill.source.path;
          const files = yield* io("update", () => readLocalSkillFiles(folder), input.skillId);
          const result = yield* installCandidates([
            { label: folder, source: skill.source, files, id: input.skillId },
          ]);
          if (result.skillIds.length === 0) {
            return yield* fail(
              "update",
              result.skipped[0]?.reason ?? "Update failed.",
              input.skillId,
            );
          }
          return;
        }
        return yield* fail(
          "update",
          "Skills written in T3 have nothing to update from.",
          input.skillId,
        );
      });

    const remove = (input: SkillDeleteInput) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          yield* io(
            "delete",
            () =>
              NodeFSP.rm(NodePath.join(libraryDirectory, input.skillId), {
                recursive: true,
                force: true,
              }),
            input.skillId,
          );
          yield* patchSkills({ [input.skillId]: null });
        }),
      );

    const discoverFolders = (input: SkillDiscoverInput) =>
      Effect.promise(() =>
        discoverSkillFolders(skillDiscoveryRoots({ homeDirectory, environment, cwd: input.cwd })),
      );

    const discover = (input: SkillDiscoverInput) =>
      Effect.gen(function* () {
        const folders = yield* discoverFolders(input);
        const skills: Readonly<Record<string, SkillConfig>> = yield* getSkills.pipe(
          Effect.orElseSucceed(() => ({})),
        );
        return {
          skills: folders.map((folder): DiscoveredSkill => {
            const id = skillIdFromName(folder.name);
            return {
              name: folder.name,
              description: folder.description,
              source: folder.source,
              path: folder.path,
              ...(id && skills[id] ? { importedAs: id as SkillId } : {}),
              ...(folder.error ? { note: folder.error } : {}),
            };
          }),
        } satisfies SkillDiscoverResult;
      });

    const importSkills = (input: SkillImportInput) =>
      Effect.gen(function* () {
        // Only folders discovery reports may be imported: the RPC must not
        // become a way to copy arbitrary server paths into the library.
        const folders = yield* discoverFolders(input);
        const skipped: Array<{ path: string; reason: string }> = [];
        const candidates: Array<{
          label: string;
          source: SkillSource;
          files: ReadonlyArray<PlannedSkillFile>;
        }> = [];
        for (const path of input.paths) {
          const folder = folders.find((entry) => entry.path === path);
          if (!folder || folder.error) {
            skipped.push({ path, reason: folder?.error ?? "Not a discovered skill folder." });
            continue;
          }
          const files = yield* Effect.tryPromise(() => readLocalSkillFiles(path)).pipe(
            Effect.catch((cause) =>
              Effect.sync(() => {
                skipped.push({ path, reason: describe(cause) });
                return undefined;
              }),
            ),
          );
          if (files) candidates.push({ label: path, source: { type: "imported", path }, files });
        }
        return yield* installCandidates(candidates, skipped);
      });

    const resolveForSession = (input: ResolveSessionSkillsInput) =>
      Effect.gen(function* () {
        const skills = resolveSkillsForProvider(
          yield* getSkills,
          input.provider,
          input.disabledForThread,
        );
        if (skills.length === 0) return undefined;
        const ids = skills.map((skill) => skill.id);
        const { root, skillsDirectory } = yield* io("deliver", () =>
          materializeSkillDeliveryRoot({ runtimeDirectory, libraryDirectory, ids }),
        );
        return {
          root,
          skillsDirectory,
          skills: skills.map(({ id, config }): DeliveredSkill => ({
            id,
            name: config.name,
            description: config.description,
            skillFile: NodePath.join(libraryDirectory, id, "SKILL.md"),
          })),
        } satisfies SessionSkills;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not deliver library skills to this session.", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );

    return SkillLibrary.of({
      resolveForSession,
      install,
      read,
      save,
      update,
      remove,
      discover,
      importSkills,
    });
  });

export const layer = (options?: SkillLibraryOptions) => Layer.effect(SkillLibrary, make(options));

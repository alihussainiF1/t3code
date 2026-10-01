// @effect-diagnostics nodeBuiltinImport:off - pure POSIX path math over archive entries
/**
 * SkillArchive - reads skill folders out of a repository tarball.
 *
 * Skills install from GitHub's tarball endpoint so the server needs neither a
 * git binary nor a tar binary. Archives are untrusted: every entry is
 * normalized inside the skill folder, links are only honored when they point
 * at a regular file inside the same skill, and sizes are capped. Nothing here
 * touches the filesystem; the library writes the planned files.
 *
 * @module skills/SkillArchive
 */
import * as NodePath from "node:path";

export interface TarEntry {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "hardlink" | "other";
  readonly data: Uint8Array;
  readonly linkTarget: string;
  readonly mode: number;
}

const BLOCK = 512;
const textDecoder = new TextDecoder();

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return textDecoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  // GNU base-256 for sizes over 8 GiB; far beyond any skill, so refuse it.
  if ((block[offset] ?? 0) & 0x80) return Number.NaN;
  const text = readString(block, offset, length).trim();
  return text.length === 0 ? 0 : Number.parseInt(text, 8);
}

function parsePaxRecords(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  const text = textDecoder.decode(data);
  let index = 0;
  while (index < text.length) {
    const space = text.indexOf(" ", index);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(index, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, index + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    index += length;
  }
  return records;
}

/**
 * Parse an uncompressed tar archive (ustar, pax, and GNU long names). Throws
 * on a truncated or malformed archive.
 */
export function parseTarArchive(archive: Uint8Array): ReadonlyArray<TarEntry> {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingPath: string | undefined;
  let pendingLink: string | undefined;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = readOctal(header, 124, 12);
    if (!Number.isFinite(size) || size < 0) throw new Error("Archive entry has an invalid size.");
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw new Error("Archive is truncated.");
    const data = archive.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    const typeFlag = String.fromCharCode(header[156] ?? 0);
    if (typeFlag === "x") {
      const records = parsePaxRecords(data);
      pendingPath = records.get("path") ?? pendingPath;
      pendingLink = records.get("linkpath") ?? pendingLink;
      continue;
    }
    if (typeFlag === "g") continue;
    if (typeFlag === "L") {
      pendingPath = readString(data, 0, data.length);
      continue;
    }
    if (typeFlag === "K") {
      pendingLink = readString(data, 0, data.length);
      continue;
    }

    const isUstar = readString(header, 257, 5) === "ustar";
    const prefix = isUstar ? readString(header, 345, 155) : "";
    const name = readString(header, 0, 100);
    const path = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    const linkTarget = pendingLink ?? readString(header, 157, 100);
    pendingPath = undefined;
    pendingLink = undefined;
    entries.push({
      path,
      type:
        typeFlag === "0" || typeFlag === "\0" || typeFlag === "7"
          ? "file"
          : typeFlag === "5"
            ? "directory"
            : typeFlag === "2"
              ? "symlink"
              : typeFlag === "1"
                ? "hardlink"
                : "other",
      data,
      linkTarget,
      mode: readOctal(header, 100, 8) || 0o644,
    });
  }
  return entries;
}

/**
 * Normalize an archive path to forward slashes without `.` segments.
 * Undefined for absolute paths and anything that climbs out with `..`.
 */
export function normalizeArchivePath(path: string): string | undefined {
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\0")) return undefined;
  const normalized = NodePath.posix.normalize(path.replaceAll("\\", "/"));
  if (normalized === "." || normalized === "") return "";
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized.replace(/\/+$/, "");
}

/** GitHub tarballs wrap the tree in one `<owner>-<repo>-<sha>/` folder. */
export function stripArchiveRoot(entries: ReadonlyArray<TarEntry>): ReadonlyArray<TarEntry> {
  return entries.flatMap((entry) => {
    const slash = entry.path.indexOf("/");
    if (slash === -1) return [];
    return [{ ...entry, path: entry.path.slice(slash + 1) }];
  });
}

const MAX_SKILL_DEPTH = 6;
const MAX_SKILLS_PER_INSTALL = 100;

/**
 * Folders (relative to the archive root) that hold a SKILL.md at or below
 * `subpath`. A `subpath` that is itself a skill yields only that folder, so a
 * skill's bundled examples are never installed as separate skills.
 */
export function findSkillFolders(
  entries: ReadonlyArray<TarEntry>,
  subpath: string,
): ReadonlyArray<string> {
  const base = normalizeArchivePath(subpath);
  if (base === undefined) return [];
  const folders = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    const path = normalizeArchivePath(entry.path);
    if (path === undefined || NodePath.posix.basename(path) !== "SKILL.md") continue;
    const folder = NodePath.posix.dirname(path) === "." ? "" : NodePath.posix.dirname(path);
    if (base !== "" && folder !== base && !folder.startsWith(`${base}/`)) continue;
    const depth =
      base === "" ? folder.split("/").length : folder.slice(base.length).split("/").length - 1;
    if (depth > MAX_SKILL_DEPTH) continue;
    folders.add(folder);
  }
  if (folders.has(base)) return [base];
  // Skills nested inside another skill are its resources, not separate skills.
  const sorted = [...folders].toSorted();
  const outermost = sorted.filter(
    (folder) =>
      !sorted.some((other) => other !== folder && (other === "" || folder.startsWith(`${other}/`))),
  );
  return outermost.slice(0, MAX_SKILLS_PER_INSTALL);
}

export interface PlannedSkillFile {
  /** Path inside the skill folder, forward slashes. */
  readonly path: string;
  readonly data: Uint8Array;
  readonly executable: boolean;
}

export type SkillFilePlan =
  | { readonly ok: true; readonly files: ReadonlyArray<PlannedSkillFile> }
  | { readonly ok: false; readonly error: string };

const MAX_SKILL_FILES = 2_000;
const MAX_SKILL_BYTES = 25 * 1024 * 1024;

/**
 * The files to write for the skill at `folder`. Fails the whole skill when an
 * entry or link escapes the folder: a skill that reaches outside itself is
 * not one T3 should install, even partially. Links inside the folder are
 * written as copies of their target so the installed skill holds no links.
 */
export function planSkillFiles(entries: ReadonlyArray<TarEntry>, folder: string): SkillFilePlan {
  const prefix = folder === "" ? "" : `${folder}/`;
  const files = new Map<string, TarEntry>();
  const links: Array<{ path: string; entry: TarEntry }> = [];
  for (const entry of entries) {
    const normalized = normalizeArchivePath(entry.path);
    const textuallyInside = entry.path.startsWith(prefix);
    const inside = normalized !== undefined && normalized.startsWith(prefix);
    // Only normalized paths under the folder are ever written, so traversal
    // cannot land outside it; an entry that looks inside but climbs out
    // (`skill/../../x`) still marks the archive as hostile.
    if (textuallyInside && !inside) {
      return { ok: false, error: `Archive entry '${entry.path}' leaves the skill folder.` };
    }
    if (!inside) continue;
    const relative = normalized.slice(prefix.length);
    if (relative === "" || entry.type === "directory" || entry.type === "other") continue;
    if (entry.type === "file") files.set(relative, entry);
    else links.push({ path: relative, entry });
  }

  const resolved = new Map<string, PlannedSkillFile>();
  for (const [path, entry] of files) {
    resolved.set(path, { path, data: entry.data, executable: (entry.mode & 0o111) !== 0 });
  }
  for (const { path, entry } of links) {
    const target =
      entry.type === "hardlink"
        ? normalizeArchivePath(entry.linkTarget)
        : normalizeArchivePath(
            NodePath.posix.join(NodePath.posix.dirname(`${prefix}${path}`), entry.linkTarget),
          );
    if (target === undefined || !target.startsWith(prefix) || entry.linkTarget.startsWith("/")) {
      return { ok: false, error: `Link '${path}' points outside the skill folder.` };
    }
    const targetEntry = files.get(target.slice(prefix.length));
    // Links to folders or to other links are skipped rather than followed.
    if (!targetEntry) continue;
    resolved.set(path, {
      path,
      data: targetEntry.data,
      executable: (targetEntry.mode & 0o111) !== 0,
    });
  }

  if (!resolved.has("SKILL.md")) return { ok: false, error: "The folder has no SKILL.md." };
  if (resolved.size > MAX_SKILL_FILES) {
    return { ok: false, error: `The skill has more than ${MAX_SKILL_FILES} files.` };
  }
  const totalBytes = [...resolved.values()].reduce((sum, file) => sum + file.data.length, 0);
  if (totalBytes > MAX_SKILL_BYTES) {
    return { ok: false, error: "The skill is larger than 25 MB." };
  }
  return {
    ok: true,
    files: [...resolved.values()].toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

export interface GitHubSkillLocation {
  readonly owner: string;
  readonly repo: string;
  /** Empty means the default branch. */
  readonly ref: string;
  readonly path: string;
}

/**
 * Parse `https://github.com/<owner>/<repo>[/tree|blob/<ref>/<path>]` (or the
 * `<owner>/<repo>` shorthand). A ref containing `/` cannot be told apart from
 * the path in a URL, so the first segment after `tree/` is taken as the ref,
 * matching how GitHub's own links for branch names without slashes read.
 */
export function parseGitHubSkillUrl(input: string): GitHubSkillLocation | undefined {
  const trimmed = input
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const shorthand = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(trimmed);
  if (shorthand) return { owner: shorthand[1]!, repo: shorthand[2]!, ref: "", path: "" };
  let url: URL;
  try {
    url = new URL(trimmed.startsWith("github.com/") ? `https://${trimmed}` : trimmed);
  } catch {
    return undefined;
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return undefined;
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [owner, repo, kind, ref, ...rest] = segments;
  if (!owner || !repo) return undefined;
  if (kind === undefined) return { owner, repo, ref: "", path: "" };
  if ((kind !== "tree" && kind !== "blob") || !ref) return undefined;
  // A blob link to SKILL.md means its folder.
  const path = kind === "blob" && rest.at(-1) === "SKILL.md" ? rest.slice(0, -1) : rest;
  const normalized = normalizeArchivePath(path.join("/"));
  if (normalized === undefined) return undefined;
  return { owner, repo, ref, path: normalized };
}

export function gitHubSkillUrl(location: GitHubSkillLocation): string {
  const base = `https://github.com/${location.owner}/${location.repo}`;
  if (!location.ref && !location.path) return base;
  return `${base}/tree/${location.ref || "HEAD"}${location.path ? `/${location.path}` : ""}`;
}

export function gitHubTarballUrl(location: GitHubSkillLocation): string {
  return `https://codeload.github.com/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}/tar.gz/${encodeURIComponent(location.ref || "HEAD")}`;
}

import { describe, expect, it } from "vite-plus/test";

import {
  findSkillFolders,
  gitHubTarballUrl,
  normalizeArchivePath,
  parseGitHubSkillUrl,
  parseTarArchive,
  planSkillFiles,
  stripArchiveRoot,
} from "./SkillArchive.ts";
import { makeTar, type TestEntry } from "./SkillArchive.testFixtures.ts";

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\n---\nBody\n`;

describe("parseTarArchive", () => {
  it("reads files, folders, links, and pax long paths", () => {
    const longPath = `root/${"a".repeat(120)}/SKILL.md`;
    const entries = parseTarArchive(
      makeTar([
        { path: "root/", type: "5" },
        { path: "root/x.sh", content: "echo", mode: 0o755 },
        { path: "root/link", type: "2", link: "x.sh" },
        { path: longPath, content: "long" },
      ]),
    );
    expect(entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["root/", "directory"],
      ["root/x.sh", "file"],
      ["root/link", "symlink"],
      [longPath, "file"],
    ]);
    expect(entries[1]?.mode).toBe(0o755);
    expect(new TextDecoder().decode(entries[3]?.data)).toBe("long");
  });

  it("rejects a truncated archive", () => {
    const archive = makeTar([{ path: "root/file", content: "x".repeat(2000) }]);
    expect(() => parseTarArchive(archive.subarray(0, 1024))).toThrow(/truncated/);
  });
});

describe("normalizeArchivePath", () => {
  it("refuses absolute and climbing paths", () => {
    expect(normalizeArchivePath("a/./b/")).toBe("a/b");
    expect(normalizeArchivePath("/etc/passwd")).toBeUndefined();
    expect(normalizeArchivePath("C:/x")).toBeUndefined();
    expect(normalizeArchivePath("a/../../x")).toBeUndefined();
    expect(normalizeArchivePath("a/../b")).toBe("b");
  });
});

describe("findSkillFolders", () => {
  const entries = stripArchiveRoot(
    parseTarArchive(
      makeTar([
        { path: "repo-sha/README.md", content: "readme" },
        { path: "repo-sha/skills/pdf/SKILL.md", content: skillMd("pdf") },
        { path: "repo-sha/skills/pdf/examples/demo/SKILL.md", content: skillMd("demo") },
        { path: "repo-sha/skills/docx/SKILL.md", content: skillMd("docx") },
      ]),
    ),
  );

  it("finds every outermost skill below a folder", () => {
    expect(findSkillFolders(entries, "")).toEqual(["skills/docx", "skills/pdf"]);
    expect(findSkillFolders(entries, "skills")).toEqual(["skills/docx", "skills/pdf"]);
  });

  it("returns only the skill itself when pointed at one", () => {
    expect(findSkillFolders(entries, "skills/pdf")).toEqual(["skills/pdf"]);
  });

  it("finds nothing outside the requested folder", () => {
    expect(findSkillFolders(entries, "docs")).toEqual([]);
    expect(findSkillFolders(entries, "../x")).toEqual([]);
  });
});

describe("planSkillFiles", () => {
  const plan = (entries: ReadonlyArray<TestEntry>, folder = "skills/a") =>
    planSkillFiles(stripArchiveRoot(parseTarArchive(makeTar(entries))), folder);

  it("plans the folder's files relative to it, copying internal links", () => {
    const result = plan([
      { path: "r/skills/a/SKILL.md", content: skillMd("a") },
      { path: "r/skills/a/scripts/run.sh", content: "echo", mode: 0o755 },
      { path: "r/skills/a/run", type: "2", link: "scripts/run.sh" },
      { path: "r/skills/b/SKILL.md", content: skillMd("b") },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((file) => [file.path, file.executable])).toEqual([
      ["run", true],
      ["scripts/run.sh", true],
      ["SKILL.md", false],
    ]);
  });

  it("rejects an entry that climbs out of the folder", () => {
    const result = plan([
      { path: "r/skills/a/SKILL.md", content: skillMd("a") },
      { path: "r/skills/a/../../../evil", content: "x" },
    ]);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/leaves the skill folder/) });
  });

  it("rejects links that point outside the folder", () => {
    for (const link of ["../b/SKILL.md", "/etc/passwd", "../../../../etc/passwd"]) {
      const result = plan([
        { path: "r/skills/a/SKILL.md", content: skillMd("a") },
        { path: "r/skills/b/SKILL.md", content: skillMd("b") },
        { path: "r/skills/a/leak", type: "2", link },
      ]);
      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(/outside the skill folder/),
      });
    }
  });

  it("requires a SKILL.md", () => {
    expect(plan([{ path: "r/skills/a/README.md", content: "x" }])).toEqual({
      ok: false,
      error: "The folder has no SKILL.md.",
    });
  });
});

describe("parseGitHubSkillUrl", () => {
  it("reads repository, folder, and blob URLs", () => {
    expect(parseGitHubSkillUrl("https://github.com/anthropics/skills")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "",
      path: "",
    });
    expect(
      parseGitHubSkillUrl("https://github.com/openai/skills/tree/main/skills/.curated/linear/"),
    ).toEqual({ owner: "openai", repo: "skills", ref: "main", path: "skills/.curated/linear" });
    expect(
      parseGitHubSkillUrl("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md"),
    ).toEqual({ owner: "anthropics", repo: "skills", ref: "main", path: "skills/pdf" });
    expect(parseGitHubSkillUrl("owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
      ref: "",
      path: "",
    });
  });

  it("rejects other hosts and traversal", () => {
    expect(parseGitHubSkillUrl("https://gitlab.com/a/b")).toBeUndefined();
    expect(parseGitHubSkillUrl("https://github.com/a/b/tree/main/../../x")).toBeUndefined();
    expect(parseGitHubSkillUrl("not a url")).toBeUndefined();
  });

  it("downloads the default branch when no ref is given", () => {
    expect(gitHubTarballUrl({ owner: "a", repo: "b", ref: "", path: "" })).toBe(
      "https://codeload.github.com/a/b/tar.gz/HEAD",
    );
  });
});

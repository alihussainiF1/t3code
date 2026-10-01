import { describe, expect, it } from "vite-plus/test";

import { parseSkillFrontmatter, skillIdFromName } from "./SkillFrontmatter.ts";

describe("parseSkillFrontmatter", () => {
  it("reads name and description", () => {
    expect(
      parseSkillFrontmatter('---\nname: "pdf"\ndescription: >\n  Work with PDFs.\n---\n# PDF\n'),
    ).toEqual({ ok: true, name: "pdf", description: "Work with PDFs." });
  });

  it("requires frontmatter, a name, and a description", () => {
    expect(parseSkillFrontmatter("# No frontmatter")).toMatchObject({ ok: false });
    expect(parseSkillFrontmatter("---\ndescription: x\n---\n")).toEqual({
      ok: false,
      error: "Frontmatter needs a `name`.",
    });
    expect(parseSkillFrontmatter("---\nname: x\n---\n")).toEqual({
      ok: false,
      error: "Frontmatter needs a `description`.",
    });
  });

  it("reports invalid YAML and oversized descriptions", () => {
    expect(parseSkillFrontmatter("---\nname: [unclosed\n---\n")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not valid YAML/),
    });
    expect(
      parseSkillFrontmatter(`---\nname: x\ndescription: ${"d".repeat(1100)}\n---\n`),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/keep it under 1024/) });
  });

  it("rejects names with nothing usable", () => {
    expect(parseSkillFrontmatter("---\nname: '!!!'\ndescription: x\n---\n")).toMatchObject({
      ok: false,
    });
  });
});

describe("skillIdFromName", () => {
  it("keeps Agent Skills names and slugs everything else", () => {
    expect(skillIdFromName("frontend-design")).toBe("frontend-design");
    expect(skillIdFromName("My Cool_Skill!")).toBe("my-cool-skill");
    expect(skillIdFromName("../etc")).toBe("etc");
    expect(skillIdFromName("---")).toBeUndefined();
    expect(skillIdFromName("a".repeat(80))).toHaveLength(64);
  });
});

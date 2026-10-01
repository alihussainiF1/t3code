import { SKILL_GALLERY, type SkillConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  galleryInstallState,
  importableDiscoveredSkills,
  skillCanUpdate,
  skillSourceLabel,
} from "./SkillsSettings.logic";

const github = (path: string): SkillConfig["source"] => ({
  type: "github",
  owner: "anthropics",
  repo: "skills",
  ref: "main",
  path,
});
const config = (source: SkillConfig["source"]): SkillConfig => ({
  name: "pdf",
  description: "",
  enabled: true,
  source,
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("galleryInstallState", () => {
  const pdf = SKILL_GALLERY.find((entry) => entry.id === "pdf")!;

  it("knows the gallery folder it installed from", () => {
    expect(galleryInstallState(pdf, {})).toBe("installable");
    expect(galleryInstallState(pdf, { pdf: config(github("skills/pdf")) })).toBe("installed");
    expect(galleryInstallState(pdf, { pdf: config({ type: "local" }) })).toBe("name-taken");
  });
});

describe("skill sources", () => {
  it("labels sources and only offers updates for fetched or imported skills", () => {
    expect(skillSourceLabel(github("skills/pdf"))).toBe("GitHub · anthropics/skills/skills/pdf");
    expect(skillCanUpdate({ type: "local" })).toBe(false);
    expect(skillCanUpdate({ type: "imported", path: "/x" })).toBe(true);
  });
});

describe("importableDiscoveredSkills", () => {
  it("skips invalid, imported, and repeated names", () => {
    const base = { description: "", source: "claude-user" as const };
    expect(
      importableDiscoveredSkills([
        { ...base, name: "a", path: "/1/a" },
        { ...base, name: "A", path: "/2/a", source: "codex-user" },
        { ...base, name: "b", path: "/1/b", note: "Frontmatter needs a `name`." },
        { ...base, name: "c", path: "/1/c", importedAs: "c" as never },
      ]).map((skill) => skill.path),
    ).toEqual(["/1/a"]);
  });
});

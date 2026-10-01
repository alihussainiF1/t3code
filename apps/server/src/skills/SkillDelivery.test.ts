// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildSkillIndexInstructions,
  materializeSkillDeliveryRoot,
  skillDeliveryKey,
  withOpenCodeSkillPaths,
} from "./SkillDelivery.ts";
import { buildRuntimeInstructions } from "../provider/RuntimeInstructions.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

const skill = (id: string, description = `Does ${id}.`) => ({
  id,
  name: id,
  description,
  skillFile: `/lib/${id}/SKILL.md`,
});

describe("buildSkillIndexInstructions", () => {
  it("lists each skill with its SKILL.md path and nothing when empty", () => {
    const text = buildSkillIndexInstructions([skill("pdf"), skill("docx", "Line\n  two")]);
    expect(text).toContain("- pdf: Does pdf. (/lib/pdf/SKILL.md)");
    expect(text).toContain("- docx: Line two (/lib/docx/SKILL.md)");
    expect(text).toContain("$<name>");
    expect(buildSkillIndexInstructions([])).toBe("");
  });

  it("truncates long descriptions so the per-turn index stays small", () => {
    const line = buildSkillIndexInstructions([skill("long", "x".repeat(1000))])
      .split("\n")
      .find((entry) => entry.startsWith("- long"));
    expect(line?.length).toBeLessThan(360);
  });

  it("rides along with the runtime instructions only when skills are present", () => {
    expect(buildRuntimeInstructions({ harness: "Cursor" })).not.toContain("<skills>");
    expect(buildRuntimeInstructions({ harness: "Cursor", skills: [skill("pdf")] })).toContain(
      "<skills>",
    );
  });
});

describe("withOpenCodeSkillPaths", () => {
  it("adds paths while keeping the user's config and existing paths", () => {
    const merged = JSON.parse(
      withOpenCodeSkillPaths(
        JSON.stringify({ model: "x", skills: { paths: ["/mine"], urls: ["u"] } }),
        ["/t3", "/mine"],
      ),
    );
    expect(merged).toEqual({ model: "x", skills: { paths: ["/mine", "/t3"], urls: ["u"] } });
  });

  it("leaves unparseable or empty input alone", () => {
    expect(withOpenCodeSkillPaths("{nope", ["/t3"])).toBe("{nope");
    expect(withOpenCodeSkillPaths("{}", [])).toBe("{}");
    expect(JSON.parse(withOpenCodeSkillPaths("{}", ["/t3"]))).toEqual({
      skills: { paths: ["/t3"] },
    });
  });
});

describe("materializeSkillDeliveryRoot", () => {
  it("builds a Claude plugin root of links to the library, reused for the same set", async () => {
    const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skill-delivery-"));
    temporaryDirectories.push(base);
    const libraryDirectory = NodePath.join(base, "library");
    await NodeFSP.mkdir(NodePath.join(libraryDirectory, "pdf"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(libraryDirectory, "pdf", "SKILL.md"), "pdf");
    const input = {
      runtimeDirectory: NodePath.join(base, "runtime"),
      libraryDirectory,
      ids: ["pdf"],
    };

    const first = await materializeSkillDeliveryRoot(input);
    expect(first.root).toBe(NodePath.join(base, "runtime", skillDeliveryKey(["pdf"])));
    expect(
      JSON.parse(
        await NodeFSP.readFile(NodePath.join(first.root, ".claude-plugin/plugin.json"), "utf8"),
      ),
    ).toMatchObject({ name: "t3" });
    expect(
      await NodeFSP.readFile(NodePath.join(first.skillsDirectory, "pdf", "SKILL.md"), "utf8"),
    ).toBe("pdf");

    const [second, third] = await Promise.all([
      materializeSkillDeliveryRoot(input),
      materializeSkillDeliveryRoot(input),
    ]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    // No staging folders are left behind.
    expect(await NodeFSP.readdir(input.runtimeDirectory)).toEqual([skillDeliveryKey(["pdf"])]);
  });

  it("keys roots by the set, not its order", () => {
    expect(skillDeliveryKey(["b", "a"])).toBe(skillDeliveryKey(["a", "b"]));
    expect(skillDeliveryKey(["a"])).not.toBe(skillDeliveryKey(["a", "b"]));
  });
});

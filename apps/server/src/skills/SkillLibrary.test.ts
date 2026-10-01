// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, SkillId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { makeTar, type TestEntry } from "./SkillArchive.testFixtures.ts";
import * as SkillLibrary from "./SkillLibrary.ts";

const skillMd = (name: string, description = `Does ${name}.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nInstructions for ${name}.\n`;

/** GitHub's tarball endpoint over a mutable in-memory repository. */
function makeGitHub(initial: ReadonlyArray<TestEntry>) {
  let entries = initial;
  const requested: string[] = [];
  const fetch: SkillLibrary.FetchLike = async (url) => {
    requested.push(url);
    if (!url.startsWith("https://codeload.github.com/acme/skills/")) {
      return new Response("", { status: 404 });
    }
    const archive = NodeZlib.gzipSync(
      makeTar(entries.map((entry) => ({ ...entry, path: `acme-skills-sha/${entry.path}` }))),
    );
    return new Response(archive, { status: 200 });
  };
  return {
    fetch,
    requested,
    setEntries: (next: ReadonlyArray<TestEntry>) => {
      entries = next;
    },
  };
}

const makeLayer = (fetch: SkillLibrary.FetchLike, homeDirectory = "/nonexistent") => {
  const settings = ServerSettingsModule.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-skill-library-test-" })),
    ),
  );
  return SkillLibrary.layer({ fetch, environment: {}, homeDirectory }).pipe(
    Layer.provideMerge(settings),
  );
};

const codex = ProviderDriverKind.make("codex");
const cursor = ProviderDriverKind.make("cursor");

it.layer(NodeServices.layer)("SkillLibrary", (it) => {
  it.effect("installs a repository's skills, skipping broken ones, and updates from source", () => {
    const github = makeGitHub([
      { path: "skills/pdf/SKILL.md", content: skillMd("pdf") },
      { path: "skills/pdf/scripts/fill.py", content: "print(1)", mode: 0o755 },
      { path: "skills/broken/SKILL.md", content: "no frontmatter" },
      { path: "skills/evil/SKILL.md", content: skillMd("evil") },
      { path: "skills/evil/leak", type: "2", link: "../../../../etc/passwd" },
    ]);
    return Effect.gen(function* () {
      const library = yield* SkillLibrary.SkillLibrary;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;

      const result = yield* library.install({ url: "https://github.com/acme/skills" });
      assert.deepEqual(result.skillIds, [SkillId.make("pdf")]);
      assert.deepEqual(result.skipped.map((entry) => entry.path).toSorted(), [
        "skills/broken",
        "skills/evil",
      ]);
      assert.equal(github.requested[0], "https://codeload.github.com/acme/skills/tar.gz/HEAD");

      const pdf = (yield* settings.getSettings).skills[SkillId.make("pdf")];
      assert.deepEqual(pdf?.source, {
        type: "github",
        owner: "acme",
        repo: "skills",
        ref: "",
        path: "skills/pdf",
      });
      const script = NodePath.join(config.stateDir, "skills", "pdf", "scripts", "fill.py");
      assert.equal((yield* Effect.promise(() => NodeFSP.stat(script))).mode & 0o111, 0o111);

      // Updating re-fetches the same folder and keeps the user's choices.
      yield* settings.updateSettings({
        skills: { [SkillId.make("pdf")]: { ...pdf!, enabled: false } },
      });
      github.setEntries([{ path: "skills/pdf/SKILL.md", content: skillMd("pdf", "Newer.") }]);
      yield* library.update({ skillId: SkillId.make("pdf") });
      const updated = (yield* settings.getSettings).skills[SkillId.make("pdf")];
      assert.equal(updated?.description, "Newer.");
      assert.equal(updated?.enabled, false);
      // Files the new version dropped are gone.
      assert.isFalse(
        yield* Effect.promise(() =>
          NodeFSP.stat(script).then(
            () => true,
            () => false,
          ),
        ),
      );
    }).pipe(Effect.provide(makeLayer(github.fetch)));
  });

  it.effect("rejects URLs it cannot install and names it already owns", () => {
    const github = makeGitHub([{ path: "SKILL.md", content: skillMd("pdf") }]);
    return Effect.gen(function* () {
      const library = yield* SkillLibrary.SkillLibrary;
      const notGitHub = yield* library.install({ url: "https://gitlab.com/a/b" }).pipe(Effect.flip);
      assert.match(notGitHub.detail, /GitHub/);
      const missing = yield* library
        .install({ url: "https://github.com/nobody/x" })
        .pipe(Effect.flip);
      assert.match(missing.detail, /not found/);

      yield* library.save({ content: skillMd("pdf", "Mine.") });
      const taken = yield* library.install({ url: "acme/skills" }).pipe(Effect.flip);
      assert.match(taken.detail, /already installed/);
    }).pipe(Effect.provide(makeLayer(github.fetch)));
  });

  it.effect("creates and edits skills with frontmatter validation", () =>
    Effect.gen(function* () {
      const library = yield* SkillLibrary.SkillLibrary;
      const invalid = yield* library.save({ content: "# no frontmatter" }).pipe(Effect.flip);
      assert.match(invalid.detail, /frontmatter/);

      const { skillId } = yield* library.save({ content: skillMd("Release Notes") });
      assert.equal(skillId, "release-notes");
      const read = yield* library.read({ skillId });
      assert.include(read.content, "Instructions for Release Notes");

      yield* library.save({ skillId, content: skillMd("Release Notes", "Edited.") });
      assert.include((yield* library.read({ skillId })).content, "Edited.");

      const renamed = yield* library
        .save({ skillId, content: skillMd("other-name") })
        .pipe(Effect.flip);
      assert.match(renamed.detail, /Keep the name/);
      const duplicate = yield* library
        .save({ content: skillMd("release-notes") })
        .pipe(Effect.flip);
      assert.match(duplicate.detail, /already exists/);

      yield* library.remove({ skillId });
      const gone = yield* library.read({ skillId }).pipe(Effect.flip);
      assert.match(gone.detail, /No skill/);
    }).pipe(Effect.provide(makeLayer(makeGitHub([]).fetch))),
  );

  it.effect("delivers enabled skills per provider and thread", () =>
    Effect.gen(function* () {
      const library = yield* SkillLibrary.SkillLibrary;
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      assert.isUndefined(
        yield* library.resolveForSession({ provider: codex, disabledForThread: [] }),
      );

      yield* library.save({ content: skillMd("alpha") });
      yield* library.save({ content: skillMd("beta") });
      const beta = (yield* settings.getSettings).skills[SkillId.make("beta")]!;
      yield* settings.updateSettings({
        skills: { [SkillId.make("beta")]: { ...beta, providers: [cursor] } },
      });

      const forCodex = yield* library.resolveForSession({ provider: codex, disabledForThread: [] });
      assert.deepEqual(
        forCodex?.skills.map((skill) => skill.id),
        ["alpha"],
      );
      const linked = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(forCodex!.skillsDirectory, "alpha", "SKILL.md"), "utf8"),
      );
      assert.include(linked, "name: alpha");

      const forCursor = yield* library.resolveForSession({
        provider: cursor,
        disabledForThread: ["alpha"],
      });
      assert.deepEqual(
        forCursor?.skills.map((skill) => skill.id),
        ["beta"],
      );
      assert.notEqual(forCursor?.root, forCodex?.root);
    }).pipe(Effect.provide(makeLayer(makeGitHub([]).fetch))),
  );

  it.effect("imports only folders discovery reports", () => {
    const home = NodeOS.tmpdir();
    return Effect.gen(function* () {
      const base = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(home, "t3-skill-import-")),
      );
      const claudeSkill = NodePath.join(base, ".claude", "skills", "notes");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(claudeSkill, "ref"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(claudeSkill, "SKILL.md"), skillMd("notes"));
        await NodeFSP.writeFile(NodePath.join(claudeSkill, "ref", "guide.md"), "guide");
        await NodeFSP.mkdir(NodePath.join(base, ".agents", "skills", "bad"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(base, ".agents", "skills", "bad", "SKILL.md"), "x");
      });
      const result = yield* Effect.gen(function* () {
        const library = yield* SkillLibrary.SkillLibrary;
        const discovered = yield* library.discover({});
        assert.deepEqual(
          discovered.skills.map((skill) => [skill.source, skill.name, skill.note !== undefined]),
          [
            ["claude-user", "notes", false],
            ["agents-user", "bad", true],
          ],
        );
        const imported = yield* library.importSkills({
          paths: [claudeSkill, "/etc", NodePath.join(base, ".agents", "skills", "bad")],
        });
        const read = yield* library.read({ skillId: SkillId.make("notes") });
        const after = yield* library.discover({});
        return { imported, files: read.files, after };
      }).pipe(Effect.provide(makeLayer(makeGitHub([]).fetch, base)));
      yield* Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true }));

      assert.deepEqual(result.imported.skillIds, [SkillId.make("notes")]);
      assert.deepEqual(
        result.imported.skipped.map((entry) => entry.path),
        ["/etc", NodePath.join(base, ".agents", "skills", "bad")],
      );
      assert.deepEqual(result.files, ["ref/guide.md"]);
      assert.equal(result.after.skills[0]?.importedAs, "notes");
    });
  });
});

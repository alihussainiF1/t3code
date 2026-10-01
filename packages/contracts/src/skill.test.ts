import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "./providerInstance.ts";
import { ServerSettings } from "./settings.ts";
import { resolveSkillsForProvider, SKILL_GALLERY, type SkillConfig, SkillId } from "./skill.ts";

const skill = (overrides: Partial<SkillConfig> = {}): SkillConfig => ({
  name: "x",
  description: "x",
  enabled: true,
  source: { type: "local" },
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("resolveSkillsForProvider", () => {
  it("keeps enabled skills allowed for the driver and not turned off on the thread", () => {
    const skills = {
      zeta: skill(),
      alpha: skill(),
      off: skill({ enabled: false }),
      cursorOnly: skill({ providers: [ProviderDriverKind.make("cursor")] }),
      nowhere: skill({ providers: [] }),
      threadOff: skill(),
    };
    expect(
      resolveSkillsForProvider(skills, "codex", ["threadOff"]).map((entry) => entry.id),
    ).toEqual(["alpha", "zeta"]);
    expect(resolveSkillsForProvider(skills, "cursor").map((entry) => entry.id)).toEqual([
      "alpha",
      "cursorOnly",
      "threadOff",
      "zeta",
    ]);
  });
});

describe("skill schemas", () => {
  it("defaults the library to empty and restricts ids to the Agent Skills grammar", () => {
    expect(Schema.decodeSync(ServerSettings)({}).skills).toEqual({});
    const decodeId = Schema.decodeUnknownOption(SkillId);
    expect(decodeId("frontend-design")._tag).toBe("Some");
    expect(decodeId("Bad Name")._tag).toBe("None");
    expect(decodeId("../etc")._tag).toBe("None");
  });

  it("only lists gallery ids that are valid skill ids", () => {
    for (const entry of SKILL_GALLERY) {
      expect(Schema.decodeUnknownOption(SkillId)(entry.id)._tag).toBe("Some");
      expect(entry.url).toMatch(/^https:\/\/github\.com\//);
    }
  });
});

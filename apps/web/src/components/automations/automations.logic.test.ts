import { AutomationId, ProjectId, ProviderInstanceId, type Automation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  automationFormFromAutomation,
  automationInputFromForm,
  automationScheduleFromForm,
  emptyAutomationForm,
} from "./automations.logic";

const NOW = Date.parse("2026-10-01T08:00:00.000Z");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

describe("automations.logic", () => {
  it("builds preset schedules and reports what is missing", () => {
    const form = {
      ...emptyAutomationForm({
        projectId: ProjectId.make("project"),
        modelSelection,
        runtimeMode: "approval-required",
      }),
      timezone: "Europe/Berlin",
    };
    expect(automationInputFromForm(form, NOW)).toEqual({ error: "Give the automation a name." });

    const named = { ...form, name: " Triage ", prompt: "Look at new issues." };
    expect(automationScheduleFromForm({ ...named, scheduleMode: "weekly", weekday: 5 })).toEqual({
      cron: "0 9 * * 5",
      timezone: "Europe/Berlin",
    });
    expect(automationScheduleFromForm({ ...named, scheduleMode: "daily", time: "9" })).toBeNull();
    expect(
      automationInputFromForm({ ...named, scheduleMode: "custom", customCron: "bad" }, NOW),
    ).toMatchObject({ error: expect.stringMatching(/Invalid cron/) });

    const result = automationInputFromForm({ ...named, scheduleMode: "weekdays" }, NOW);
    expect(result).toMatchObject({
      input: { name: "Triage", schedule: { cron: "0 9 * * 1-5", timezone: "Europe/Berlin" } },
    });
  });

  it("reopens a saved automation on its preset, or as custom cron", () => {
    const automation: Automation = {
      id: AutomationId.make("automation"),
      name: "Weekly report",
      projectId: ProjectId.make("project"),
      prompt: "Write the report.",
      modelSelection,
      runtimeMode: "full-access",
      schedule: { cron: "30 17 * * 5", timezone: "UTC" },
      target: "same-thread",
      enabled: false,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      nextRunAt: null,
      lastRun: null,
    };
    expect(automationFormFromAutomation(automation)).toMatchObject({
      scheduleMode: "weekly",
      weekday: 5,
      time: "17:30",
      target: "same-thread",
      enabled: false,
    });
    expect(
      automationFormFromAutomation({
        ...automation,
        schedule: { cron: "*/10 * * * *", timezone: "UTC" },
      }),
    ).toMatchObject({ scheduleMode: "custom", customCron: "*/10 * * * *" });
  });
});

// @effect-diagnostics globalDate:off -- fixtures are plain instants.
import { describe, expect, it } from "vite-plus/test";

import {
  automationPresetToCron,
  cronToAutomationPreset,
  describeAutomationSchedule,
  dueAutomationSlots,
  nextAutomationRuns,
  validateAutomationSchedule,
} from "./automationSchedule.ts";

const ms = (iso: string) => Date.parse(iso);
const iso = (values: ReadonlyArray<number>) => values.map((value) => new Date(value).toISOString());

describe("automationSchedule", () => {
  it("runs a daily schedule exactly once per day across both DST transitions", () => {
    // 02:30 does not exist on the spring-forward day and 01:30 happens twice
    // on the fall-back day; each day must still produce exactly one slot.
    expect(
      iso(
        nextAutomationRuns(
          { cron: "30 2 * * *", timezone: "America/New_York" },
          ms("2026-03-07T12:00:00Z"),
          3,
        ),
      ),
    ).toEqual(["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);

    expect(
      iso(
        nextAutomationRuns(
          { cron: "30 1 * * *", timezone: "America/New_York" },
          ms("2026-10-31T12:00:00Z"),
          3,
        ),
      ),
    ).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z", "2026-11-03T06:30:00.000Z"]);
  });

  it("returns only the latest due slot after an outage", () => {
    const due = dueAutomationSlots(
      { cron: "0 * * * *", timezone: "UTC" },
      ms("2026-10-01T08:00:00Z"),
      ms("2026-10-01T11:30:00Z"),
    );
    expect(due).toEqual({ latestMs: ms("2026-10-01T11:00:00Z"), skippedEarlier: true });
    expect(
      dueAutomationSlots(
        { cron: "0 9 * * *", timezone: "UTC" },
        ms("2026-10-01T09:00:00Z"),
        ms("2026-10-01T12:00:00Z"),
      ),
    ).toBeNull();
  });

  it("round-trips presets and describes them in words", () => {
    for (const preset of [
      { kind: "hourly", minute: 15 },
      { kind: "daily", hour: 9, minute: 0 },
      { kind: "weekdays", hour: 17, minute: 30 },
      { kind: "weekly", weekday: 1, hour: 8, minute: 5 },
    ] as const) {
      expect(cronToAutomationPreset(automationPresetToCron(preset))).toEqual(preset);
    }
    expect(describeAutomationSchedule({ cron: "0 9 * * 1-5", timezone: "UTC" })).toBe(
      "Weekdays at 09:00",
    );
    expect(describeAutomationSchedule({ cron: "*/5 * * * *", timezone: "UTC" })).toBe(
      "Cron */5 * * * * (UTC)",
    );
  });

  it("rejects invalid expressions and time zones", () => {
    const now = ms("2026-10-01T00:00:00Z");
    expect(validateAutomationSchedule({ cron: "0 9 * * *", timezone: "UTC" }, now)).toBeNull();
    expect(validateAutomationSchedule({ cron: "nope", timezone: "UTC" }, now)).toMatch(
      /Invalid cron/,
    );
    expect(validateAutomationSchedule({ cron: "0 9 * * *", timezone: "Mars/Base" }, now)).toMatch(
      /Unknown time zone/,
    );
  });
});

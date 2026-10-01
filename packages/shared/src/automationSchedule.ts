// @effect-diagnostics globalDate:off -- croner evaluates cron patterns on Date instances; this module's API speaks epoch milliseconds.
import type { AutomationSchedule } from "@t3tools/contracts";
import { Cron } from "croner";

/**
 * Cron evaluation for automations, shared by the server scheduler and the
 * clients' schedule previews. Expressions are standard five-field cron
 * (minute hour day-of-month month day-of-week) evaluated in an IANA zone.
 * Instants are epoch milliseconds.
 */

function makeCron(schedule: AutomationSchedule): Cron {
  // No callback: croner only evaluates the pattern and never starts a timer.
  return new Cron(schedule.cron, { timezone: schedule.timezone, mode: "5-part" });
}

/** A user-facing reason the schedule cannot run, or null when it is valid. */
export function validateAutomationSchedule(
  schedule: AutomationSchedule,
  nowMs: number,
): string | null {
  try {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone });
    if (zone.resolvedOptions().timeZone.length === 0)
      return `Unknown time zone "${schedule.timezone}".`;
  } catch {
    return `Unknown time zone "${schedule.timezone}".`;
  }
  try {
    const next = makeCron(schedule).nextRun(new Date(nowMs));
    return next === null ? "This schedule never runs." : null;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return `Invalid cron expression: ${message.replace(/^CronPattern: /, "")}`;
  }
}

/** The first slot strictly after `afterMs`, or null when the schedule is invalid or exhausted. */
export function nextAutomationRun(schedule: AutomationSchedule, afterMs: number): number | null {
  try {
    return makeCron(schedule).nextRun(new Date(afterMs))?.getTime() ?? null;
  } catch {
    return null;
  }
}

/** Up to `count` slots strictly after `afterMs`. */
export function nextAutomationRuns(
  schedule: AutomationSchedule,
  afterMs: number,
  count: number,
): ReadonlyArray<number> {
  try {
    return makeCron(schedule)
      .nextRuns(count, new Date(afterMs))
      .map((date) => date.getTime());
  } catch {
    return [];
  }
}

export interface DueAutomationSlots {
  /** The latest slot in `(after, now]`, the only one a catch-up may run. */
  readonly latestMs: number;
  /** Whether earlier slots in the same window were passed over. */
  readonly skippedEarlier: boolean;
}

/**
 * Find the slots that came due in `(afterMs, nowMs]`. Only the latest is ever
 * run, so a server that was down for hours fires once instead of in a burst.
 */
export function dueAutomationSlots(
  schedule: AutomationSchedule,
  afterMs: number,
  nowMs: number,
): DueAutomationSlots | null {
  let cron: Cron;
  try {
    cron = makeCron(schedule);
  } catch {
    return null;
  }
  let latest: Date | null = null;
  let count = 0;
  let cursor = cron.nextRun(new Date(afterMs));
  // Bounded so a per-minute schedule after a long outage stays cheap.
  while (cursor !== null && cursor.getTime() <= nowMs && count < 100_000) {
    latest = cursor;
    count += 1;
    cursor = cron.nextRun(cursor);
  }
  return latest === null ? null : { latestMs: latest.getTime(), skippedEarlier: count > 1 };
}

export type AutomationSchedulePreset =
  | { readonly kind: "hourly"; readonly minute: number }
  | { readonly kind: "daily"; readonly hour: number; readonly minute: number }
  | { readonly kind: "weekdays"; readonly hour: number; readonly minute: number }
  | {
      readonly kind: "weekly";
      readonly weekday: number;
      readonly hour: number;
      readonly minute: number;
    };

export const AUTOMATION_WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function automationPresetToCron(preset: AutomationSchedulePreset): string {
  switch (preset.kind) {
    case "hourly":
      return `${preset.minute} * * * *`;
    case "daily":
      return `${preset.minute} ${preset.hour} * * *`;
    case "weekdays":
      return `${preset.minute} ${preset.hour} * * 1-5`;
    case "weekly":
      return `${preset.minute} ${preset.hour} * * ${preset.weekday}`;
  }
}

const SMALL_INT = /^\d{1,2}$/;

function parseField(value: string | undefined, max: number): number | null {
  if (value === undefined || !SMALL_INT.test(value)) return null;
  const parsed = Number(value);
  return parsed <= max ? parsed : null;
}

/** Recognize the presets {@link automationPresetToCron} writes; anything else is custom. */
export function cronToAutomationPreset(cron: string): AutomationSchedulePreset | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteField, hourField, dom, month, dow] = parts;
  const minute = parseField(minuteField, 59);
  if (minute === null || dom !== "*" || month !== "*") return null;
  if (hourField === "*" && dow === "*") return { kind: "hourly", minute };
  const hour = parseField(hourField, 23);
  if (hour === null) return null;
  if (dow === "*") return { kind: "daily", hour, minute };
  if (dow === "1-5") return { kind: "weekdays", hour, minute };
  const weekday = parseField(dow, 7);
  if (weekday === null) return null;
  return { kind: "weekly", weekday: weekday % 7, hour, minute };
}

function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "Daily at 09:00", "Every hour at :15", or the raw expression for custom schedules. */
export function describeAutomationSchedule(schedule: AutomationSchedule): string {
  const preset = cronToAutomationPreset(schedule.cron);
  if (preset === null) return `Cron ${schedule.cron} (${schedule.timezone})`;
  switch (preset.kind) {
    case "hourly":
      return preset.minute === 0
        ? "Every hour"
        : `Every hour at :${String(preset.minute).padStart(2, "0")}`;
    case "daily":
      return `Daily at ${formatClock(preset.hour, preset.minute)}`;
    case "weekdays":
      return `Weekdays at ${formatClock(preset.hour, preset.minute)}`;
    case "weekly":
      return `${AUTOMATION_WEEKDAY_NAMES[preset.weekday]}s at ${formatClock(preset.hour, preset.minute)}`;
  }
}

/** Short wall-clock label in the schedule's zone, used in run thread titles. */
export function formatAutomationRunLabel(epochMs: number, timezone: string): string {
  const date = new Date(epochMs);
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

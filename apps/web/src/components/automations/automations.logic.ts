import type {
  Automation,
  AutomationCreateInput,
  AutomationSchedule,
  AutomationTarget,
  ModelSelection,
  ProjectId,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  automationPresetToCron,
  cronToAutomationPreset,
  validateAutomationSchedule,
} from "@t3tools/shared/automationSchedule";

export type AutomationScheduleMode = "hourly" | "daily" | "weekdays" | "weekly" | "custom";

export const AUTOMATION_SCHEDULE_MODE_LABELS: Readonly<Record<AutomationScheduleMode, string>> = {
  hourly: "Hourly",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  custom: "Custom cron",
};

export interface AutomationFormState {
  readonly name: string;
  readonly projectId: ProjectId | null;
  readonly prompt: string;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly scheduleMode: AutomationScheduleMode;
  /** "HH:MM" for daily, weekday, and weekly presets. */
  readonly time: string;
  /** Minute past the hour for the hourly preset. */
  readonly minute: number;
  /** 0 = Sunday. */
  readonly weekday: number;
  readonly customCron: string;
  readonly timezone: string;
  readonly target: AutomationTarget;
  readonly enabled: boolean;
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function emptyAutomationForm(defaults: {
  readonly projectId: ProjectId | null;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
}): AutomationFormState {
  return {
    name: "",
    projectId: defaults.projectId,
    prompt: "",
    modelSelection: defaults.modelSelection,
    runtimeMode: defaults.runtimeMode,
    scheduleMode: "daily",
    time: "09:00",
    minute: 0,
    weekday: 1,
    customCron: "0 9 * * *",
    timezone: localTimeZone(),
    target: "new-thread",
    enabled: true,
  };
}

const pad = (value: number) => String(value).padStart(2, "0");

export function automationFormFromAutomation(automation: Automation): AutomationFormState {
  const preset = cronToAutomationPreset(automation.schedule.cron);
  const base = {
    name: automation.name,
    projectId: automation.projectId,
    prompt: automation.prompt,
    modelSelection: automation.modelSelection,
    runtimeMode: automation.runtimeMode,
    customCron: automation.schedule.cron,
    timezone: automation.schedule.timezone,
    target: automation.target,
    enabled: automation.enabled,
    time: "09:00",
    minute: 0,
    weekday: 1,
  };
  if (preset === null) return { ...base, scheduleMode: "custom" };
  if (preset.kind === "hourly") return { ...base, scheduleMode: "hourly", minute: preset.minute };
  const time = `${pad(preset.hour)}:${pad(preset.minute)}`;
  return preset.kind === "weekly"
    ? { ...base, scheduleMode: "weekly", time, weekday: preset.weekday }
    : { ...base, scheduleMode: preset.kind, time };
}

function parseTime(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** The schedule the form describes, or null while the time field is incomplete. */
export function automationScheduleFromForm(form: AutomationFormState): AutomationSchedule | null {
  const timezone = form.timezone.trim();
  if (form.scheduleMode === "custom") return { cron: form.customCron.trim(), timezone };
  if (form.scheduleMode === "hourly") {
    return { cron: automationPresetToCron({ kind: "hourly", minute: form.minute }), timezone };
  }
  const time = parseTime(form.time);
  if (time === null) return null;
  const cron =
    form.scheduleMode === "weekly"
      ? automationPresetToCron({ kind: "weekly", weekday: form.weekday, ...time })
      : automationPresetToCron({ kind: form.scheduleMode, ...time });
  return { cron, timezone };
}

/** A complete create input, or the first reason the form cannot be saved yet. */
export function automationInputFromForm(
  form: AutomationFormState,
  nowMs: number,
): { readonly input: AutomationCreateInput } | { readonly error: string } {
  if (form.name.trim().length === 0) return { error: "Give the automation a name." };
  if (form.projectId === null) return { error: "Choose a project." };
  if (form.prompt.trim().length === 0) return { error: "Write the prompt the agent should run." };
  if (form.modelSelection === null) return { error: "Choose a model." };
  const schedule = automationScheduleFromForm(form);
  if (schedule === null) return { error: "Enter a time as HH:MM." };
  const scheduleError = validateAutomationSchedule(schedule, nowMs);
  if (scheduleError !== null) return { error: scheduleError };
  return {
    input: {
      name: form.name.trim(),
      projectId: form.projectId,
      prompt: form.prompt.trim(),
      modelSelection: form.modelSelection,
      runtimeMode: form.runtimeMode,
      schedule,
      target: form.target,
      enabled: form.enabled,
    },
  };
}

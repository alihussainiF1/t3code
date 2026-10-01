import type {
  AutomationCreateInput,
  AutomationId,
  AutomationRun,
  AutomationUpdateInput,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import { dueAutomationSlots, nextAutomationRun } from "@t3tools/shared/automationSchedule";

import type { AutomationRecord } from "./AutomationRepository.ts";

/**
 * Pure rules for automations: how edits move the scheduler cursor, which
 * slot (if any) is due, and when a run's thread counts as finished. The
 * service owns persistence and side effects; everything decidable from
 * plain values lives here so it can be tested without a clock or database.
 */

/** A slot missed by more than this (server down, laptop asleep) is recorded as skipped. */
export const AUTOMATION_MISSED_RUN_GRACE_MS = 24 * 60 * 60 * 1000;

export function createAutomationRecord(
  id: AutomationId,
  input: AutomationCreateInput,
  now: string,
): AutomationRecord {
  return {
    id,
    name: input.name,
    projectId: input.projectId,
    prompt: input.prompt,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    schedule: input.schedule,
    target: input.target,
    enabled: input.enabled,
    scheduleAnchorAt: now,
    lastScheduledFor: null,
    continueThreadId: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Apply an edit. Re-enabling or changing the schedule re-anchors the cursor
 * at `now`, so slots that passed while disabled or under the old schedule
 * never fire late. Retargeting to a new project drops the continued thread.
 */
export function applyAutomationUpdate(
  record: AutomationRecord,
  input: AutomationUpdateInput,
  now: string,
): AutomationRecord {
  const schedule = input.schedule ?? record.schedule;
  const enabled = input.enabled ?? record.enabled;
  const scheduleChanged =
    schedule.cron !== record.schedule.cron || schedule.timezone !== record.schedule.timezone;
  const reEnabled = enabled && !record.enabled;
  const projectId = input.projectId ?? record.projectId;
  const target = input.target ?? record.target;
  return {
    ...record,
    name: input.name ?? record.name,
    projectId,
    prompt: input.prompt ?? record.prompt,
    modelSelection: input.modelSelection ?? record.modelSelection,
    runtimeMode: input.runtimeMode ?? record.runtimeMode,
    schedule,
    target,
    enabled,
    scheduleAnchorAt: scheduleChanged || reEnabled ? now : record.scheduleAnchorAt,
    lastScheduledFor: scheduleChanged || reEnabled ? null : record.lastScheduledFor,
    continueThreadId:
      projectId !== record.projectId || target !== "same-thread" ? null : record.continueThreadId,
    updatedAt: now,
  };
}

/** Epoch millis after which slots may fire: the later of the anchor and the last handled slot. */
function scheduleCursorMs(record: AutomationRecord): number {
  const anchor = Date.parse(record.scheduleAnchorAt);
  const last = record.lastScheduledFor === null ? Number.NaN : Date.parse(record.lastScheduledFor);
  return Number.isFinite(last) && last > anchor ? last : anchor;
}

/** The next slot (epoch millis) the scheduler will act on, or null while disabled. */
export function nextAutomationRunAtMs(record: AutomationRecord): number | null {
  return record.enabled ? nextAutomationRun(record.schedule, scheduleCursorMs(record)) : null;
}

export type AutomationScheduleDecision =
  | { readonly kind: "idle" }
  /** Run once for the latest due slot; earlier ones are folded into it. */
  | { readonly kind: "run"; readonly slotMs: number }
  /** The latest due slot is older than the grace window: record it as skipped. */
  | { readonly kind: "missed"; readonly slotMs: number };

export function decideAutomationSchedule(
  record: AutomationRecord,
  nowMs: number,
  graceMs: number = AUTOMATION_MISSED_RUN_GRACE_MS,
): AutomationScheduleDecision {
  if (!record.enabled) return { kind: "idle" };
  const due = dueAutomationSlots(record.schedule, scheduleCursorMs(record), nowMs);
  if (due === null) return { kind: "idle" };
  return nowMs - due.latestMs > graceMs
    ? { kind: "missed", slotMs: due.latestMs }
    : { kind: "run", slotMs: due.latestMs };
}

export interface AutomationRunOutcome {
  readonly status: "completed" | "failed";
  readonly detail: string | null;
}

/**
 * Whether the thread a run started has finished its turn. Turns requested
 * before the run started belong to earlier runs of a continued thread.
 */
export function resolveAutomationRunOutcome(
  run: Pick<AutomationRun, "startedAt">,
  thread: Pick<OrchestrationThreadShell, "latestTurn" | "session"> | null,
): AutomationRunOutcome | null {
  if (thread === null) return { status: "failed", detail: "The run's thread was deleted." };
  const turn = thread.latestTurn;
  if (turn === null || turn.requestedAt < run.startedAt) {
    const session = thread.session;
    if (session !== null && session.status === "error" && session.updatedAt >= run.startedAt) {
      return {
        status: "failed",
        detail: session.lastError ?? "The provider session failed to start.",
      };
    }
    return null;
  }
  switch (turn.state) {
    case "running":
      return null;
    case "completed":
      return { status: "completed", detail: null };
    case "interrupted":
      return { status: "failed", detail: "The turn was interrupted." };
    case "error":
      return { status: "failed", detail: thread.session?.lastError ?? "The turn failed." };
  }
}

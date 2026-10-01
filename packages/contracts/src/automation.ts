import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection, RuntimeMode } from "./orchestration.ts";

/**
 * Automations: an agent prompt the server runs in a project on a cron
 * schedule (or on demand). Every run starts a turn in a thread, so results
 * are reviewed like any other thread.
 */

export const AutomationId = TrimmedNonEmptyString.pipe(Schema.brand("AutomationId"));
export type AutomationId = typeof AutomationId.Type;
export const AutomationRunId = TrimmedNonEmptyString.pipe(Schema.brand("AutomationRunId"));
export type AutomationRunId = typeof AutomationRunId.Type;

/** A five-field cron expression evaluated in an IANA time zone. */
export const AutomationSchedule = Schema.Struct({
  cron: TrimmedNonEmptyString,
  timezone: TrimmedNonEmptyString,
});
export type AutomationSchedule = typeof AutomationSchedule.Type;

/** Where each run's turn goes: a fresh thread, or the thread the automation last used. */
export const AutomationTarget = Schema.Literals(["new-thread", "same-thread"]);
export type AutomationTarget = typeof AutomationTarget.Type;

export const AutomationRunStatus = Schema.Literals(["running", "completed", "failed", "skipped"]);
export type AutomationRunStatus = typeof AutomationRunStatus.Type;

export const AutomationRunTrigger = Schema.Literals(["schedule", "manual"]);
export type AutomationRunTrigger = typeof AutomationRunTrigger.Type;

export const AutomationRun = Schema.Struct({
  id: AutomationRunId,
  automationId: AutomationId,
  trigger: AutomationRunTrigger,
  /** The schedule slot this run answers; null for manual runs. */
  scheduledFor: Schema.NullOr(IsoDateTime),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  status: AutomationRunStatus,
  /** Null when the run was skipped before a thread existed. */
  threadId: Schema.NullOr(ThreadId),
  /** Why a run was skipped or failed. */
  detail: Schema.NullOr(Schema.String),
});
export type AutomationRun = typeof AutomationRun.Type;

const AutomationFields = {
  name: TrimmedNonEmptyString,
  projectId: ProjectId,
  prompt: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  schedule: AutomationSchedule,
  target: AutomationTarget,
  enabled: Schema.Boolean,
};

export const Automation = Schema.Struct({
  id: AutomationId,
  ...AutomationFields,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Next scheduled slot; null while disabled. */
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRun: Schema.NullOr(AutomationRun),
});
export type Automation = typeof Automation.Type;

export const AutomationCreateInput = Schema.Struct(AutomationFields);
export type AutomationCreateInput = typeof AutomationCreateInput.Type;

export const AutomationUpdateInput = Schema.Struct({
  id: AutomationId,
  name: Schema.optional(AutomationFields.name),
  projectId: Schema.optional(AutomationFields.projectId),
  prompt: Schema.optional(AutomationFields.prompt),
  modelSelection: Schema.optional(AutomationFields.modelSelection),
  runtimeMode: Schema.optional(AutomationFields.runtimeMode),
  schedule: Schema.optional(AutomationFields.schedule),
  target: Schema.optional(AutomationFields.target),
  enabled: Schema.optional(AutomationFields.enabled),
});
export type AutomationUpdateInput = typeof AutomationUpdateInput.Type;

export const AutomationIdInput = Schema.Struct({ id: AutomationId });
export type AutomationIdInput = typeof AutomationIdInput.Type;

export const AutomationListRunsInput = Schema.Struct({
  automationId: AutomationId,
  limit: Schema.optional(PositiveInt),
});
export type AutomationListRunsInput = typeof AutomationListRunsInput.Type;

export const AutomationListRunsResult = Schema.Struct({
  runs: Schema.Array(AutomationRun),
});
export type AutomationListRunsResult = typeof AutomationListRunsResult.Type;

/** The full automation list, re-sent whenever an automation or one of its runs changes. */
export const AutomationsSnapshot = Schema.Struct({
  automations: Schema.Array(Automation),
});
export type AutomationsSnapshot = typeof AutomationsSnapshot.Type;

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  operation: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

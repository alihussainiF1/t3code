import {
  AutomationId,
  AutomationRun,
  AutomationTarget,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";

/** The stored automation, including the scheduler cursor clients never see. */
export const AutomationRecord = Schema.Struct({
  id: AutomationId,
  name: Schema.String,
  projectId: ProjectId,
  prompt: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  schedule: Schema.Struct({ cron: Schema.String, timezone: Schema.String }),
  target: AutomationTarget,
  enabled: Schema.Boolean,
  /** Slots at or before this instant never fire (set on create, re-enable, reschedule). */
  scheduleAnchorAt: Schema.String,
  /** The latest slot the scheduler already handled, fired or skipped. */
  lastScheduledFor: Schema.NullOr(Schema.String),
  /** The thread a "same-thread" automation keeps continuing. */
  continueThreadId: Schema.NullOr(ThreadId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type AutomationRecord = typeof AutomationRecord.Type;

const AutomationDbRow = Schema.Struct({
  id: AutomationId,
  name: Schema.String,
  projectId: ProjectId,
  prompt: Schema.String,
  modelSelection: Schema.fromJsonString(ModelSelection),
  runtimeMode: RuntimeMode,
  cron: Schema.String,
  timezone: Schema.String,
  target: AutomationTarget,
  enabled: Schema.Number,
  scheduleAnchorAt: Schema.String,
  lastScheduledFor: Schema.NullOr(Schema.String),
  continueThreadId: Schema.NullOr(ThreadId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const encodeModelSelection = Schema.encodeSync(ModelSelection);

const fromDbRow = (row: typeof AutomationDbRow.Type): AutomationRecord => {
  const { cron, timezone, enabled, ...rest } = row;
  return { ...rest, schedule: { cron, timezone }, enabled: enabled === 1 };
};

export class AutomationRepository extends Context.Service<
  AutomationRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<AutomationRecord>, ProjectionRepositoryError>;
    readonly get: (
      id: AutomationId,
    ) => Effect.Effect<Option.Option<AutomationRecord>, ProjectionRepositoryError>;
    readonly upsert: (record: AutomationRecord) => Effect.Effect<void, ProjectionRepositoryError>;
    /** Removes the automation and its run history. Run threads are left alone. */
    readonly remove: (id: AutomationId) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly upsertRun: (run: AutomationRun) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly listRuns: (
      automationId: AutomationId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<AutomationRun>, ProjectionRepositoryError>;
    readonly latestRuns: Effect.Effect<ReadonlyArray<AutomationRun>, ProjectionRepositoryError>;
    readonly runningRuns: Effect.Effect<ReadonlyArray<AutomationRun>, ProjectionRepositoryError>;
  }
>()("t3/automation/AutomationRepository") {}

const RUN_COLUMNS = (sql: SqlClient.SqlClient) => sql`
  run_id AS "id",
  automation_id AS "automationId",
  trigger,
  scheduled_for AS "scheduledFor",
  started_at AS "startedAt",
  finished_at AS "finishedAt",
  status,
  thread_id AS "threadId",
  detail
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const AUTOMATION_COLUMNS = sql`
    automation_id AS "id",
    name,
    project_id AS "projectId",
    prompt,
    model_selection_json AS "modelSelection",
    runtime_mode AS "runtimeMode",
    cron,
    timezone,
    target,
    enabled,
    schedule_anchor_at AS "scheduleAnchorAt",
    last_scheduled_for AS "lastScheduledFor",
    continue_thread_id AS "continueThreadId",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AutomationDbRow,
    execute: () => sql`
      SELECT ${AUTOMATION_COLUMNS}
      FROM automations
      ORDER BY created_at ASC, automation_id ASC
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: AutomationId,
    Result: AutomationDbRow,
    execute: (id) => sql`
      SELECT ${AUTOMATION_COLUMNS}
      FROM automations
      WHERE automation_id = ${id}
    `,
  });

  const listRunRows = SqlSchema.findAll({
    Request: Schema.Struct({ automationId: AutomationId, limit: Schema.Number }),
    Result: AutomationRun,
    execute: ({ automationId, limit }) => sql`
      SELECT ${RUN_COLUMNS(sql)}
      FROM automation_runs
      WHERE automation_id = ${automationId}
      ORDER BY started_at DESC, run_id DESC
      LIMIT ${limit}
    `,
  });

  const latestRunRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AutomationRun,
    execute: () => sql`
      SELECT ${RUN_COLUMNS(sql)}
      FROM automation_runs AS runs
      WHERE run_id = (
        SELECT latest.run_id FROM automation_runs AS latest
        WHERE latest.automation_id = runs.automation_id
        ORDER BY latest.started_at DESC, latest.run_id DESC
        LIMIT 1
      )
    `,
  });

  const runningRunRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: AutomationRun,
    execute: () => sql`
      SELECT ${RUN_COLUMNS(sql)}
      FROM automation_runs
      WHERE status = 'running'
    `,
  });

  return AutomationRepository.of({
    list: listRows(undefined).pipe(
      Effect.map((rows) => rows.map(fromDbRow)),
      Effect.mapError(toPersistenceSqlError("AutomationRepository.list:query")),
    ),
    get: (id) =>
      getRow(id).pipe(
        Effect.map(Option.map(fromDbRow)),
        Effect.mapError(toPersistenceSqlError("AutomationRepository.get:query")),
      ),
    upsert: (record) =>
      sql`
        INSERT INTO automations (
          automation_id, name, project_id, prompt, model_selection_json, runtime_mode,
          cron, timezone, target, enabled, schedule_anchor_at, last_scheduled_for,
          continue_thread_id, created_at, updated_at
        )
        VALUES (
          ${record.id}, ${record.name}, ${record.projectId}, ${record.prompt},
          ${JSON.stringify(encodeModelSelection(record.modelSelection))},
          ${record.runtimeMode}, ${record.schedule.cron}, ${record.schedule.timezone},
          ${record.target}, ${record.enabled ? 1 : 0}, ${record.scheduleAnchorAt},
          ${record.lastScheduledFor}, ${record.continueThreadId}, ${record.createdAt},
          ${record.updatedAt}
        )
        ON CONFLICT (automation_id) DO UPDATE SET
          name = excluded.name,
          project_id = excluded.project_id,
          prompt = excluded.prompt,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          cron = excluded.cron,
          timezone = excluded.timezone,
          target = excluded.target,
          enabled = excluded.enabled,
          schedule_anchor_at = excluded.schedule_anchor_at,
          last_scheduled_for = excluded.last_scheduled_for,
          continue_thread_id = excluded.continue_thread_id,
          updated_at = excluded.updated_at
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("AutomationRepository.upsert:query")),
      ),
    remove: (id) =>
      sql
        .withTransaction(
          Effect.andThen(
            sql`DELETE FROM automation_runs WHERE automation_id = ${id}`,
            sql`DELETE FROM automations WHERE automation_id = ${id}`,
          ),
        )
        .pipe(
          Effect.asVoid,
          Effect.mapError(toPersistenceSqlError("AutomationRepository.remove:query")),
        ),
    upsertRun: (run) =>
      sql`
        INSERT INTO automation_runs (
          run_id, automation_id, trigger, scheduled_for, started_at, finished_at,
          status, thread_id, detail
        )
        VALUES (
          ${run.id}, ${run.automationId}, ${run.trigger}, ${run.scheduledFor},
          ${run.startedAt}, ${run.finishedAt}, ${run.status}, ${run.threadId}, ${run.detail}
        )
        ON CONFLICT (run_id) DO UPDATE SET
          finished_at = excluded.finished_at,
          status = excluded.status,
          thread_id = excluded.thread_id,
          detail = excluded.detail
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("AutomationRepository.upsertRun:query")),
      ),
    listRuns: (automationId, limit) =>
      listRunRows({ automationId, limit }).pipe(
        Effect.mapError(toPersistenceSqlError("AutomationRepository.listRuns:query")),
      ),
    latestRuns: latestRunRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.latestRuns:query")),
    ),
    runningRuns: runningRunRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.runningRuns:query")),
    ),
  });
});

export const layer = Layer.effect(AutomationRepository, make);

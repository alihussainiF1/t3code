import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `schedule_anchor_at` and `last_scheduled_for` are the scheduler cursor:
  // only slots after the later of the two may fire. Creating, re-enabling, or
  // rescheduling moves the anchor to "now" so old slots never fire.
  yield* sql`
    CREATE TABLE IF NOT EXISTS automations (
      automation_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      cron TEXT NOT NULL,
      timezone TEXT NOT NULL,
      target TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      schedule_anchor_at TEXT NOT NULL,
      last_scheduled_for TEXT,
      continue_thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      scheduled_for TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      thread_id TEXT,
      detail TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_started
    ON automation_runs(automation_id, started_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_running
    ON automation_runs(status)
    WHERE status = 'running'
  `;
});

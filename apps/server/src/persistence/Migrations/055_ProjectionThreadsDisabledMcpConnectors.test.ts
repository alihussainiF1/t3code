import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateDisabledMcpConnectors from "./055_ProjectionThreadsDisabledMcpConnectors.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "055_ProjectionThreadsDisabledMcpConnectors",
  (it) => {
    it.effect("adds the column with every connector enabled for existing threads", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 54 });
        const now = "2026-01-01T00:00:00.000Z";
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          created_at, updated_at
        ) VALUES (
          'thread-1', 'project-1', 'Existing thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
        )
      `;
        yield* runMigrations({ toMigrationInclusive: 55 });
        const migrated = yield* sql<{ readonly disabledMcpConnectorIds: string | null }>`
        SELECT disabled_mcp_connector_ids_json AS "disabledMcpConnectorIds" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
        assert.deepEqual(migrated, [{ disabledMcpConnectorIds: null }]);
        // Re-running against a database that already has the column keeps its value.
        const stored = `["linear"]`;
        yield* sql`UPDATE projection_threads SET disabled_mcp_connector_ids_json = ${stored} WHERE thread_id = 'thread-1'`;
        yield* migrateDisabledMcpConnectors;
        const rows = yield* sql<{ readonly disabledMcpConnectorIds: string | null }>`
        SELECT disabled_mcp_connector_ids_json AS "disabledMcpConnectorIds" FROM projection_threads WHERE thread_id = 'thread-1'
      `;
        assert.deepEqual(rows, [{ disabledMcpConnectorIds: stored }]);
      }),
    );
  },
);

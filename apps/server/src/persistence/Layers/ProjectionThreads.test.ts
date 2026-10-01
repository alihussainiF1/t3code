import { McpConnectorId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../Services/ProjectionThreads.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const NOW = "2026-01-01T00:00:00.000Z";

const baseRow: ProjectionThread = {
  threadId: ThreadId.make("thread-mcp"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurnId: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  latestUserMessageAt: null,
  pendingApprovalCount: 0,
  pendingUserInputCount: 0,
  hasActionableProposedPlan: 0,
  deletedAt: null,
};

layer("ProjectionThreadRepository", (it) => {
  it.effect("round-trips the disabled MCP connector set and stores empty as null", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const threadId = baseRow.threadId;

      yield* repository.upsert(baseRow);
      const initial = yield* repository.getById({ threadId });
      assert.isNull(Option.getOrThrow(initial).disabledMcpConnectorIds ?? null);

      const disabled = [McpConnectorId.make("github"), McpConnectorId.make("linear")];
      yield* repository.upsert({ ...baseRow, disabledMcpConnectorIds: disabled });
      const stored = yield* repository.getById({ threadId });
      assert.deepEqual(Option.getOrThrow(stored).disabledMcpConnectorIds, disabled);

      yield* repository.upsert({ ...baseRow, disabledMcpConnectorIds: [] });
      const cleared = yield* repository.getById({ threadId });
      assert.isNull(Option.getOrThrow(cleared).disabledMcpConnectorIds ?? null);
    }),
  );
});

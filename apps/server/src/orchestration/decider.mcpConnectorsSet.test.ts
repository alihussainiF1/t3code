import {
  CommandId,
  McpConnectorId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ids = (...values: string[]) => values.map((value) => McpConnectorId.make(value));

function makeReadModel(input: {
  readonly disabledMcpConnectorIds?: ReadonlyArray<McpConnectorId>;
  readonly archived?: boolean;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archived ? NOW : null,
        settledOverride: null,
        settledAt: null,
        ...(input.disabledMcpConnectorIds !== undefined
          ? { disabledMcpConnectorIds: input.disabledMcpConnectorIds }
          : {}),
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const events = (event: Effect.Success<ReturnType<typeof decideOrchestrationCommand>>) =>
  Array.isArray(event) ? event : [event];

it.layer(NodeServices.layer)("thread.mcp-connectors.set decider", (it) => {
  it.effect("disabling connectors emits a deduped, sorted set and bumps updatedAt", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.mcp-connectors.set",
            commandId: CommandId.make("cmd-disable"),
            threadId: ThreadId.make("thread-1"),
            disabledMcpConnectorIds: ids("linear", "github", "linear"),
          },
          readModel: makeReadModel({}),
        }),
      );
      expect(event?.type).toBe("thread.mcp-connectors-set");
      if (event?.type === "thread.mcp-connectors-set") {
        expect(event.payload.disabledMcpConnectorIds).toEqual(ids("github", "linear"));
        expect(event.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("re-sending the same set keeps updatedAt", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.mcp-connectors.set",
            commandId: CommandId.make("cmd-same"),
            threadId: ThreadId.make("thread-1"),
            disabledMcpConnectorIds: ids("linear", "github"),
          },
          readModel: makeReadModel({ disabledMcpConnectorIds: ids("github", "linear") }),
        }),
      );
      expect(event?.type).toBe("thread.mcp-connectors-set");
      if (event?.type === "thread.mcp-connectors-set") {
        expect(event.payload.disabledMcpConnectorIds).toEqual(ids("github", "linear"));
        expect(event.payload.updatedAt).toBe(NOW);
      }
    }),
  );

  it.effect("an empty set re-enables every connector", () =>
    Effect.gen(function* () {
      const [event] = events(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.mcp-connectors.set",
            commandId: CommandId.make("cmd-enable"),
            threadId: ThreadId.make("thread-1"),
            disabledMcpConnectorIds: [],
          },
          readModel: makeReadModel({ disabledMcpConnectorIds: ids("github") }),
        }),
      );
      expect(event?.type).toBe("thread.mcp-connectors-set");
      if (event?.type === "thread.mcp-connectors-set") {
        expect(event.payload.disabledMcpConnectorIds).toEqual([]);
        expect(event.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("rejects unknown and archived threads", () =>
    Effect.gen(function* () {
      const unknown = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.mcp-connectors.set",
            commandId: CommandId.make("cmd-unknown"),
            threadId: ThreadId.make("thread-missing"),
            disabledMcpConnectorIds: ids("github"),
          },
          readModel: makeReadModel({}),
        }),
      );
      expect(unknown._tag).toBe("Failure");
      const archived = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.mcp-connectors.set",
            commandId: CommandId.make("cmd-archived"),
            threadId: ThreadId.make("thread-1"),
            disabledMcpConnectorIds: ids("github"),
          },
          readModel: makeReadModel({ archived: true }),
        }),
      );
      expect(archived._tag).toBe("Failure");
    }),
  );
});

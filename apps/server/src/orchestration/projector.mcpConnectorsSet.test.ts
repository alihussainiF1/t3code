import {
  CommandId,
  EventId,
  McpConnectorId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

it.effect("projects per-thread disabled MCP connectors and re-enabling them", () =>
  Effect.gen(function* () {
    const now = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-02T00:00:00.000Z";
    const created = yield* projectEvent(
      createEmptyReadModel(now),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    expect(created.threads[0]?.disabledMcpConnectorIds ?? []).toEqual([]);

    const disabled = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.mcp-connectors-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          disabledMcpConnectorIds: [McpConnectorId.make("github"), McpConnectorId.make("linear")],
          updatedAt: later,
        },
      }),
    );
    expect(disabled.threads[0]?.disabledMcpConnectorIds).toEqual(["github", "linear"]);
    expect(disabled.threads[0]?.updatedAt).toBe(later);

    const enabled = yield* projectEvent(
      disabled,
      makeEvent({
        sequence: 3,
        type: "thread.mcp-connectors-set",
        payload: {
          threadId: ThreadId.make("thread-1"),
          disabledMcpConnectorIds: [],
          updatedAt: later,
        },
      }),
    );
    expect(enabled.threads[0]?.disabledMcpConnectorIds ?? []).toEqual([]);
  }),
);

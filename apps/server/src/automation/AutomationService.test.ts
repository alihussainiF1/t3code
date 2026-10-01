import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AutomationCreateInput,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as AutomationRepository from "./AutomationRepository.ts";
import { AutomationService, layer as AutomationServiceLayer } from "./AutomationService.ts";

const START = "2026-10-01T08:00:00.000Z"; // a Thursday
const PROJECT_ID = ProjectId.make("automation-project");

const TestLayer = AutomationServiceLayer.pipe(
  Layer.provideMerge(AutomationRepository.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
      ),
      OrchestrationProjectionSnapshotQueryLive,
    ),
  ),
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-automation-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function automationInput(overrides: Partial<AutomationCreateInput> = {}): AutomationCreateInput {
  return {
    name: "Morning triage",
    projectId: PROJECT_ID,
    prompt: "Summarize new issues.",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "approval-required",
    schedule: { cron: "0 9 * * *", timezone: "UTC" },
    target: "new-thread",
    enabled: true,
    ...overrides,
  };
}

/** Seed the project and hand back the pieces tests drive; `start` launches the scheduler. */
const seed = Effect.gen(function* () {
  yield* TestClock.setTime(Date.parse(START));
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("seed-project"),
    projectId: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/automation-project",
    createdAt: START,
  });
  const service = yield* AutomationService;
  return { engine, service };
});

const setup = Effect.tap(seed, ({ service }) => service.start());

/** Drive a thread's turn from running to a settled state, as provider ingestion would. */
const finishTurn = Effect.fnUntraced(function* (
  threadId: ThreadId,
  status: "ready" | "error" = "ready",
) {
  const engine = yield* OrchestrationEngineService;
  const turnId = TurnId.make(`turn-${threadId}-${yield* nowIso}`);
  const session = (sessionStatus: "running" | "ready" | "error", updatedAt: string) => ({
    threadId,
    status: sessionStatus,
    providerName: "Codex",
    runtimeMode: "approval-required" as const,
    activeTurnId: sessionStatus === "running" ? turnId : null,
    lastError: sessionStatus === "error" ? "Provider crashed." : null,
    updatedAt,
  });
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make(`running-${turnId}`),
    threadId,
    session: session("running", yield* nowIso),
    createdAt: yield* nowIso,
  });
  yield* TestClock.adjust("1 minute");
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make(`settled-${turnId}`),
    threadId,
    session: session(status, yield* nowIso),
    createdAt: yield* nowIso,
  });
});

describe("AutomationService", () => {
  it.effect("fires on schedule, skips while active, and records completion", () =>
    Effect.gen(function* () {
      const { service } = yield* setup;
      const snapshots = yield* ProjectionSnapshotQuery;
      const receipts = yield* OrchestrationCommandReceiptRepository;

      const automation = yield* service.create(automationInput());
      assert.strictEqual(automation.nextRunAt, "2026-10-01T09:00:00.000Z");

      yield* service.tick;
      assert.deepStrictEqual((yield* service.listRuns({ automationId: automation.id })).runs, []);

      yield* TestClock.adjust("1 hour");
      yield* service.tick;
      const [run] = (yield* service.listRuns({ automationId: automation.id })).runs;
      assert.ok(run);
      assert.strictEqual(run.status, "running");
      assert.strictEqual(run.trigger, "schedule");
      assert.strictEqual(run.scheduledFor, "2026-10-01T09:00:00.000Z");
      assert.ok(run.threadId);

      // The run went through orchestration: both commands were accepted.
      for (const step of ["create", "turn"]) {
        const receipt = yield* receipts.getByCommandId({
          commandId: CommandId.make(`server:automation:${run.id}:${step}`),
        });
        assert.strictEqual(Option.getOrThrow(receipt).status, "accepted");
      }
      const thread = Option.getOrThrow(yield* snapshots.getThreadShellById(run.threadId));
      assert.strictEqual(thread.title, "Morning triage · Oct 1, 09:00");
      assert.strictEqual(thread.runtimeMode, "approval-required");
      assert.strictEqual(thread.projectId, PROJECT_ID);

      // The next day's slot comes due while the first turn is still running.
      yield* TestClock.adjust("1 day");
      yield* service.tick;
      const afterSkip = (yield* service.listRuns({ automationId: automation.id })).runs;
      assert.deepStrictEqual(
        afterSkip.map((entry) => [entry.status, entry.detail]),
        [
          ["skipped", "Previous run still active."],
          ["running", null],
        ],
      );

      yield* finishTurn(run.threadId);
      yield* service.drain;
      const finished = (yield* service.listRuns({ automationId: automation.id })).runs.find(
        (entry) => entry.id === run.id,
      );
      assert.strictEqual(finished?.status, "completed");
      assert.ok(finished?.finishedAt);

      // With nothing active, "Run now" starts a manual run in a fresh thread.
      const manual = yield* service.runNow(automation.id);
      assert.strictEqual(manual.status, "running");
      assert.strictEqual(manual.trigger, "manual");
      assert.notStrictEqual(manual.threadId, run.threadId);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("runs only the latest missed slot after downtime, or skips one past the grace", () =>
    Effect.gen(function* () {
      // The scheduler is not started yet: the server is down.
      const { service } = yield* seed;
      const hourly = yield* service.create(
        automationInput({ name: "Hourly", schedule: { cron: "0 * * * *", timezone: "UTC" } }),
      );
      const weekly = yield* service.create(
        automationInput({ name: "Weekly", schedule: { cron: "0 9 * * 4", timezone: "UTC" } }),
      );

      yield* TestClock.adjust("26 hours");
      yield* service.start();
      yield* service.tick;

      const hourlyRuns = (yield* service.listRuns({ automationId: hourly.id })).runs;
      assert.deepStrictEqual(
        hourlyRuns.map((run) => [run.status, run.scheduledFor]),
        [["running", "2026-10-02T10:00:00.000Z"]],
      );
      const weeklyRuns = (yield* service.listRuns({ automationId: weekly.id })).runs;
      assert.deepStrictEqual(
        weeklyRuns.map((run) => [run.status, run.scheduledFor, run.detail]),
        [["skipped", "2026-10-01T09:00:00.000Z", "Missed while the server was offline."]],
      );

      // A second tick at the same instant does not replay either slot.
      yield* service.tick;
      assert.strictEqual((yield* service.listRuns({ automationId: hourly.id })).runs.length, 1);
      assert.strictEqual((yield* service.listRuns({ automationId: weekly.id })).runs.length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("disabling stops runs and re-enabling never fires slots missed meanwhile", () =>
    Effect.gen(function* () {
      const { service } = yield* setup;
      const automation = yield* service.create(automationInput());
      const disabled = yield* service.update({ id: automation.id, enabled: false });
      assert.strictEqual(disabled.nextRunAt, null);

      yield* TestClock.adjust("2 hours");
      yield* service.tick;
      assert.deepStrictEqual((yield* service.listRuns({ automationId: automation.id })).runs, []);

      const enabled = yield* service.update({ id: automation.id, enabled: true });
      assert.strictEqual(enabled.nextRunAt, "2026-10-02T09:00:00.000Z");
      yield* service.tick;
      assert.deepStrictEqual((yield* service.listRuns({ automationId: automation.id })).runs, []);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("continues the same thread and keeps it after the automation is deleted", () =>
    Effect.gen(function* () {
      const { service } = yield* setup;
      const snapshots = yield* ProjectionSnapshotQuery;
      const automation = yield* service.create(automationInput({ target: "same-thread" }));

      const first = yield* service.runNow(automation.id);
      assert.ok(first.threadId);
      yield* finishTurn(first.threadId, "error");
      yield* service.drain;
      const [failed] = (yield* service.listRuns({ automationId: automation.id })).runs;
      assert.deepStrictEqual([failed?.status, failed?.detail], ["failed", "Provider crashed."]);

      yield* TestClock.adjust("1 minute");
      const second = yield* service.runNow(automation.id);
      assert.strictEqual(second.threadId, first.threadId);
      assert.strictEqual(second.status, "running");

      yield* service.remove(automation.id);
      assert.ok(Option.isSome(yield* snapshots.getThreadShellById(first.threadId)));
      const rejected = yield* Effect.flip(service.runNow(automation.id));
      assert.strictEqual(rejected.detail, "Automation not found.");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects invalid schedules and unknown projects", () =>
    Effect.gen(function* () {
      const { service } = yield* setup;
      const badCron = yield* Effect.flip(
        service.create(automationInput({ schedule: { cron: "every day", timezone: "UTC" } })),
      );
      assert.match(badCron.detail, /Invalid cron/);
      const badProject = yield* Effect.flip(
        service.create(automationInput({ projectId: ProjectId.make("missing") })),
      );
      assert.strictEqual(badProject.detail, "Project not found.");
    }).pipe(Effect.provide(TestLayer)),
  );
});

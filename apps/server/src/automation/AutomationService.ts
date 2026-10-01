import {
  AutomationError,
  AutomationId,
  AutomationRunId,
  CommandId,
  MessageId,
  ThreadId,
  type Automation,
  type AutomationCreateInput,
  type AutomationListRunsInput,
  type AutomationListRunsResult,
  type AutomationRun,
  type AutomationRunTrigger,
  type AutomationsSnapshot,
  type AutomationUpdateInput,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import {
  formatAutomationRunLabel,
  validateAutomationSchedule,
} from "@t3tools/shared/automationSchedule";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../serverActivation.ts";
import { AutomationRepository, type AutomationRecord } from "./AutomationRepository.ts";
import {
  applyAutomationUpdate,
  createAutomationRecord,
  decideAutomationSchedule,
  nextAutomationRunAtMs,
  resolveAutomationRunOutcome,
} from "./automationPolicy.ts";

/** The scheduler re-evaluates at least this often, so clock jumps (sleep, NTP) self-correct. */
const MAX_SCHEDULER_SLEEP_MS = 5 * 60 * 1000;
const DEFAULT_RUN_HISTORY_LIMIT = 50;

/**
 * Stores automations and runs them. A timer evaluates every enabled
 * automation's cron schedule, starts a thread turn for each due slot, and
 * watches orchestration events to record when that turn finishes. All
 * mutations are serialized, so a manual run, a scheduled run, and an edit
 * never interleave.
 */
export class AutomationService extends Context.Service<
  AutomationService,
  {
    /** The full automation list now and after every change. */
    readonly subscribe: Stream.Stream<AutomationsSnapshot, AutomationError>;
    readonly create: (input: AutomationCreateInput) => Effect.Effect<Automation, AutomationError>;
    readonly update: (input: AutomationUpdateInput) => Effect.Effect<Automation, AutomationError>;
    readonly remove: (id: AutomationId) => Effect.Effect<void, AutomationError>;
    readonly runNow: (id: AutomationId) => Effect.Effect<AutomationRun, AutomationError>;
    readonly listRuns: (
      input: AutomationListRunsInput,
    ) => Effect.Effect<AutomationListRunsResult, AutomationError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Run every schedule decision due at the current clock. The timer calls this; tests may too. */
    readonly tick: Effect.Effect<void>;
    /** Resolves once queued run-completion checks have been processed. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/automation/AutomationService") {}

const toAutomationError =
  (operation: string) =>
  (cause: unknown): AutomationError =>
    new AutomationError({
      operation,
      detail:
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : `Automation ${operation} failed.`,
    });

/** Log and swallow failures so a background loop survives; interruption still propagates. */
const logFailures =
  (message: string, annotations: Readonly<Record<string, unknown>> = {}) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | void, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(message, { ...annotations, cause: Cause.pretty(cause) }),
      ),
    );

const toIso = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));
const nullableIso = (epochMs: number | null) => (epochMs === null ? null : toIso(epochMs));

function eventThreadId(event: OrchestrationEvent): ThreadId | null {
  switch (event.type) {
    case "thread.session-set":
    case "thread.deleted":
    case "thread.turn-diff-completed":
      return event.payload.threadId;
    default:
      return null;
  }
}

export const make = Effect.gen(function* () {
  const repository = yield* AutomationRepository;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const lock = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<void>();
  const wake = yield* Queue.sliding<void>(1);
  /** Threads of runs still in flight, so unrelated events skip the database. */
  const runningThreadIds = new Set<ThreadId>();

  const nowIso = Effect.map(Clock.currentTimeMillis, toIso);
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const wakeScheduler = Queue.offer(wake, undefined).pipe(Effect.asVoid);

  const toAutomation = (record: AutomationRecord, lastRun: AutomationRun | null): Automation => ({
    id: record.id,
    name: record.name,
    projectId: record.projectId,
    prompt: record.prompt,
    modelSelection: record.modelSelection,
    runtimeMode: record.runtimeMode,
    schedule: record.schedule,
    target: record.target,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nextRunAt: nullableIso(nextAutomationRunAtMs(record)),
    lastRun,
  });

  const buildSnapshot = Effect.gen(function* () {
    const records = yield* repository.list;
    const latestRuns = new Map(
      (yield* repository.latestRuns).map((run) => [run.automationId, run] as const),
    );
    return {
      automations: records.map((record) => toAutomation(record, latestRuns.get(record.id) ?? null)),
    } satisfies AutomationsSnapshot;
  }).pipe(Effect.mapError(toAutomationError("list")));

  const latestRunFor = (id: AutomationId) =>
    repository.listRuns(id, 1).pipe(Effect.map((runs) => runs[0] ?? null));

  const requireAutomation = (id: AutomationId, operation: string) =>
    repository.get(id).pipe(
      Effect.mapError(toAutomationError(operation)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new AutomationError({ operation, detail: "Automation not found." })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const validate = Effect.fnUntraced(function* (record: AutomationRecord, operation: string) {
    const scheduleError = validateAutomationSchedule(
      record.schedule,
      yield* Clock.currentTimeMillis,
    );
    if (scheduleError !== null) {
      return yield* new AutomationError({ operation, detail: scheduleError });
    }
    const project = yield* snapshots
      .getProjectShellById(record.projectId)
      .pipe(Effect.mapError(toAutomationError(operation)));
    if (Option.isNone(project)) {
      return yield* new AutomationError({ operation, detail: "Project not found." });
    }
  });

  const finishRun = Effect.fnUntraced(function* (
    run: AutomationRun,
    status: AutomationRun["status"],
    detail: string | null,
  ) {
    const finished: AutomationRun = { ...run, status, detail, finishedAt: yield* nowIso };
    yield* repository.upsertRun(finished);
    if (run.threadId !== null) runningThreadIds.delete(run.threadId);
    yield* notifyChanged;
    return finished;
  });

  /** Record the outcome of a running run if its turn has finished. Returns the run as stored. */
  const settleRun = Effect.fnUntraced(function* (run: AutomationRun) {
    if (run.status !== "running" || run.threadId === null) return run;
    const thread = yield* snapshots.getThreadShellById(run.threadId);
    const outcome = resolveAutomationRunOutcome(run, Option.getOrNull(thread));
    return outcome === null ? run : yield* finishRun(run, outcome.status, outcome.detail);
  });

  const settleThread = (threadId: ThreadId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const running = yield* repository.runningRuns;
        yield* Effect.forEach(
          running.filter((run) => run.threadId === threadId),
          settleRun,
          { discard: true },
        );
      }),
    );

  /**
   * Start one run. Skips (and records why) while the previous run is still
   * active; a stale "running" row whose turn already ended is settled first.
   */
  const startRun = Effect.fnUntraced(function* (
    record: AutomationRecord,
    trigger: AutomationRunTrigger,
    scheduledFor: string | null,
  ) {
    const startedAt = yield* nowIso;
    const runId = AutomationRunId.make(yield* uuid);
    const base: AutomationRun = {
      id: runId,
      automationId: record.id,
      trigger,
      scheduledFor,
      startedAt,
      finishedAt: null,
      status: "running",
      threadId: null,
      detail: null,
    };

    const active = (yield* repository.runningRuns).filter((run) => run.automationId === record.id);
    const stillActive = yield* Effect.filter(active, (run) =>
      settleRun(run).pipe(Effect.map((settled) => settled.status === "running")),
    );
    if (stillActive.length > 0) {
      const skipped: AutomationRun = {
        ...base,
        status: "skipped",
        finishedAt: startedAt,
        detail: "Previous run still active.",
      };
      yield* repository.upsertRun(skipped);
      yield* notifyChanged;
      return skipped;
    }

    const project = yield* snapshots.getProjectShellById(record.projectId);
    if (Option.isNone(project)) {
      const failed: AutomationRun = {
        ...base,
        status: "failed",
        finishedAt: startedAt,
        detail: "The automation's project no longer exists.",
      };
      yield* repository.upsertRun(failed);
      yield* notifyChanged;
      return failed;
    }

    let threadId: ThreadId | null = null;
    if (record.target === "same-thread" && record.continueThreadId !== null) {
      const existing = yield* snapshots.getThreadShellById(record.continueThreadId);
      if (Option.isSome(existing) && existing.value.archivedAt === null) {
        threadId = existing.value.id;
      }
    }
    const createThread = threadId === null;
    const runThreadId = threadId ?? ThreadId.make(yield* uuid);
    const run: AutomationRun = { ...base, threadId: runThreadId };
    yield* repository.upsertRun(run);
    runningThreadIds.add(runThreadId);
    if (record.target === "same-thread" && record.continueThreadId !== runThreadId) {
      yield* repository.upsert({ ...record, continueThreadId: runThreadId });
    }
    yield* notifyChanged;

    const label = formatAutomationRunLabel(Date.parse(startedAt), record.schedule.timezone);
    const launch = Effect.gen(function* () {
      if (createThread) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`server:automation:${runId}:create`),
          threadId: runThreadId,
          projectId: record.projectId,
          title: `${record.name} · ${label}`,
          modelSelection: record.modelSelection,
          runtimeMode: record.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: startedAt,
        });
      }
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:automation:${runId}:turn`),
        threadId: runThreadId,
        message: {
          messageId: MessageId.make(`automation:${runId}`),
          role: "user",
          text: record.prompt,
          attachments: [],
        },
        modelSelection: record.modelSelection,
        runtimeMode: record.runtimeMode,
        interactionMode: "default",
        createdAt: startedAt,
      });
    });
    return yield* launch.pipe(
      Effect.as(run),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => {
          const error = Cause.squash(cause);
          return finishRun(
            run,
            "failed",
            error instanceof Error && error.message.length > 0
              ? error.message
              : "Failed to start the run.",
          );
        },
      ),
    );
  });

  const tickUnlocked = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    for (const record of yield* repository.list) {
      const decision = decideAutomationSchedule(record, nowMs);
      if (decision.kind === "idle") continue;
      const slot = toIso(decision.slotMs);
      // Advance the cursor first: a crash mid-run must never replay the slot.
      yield* repository.upsert({ ...record, lastScheduledFor: slot });
      const current = { ...record, lastScheduledFor: slot };
      if (decision.kind === "missed") {
        const startedAt = toIso(nowMs);
        yield* repository.upsertRun({
          id: AutomationRunId.make(yield* uuid),
          automationId: record.id,
          trigger: "schedule",
          scheduledFor: slot,
          startedAt,
          finishedAt: startedAt,
          status: "skipped",
          threadId: null,
          detail: "Missed while the server was offline.",
        });
        yield* notifyChanged;
        continue;
      }
      yield* startRun(current, "schedule", slot).pipe(
        logFailures("automation run failed to start", { automationId: record.id }),
      );
    }
  });

  const tick = lock
    .withPermits(1)(tickUnlocked)
    .pipe(logFailures("automation scheduler tick failed"));

  const millisUntilNextDue = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let delay = MAX_SCHEDULER_SLEEP_MS;
    for (const record of yield* repository.list) {
      const next = nextAutomationRunAtMs(record);
      if (next !== null) delay = Math.min(delay, Math.max(0, next - now));
    }
    return delay;
  }).pipe(Effect.orElseSucceed(() => MAX_SCHEDULER_SLEEP_MS));

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    settleThread(threadId).pipe(logFailures("automation run settlement failed", { threadId })),
  );

  const start: AutomationService["Service"]["start"] = Effect.fn("AutomationService.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      // Runs left "running" by a restart may have finished while we were down.
      const running = yield* repository.runningRuns.pipe(Effect.orElseSucceed(() => []));
      for (const run of running) {
        if (run.threadId === null) continue;
        runningThreadIds.add(run.threadId);
        yield* worker.enqueue(run.threadId);
      }
      yield* forkParked(
        Stream.runForEach(events, (event) => {
          const threadId = eventThreadId(event);
          return threadId !== null && runningThreadIds.has(threadId)
            ? worker.enqueue(threadId)
            : Effect.void;
        }),
      );
      yield* forkParked(
        Effect.gen(function* () {
          yield* tick;
          const delay = yield* millisUntilNextDue;
          yield* Effect.raceFirst(Effect.sleep(Duration.millis(delay)), Queue.take(wake));
        }).pipe(Effect.forever),
      );
    },
  );

  const create: AutomationService["Service"]["create"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const record = createAutomationRecord(AutomationId.make(yield* uuid), input, yield* nowIso);
        yield* validate(record, "create");
        yield* repository.upsert(record).pipe(Effect.mapError(toAutomationError("create")));
        yield* notifyChanged;
        yield* wakeScheduler;
        return toAutomation(record, null);
      }),
    );

  const update: AutomationService["Service"]["update"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* requireAutomation(input.id, "update");
        const record = applyAutomationUpdate(current, input, yield* nowIso);
        yield* validate(record, "update");
        yield* repository.upsert(record).pipe(Effect.mapError(toAutomationError("update")));
        yield* notifyChanged;
        yield* wakeScheduler;
        const lastRun = yield* latestRunFor(record.id).pipe(
          Effect.mapError(toAutomationError("update")),
        );
        return toAutomation(record, lastRun);
      }),
    );

  const remove: AutomationService["Service"]["remove"] = (id) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* requireAutomation(id, "delete");
        const running = yield* repository.runningRuns.pipe(
          Effect.mapError(toAutomationError("delete")),
        );
        for (const run of running) {
          if (run.automationId === id && run.threadId !== null) {
            runningThreadIds.delete(run.threadId);
          }
        }
        yield* repository.remove(id).pipe(Effect.mapError(toAutomationError("delete")));
        yield* notifyChanged;
        yield* wakeScheduler;
      }),
    );

  const runNow: AutomationService["Service"]["runNow"] = (id) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* requireAutomation(id, "runNow");
        return yield* startRun(record, "manual", null).pipe(
          Effect.mapError(toAutomationError("runNow")),
        );
      }),
    );

  const listRuns: AutomationService["Service"]["listRuns"] = (input) =>
    repository.listRuns(input.automationId, input.limit ?? DEFAULT_RUN_HISTORY_LIMIT).pipe(
      Effect.map((runs) => ({ runs })),
      Effect.mapError(toAutomationError("listRuns")),
    );

  const subscribe: AutomationService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(buildSnapshot),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => buildSnapshot)),
      );
    }),
  );

  return AutomationService.of({
    subscribe,
    create,
    update,
    remove,
    runNow,
    listRuns,
    start,
    tick,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(AutomationService, make);

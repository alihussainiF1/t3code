import {
  AutomationId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyAutomationUpdate,
  createAutomationRecord,
  decideAutomationSchedule,
  resolveAutomationRunOutcome,
} from "./automationPolicy.ts";

const CREATED = "2026-10-01T08:00:00.000Z";
const record = createAutomationRecord(
  AutomationId.make("automation"),
  {
    name: "Nightly",
    projectId: ProjectId.make("project"),
    prompt: "Run the checks.",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    schedule: { cron: "0 9 * * *", timezone: "UTC" },
    target: "same-thread",
    enabled: true,
  },
  CREATED,
);

describe("automationPolicy", () => {
  it("re-anchors the schedule only when it changes or the automation is re-enabled", () => {
    const fired = { ...record, lastScheduledFor: "2026-10-01T09:00:00.000Z" };
    const renamed = applyAutomationUpdate(fired, { id: record.id, name: "Renamed" }, "later");
    expect([renamed.scheduleAnchorAt, renamed.lastScheduledFor]).toEqual([
      CREATED,
      "2026-10-01T09:00:00.000Z",
    ]);

    const rescheduled = applyAutomationUpdate(
      fired,
      { id: record.id, schedule: { cron: "0 10 * * *", timezone: "UTC" } },
      "later",
    );
    expect([rescheduled.scheduleAnchorAt, rescheduled.lastScheduledFor]).toEqual(["later", null]);

    const disabled = applyAutomationUpdate(fired, { id: record.id, enabled: false }, "later");
    expect(disabled.scheduleAnchorAt).toBe(CREATED);
    const reEnabled = applyAutomationUpdate(disabled, { id: record.id, enabled: true }, "after");
    expect(reEnabled.scheduleAnchorAt).toBe("after");
  });

  it("forgets the continued thread when the project or target changes", () => {
    const continuing = { ...record, continueThreadId: ThreadId.make("thread") };
    expect(
      applyAutomationUpdate(continuing, { id: record.id, prompt: "New" }, "t").continueThreadId,
    ).toBe("thread");
    expect(
      applyAutomationUpdate(continuing, { id: record.id, projectId: ProjectId.make("other") }, "t")
        .continueThreadId,
    ).toBeNull();
    expect(
      applyAutomationUpdate(continuing, { id: record.id, target: "new-thread" }, "t")
        .continueThreadId,
    ).toBeNull();
  });

  it("never decides to run a disabled automation", () => {
    const now = Date.parse("2026-10-01T09:30:00.000Z");
    expect(decideAutomationSchedule(record, now).kind).toBe("run");
    expect(decideAutomationSchedule({ ...record, enabled: false }, now).kind).toBe("idle");
  });

  it("ignores turns that belong to earlier runs of a continued thread", () => {
    const run = { startedAt: "2026-10-02T09:00:00.000Z" };
    const turn = (requestedAt: string, state: "running" | "completed" | "interrupted") => ({
      latestTurn: {
        turnId: TurnId.make("turn"),
        state,
        requestedAt,
        startedAt: requestedAt,
        completedAt: state === "running" ? null : requestedAt,
        assistantMessageId: null,
      },
      session: null,
    });
    const thread = (input: ReturnType<typeof turn>) =>
      input as Pick<OrchestrationThreadShell, "latestTurn" | "session">;

    expect(
      resolveAutomationRunOutcome(run, thread(turn("2026-10-01T09:00:01.000Z", "completed"))),
    ).toBeNull();
    expect(
      resolveAutomationRunOutcome(run, thread(turn("2026-10-02T09:00:01.000Z", "running"))),
    ).toBeNull();
    expect(
      resolveAutomationRunOutcome(run, thread(turn("2026-10-02T09:00:01.000Z", "completed"))),
    ).toEqual({ status: "completed", detail: null });
    expect(
      resolveAutomationRunOutcome(run, thread(turn("2026-10-02T09:00:01.000Z", "interrupted"))),
    ).toEqual({ status: "failed", detail: "The turn was interrupted." });
    expect(resolveAutomationRunOutcome(run, null)?.status).toBe("failed");
  });
});

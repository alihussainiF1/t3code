// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  TextGenerationError,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { ProviderAdapterProcessError } from "../../provider/Errors.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";

const threadId = ThreadId.make("thread-1");
const codex: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};
const claude: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-6",
};
const at = (seconds: number) =>
  `2026-01-01T00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.000Z`;

type SendTurnInput = Parameters<ProviderServiceShape["sendTurn"]>[0];
type StartSessionInput = Parameters<ProviderServiceShape["startSession"]>[1];

describe("ProviderCommandReactor provider handoff", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const baseDirs: Array<string> = [];

  afterEach(async () => {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = null;
    await runtime?.dispose();
    runtime = null;
    for (const dir of baseDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  async function createHarness(options?: {
    readonly failStartFor?: ProviderInstanceId;
    readonly summary?: () => Effect.Effect<{ summary: string }, TextGenerationError>;
  }) {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-handoff-"));
    baseDirs.push(baseDir);
    const runtimeEvents = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const sessions: Array<ProviderSession> = [];
    const sent = Effect.runSync(Queue.unbounded<SendTurnInput>());
    const failStartFor = options?.failStartFor;

    const startSession = vi.fn((_: ThreadId, input: StartSessionInput) => {
      if (input.providerInstanceId === failStartFor) {
        return Effect.fail(
          new ProviderAdapterProcessError({
            provider: String(input.provider),
            threadId: input.threadId,
            detail: "not signed in",
          }),
        ) as Effect.Effect<ProviderSession, ProviderServiceError>;
      }
      const session: ProviderSession = {
        provider: ProviderDriverKind.make(input.provider ?? "codex"),
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? { opaque: `resume-${input.providerInstanceId}` },
        createdAt: at(0),
        updatedAt: at(0),
      };
      // Like ProviderService: a new session replaces the thread's previous one.
      const index = sessions.findIndex((entry) => entry.threadId === input.threadId);
      if (index >= 0) sessions.splice(index, 1);
      sessions.push(session);
      return Effect.succeed(session);
    });
    const sendTurn = vi.fn((input: SendTurnInput) =>
      Queue.offer(sent, input).pipe(
        Effect.as({ threadId: input.threadId, turnId: TurnId.make("provider-turn") }),
      ),
    );
    const generateThreadSummary = vi.fn<TextGeneration["Service"]["generateThreadSummary"]>(
      () =>
        options?.summary?.() ??
        Effect.fail(new TextGenerationError({ operation: "generateThreadSummary", detail: "off" })),
    );
    const unsupported = () => Effect.die(new Error("unsupported in test")) as never;
    const providerService: ProviderServiceShape = {
      startSession,
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      compactThread: () => Effect.void,
      interruptTurn: () => Effect.void,
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      stopSession: () => Effect.void,
      listSessions: () => Effect.succeed(sessions),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      assertConversationRollbackSupported: () => unsupported(),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(
          String(instanceId).startsWith("claude") ? "claudeAgent" : "codex",
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: { driverKind, continuationKey: `${driverKind}:${instanceId}` },
        });
      },
      rollbackConversation: () => unsupported(),
      uploadFeedback: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEvents);
      },
    };

    const projectionLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const engineLayer = OrchestrationEngineLive.pipe(
      Layer.provide(projectionLayer),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const { stateDir } = Effect.runSync(
      deriveServerPaths(baseDir, undefined).pipe(Effect.provide(NodeServices.layer)),
    );
    baseDirs.push(stateDir);
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(engineLayer),
      Layer.provideMerge(projectionLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provide(
        Layer.mock(ProviderAuthService, { tryHandlePromptCommand: () => Effect.succeed(false) }),
      ),
      Layer.provideMerge(makeProviderRegistryLayer([])),
      Layer.provideMerge(Layer.mock(GitWorkflowService.GitWorkflowService)({})),
      Layer.provideMerge(
        Layer.mock(VcsStatusBroadcaster)({ refreshStatus: () => Effect.die("unused") }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName: () =>
            Effect.fail(
              new TextGenerationError({ operation: "generateBranchName", detail: "off" }),
            ),
          generateThreadTitle: () =>
            Effect.fail(
              new TextGenerationError({ operation: "generateThreadTitle", detail: "off" }),
            ),
          generateThreadSummary,
        }),
      ),
      Layer.provideMerge(Layer.mock(TerminalManager)({ closeIdle: () => Effect.void })),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

    await run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project"),
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/handoff-project",
        defaultModelSelection: codex,
        createdAt: at(0),
      }),
    );
    await run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread"),
        threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: codex,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: at(0),
      }),
    );
    scope = await run(Scope.make("sequential"));
    await run(reactor.start().pipe(Scope.provide(scope)));

    /** Send a message and wait for the provider to receive it. */
    const send = async (
      id: string,
      text: string,
      seconds: number,
      modelSelection: ModelSelection,
    ) => {
      await run(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-${id}`),
          threadId,
          message: { messageId: MessageId.make(id), role: "user", text, attachments: [] },
          modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt: at(seconds),
        }),
      );
      await run(reactor.drain);
    };
    /** The provider runs a turn and answers. */
    const answer = async (turn: string, text: string, seconds: number) => {
      const session = (instance: ProviderSession["status"]) => ({
        threadId,
        status: instance === "running" ? ("running" as const) : ("ready" as const),
        providerName: "codex",
        runtimeMode: "full-access" as const,
        activeTurnId: instance === "running" ? TurnId.make(turn) : null,
        lastError: null,
        updatedAt: at(seconds),
      });
      const current = (await run(snapshotQuery.getThreadShellById(threadId))).pipe((value) =>
        value._tag === "Some" ? value.value.session : null,
      );
      const base = {
        providerName: current?.providerName ?? "codex",
        ...(current?.providerInstanceId ? { providerInstanceId: current.providerInstanceId } : {}),
      };
      await run(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-running-${turn}`),
          threadId,
          session: { ...session("running"), ...base },
          createdAt: at(seconds),
        }),
      );
      await run(
        engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(`cmd-delta-${turn}`),
          threadId,
          messageId: MessageId.make(`assistant-${turn}`),
          delta: text,
          turnId: TurnId.make(turn),
          createdAt: at(seconds),
        }),
      );
      await run(
        engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(`cmd-complete-${turn}`),
          threadId,
          messageId: MessageId.make(`assistant-${turn}`),
          turnId: TurnId.make(turn),
          createdAt: at(seconds),
        }),
      );
      await run(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-ready-${turn}`),
          threadId,
          session: { ...session("ready"), ...base },
          createdAt: at(seconds),
        }),
      );
      await run(reactor.drain);
    };

    return {
      engine,
      run,
      send,
      answer,
      startSession,
      generateThreadSummary,
      nextSent: () => run(Queue.take(sent)),
      readThread: async () =>
        (await run(snapshotQuery.getSnapshot())).threads.find((entry) => entry.id === threadId)!,
    };
  }

  it("hands a thread from Codex to Claude with the previous conversation", async () => {
    const harness = await createHarness();
    await harness.send("m1", "Fix the login bug", 1, codex);
    expect((await harness.nextSent()).input).toBe("Fix the login bug");
    await harness.answer("turn-1", "Fixed it in src/auth.ts", 2);
    // An approval the old session never resolved cannot be answered by the new one.
    await harness.run(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval"),
        threadId,
        activity: {
          id: EventId.make("approval-1"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: { requestId: ApprovalRequestId.make("request-1"), requestKind: "command" },
          turnId: null,
          createdAt: at(3),
        },
        createdAt: at(3),
      }),
    );

    await harness.send("m2", "Now add a test", 10, claude);
    const handoffSend = await harness.nextSent();

    const claudeStart = harness.startSession.mock.calls.at(-1)?.[1];
    expect(claudeStart).toMatchObject({
      provider: "claudeAgent",
      providerInstanceId: "claudeAgent",
      replaceConversation: true,
    });
    expect(claudeStart?.resumeCursor).toBeUndefined();
    expect(handoffSend.input).toMatch(/^<previous_conversation provider="codex">/);
    expect(handoffSend.input).toContain("User: Fix the login bug");
    expect(handoffSend.input).toContain("Assistant: Fixed it in src/auth.ts");
    expect(handoffSend.input).toMatch(/<\/previous_conversation>\n\nNow add a test$/);
    expect(harness.generateThreadSummary).not.toHaveBeenCalled();

    const thread = await harness.readThread();
    // The transcript keeps the user's message as typed.
    expect(thread.messages.find((message) => message.id === "m2")?.text).toBe("Now add a test");
    expect(thread.session).toMatchObject({ providerName: "claudeAgent" });
    expect(thread.activities.filter((entry) => entry.kind === "provider.handoff")).toEqual([
      expect.objectContaining({
        summary: "Switched from Codex to Claude",
        turnId: null,
        payload: expect.objectContaining({
          fromProviderInstanceId: "codex",
          toProviderInstanceId: "claudeAgent",
          checkpointTurnCount: 0,
        }),
      }),
    ]);
    expect(thread.activities).toContainEqual(
      expect.objectContaining({
        kind: "provider.approval.respond.failed",
        payload: expect.objectContaining({ requestId: "request-1" }),
      }),
    );

    // Once Claude has run a turn, later messages go out as typed.
    await harness.answer("turn-2", "Added a test", 11);
    await harness.send("m3", "Thanks", 20, claude);
    expect((await harness.nextSent()).input).toBe("Thanks");
  });

  it("keeps the handoff pending when the new provider fails to start", async () => {
    const harness = await createHarness({ failStartFor: claude.instanceId });
    await harness.send("m1", "Fix the login bug", 1, codex);
    await harness.nextSent();
    await harness.answer("turn-1", "Fixed it", 2);

    await harness.send("m2", "Continue on Claude", 10, claude);
    let thread = await harness.readThread();
    expect(thread.activities.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["provider.handoff", "provider.turn.start.failed"]),
    );
    // The thread stays on the provider that holds its context.
    expect(thread.session).toMatchObject({ providerInstanceId: "codex", status: "error" });

    // Going back to Codex resumes natively, without a preamble.
    await harness.send("m3", "Never mind", 20, codex);
    expect((await harness.nextSent()).input).toBe("Never mind");
    thread = await harness.readThread();
    expect(thread.activities.filter((entry) => entry.kind === "provider.handoff")).toHaveLength(1);
  });

  it("summarizes older turns and falls back to a digest when summarizing fails", async () => {
    const harness = await createHarness({
      summary: () => Effect.succeed({ summary: "Earlier: the user set up auth." }),
    });
    for (let index = 1; index <= 8; index += 1) {
      await harness.send(`m${index}`, `Request ${index}`, index * 10, codex);
      await harness.nextSent();
      await harness.answer(`turn-${index}`, `Done ${index}`, index * 10 + 1);
    }

    await harness.send("m-switch", "Keep going", 100, claude);
    const handoffSend = await harness.nextSent();
    expect(harness.generateThreadSummary).toHaveBeenCalledTimes(1);
    expect(harness.generateThreadSummary.mock.calls[0]?.[0].transcript).toContain("Request 1");
    expect(handoffSend.input).toContain(
      '<earlier_turns_summary turns="2">\nEarlier: the user set up auth.\n</earlier_turns_summary>',
    );
    expect(handoffSend.input).toContain('<turn index="8">');
    expect(handoffSend.input).not.toContain('<turn index="2">');
  });

  it("digests older turns when no summary can be generated", async () => {
    const harness = await createHarness();
    for (let index = 1; index <= 7; index += 1) {
      await harness.send(`m${index}`, `Request ${index}`, index * 10, codex);
      await harness.nextSent();
      await harness.answer(`turn-${index}`, `Done ${index}`, index * 10 + 1);
    }

    await harness.send("m-switch", "Keep going", 100, claude);
    const handoffSend = await harness.nextSent();
    expect(harness.generateThreadSummary).toHaveBeenCalledTimes(1);
    expect(handoffSend.input).toContain("- Turn 1: User: Request 1 | Assistant: Done 1");
    expect(handoffSend.input).toMatch(/Keep going$/);
  });
});

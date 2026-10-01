/**
 * Provider handoff preamble.
 *
 * When a thread moves to a provider that cannot resume the previous provider's
 * native session, the new provider starts empty. The first turn on the new
 * provider carries this preamble, rendered from T3's provider-neutral
 * transcript: the most recent turns verbatim and a summary of older ones.
 * The preamble only goes to the provider; the user's message in the T3
 * transcript stays unchanged.
 *
 * @module threadHandoff
 */
import type {
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

export const PROVIDER_HANDOFF_ACTIVITY_KIND = "provider.handoff";

/** Character budget for the whole preamble. Leaves room for the user's message. */
export const DEFAULT_HANDOFF_BUDGET = 40_000;
/** Recent turns kept verbatim, newest first, while they fit the budget. */
export const DEFAULT_HANDOFF_VERBATIM_TURNS = 6;
/** Older turns get at most this share of the budget when summarized or digested. */
const SUMMARY_SHARE = 0.25;
const MAX_TURN_CHARS = 12_000;
const MAX_TOOL_LINES = 12;
const MAX_TOOL_LINE_CHARS = 160;
const MAX_FILES = 20;
const TRUNCATED = "\n[…truncated…]\n";

export interface HandoffTurn {
  readonly index: number;
  readonly user: string;
  readonly assistant: string;
  readonly tools: ReadonlyArray<string>;
  readonly files: ReadonlyArray<string>;
}

export interface HandoffPlan {
  /** Turns too old or too large to include verbatim, oldest first. */
  readonly olderTurns: ReadonlyArray<HandoffTurn>;
  /** Turns included verbatim, oldest first. */
  readonly recentTurns: ReadonlyArray<HandoffTurn>;
}

/** Keep the start and the end of an oversized text; the end usually holds the conclusion. */
export function truncateMiddle(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= TRUNCATED.length) return text.slice(0, Math.max(0, budget));
  const available = budget - TRUNCATED.length;
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return `${text.slice(0, head)}${TRUNCATED}${tail > 0 ? text.slice(-tail) : ""}`;
}

function singleLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function payloadString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function toolLine(activity: OrchestrationThreadActivity): string | null {
  if (activity.kind !== "tool.completed") return null;
  const detail = payloadString(activity.payload, "detail");
  const status = payloadString(activity.payload, "status");
  const failed = status === "failed" || activity.tone === "error";
  const text = detail ? `${activity.summary}: ${detail}` : activity.summary;
  return singleLine(`${failed ? "[failed] " : ""}${text}`, MAX_TOOL_LINE_CHARS);
}

function messageText(message: OrchestrationMessage): string {
  const text = assistantCitationsToPlainText(message.text).trim();
  const names = message.attachments?.map((attachment) => attachment.name).join(", ");
  return [text, ...(names ? [`[Attachments: ${names}]`] : [])].filter(Boolean).join("\n");
}

/**
 * Group the transcript into user-led turns. User messages carry no turn id,
 * so each user message opens a turn and later content belongs to it by time.
 * Content from `stopAtMessageId` on (the message being sent) is excluded.
 */
export function collectHandoffTurns(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
  readonly stopAtMessageId?: MessageId | undefined;
}): ReadonlyArray<HandoffTurn> {
  const messages = input.messages.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  const stopIndex =
    input.stopAtMessageId === undefined
      ? -1
      : messages.findIndex((message) => message.id === input.stopAtMessageId);
  const included = stopIndex >= 0 ? messages.slice(0, stopIndex) : messages;
  const cutoff = stopIndex >= 0 ? messages[stopIndex]!.createdAt : undefined;
  const userMessages = included.filter((message) => message.role === "user");
  if (userMessages.length === 0) return [];

  const turnIndexAt = (createdAt: string): number => {
    if (cutoff !== undefined && createdAt >= cutoff) return -1;
    let index = -1;
    for (const [candidate, message] of userMessages.entries()) {
      if (message.createdAt <= createdAt) index = candidate;
      else break;
    }
    return index;
  };

  const turns = userMessages.map((message, index) => ({
    index: index + 1,
    user: messageText(message),
    assistant: [] as Array<string>,
    tools: [] as Array<string>,
    files: [] as Array<string>,
  }));
  for (const message of included) {
    if (message.role !== "assistant") continue;
    const text = messageText(message);
    const turn = turns[turnIndexAt(message.createdAt)];
    if (turn && text) turn.assistant.push(text);
  }
  for (const activity of input.activities.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )) {
    const line = toolLine(activity);
    const turn = turns[turnIndexAt(activity.createdAt)];
    if (line && turn) turn.tools.push(line);
  }
  for (const checkpoint of input.checkpoints) {
    const turn = turns[turnIndexAt(checkpoint.completedAt)];
    if (!turn) continue;
    for (const file of checkpoint.files) {
      const label = `${file.path} (+${file.additions}/-${file.deletions})`;
      if (!turn.files.includes(label)) turn.files.push(label);
    }
  }
  return turns
    .map((turn) => ({
      index: turn.index,
      user: turn.user,
      assistant: turn.assistant.join("\n\n"),
      tools:
        turn.tools.length > MAX_TOOL_LINES
          ? [
              ...turn.tools.slice(0, MAX_TOOL_LINES),
              `… ${turn.tools.length - MAX_TOOL_LINES} more tool calls`,
            ]
          : turn.tools,
      files:
        turn.files.length > MAX_FILES
          ? [...turn.files.slice(0, MAX_FILES), `… ${turn.files.length - MAX_FILES} more files`]
          : turn.files,
    }))
    .filter((turn) => turn.user || turn.assistant || turn.tools.length > 0);
}

/** Render one turn as plain text. */
export function formatHandoffTurn(turn: HandoffTurn, maxChars = MAX_TURN_CHARS): string {
  const tools =
    turn.tools.length > 0 ? `Tool calls:\n${turn.tools.map((line) => `- ${line}`).join("\n")}` : "";
  const files = turn.files.length > 0 ? `Files changed: ${turn.files.join(", ")}` : "";
  // Tool lines and files are compact already; the free text absorbs the budget.
  const fixed = tools.length + files.length + 64;
  const textBudget = Math.max(400, maxChars - fixed);
  const userBudget = turn.assistant ? Math.ceil(textBudget * 0.4) : textBudget;
  const user = truncateMiddle(turn.user, userBudget);
  const assistant = truncateMiddle(turn.assistant, textBudget - user.length);
  return [`User: ${user || "(no text)"}`, tools, assistant ? `Assistant: ${assistant}` : "", files]
    .filter(Boolean)
    .join("\n");
}

/** Split turns into verbatim recent turns and older turns that need a summary. */
export function planThreadHandoff(input: {
  readonly turns: ReadonlyArray<HandoffTurn>;
  readonly budget?: number;
  readonly maxVerbatimTurns?: number;
}): HandoffPlan {
  const budget = input.budget ?? DEFAULT_HANDOFF_BUDGET;
  const maxVerbatimTurns = input.maxVerbatimTurns ?? DEFAULT_HANDOFF_VERBATIM_TURNS;
  // Reserve the summary share only when there will be older turns to summarize.
  const verbatimBudget =
    input.turns.length > maxVerbatimTurns ? budget * (1 - SUMMARY_SHARE) : budget;
  const recent: Array<HandoffTurn> = [];
  let used = 0;
  for (const turn of input.turns.toReversed()) {
    if (recent.length >= maxVerbatimTurns) break;
    const size = formatHandoffTurn(turn).length + 32;
    if (used + size > verbatimBudget) {
      // The newest turn always makes it in, trimmed to fit.
      if (recent.length === 0) recent.push(turn);
      break;
    }
    recent.push(turn);
    used += size;
  }
  const olderCount = input.turns.length - recent.length;
  return {
    olderTurns: input.turns.slice(0, olderCount),
    recentTurns: recent.toReversed(),
  };
}

/** Transcript of older turns, used as the summarizer's input. */
export function formatHandoffTranscript(turns: ReadonlyArray<HandoffTurn>): string {
  return turns.map((turn) => `Turn ${turn.index}\n${formatHandoffTurn(turn, 4_000)}`).join("\n\n");
}

/** Fallback when no summary could be generated: a truncated digest of older turns. */
export function digestHandoffTurns(turns: ReadonlyArray<HandoffTurn>, budget: number): string {
  if (turns.length === 0) return "";
  const perTurn = Math.max(200, Math.floor(budget / turns.length));
  const lines = turns.map((turn) => {
    const user = singleLine(turn.user, Math.ceil(perTurn * 0.4));
    const assistant = singleLine(turn.assistant, Math.floor(perTurn * 0.5));
    const files = turn.files.length > 0 ? ` Files: ${turn.files.slice(0, 5).join(", ")}` : "";
    return `- Turn ${turn.index}: User: ${user || "(no text)"}${assistant ? ` | Assistant: ${assistant}` : ""}${files}`;
  });
  // Keep the newest of the older turns when the digest is over budget.
  const kept: Array<string> = [];
  let used = 0;
  for (const line of lines.toReversed()) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  const omitted = lines.length - kept.length;
  return [
    ...(omitted > 0 ? [`(${omitted} earlier turns omitted)`] : []),
    ...kept.toReversed(),
  ].join("\n");
}

function escapeDelimiter(text: string): string {
  return text.replaceAll("</previous_conversation>", "<\\/previous_conversation>");
}

function escapeAttribute(text: string): string {
  return text.replace(/["<>&]/g, "");
}

/**
 * Render the preamble that precedes the user's message on the new provider.
 * Returns an empty string when there is nothing to hand off.
 */
export function renderHandoffPreamble(input: {
  readonly fromProvider: string;
  readonly fromProviderLabel: string;
  readonly plan: HandoffPlan;
  /** Summary or digest of `plan.olderTurns`. */
  readonly earlierSummary?: string | undefined;
  readonly budget?: number;
}): string {
  const budget = input.budget ?? DEFAULT_HANDOFF_BUDGET;
  const { recentTurns, olderTurns } = input.plan;
  if (recentTurns.length === 0 && olderTurns.length === 0) return "";
  const summary = input.earlierSummary?.trim()
    ? truncateMiddle(input.earlierSummary.trim(), Math.floor(budget * SUMMARY_SHARE))
    : "";
  const header = [
    `This thread was previously handled by another coding agent (${input.fromProviderLabel}).`,
    "The conversation so far is below for context only. Continue the work from here;",
    "the user's new message follows after this block.",
  ].join(" ");
  const sections = [
    header,
    ...(summary
      ? [
          `<earlier_turns_summary turns="${olderTurns.length}">\n${summary}\n</earlier_turns_summary>`,
        ]
      : []),
  ];
  let remaining = budget - sections.join("\n\n").length - 128;
  const renderedTurns: Array<string> = [];
  for (const turn of recentTurns.toReversed()) {
    const limit = Math.min(MAX_TURN_CHARS, remaining - 32);
    if (limit < 400 && renderedTurns.length > 0) break;
    const rendered = `<turn index="${turn.index}">\n${formatHandoffTurn(turn, Math.max(400, limit))}\n</turn>`;
    renderedTurns.push(rendered);
    remaining -= rendered.length + 2;
  }
  sections.push(...renderedTurns.toReversed());
  const body = escapeDelimiter(sections.join("\n\n"));
  return `<previous_conversation provider="${escapeAttribute(input.fromProvider)}">\n${body}\n</previous_conversation>`;
}

/** Payload of a `provider.handoff` activity. */
export interface ProviderHandoffPayload {
  readonly fromProviderInstanceId: string;
  readonly fromDriver: string;
  readonly toProviderInstanceId: string;
  readonly toDriver: string;
  /** When the turn that switched providers was requested. */
  readonly requestedAt: string;
  /** The thread's latest turn when the switch happened. */
  readonly previousTurnId: string | null;
  /** Turns checkpointed before the switch. The new provider never saw them as native turns. */
  readonly checkpointTurnCount: number;
}

export function readProviderHandoffPayload(
  activity: OrchestrationThreadActivity,
): ProviderHandoffPayload | null {
  if (activity.kind !== PROVIDER_HANDOFF_ACTIVITY_KIND) return null;
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const fromProviderInstanceId = payloadString(record, "fromProviderInstanceId");
  const toProviderInstanceId = payloadString(record, "toProviderInstanceId");
  const requestedAt = payloadString(record, "requestedAt");
  if (!fromProviderInstanceId || !toProviderInstanceId || !requestedAt) return null;
  return {
    fromProviderInstanceId,
    fromDriver: payloadString(record, "fromDriver") ?? fromProviderInstanceId,
    toProviderInstanceId,
    toDriver: payloadString(record, "toDriver") ?? toProviderInstanceId,
    requestedAt,
    previousTurnId: payloadString(record, "previousTurnId") ?? null,
    checkpointTurnCount:
      typeof record.checkpointTurnCount === "number" ? record.checkpointTurnCount : 0,
  };
}

/**
 * A handoff stays pending until a provider turn starts after it. Until then
 * the next send to the new provider carries the preamble, which also covers a
 * restart or failed start between the switch and the first send, and a revert
 * back past the switch.
 */
export function isProviderHandoffPending(
  payload: ProviderHandoffPayload,
  latestTurn: { readonly turnId: string; readonly requestedAt: string } | null,
): boolean {
  return !(
    latestTurn !== null &&
    latestTurn.turnId !== payload.previousTurnId &&
    latestTurn.requestedAt >= payload.requestedAt
  );
}

/** Prepend the preamble to the user's input, keeping the two clearly separated. */
export function prependHandoffPreamble(preamble: string, userInput: string | undefined): string {
  if (!preamble) return userInput ?? "";
  return userInput ? `${preamble}\n\n${userInput}` : preamble;
}

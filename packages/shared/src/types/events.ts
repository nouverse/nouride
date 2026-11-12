/**
 * The event stream's contract — protocol 1.4, from 0.7.26 (1.3 from 0.7.14, 1.2 from 0.7.11, 1.1 from 0.7.10, 1.0 from
 * 0.7.6).
 *
 * What a turn does reaches anything watching as one append-only stream of rows (`modules/events/` in the engine,
 * `GET /api/control/events` and `/events/stream`, `nouride events`): its start and end, each step, the answer as it
 * is written, each tool call as audited and each model call as metered. A dashboard follows it, the CLI prints it,
 * and editors drive a conversation on it, so what a row says is a promise to programs that are not upgraded with
 * the daemon. This file is that promise: every kind, and every key each kind's `data` carries.
 *
 * `EVENT_CONTRACT` is the one source. The types below are derived from it, so a writer cannot put a key on the
 * wire that is not in it; `docs/contracts/events.lock.json` is it serialised, so a change to it is a reviewed
 * diff; and `apps/engine/tests/contracts/events-contract.test.ts` writes a row of every kind through the daemon's
 * real stores and checks each against it — and checks the lock against the frozen 1.0 baseline. `docs/EVENTS.md`
 * says the same for people, with the rules below.
 *
 * ## How it may change
 *
 * - Additive only within a major version. A kind or a key is never removed, renamed, retyped or given a second
 *   meaning. A new key is optional; a new kind is allowed. Either bumps `EVENT_PROTOCOL_VERSION`'s minor, and
 *   `docs/contracts/EVENTS_CHANGELOG.md` gets a line.
 * - A consumer ignores a kind and a key it does not know — and a producer never relies on one knowing a new kind.
 * - Identity keys (`step`, `callId`, `name`, `approvalId`, `phase`, `status`, `from`, `reason`, `request`) are never cut or retyped: a row
 *   over the size bound has its payload strings cut instead, listed in `cut`, with `truncated: true`.
 * - A breaking change is a new major: a new frozen baseline, and a deprecation note one release ahead.
 *
 * ## What a reader can rely on
 *
 * - `seq` only increases and is never reused; it is not contiguous. A step's number (`data.step`) counts within its
 *   turn, from 1, and is a different counter. `at` is wall-clock time, not an order.
 * - A row reaches a watcher only after its transaction commits; a row that is rolled back is never announced. The
 *   rows of one tool result — its `audit` row and its `tool_done` step — commit together.
 * - `callId` pairs a `tool` with its `tool_done` and its `audit` row. It is unique within a turn: the daemon makes
 *   one up when a provider gives none, or gives one twice.
 * - `unstep` takes back steps already written — never deletes them: a reader leaves those numbers out.
 * - `turn` with `phase: "end"` (or `"note"`, a command's answer) closes the turn and any tool still open in it.
 *   `compact` and `usage` rows of a turn may arrive after its end: the daemon compacts and meters after replying.
 * - `reply.from` is a splice offset: the answer so far is `text.slice(0, from) + data.text`. The end's `reply` and
 *   `replyChars` are the authority on what was sent.
 */

export const EVENT_PROTOCOL_VERSION = "1.9";

type FieldType = "string" | "number" | "boolean" | "object" | "array";

/** One key of a kind's `data`. `identity`: never cut, never retyped — what a reader pairs and orders by. */
export interface EventField {
  readonly type: FieldType;
  readonly optional?: true;
  readonly identity?: true;
  /** The values a string may take, when it is one of a few. */
  readonly values?: readonly string[];
  /** What an array holds. */
  readonly items?: "string" | "number";
}

/**
 * What a model call was for: the turn's own, a helper's, a peer's, a steering reply's — and the work nobody waits
 * on, metered under the turn that set it off when there is one. `llm_usage.purpose` holds the same words.
 */
const USAGE_PURPOSES = ["turn", "helper", "peer", "steer_reply", "compaction", "reflection", "memory", "embedding", "vision", "transcription", "second_look", "side_question"] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

/**
 * How a call is billed: `list` — priced from the price book; `included` — a subscription route the provider profile
 * says costs nothing per token (`billing = "included"`): outside the dollar cap, inside the token cap; `unpriced` —
 * a model the price book does not list; `cli` (1.6) — a coding CLI's prompt, on the CLI's own account: outside both caps.
 */
const USAGE_BASES = ["list", "included", "unpriced", "cli"] as const;
export type UsageBasis = (typeof USAGE_BASES)[number];

/** Why a model call ended, as its provider said (`TokenUsage.stopReason`). `llm_usage.stop_reason` holds the same words. */
const STOP_REASONS = ["stop", "tool_calls", "max_tokens", "error"] as const;

const step = { type: "number", identity: true } as const;
const text = { type: "string" } as const;
const optionalNumber = { type: "number", optional: true } as const;
const optionalString = { type: "string", optional: true } as const;
/**
 * (1.2) A step a helper or a peer took inside one of the turn's calls, written into the turn that started it: `via` is
 * the tool whose call started it — `delegate`, a helper running as this agent, or `ask_agent`, another agent — and `by`
 * is the agent that took it. Its line is marked too (`↳ `, `[nox] `), for a reader that knows neither key. Absent on
 * the turn's own steps. (1.4) On a `turn` start, the same two say the turn is a delegate's own (`turn`, below).
 */
const delegated = { via: { type: "string", optional: true, values: ["delegate", "ask_agent"] }, by: optionalString } as const;

/**
 * Every kind of row, and what its `data` holds. A kind's own comment says when it is written.
 *
 * The step kinds — every kind with a `step` — are numbered within their turn and read back as its step log
 * (`nouride turns show`, the dashboard's steps). The rest describe the turn rather than a step of it.
 */
export const EVENT_CONTRACT = {
  version: EVENT_PROTOCOL_VERSION,
  kinds: {
    /** The model's own account of what it is working out, when the provider sends one. */
    reasoning: { step, text, ...delegated },
    /**
     * A tool call started: its line, the call it pairs by, and the tool. (1.6) `like`: a coding CLI's step, the tool of
     * Nouride's its kind is like — its `name` is the CLI's own (`Bash`), which names none of them.
     */
    tool: { step, text, callId: { type: "string", identity: true }, name: { type: "string", identity: true }, like: { type: "string", optional: true, values: ["exec", "read", "edit", "search", "web_fetch"] }, ...delegated },
    /**
     * A tool call ended: its line — how it went, how long it took — and whether it failed. `outcome` (1.1) says how:
     * `exit` is a command that ran and answered with a non-zero exit — `which` saying no — where `failed`, `timed_out`
     * and `killed` are the call not doing its job. `error` is true for all four. `page` (1.9) is the dashboard page
     * of what the call made or changed, a path under the dashboard: an automation proposed, a mission started.
     */
    tool_done: {
      step,
      text,
      callId: { type: "string", identity: true },
      name: { type: "string", identity: true },
      error: { type: "boolean" },
      outcome: { type: "string", optional: true, values: ["ok", "exit", "failed", "timed_out", "killed"] },
      page: optionalString,
      ...delegated,
    },
    /**
     * Something the daemon says that is not a call or its result: a batch of calls at once, output kept in a file,
     * the context made room. `capped` marks the one note that says the step log reached its cap of 500 — past it
     * the remarks stop, and tool calls, their results and waits are still written.
     */
    note: { step, text, capped: { type: "boolean", optional: true }, ...delegated },
    /**
     * Parked on a person — an approval. The call it is for, when it is one, and (1.2) `approvalId`, the request it
     * waits on — what `POST /approvals/:id/:decision` answers. Written once the request exists, before it is shown.
     */
    waiting: {
      step,
      text,
      callId: { type: "string", optional: true, identity: true },
      name: { type: "string", optional: true, identity: true },
      approvalId: { type: "string", optional: true, identity: true },
      ...delegated,
    },
    /**
     * A message sent while the turn worked, drawn on it once read. (1.3) `editOf`: it is the sender's edit of the message
     * it names — the one the turn answers, or one sent before — and its line starts `✎ `, for a reader that knows no key.
     */
    steer: { step, text, editOf: optionalString },
    /** What the sender of a steering message was told back at once. */
    steer_reply: { step, text },
    /**
     * A model call asked again, said while the wait happens. `provider`: the provider refused or failed and is
     * asked again after `delayMs` — `failure` is the class of what went wrong, never its body. `context_overflow`:
     * asked again with `dropped` earlier messages left out. `audio_refused`: asked again without a voice note. (1.7)
     * `fallback`: the model failed with `failure` and the next model of the agent's chain answers instead — `from` the
     * model that failed, `to` the one asked.
     */
    retry: {
      step,
      text,
      reason: { type: "string", identity: true, values: ["provider", "context_overflow", "audio_refused", "fallback"] },
      from: optionalString,
      to: optionalString,
      failure: optionalString,
      attempt: optionalNumber,
      maxAttempts: optionalNumber,
      delayMs: optionalNumber,
      status: optionalNumber,
      dropped: optionalNumber,
      ...delegated,
    },
    /**
     * The conversation made to fit: `start` and then `done` or `failed` around a summary of `turns` earlier turns of
     * about `tokens`; `trimmed`, earlier messages left out of this request (`dropped`); `pruned`, earlier tool
     * results cleared (`pruned`). Also written after a turn's end, by the compaction that follows a reply. The
     * `/compact` command runs outside any turn and writes none.
     */
    compact: {
      step,
      text,
      phase: { type: "string", identity: true, values: ["start", "done", "failed", "trimmed", "pruned"] },
      turns: optionalNumber,
      tokens: optionalNumber,
      pruned: optionalNumber,
      dropped: optionalNumber,
      ...delegated,
    },
    /**
     * A turn's start (`sessionId`, `prompt`, the message it answers), a command's answer written whole (`note`:
     * `prompt`, `reply`), or its end (`status`, the `reply` — cut at 4,000 characters, `replyChars` its length —
     * `error`, `model`, `toolCalls`, tokens). (1.3) `editOf` on a start: what the turn answers is a person's edit of
     * the message it names — edited while it waited (`messageId` is that message, answered as corrected), or after it
     * was answered (a turn of its own, for the edit). (1.4) `via` and `by` on a start: a delegate's own turn — a helper
     * working in the background (`delegate`), or an agent asked with `ask_agent` once its turn moved there — in the chat
     * it works for and no turn of its conversation. Its steps are rows of it; a reader drawing the conversation leaves
     * it out.
     */
    turn: {
      phase: { type: "string", identity: true, values: ["start", "note", "end"] },
      sessionId: optionalString,
      prompt: optionalString,
      messageId: optionalString,
      senderId: optionalString,
      editOf: optionalString,
      status: { type: "string", optional: true, identity: true, values: ["done", "failed", "cancelled", "interrupted"] },
      reply: optionalString,
      replyChars: optionalNumber,
      error: optionalString,
      model: optionalString,
      toolCalls: optionalNumber,
      inputTokens: optionalNumber,
      outputTokens: optionalNumber,
      ...delegated,
    },
    /**
     * (1.4) What one model request of the turn carried — never the request: about how many tokens (`estimatedTokens`,
     * the daemon's estimate at the scale the provider last measured; the provider's own count is the call's `usage`
     * row), how many earlier tool results in it were cleared to make room (`cleared`) and where those cleared since the
     * line before were kept (`keptAt`, at most 20), whether a compaction's summary of earlier turns was in it
     * (`summary`), and whether the agent's notes were (`notes`). `request` numbers the turn's requests from 1 — not a
     * step, and not in the step log. A helper's or a peer's, inside the turn that waited on it, is marked `via`, `by`.
     */
    context: {
      request: { type: "number", identity: true },
      estimatedTokens: { type: "number" },
      cleared: { type: "number" },
      keptAt: { type: "array", items: "string", optional: true },
      summary: { type: "boolean" },
      notes: { type: "boolean" },
      ...delegated,
    },
    /** Steps taken back off the turn — a message it never read, which is the next turn's question. */
    unstep: { steps: { type: "array", items: "number" } },
    /** The answer's new text since the last row: `text` goes at offset `from`. */
    reply: { from: { type: "number", identity: true }, text },
    /**
     * A tool call as the audit log keeps it: the tool, its arguments (`stdin` never kept, credentials redacted),
     * whether it failed — `error` for a result, `threw` for an exception — how long it ran, and the names of the
     * secrets a command was handed, never a value. Written with its `tool_done`, in the same transaction.
     */
    audit: {
      callId: { type: "string", optional: true, identity: true },
      tool: { type: "string", identity: true },
      args: { type: "object" },
      error: { type: "boolean", optional: true },
      threw: optionalString,
      ms: { type: "number" },
      secrets: { type: "array", items: "string", optional: true },
    },
    /**
     * A model call made on the turn's behalf, as metered: its own, a helper's, a peer's or a steering reply's, and the
     * compaction and reflection the turn set off (1.1: `purpose` says which). May follow the turn's end. `usd` is
     * absent when the call has no list price — `basis` (1.1) says whether it is unpriced or included in a
     * subscription — and `priceAsOf` names the day the price was read. A clip transcribed says `durationMs`. (1.4)
     * `stopReason`: why the provider says the call ended — `max_tokens` a reply cut at the output limit, even one that
     * carried tool calls. Absent when it said nothing: never a guessed `stop`.
     */
    usage: {
      model: { type: "string" },
      provider: { type: "string" },
      inputTokens: { type: "number" },
      outputTokens: { type: "number" },
      usd: optionalNumber,
      estimated: { type: "boolean", optional: true },
      cachedInputTokens: optionalNumber,
      cacheCreationInputTokens: optionalNumber,
      latencyMs: optionalNumber,
      attempts: optionalNumber,
      upstream: { type: "object", optional: true },
      purpose: { type: "string", optional: true, values: USAGE_PURPOSES },
      basis: { type: "string", optional: true, values: USAGE_BASES },
      priceAsOf: optionalString,
      durationMs: optionalNumber,
      stopReason: { type: "string", optional: true, values: STOP_REASONS },
    },
  },
  /**
   * The stream's control frames (1.1): named events, sent only to a reader that asks with `frames=1` — a reader of
   * 1.0 never sees one, and one that skips named frames, as `nouride events` has since 0.7.6, is unaffected either way.
   */
  frames: {
    /** First, before any row: the protocol, the oldest and newest `seq` there are, and the database's epoch. */
    hello: {
      version: { type: "string" },
      oldest: { type: "number" },
      latest: { type: "number" },
      /** Changes when the database is restored to an older state, whose next rows reuse numbers a reader holds. */
      epoch: { type: "string" },
    },
    /**
     * Rows after `since`, up to and including `until`, that this stream will not send. `swept`: gone with their
     * turns' retention, and no page has them. `capped`: more than one stream replays — page `GET /events` from `since`.
     */
    gap: {
      since: { type: "number" },
      until: { type: "number" },
      reason: { type: "string", identity: true, values: ["swept", "capped"] },
    },
    /** The cursor asked for is past the newest row: the database went back to an older state. Start over from `latest`. */
    reset: { latest: { type: "number" } },
    /** The daemon is ending this stream: `shutdown` — reconnect once it is back; `slow` — reconnect now, the rows are kept. */
    bye: { reason: { type: "string", identity: true, values: ["shutdown", "slow"] } },
    /**
     * (1.2) A model call of turn `turnId` is under way: `thinking`, `thinking (step 3)`, `generating · 4.1 KB` — at most
     * one every three seconds of generation. Not a row: never written, never replayed, no `id`; what it says is gone
     * with the moment. A helper's or a peer's says so in its line (`↳ `, `[nox] `).
     */
    thinking: { turnId: { type: "string" }, text: { type: "string" } },
  },
} as const satisfies {
  version: string;
  kinds: Record<string, Record<string, EventField>>;
  frames: Record<string, Record<string, EventField>>;
};

/** Every kind a row can be. */
export type TurnEventKind = keyof typeof EVENT_CONTRACT.kinds;
export const EVENT_KINDS = Object.keys(EVENT_CONTRACT.kinds) as TurnEventKind[];
/** The kinds that are steps of a turn, numbered within it. */
export const TURN_STEP_KINDS = ["reasoning", "tool", "tool_done", "note", "waiting", "steer", "steer_reply", "retry", "compact"] as const satisfies readonly TurnEventKind[];
export type TurnStepKind = (typeof TURN_STEP_KINDS)[number];
/**
 * The step kinds a turn's own work writes — every one but what is said *to* a turn while it works (`steer`,
 * `steer_reply`). What the engine's executor says, what `nouride chat` draws, what a helper or a peer may mark (`via`).
 * Each renderer maps them with `satisfies Record<…>`, so a kind added here and drawn nowhere does not compile.
 */
const EXECUTOR_STEP_KINDS = ["reasoning", "tool", "tool_done", "note", "waiting", "retry", "compact"] as const satisfies readonly TurnStepKind[];
export type ExecutorStepKind = (typeof EXECUTOR_STEP_KINDS)[number];

/**
 * What the executor says, by kind: `thinking` — waiting on the provider, a frame and never a step — and the step kinds
 * a turn's own work writes (`EXECUTOR_STEP_KINDS`). One list, where each kind's meaning is its comment in
 * `EVENT_CONTRACT`; a map that draws them is `satisfies Record<ActivityKind, …>`, so a kind added there and drawn
 * nowhere does not compile.
 */
export type ActivityKind = "thinking" | ExecutorStepKind;

type ValueOf<F> = F extends { values: readonly (infer V)[] }
  ? V
  : F extends { type: "string" }
    ? string
    : F extends { type: "number" }
      ? number
      : F extends { type: "boolean" }
        ? boolean
        : F extends { items: "number" }
          ? number[]
          : F extends { items: "string" }
            ? string[]
            : Record<string, unknown>;
type Always<D> = { [P in keyof D as D[P] extends { optional: true } ? never : P]: ValueOf<D[P]> };
type Sometimes<D> = { [P in keyof D as D[P] extends { optional: true } ? P : never]?: ValueOf<D[P]> };

/** What a row of each kind carries in `data`, as written. */
export type TurnEventData = { [K in TurnEventKind]: Always<(typeof EVENT_CONTRACT.kinds)[K]> & Sometimes<(typeof EVENT_CONTRACT.kinds)[K]> };

/** Added to any row's `data` cut to fit the size bound: which keys were cut. */
export interface EventCut {
  truncated?: true;
  cut?: string[];
}

/** A control frame's name (1.1). */
export type StreamFrameName = keyof typeof EVENT_CONTRACT.frames;
/** What each control frame carries, as sent. */
export type StreamFrameData = {
  [F in StreamFrameName]: Always<(typeof EVENT_CONTRACT.frames)[F]> & Sometimes<(typeof EVENT_CONTRACT.frames)[F]>;
};

/** The keys of a row as the wire carries it, in order — and no others: the store's own fields never reach a reader. */
export const STREAM_ROW_KEYS = ["seq", "at", "turnId", "agentId", "gatewayId", "chatId", "kind", "data"] as const;

/** A row as the wire carries it — `GET /events`'s `events` and each frame of `/events/stream`. */
export interface StreamRow<K extends TurnEventKind = TurnEventKind> {
  seq: number;
  at: number;
  turnId: string | null;
  agentId: string | null;
  gatewayId: string | null;
  chatId: string | null;
  kind: K;
  data: TurnEventData[K] & EventCut;
}

/**
 * One row's `data` of every kind, as the contract has it — what a consumer is tested against: each prints, draws or
 * maps without throwing, and a kind it has never heard of beside them is passed over or shown plainly, never refused.
 */
export const EVENT_EXAMPLES: { [K in TurnEventKind]: TurnEventData[K] } = {
  reasoning: { step: 1, text: "The tests failed on the second run; checking the fixture." },
  tool: { step: 2, text: "exec bun test", callId: "call_1", name: "exec" },
  tool_done: { step: 3, text: "exec ok · 2.1s", callId: "call_1", name: "exec", error: false, outcome: "ok" },
  note: { step: 4, text: "3 calls at once" },
  waiting: { step: 5, text: "waiting for approval: rm -rf build/", callId: "call_2", name: "exec", approvalId: "apr_1" },
  steer: { step: 6, text: "use the staging database" },
  steer_reply: { step: 7, text: "Noted, switching to staging." },
  retry: { step: 8, text: "the provider is busy, asking again in 2s", reason: "provider", failure: "overloaded", attempt: 2, maxAttempts: 6, delayMs: 2_000, status: 529 },
  compact: { step: 9, text: "summarised 12 earlier turns", phase: "done", turns: 12, tokens: 1_800 },
  turn: { phase: "end", status: "done", reply: "All green.", replyChars: 10, model: "claude-sonnet-4-6", toolCalls: 1, inputTokens: 1_200, outputTokens: 40 },
  context: { request: 3, estimatedTokens: 148_200, cleared: 2, keptAt: ["/data/spill/s1/cleared-call_1-ab12.txt"], summary: true, notes: false },
  unstep: { steps: [6] },
  reply: { from: 0, text: "All green." },
  audit: { callId: "call_1", tool: "exec", args: { command: "bun test" }, ms: 2_100 },
  usage: { model: "claude-sonnet-4-6", provider: "nougate", inputTokens: 1_200, outputTokens: 40, usd: 0.0042, purpose: "turn", basis: "list", priceAsOf: "2026-10-17", stopReason: "stop" },
};

/**
 * What is wrong with a row's `data` against the contract, in words — empty when nothing is. Unknown keys are
 * wrong too: a writer does not add one without adding it here first. `truncated` and `cut` are allowed on any kind.
 */
export function eventProblems(kind: string, data: Record<string, unknown>): string[] {
  const fields = (EVENT_CONTRACT.kinds as Record<string, Record<string, EventField>>)[kind];
  if (!fields) return [`"${kind}" is not a kind`];
  const problems: string[] = [];
  for (const [key, field] of Object.entries(fields)) {
    const value = data[key];
    if (value === undefined) {
      if (!field.optional && !(data.truncated === true && !field.identity)) problems.push(`${kind}.${key} is missing`);
      continue;
    }
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (actual !== field.type) problems.push(`${kind}.${key} is ${actual}, not ${field.type}`);
    else if (field.values && !field.values.includes(String(value))) problems.push(`${kind}.${key} is "${String(value)}", not one of ${field.values.join(", ")}`);
    else if (field.items && (value as unknown[]).some((item) => typeof item !== field.items)) problems.push(`${kind}.${key} holds something other than ${field.items}s`);
  }
  for (const key of Object.keys(data)) {
    if (!(key in fields) && key !== "truncated" && key !== "cut") problems.push(`${kind}.${key} is not in the contract`);
  }
  return problems;
}

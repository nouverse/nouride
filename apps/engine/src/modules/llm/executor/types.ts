/**
 * What a turn is asked for, what it produces, and what the executor is wired to.
 *
 * Separate from the loop so the tool caller and the workspace view can depend on the shape without
 * importing the class that drives them. The four token-share constants live here too: they are the
 * budget the loop and the tool caller both spend from, and two copies of a ratio is how they drift.
 */

import type { Recall } from "@/modules/memory/index.ts";
import type {
  ChatMessage,
  ChatType,
  GatewayName,
  LLMFailure,
  LLMProvider,
  LLMSection,
  LlmEffort,
  LoadedAgent,
  Skill,
  StopReason,
  TokenUsage,
  UsagePurpose,
} from "@nouride/shared";
import type { ApprovalLevel } from "@nouride/shared";
import type { ApprovalGate } from "@/modules/tools/approval.ts";
import type { AgentToolset } from "@/modules/tools/registry.ts";
import type { ToolOutputSpill } from "@/modules/llm/spill.ts";
import type { TokenScales } from "@/modules/llm/context-scale.ts";
import type { ActivityKind } from "@/commons/activity.ts";
import type { ContextLine } from "./context-line.ts";
import type { HarnessFacts } from "@/modules/llm/prompt/index.ts";
import type { TurnJournal } from "@/modules/turns/journal.store.ts";

/** How often the platform's typing affordance is refreshed while we work (§6.5 SPEC). */
export const TYPING_REFRESH_MS = 5000;

/**
 * Share of the usable window the system prompt may occupy before its own sections start being dropped.
 *
 * See `promptCeiling` in `run` for why half, and why it is not derived from the conversation budget.
 */
export const PROMPT_SHARE = 0.5;

/**
 * Share of the conversation budget one tool result may occupy before it is spilled to a file.
 *
 * A quarter, so four large results can coexist with room left for the conversation that asked for
 * them. This is the number that makes the cap a *context* cap: `security.tool_max_output_bytes` is
 * 10MB — about 2.5M tokens — which bounds memory and nothing else, so a single command's output could
 * exceed any window by two orders of magnitude and the only thing downstream was a trimmer that
 * cannot touch the newest results.
 *
 * Also bounded absolutely by `MAX_TOOL_RESULT_TOKENS`: a quarter of a million-token window is 200k
 * tokens of log, which fits and is still not something worth paying for on every subsequent request
 * in the turn.
 */
export const TOOL_RESULT_SHARE = 0.25;

/**
 * Hard ceiling on one tool result, whatever the window allows.
 *
 * 12k, down from 25k. A result is paid for again on every request left in the turn, and the newest
 * are exactly the ones `trimToolResults` may not touch — so a 25k-token log read at step 3 of a
 * 20-step turn cost half a million input tokens by the end. What the excerpt is for is to say what
 * the output *is* and how it ended; the detail is one `grep` away in the file it names, which is a
 * cheaper way to see line 40,000 than carrying 24,000 lines nobody asked about.
 */
export const MAX_TOOL_RESULT_TOKENS = 12_000;

/** Work nobody watches, as a turn is told it (`TurnRequest.unattended`). */
export interface Unattended {
  goal: string;
  sendsTo?: { gatewayId: string; chatId: string };
  jobId?: string;
  allowed?: readonly string[];
}

/**
 * Floor, so a small or mis-detected window cannot shrink a result to uselessness.
 *
 * At the 32k fallback a quarter is 6k tokens, which is a reasonable excerpt. At a window small enough
 * to make that figure tiny, the excerpt stops carrying the head and tail that make a spilled log
 * readable, and the agent is better served by a bigger excerpt and an earlier trim than by a stub.
 */
export const MIN_TOOL_RESULT_TOKENS = 2_000;

export interface TurnRequest {
  agent: LoadedAgent;
  provider: LLMProvider;
  toolset: AgentToolset;
  /** History *excluding* the incoming message. */
  history: ChatMessage[];
  userMessage: ChatMessage;
  /**
   * Notes for this turn only: appended to the user message in what is sent to the model, never in
   * what is kept. See `turnReminders` in `pipeline/messages.ts`.
   */
  reminders?: string[];
  /** Platform, for formatting instructions in the prompt. */
  gateway: GatewayName;
  /** What the connection says about writing for it (`Gateway.formatting`) — the prompt's formatting line. */
  formatting?: string;
  /** Connection instance, for session identity and outbound routing. */
  gatewayId: string;
  chatId: string;
  /**
   * When this turn will be aborted, as an epoch millisecond.
   *
   * The signal says *that* the turn ends; this says *when*, which is what anything deciding how long
   * to block needs. Without it the approval gate could only be bounded by its own timeout, and since
   * both default to 300s and the turn starts first, the turn always died before the model could react
   * to a refused call.
   */
  deadlineAt?: number;
  /**
   * Park a call that needs a person rather than wait on it, the question answerable this long (a mission's turn, 0.8.0):
   * nobody is watching, so waiting would hold the work for nothing — the rest goes on, and the answer starts a turn.
   */
  parkApprovalsMs?: number;
  /**
   * The agent's `[llm] fallbacks`, each with its endpoint — in order, tried when the model the turn is on cannot answer
   * (`ProviderCaller`). Absent: none, and a failure stands.
   */
  fallbacks?: { profile: string; model: string; provider: LLMProvider }[];
  /**
   * Calls parked before this turn and not answered: it starts as a turn that just parked one, its rounds as few. A
   * mission's next turn read its pending approval 60 times on the live box — parked a turn earlier, so the turn that
   * parked it was not the one counting.
   */
  parkedCalls?: number;
  chatType: ChatType;
  /** The room's name, where it has one (`roomName`, 0.7.24) — said beside the chat type in the runtime block. */
  roomName?: string;
  sessionId: string;
  /**
   * The turn's record: handed to every tool call's context, so its audit row and the usage of a helper or a
   * peer it starts carry it, and put on the executor's log lines. Absent for a run with no record — cron, a test.
   */
  turnId?: string;
  /**
   * Every call id the turn has used, when this run shares the turn's stream with others — a helper's or a peer's run
   * writes into the turn that started it, so its ids are drawn from the same set (`call-ids.ts`). A run of its own
   * starts an empty one.
   */
  callIds?: Set<string>;
  senderId: string;
  /** A `delegate` helper's turn — see `HarnessFacts.helper`. */
  helper?: boolean;
  /** The daemon started this turn, not a person — see `PromptContext.systemEvent`. */
  systemEvent?: boolean;
  /** Started for what an external agent's CLI said by itself, between turns: its runner reads that, and prompts nothing (`own-words.ts`). */
  ownWords?: boolean;
  /** Another agent asked this one, inside its own turn (`ask_agent`): the chat is the asker's, not this agent's. */
  asked?: boolean;
  senderName?: string;
  /** Whether this daemon authenticated the sender itself — see `MessageEnvelope.senderVerified`. */
  senderVerified?: boolean;
  /** The sender, matched against `[[people]]` by id. Carried separately from the display name. */
  person?: { name: string; notes?: string };
  /**
   * What is remembered and may be shown in this chat (`modules/memory`), for the RECALL section.
   *
   * Copied into the prompt context like `person` beside it — and it was not, at first: the turn read
   * it and the executor dropped it, so every unit test passed and no agent ever saw what it
   * remembered. Found by the pipeline test that sends a message after the nightly pass.
   */
  recall?: Recall;
  /** Whether the install names anyone at all — see `PromptContext.peopleConfigured`. */
  peopleConfigured?: boolean;
  /** Overrides the agent's configured model — set by `/model` for this chat. */
  model?: string;
  /** Directory holding this agent's inbound attachments, readable for this turn. */
  attachmentRoot?: string;
  /**
   * The shared work directory — every agent in the install sees the same one.
   *
   * Absent falls back to the pack directory.
   */
  workspaceDir?: string;
  /**
   * This agent's own directory, reachable by nobody else.
   *
   * Reachable but not the default: work that is handed over has to be somewhere the other agent can
   * read, and handover is the normal case in a multi-agent install.
   */
  privateDir?: string;
  /**
   * `/effort` in this chat, over `[llm] effort`: a coding CLI's level for it (0.8.16), and what an agent's own model is
   * sent (0.8.17).
   */
  effort?: LlmEffort;
  /** A mission's folder (`TurnShape.workdir`): where an external agent's CLI works this turn. Absent: its own folder. */
  workdir?: string;
  /**
   * Other agents reachable in this conversation, and how they are reached.
   *
   * Passed in rather than read from a registry here: which agents are *in this chat*, and whether a
   * mention would be delivered in it, are both routing facts, and the executor has no business
   * knowing how routing works.
   *
   * Typed off `HarnessFacts` rather than restated, because it was restated once and the two drifted:
   * `mentions` was built by the pipeline, declared in both, and forwarded by neither.
   */
  otherAgents?: HarnessFacts["otherAgents"];
  /**
   * Directories readable but not writable for this turn.
   *
   * Background job logs, so an agent can follow work it started without being able to truncate a log
   * that is still being written.
   */
  readOnlyRoots?: string[];
  /**
   * A requirement this turn's final message must satisfy — see `MessageEnvelope.owedReport`.
   *
   * Delivered in the wrap-up call rather than the opening prompt, because that is where the last word
   * is actually written. A turn woken by a finished job that then starts a job of its own ends in
   * `wrapUp` with the `background_started` instruction, and whatever the opening prompt asked for is
   * by then hundreds of tool-result tokens back.
   */
  owedReport?: string;
  signal?: AbortSignal;
  /**
   * Where this turn's messages are committed as they happen — `modules/turns/journal.store.ts`.
   *
   * The caller opens it with the question; the executor records every message after that, and the tool
   * caller the id of each call just before it executes — past the gate and any wait for approval. Absent for a turn nothing will ever resume — a
   * helper `delegate` starts, a peer's turn inside `ask_agent` — whose work is the caller's tool call.
   */
  journal?: TurnJournal;
  /**
   * What this turn's own prompt carried from outside — a forwarded message, a webhook's payload. Read as outside
   * content from the first step: every call is handed it in `ToolContext.untrustedRead`, before any tool brought more.
   */
  outsideContent?: readonly string[];
  /**
   * Work nobody watches (0.8.0): a scheduled job's run, a webhook's, a mission's turn. `goal` is what the work is for —
   * what the second look weighs an action against (`tools/second-look.ts`); `sendsTo`, for a job's run, is the one chat
   * its job names, and a send anywhere else is asked first (`ToolContext.sendsTo`); `jobId` the job, so a person can
   * answer *always for this job*, and `allowed` what they already allowed it (`Job.allowed`).
   */
  unattended?: Unattended;
  /**
   * Asked at every step boundary: stop here rather than start another model call or tool.
   *
   * The shutdown's way of ending a turn between steps instead of in the middle of one. A turn that
   * stops here returns with `paused` set; its caller closes it from the journal.
   */
  pause?: () => boolean;
  /**
   * Asked at the end of a round that will be followed by another: what the person sent while it ran, as one
   * user message, or null — `pipeline/steering.ts`. Read there and not mid-step, so nothing running is cut.
   */
  steer?: () => ChatMessage | null;
  /**
   * Told each time a message is put in front of the turn — a steer, a mission's `tell` (0.8.10) — while `poke` listens;
   * answers how to stop. A coding CLI's turn listens while its prompt runs, to hand the words over then
   * (`external-agents/steering.ts`); a model's turn reads them at its next round and needs no telling.
   */
  steerListen?: (poke: () => void) => () => void;
  /**
   * A line in the agent's own words is being written for a message waiting here (`pipeline/steer-reply.ts`): a coding
   * CLI's turn holds the message until it is said, so the CLI reads the two together.
   */
  steerReplying?: () => boolean;
  /**
   * Asked where `steer` is: a note the harness has for this turn, or null — the nudge of a run gone long
   * (`pipeline/budget-nudges.ts`). Taken when read, and put on the last tool result as the owed report is.
   */
  harnessNote?: () => string | null;
  /**
   * The conversation's work notes as the model reads them, asked at every request and sent after everything else
   * (`ChatParams.tail`, `modules/notes/`): never part of the history, so compaction, the rollover and `/new` never touch
   * them. Absent, or undefined, where there are none — and for a helper's turn or a peer's, whose notes these are not.
   */
  notes?: () => string | undefined;
}

/** One call of a turn, as `TurnResult.toolSteps` keeps it. */
export interface ToolStep {
  name: string;
  ok: boolean;
  path?: string;
  spilledTo?: string;
  /**
   * Its result carried content from outside (`ToolResult.untrusted`): a page, a message, an MCP server's answer. What a
   * mission keeps as its mark across turns, which each start fresh.
   */
  outside?: true;
}

export interface TurnResult {
  text: string;
  /**
   * The whole reply, where some of it went to the chat before `text` as messages of their own — a coding CLI's words
   * before a step (0.8.5). The turn's record keeps this: the dashboard shows a turn's reply from there, and on its own
   * connection that is the only way a reply is read, so the words before a step reached nobody (0.8.7). Absent where
   * `text` is the whole reply.
   */
  told?: string;
  /**
   * A coding CLI's turn (0.8.7): the tokens it reported spending, over ACP — or null where it reported none, which is
   * unknown, not zero. Absent for a turn of the agent's own model, whose tokens are `usage`. A mission counts them
   * against its own limit; each prompt's is recorded as the CLI's through `onUsage` (0.8.8), outside the daily caps.
   */
  externalTokens?: number | null;
  /**
   * What answered, where it was not the agent's own model: a coding CLI (0.8.1), by its name and the model it was set
   * to. The turn's record says this; it said the agent's own model, which had not answered a word.
   */
  answeredBy?: string;
  /** History plus this turn, ready to persist. */
  messages: ChatMessage[];
  /**
   * Only what this turn added: the user message, and every assistant and tool message after it.
   *
   * Returned rather than left to be sliced off `messages`, because it cannot be. The history the
   * executor worked from is not the history it was handed — compaction and truncation happen inside
   * `prepareTurn` — so no length the caller knows is the right offset. The one place that can answer
   * it is here.
   */
  turnMessages: ChatMessage[];
  usage: TokenUsage;
  toolCalls: number;
  iterations: number;
  /**
   * Tool calls the approval gate did not let through this turn.
   *
   * Carried out so the pipeline's closing message can name an approval only when one was actually
   * involved. Guessing is what the previous two versions of that message did, and both guessed wrong
   * in front of the operator.
   */
  approvalsRefused: number;
  /**
   * Every tool call this turn, in order: what ran and whether it worked.
   *
   * Two fields per call and no arguments — plus `path`, for the three tools that write to disk. The
   * refusal to carry arguments stands: keeping every path, URL and command line of every turn in
   * memory to answer the reflection trigger's question about booleans is not a trade worth making.
   * One short string from `write`, `edit` and `multi_edit` is a different bargain, and it buys the
   * thing a delegated turn cannot get any other way — an honest list of what it changed, rather than
   * the list the model remembers writing. See `tools/handoff.ts`.
   *
   * Structural, not imported from `modules/reflection`: the executor has no business knowing that a
   * self-improvement loop exists, and a shape this small is cheaper to restate than to couple to.
   */
  toolSteps: ToolStep[];
  stopReason: StopReason;
  contextTokens: number;
  truncated: boolean;
  /**
   * What this conversation is compacted against, so the pipeline can compact *after* the reply.
   *
   * The pass before a turn is a safety net; the one that matters runs once the answer has gone out, so
   * nobody waits on a summary to get one. At the scale the turn ended on, `tokenScale`.
   */
  compaction: CompactionPlan;
  /**
   * What the provider counted per estimated token, as this turn last measured it — or as the
   * conversation had it when the turn began, if no call reported a count (`context-scale.ts`).
   */
  tokenScale: number;
  /**
   * Stopped at a step boundary because `pause` said so. The messages may end on a round whose later
   * calls never started — the caller closes the turn from its journal rather than saving these.
   */
  paused?: boolean;
  /**
   * Why its last words came from a wrap-up call, when they did: `OUT_OF_TIME`, `OUT_OF_ROUNDS` (`settle.ts`), a tool
   * that asked the turn to end (`background_started`, `helper_started`), an empty reply rescued. The loop ends with
   * `stop` either way, so this is the only place a delegated turn's handoff can tell "finished" from "ran out".
   */
  wrappedUp?: string;
  /**
   * The level this chat's `/effort` asked for that the model refused, and the model (0.8.17): its requests went without
   * it (`EffortGuard`), and the chat is told. Only a level the chat set: one from `[llm] effort` is the log's, as before.
   */
  effortRefused?: { effort: LlmEffort; model: string };
}

/**
 * Everything a compaction of this conversation needs, decided per turn.
 *
 * In the estimator's tokens, converted from the provider's at the scale the turn measured — so a history
 * that tokenizes at twice its estimate is compacted at half the estimate, and the comparison is a plain
 * one wherever it is made (`context-scale.ts`). `totalLimit` alone is the provider's number, as configured.
 */
export interface CompactionPlan {
  /** History estimated above this is compacted. */
  threshold: number;
  /** The history limit compaction is shaped against — tail and parts are shares of it. */
  limit: number;
  /** The whole-request figure the threshold came from, and where that came from — for the log. */
  totalLimit: number;
  source: string;
  summaryModel: string;
  /** The summarizer's window, so a stretch too large for one call is split rather than cut. */
  summarizerWindow: number;
}

export interface ToolControl {
  /**
   * `wrap_up`: one more call, tools withheld, writes the reply. `end`: the turn is over at this round, `reply` its text —
   * for a call that is itself the turn's whole answer (a mission saying it is done), where another call only costs: a
   * model told "end your turn now" went on for 30 more calls on a live box, re-reading what it had just claimed.
   */
  finishTurn?: "wrap_up" | "end";
  note?: string;
  reply?: string;
}

/**
 * What answers a turn: the executor's own tool loop on a model, or an external agent's coding CLI (0.8.1,
 * `external-agents/runner.ts`). Everything after it — the record, the reply, a mission's count — reads the result alone.
 */
export interface TurnBrain {
  run(req: TurnRequest): Promise<TurnResult>;
}

export interface ExecutorDeps {
  llm: LLMSection;
  /**
   * `[media] max_image_bytes` — the per-image ceiling, applied when an attachment is resolved into
   * the request.
   *
   * Passed rather than read from a config object, because the executor holds the LLM section and
   * nothing else, and widening it to the whole config to reach one number would hand this class
   * every setting in the daemon.
   */
  maxImageBytes?: number;
  /**
   * The model refused an audio part and the turn was answered without it.
   *
   * The caller records it against the profile and model, so the next voice note is not sent into the
   * same refusal — see `HearingCheck.recordRejection`. A callback rather than the check itself for the
   * reason `maxImageBytes` is a number: the executor should not hold the attachment layer.
   */
  onAudioRefused?: () => void;
  /**
   * The model the turn was on could not answer and a pair of its `[llm] fallbacks` is answering instead, for the rest
   * of the turn. The caller tells the operator, once an outage (`pipeline/fallback-alert.ts`).
   */
  onFallback?: (info: { from: string; fromProfile: string; to: string; toProfile: string; failure: LLMFailure }) => void;
  /**
   * The context window the agent's gateway states for a model, from its last listing — null when it has said nothing
   * (`llm/catalog.ts`). Read before the table of model families and after the pack's own `context_window`.
   */
  windowOf?: (model: string) => number | null;
  approvals: ApprovalGate;
  timezone: string;
  /** Slash commands the harness intercepts, so the prompt can tell the agent they exist. */
  commands: string[];
  /** Called on a timer while a turn is in flight, to keep the typing indicator alive. */
  onTyping?: () => void;
  /**
   * Keepalive interval. Injectable only so a test can observe the indicator surviving a slow tool
   * without waiting real seconds — that is the exact behaviour the previous version lost.
   */
  typingRefreshMs?: number;
  /**
   * How long a tool has, once its turn is stopped, to stop by itself before the turn goes on without it
   * (`STOPPED_CALL_GRACE_MS`). Injectable so a test of a tool that never stops does not wait real seconds.
   */
  stoppedCallGraceMs?: number;
  /**
   * Each model call the turn makes, as the provider reported it: its own, and the compaction before the first, which
   * says so (`purpose: "compaction"`) — the summary is a call of its own, and it used to be metered by nobody.
   */
  onUsage?: (usage: TokenUsage & { model: string; agentId: string; purpose?: UsagePurpose; provider?: string }) => void;
  /**
   * Who writes a compaction summary for a turn on `model` — `summarizerFor` (`llm/summarizer.ts`), which may send it
   * to `[memory]`'s pass model on another profile, its provider already metered. Absent — a helper's or a peer's
   * scratch turn — the turn's own provider writes it, with `[llm.context] summary_model` or the turn's model.
   */
  summarizer?: (model: string) => { provider: LLMProvider; model: string };
  /**
   * The history as a compaction left it, the moment a summary that was paid for exists. A turn that then fails —
   * a provider error, a stop during the answer, a shutdown — keeps it, rather than going back to the history it
   * started from and paying for the same summary on the next message.
   */
  onCompacted?: (history: ChatMessage[]) => void;
  /** A durable grant authorized a call — bumps its usage counters. */
  onGrantUsed?: (agentId: string, grantKey: string | undefined) => void;
  /**
   * What the agent is doing, one line at a time — and `detail`, what the turn's record keeps beside the line and
   * the live view never shows: a call's id and tool, why a model call was asked again, a tool result's audit row.
   *
   * Separate from `onTyping`, which only says "still working". A 21-second turn used to show nothing at
   * all — the daemon knew it was reading a file and calling a provider, and none of it reached the
   * person who asked. The kinds are `activity.ts`'s, imported rather than restated.
   *
   * Returns a promise only where ordering matters. The `waiting` call site is awaited: whatever it does has to
   * land *before* the approval prompt is posted, or the progress bubble arrives underneath the question it was
   * meant to precede. Every other site stays fire-and-forget — they run inside the tool loop, and a turn should
   * not wait on a status line.
   */
  onActivity?: (kind: ActivityKind, text: string, detail?: Record<string, unknown>) => void | Promise<void>;
  /**
   * What each model request of the turn carried, said just before it is made — each round and each wrap-up (0.7.26,
   * `context-line.ts`). Not activity: no line anybody watches, kept with the turn's record for whoever reads it later.
   */
  onRequest?: (line: ContextLine) => void;
  /**
   * One transaction around the synchronous writes of one tool result — its `tool_done` step with its audit row,
   * the tool message, the journal record — so a follower is told them together, once committed. The pipeline
   * gives the settle's (`TurnContext.atomically`); without one each write is its own. Never spans an await.
   */
  group?: <T>(fn: () => T) => T;
  /**
   * A group of calls is about to run at the same time — one line per call, in call order.
   *
   * For the chat bubble, which shows a single line at a time and would otherwise show only whichever
   * call was announced last. The record and the live view get a `note` through `onActivity` instead,
   * and the per-call `tool` lines still follow for every call: the turn record pairs each call with
   * its result, and a batch line cannot stand in for them.
   */
  onBatch?: (lines: string[]) => void;
  /**
   * The answer as it is written, one delta at a time.
   *
   * Separate from `onActivity` because it is not activity — it is the reply, and the two have opposite
   * lifetimes: a status line is replaced, a reply accumulates. The gateways deliberately do not use
   * this (§6.5: editing a chat message per token flickers and hits rate limits); the dashboard does,
   * because it polls a record rather than editing a message, and a person watching a four-minute turn
   * should see it being written rather than a spinner.
   *
   * Fire-and-forget, and never awaited: a turn must not wait on somebody watching it.
   */
  onText?: (delta: string) => void;
  /**
   * A model step came back with words *and* tool calls — the opening line before work ("aku cek dulu ya"). Called with
   * those words before the step's tools run, and awaited, so what it posts lands above anything the tools post. The
   * caller decides whether it reaches the chat (`pipeline/preamble.ts`); the words stay in the conversation either way.
   * Resolves true where they went out — an external agent's answer then leaves them out (`external-agents/runner.ts`).
   * `own`: the words are a message of their own — a coding CLI's between its steps — said whatever the gap between lines.
   */
  onPreamble?: (text: string, said?: { own?: boolean }) => boolean | void | Promise<boolean | void>;
  /**
   * How much this (agent, person) pair gets asked. Absent behaves as `careful`.
   *
   * Was `autoApproved?: () => boolean`, which could say "stop asking me" and "ask me" and nothing
   * either side of those — see `@nouride/policy`'s `approvals.ts` for the three levels and who decides
   * between them. A function, not a value, because an operator can change it while a turn is running.
   */
  approvalLevel?: () => ApprovalLevel;
  /**
   * The second look (0.8.0): asked whether an action that sends something out belongs to the work, in work nobody
   * watches that has read outside content. Null when it does; why not when it does not — or when nothing could answer.
   * Absent where it is off: by the agent's `[security] model_guard`, or its approval level.
   */
  secondLook?: (input: { goal: string; action: string }) => Promise<string | null>;
  /**
   * The daemon's hint under `careful` for the question about to be put to a person, or null — counted per question, so
   * called only when one is actually asked (`tools/careful-hint.ts`). Absent where nobody is talking to the agent.
   */
  carefulHint?: () => string | null;
  /**
   * The exec posture, for the harness block.
   *
   * A function of the agent because the grant count is per agent, and it has to be read at turn
   * time — a count captured at construction is wrong the moment anyone answers `allow-always`.
   */
  execPolicy?: (agentId: string) => HarnessFacts["execPolicy"];
  /** Told to the agent so it knows credentials exist and how to use one without seeing it. */
  credentialsDir?: string;
  /**
   * The install directory — where `nouride` has to be run from.
   *
   * Missing from the executor until 2026-08-23: the diagnostic `renderPrompt` in the pipeline set it,
   * but the real turn path did not, so the "MY OWN CLI" harness section was silently dropped on every
   * turn. The agent never saw the CLI reference that was written for it.
   */
  installDir?: string;
  /** The user-space bin directory on $PATH, absolute — see `HarnessFacts.binDir`. */
  binDir?: string;
  /** Whether this agent installs the programs every agent runs — the orchestrator's (`toolchain/shared-tools.ts`). */
  changesSharedTools?: (agentId: string) => boolean;
  /**
   * Skills a project carries, scanned fresh each turn.
   *
   * A function rather than a list, for the same reason `liveGrants` is: a skill edited between two
   * messages must be visible on the second one. That freshness is the whole feature — a project
   * skill that needs a reload is a skill nobody bothers to write.
   */
  projectSkills?: (agent: LoadedAgent) => Promise<Skill[]>;
  /**
   * Where a tool result too big for the context goes.
   *
   * Absent means no spilling, and then a huge result enters the working set whole — the behaviour this
   * exists to end. Optional because a test that never produces one should not have to arrange a
   * directory for it, not because it is optional in a daemon.
   */
  spill?: ToolOutputSpill;
  /**
   * What each conversation's provider counted per estimated token — read when a turn is planned, written
   * whenever a call reports a count (`context-scale.ts`). Absent, every turn starts from the raw estimate
   * and corrects it from its own first call: a helper or a peer, whose turn carries no history.
   */
  tokenScales?: TokenScales;
  now?: () => Date;
}

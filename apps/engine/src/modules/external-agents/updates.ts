/**
 * What a coding CLI says while it works, read as a turn of Nouride's (0.8.1).
 *
 * ACP streams a prompt as `session/update`s; the executor's own turn is a run of steps — `tool`, `tool_done`,
 * `reasoning` — and the reply's deltas. This reads one into the other, so a CLI's turn lands in the same turn record,
 * event stream, chat bubble and mission count a model's does, with nothing downstream told which it was. Pure: the
 * runner feeds it updates and hands what comes out to the turn's sinks.
 */

import { blockText, type PlanEntry, type SessionUpdate, type ToolCall, type ToolKind } from "@nouride/acp";
import { clip } from "@nouride/shared";
import type { ToolStep } from "@/modules/llm/executor/types.ts";
import { PromptSpend } from "./usage.ts";

/** Where a read update goes: the turn's own sinks. */
export interface UpdateSink {
  text(delta: string): void;
  activity(kind: "reasoning" | "tool" | "tool_done", text: string, detail?: Record<string, unknown>): void;
  plan(entries: PlanEntry[]): void;
  /**
   * The reply's words before a step, said to the chat now, each a message of its own as the CLI's terminal shows it
   * (`ExecutorDeps.onPreamble`). Resolves true where they went out, so the answer at the end does not say them again.
   */
  preamble(text: string): Promise<boolean>;
  /** Its context as it says now: the tokens in it, of its window — what `/status` tells (0.8.8). */
  context?(used: number, size: number): void;
  /** The last tool call open has ended: a message held for it goes in now (`steering.ts`). */
  idle?(): void;
}

/** A tool result's text in a step line, cut: the step is a line in a chat bubble, not the output. */
const RESULT_LINE = 160;

/**
 * The tool of Nouride's a call of this kind is like: the chat's bubble marks a step by it (`chat-progress.ts`). A CLI's
 * step is its command alone — "git status" — which names none, and every one was marked 🔧 (0.8.5).
 */
const LIKE: Partial<Record<ToolKind, string>> = { execute: "exec", read: "read", edit: "edit", delete: "edit", move: "edit", search: "search", fetch: "web_fetch" };

interface OpenCall {
  name: string;
  title: string;
  like: string | undefined;
  startedAt: number;
  /** Whether its `tool` step is out. Not while Claude Code still streams the input: its title is "Terminal" then. */
  announced: boolean;
}

/** The reply between two steps: one message of the CLI's, and whether the chat already has it. */
interface Part {
  text: string;
  said: boolean;
  offered: boolean;
}

export class UpdateReader {
  private reply = "";
  private thought = "";
  /** Whether a step came since the reply's last words: what the CLI says next is a message of its own. */
  private stepped = false;
  private readonly open = new Map<string, OpenCall>();
  private readonly done: ToolStep[] = [];
  private readonly parts: Part[] = [];
  private readonly offers: Promise<unknown>[] = [];
  private calls = 0;
  private readonly spend = new PromptSpend();

  constructor(
    private readonly sink: UpdateSink,
    private readonly now: () => number = Date.now,
  ) {}

  /** The reply as it stands: every message chunk, in order. */
  get text(): string {
    return this.reply.trim();
  }

  get steps(): readonly ToolStep[] {
    return this.done;
  }

  get toolCalls(): number {
    return this.calls;
  }

  /** What the prompt has spent so far, estimated from its context as the CLI said it (`PromptSpend`). */
  get spent(): number {
    return this.spend.tokens;
  }

  /** Whether a step is open: the CLI is still at work, however long it has said nothing (`own-words.ts`). */
  get working(): boolean {
    return this.open.size > 0;
  }

  /** The reply as the chat still needs it: every message of it the chat was not already given before a step. */
  get unsaid(): string {
    return this.parts.filter((part) => !part.said).map((part) => part.text.trim()).filter(Boolean).join("\n\n");
  }

  /** Whether any message of the reply went to the chat on its own, before the answer. Final once `settled`. */
  get spoke(): boolean {
    return this.parts.some((part) => part.said);
  }

  /** The reply's last message, said already or not: the answer of a turn that ended on a step's opening line. */
  get last(): string {
    return this.parts.at(-1)?.text.trim() ?? "";
  }

  /** Every line offered to the chat, answered: `unsaid` is final after this. */
  async settled(): Promise<void> {
    await Promise.all(this.offers);
  }

  /** What the chat was not told yet, said now: the answer to a message another one follows in the same turn. */
  async sayRest(): Promise<void> {
    this.offerRest();
    await this.settled();
  }

  /**
   * What it said so far offered to the chat now, and what it says next a message of its own: what the CLI said by
   * itself, read before a prompt's own answer (`own-words.ts`) — joined to it, the two read as one sentence.
   */
  async apart(): Promise<void> {
    this.flushThought();
    this.offerRest();
    this.stepped = this.stepped || this.reply !== "";
    await this.settled();
  }

  /** A call the CLI asks permission for is announced first, so its step stands above the question. */
  announce(callId: string, title?: string): void {
    const call = this.open.get(callId);
    if (call && !call.announced) this.announced(callId, call, title);
  }

  read(update: SessionUpdate): void {
    if (update.sessionUpdate !== "agent_thought_chunk") this.flushThought();
    if (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "plan") this.stepped = this.stepped || this.reply !== "";
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const said = blockText(update.content);
        if (!said) return;
        // A CLI's messages around its steps arrive as one stream of chunks: joined as they came, one message ended where
        // the next began — "…sama branch lain.Masih audit." on the live box. A step between them is a paragraph.
        const delta = this.stepped ? `\n\n${said.replace(/^\s+/, "")}` : said;
        if (this.stepped || this.parts.length === 0) this.parts.push({ text: "", said: false, offered: false });
        this.parts.at(-1)!.text += said;
        this.stepped = false;
        this.reply += delta;
        this.sink.text(delta);
        return;
      }
      case "agent_thought_chunk":
        this.thought += blockText(update.content);
        return;
      case "tool_call":
        this.started(update);
        if (update.status === "completed" || update.status === "failed") this.finished(update);
        return;
      case "tool_call_update": {
        const call = this.open.get(update.toolCallId);
        if (!call) this.started(update);
        // Claude Code's first report of a call comes while its input still streams, titled "Terminal"; the command
        // comes in an update. Announced at the title that says what it is, or once it runs — every command read
        // "🔧 Terminal" and the bubble, one unchanged line, looked stuck (0.8.5).
        else if (!call.announced && ((update.title?.trim() && update.title.trim() !== call.title) || (update.status && update.status !== "pending"))) this.announced(update.toolCallId, call, update.title);
        if (update.status === "completed" || update.status === "failed") this.finished(update);
        return;
      }
      case "plan":
        // A plan without its entries says nothing to keep — a CLI that sent one stopped Nouride reading it (0.8.1).
        if (Array.isArray(update.entries)) this.sink.plan(update.entries);
        return;
      case "usage_update":
        if (!Number.isFinite(update.used) || !Number.isFinite(update.size)) return;
        this.spend.context(update.used, this.open.size);
        this.sink.context?.(update.used, update.size);
        return;
      default:
        // A mode switched, the agent's own commands: nothing a turn shows.
        return;
    }
  }

  /** Tool calls open in the prompt now: a steer waits for them (`steering.ts`). */
  get running(): number {
    return this.open.size;
  }

  /** The end of the prompt: a thought still open is written, and a call the agent never closed is closed as cut off. */
  end(): void {
    this.flushThought();
    for (const [id, call] of this.open) {
      if (!call.announced) this.announced(id, call);
      this.sink.activity("tool_done", `${call.name} did not finish`, { callId: id, name: call.name, error: true, outcome: "failed" });
      this.done.push({ name: call.name, ok: false });
    }
    this.open.clear();
  }

  private started(call: ToolCall): void {
    const name = nameOf(call);
    const title = call.title?.trim() || name;
    const open: OpenCall = { name, title, like: call.kind ? LIKE[call.kind] : undefined, startedAt: this.now(), announced: false };
    this.open.set(call.toolCallId, open);
    this.calls += 1;
    if (!(call.status === "pending" && streaming(call.rawInput))) this.announced(call.toolCallId, open);
  }

  /** Its `tool` step, after the reply's words before it — said to the chat first, so they stand above the bubble. */
  private announced(callId: string, call: OpenCall, title?: string): void {
    call.announced = true;
    if (title?.trim()) call.title = title.trim();
    this.offerRest();
    this.sink.activity("tool", call.title, { callId, name: call.name, ...(call.like ? { like: call.like } : {}) });
  }

  /**
   * Every message of the reply not offered to the chat yet, offered as one, in the order they came. Not the last alone:
   * two messages a thought stood between are two parts, and the first stayed out of the chat until the answer.
   */
  private offerRest(): void {
    const parts = this.parts.filter((part) => !part.offered && part.text.trim());
    if (parts.length === 0) return;
    for (const part of parts) part.offered = true;
    const words = parts.map((part) => part.text.trim()).join("\n\n");
    this.offers.push(this.sink.preamble(words).then((sent) => parts.forEach((part) => void (part.said = sent)), () => undefined));
  }

  private finished(call: ToolCall): void {
    const open = this.open.get(call.toolCallId);
    if (!open) return;
    if (!open.announced) this.announced(call.toolCallId, open, call.title);
    this.open.delete(call.toolCallId);
    this.spend.step();
    const failed = call.status === "failed";
    const said = resultLine(call);
    const ms = this.now() - open.startedAt;
    this.sink.activity("tool_done", `${open.name} ${failed ? "failed" : "ok"}${said ? `: ${said}` : ""} · ${ms}ms`, {
      callId: call.toolCallId,
      name: open.name,
      error: failed,
      outcome: failed ? "failed" : "ok",
    });
    this.done.push({ name: open.name, ok: !failed });
    if (this.open.size === 0) this.sink.idle?.();
  }

  private flushThought(): void {
    const text = this.thought.trim();
    this.thought = "";
    if (text) this.sink.activity("reasoning", text);
  }
}

/** An input still streaming: none yet, or an empty object — what Claude Code's adapter sends at a call's first report. */
function streaming(input: unknown): boolean {
  return input === undefined || input === null || (typeof input === "object" && Object.keys(input).length === 0);
}

/**
 * The agent's name for the tool, else the protocol's kind of it — else, where the kind says nothing (`other`, as omp
 * sends for an MCP tool), the title's first word, which is the tool's name there: `mcp__nouride_notes`.
 */
function nameOf(call: ToolCall): string {
  if (call.name?.trim()) return call.name.trim();
  if (call.kind && call.kind !== "other") return call.kind;
  return call.title?.trim().split(/\s+/)[0] || call.kind || "tool";
}

/**
 * The first line of what the call returned, where it said anything in words — not a code fence's: Claude Code wraps a
 * command's output in one, and every step read "Bash ok: ```console" on the live box.
 */
function resultLine(call: ToolCall): string {
  const content = call.content?.find((item) => item.type === "content");
  const text = content && content.type === "content" ? blockText(content.content) : typeof call.rawOutput === "string" ? call.rawOutput : "";
  const line = text.split("\n").map((entry) => entry.trim()).find((entry) => entry !== "" && !entry.startsWith("```")) ?? "";
  return clip(line, RESULT_LINE);
}

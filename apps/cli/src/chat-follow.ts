/**
 * What the agent is doing while `nouride chat` waits — read off the conversation's event stream (`docs/EVENTS.md`).
 *
 * It was a poll of `/activity`, a sixty-line window per chat kept in the daemon's memory with a counter of its own:
 * a restart reset the counter under a CLI that still held a high one, a helper's and a peer's lines reached it and
 * never the stream, and the poller carried a latch for a daemon older than v0.1.0. The stream is the one record of a
 * turn: steps, a helper's and a peer's included (`via`), and — to a reader that asks for frames — `thinking`, the
 * model call under way, which no row keeps.
 *
 * One conversation, named whole — this chat on the local gateway — so another conversation's turn never reaches
 * this screen. Opened once for the session, from now, and opened again from where it was when the connection drops:
 * a daemon restarting is often what is being watched. A daemon that refuses the stream is said once and left alone;
 * the answers still arrive, through `POST /message`.
 */

import { joinLines, type StreamFrameData } from "@nouride/shared";
import type { ActivityKind } from "@nouride/shared";
import { readFrames } from "./commands/events.ts";

/** One line to draw: a step's kind and line, or `thinking`. */
export interface FollowedLine {
  kind: string;
  text: string;
}

export interface ChatFollower {
  /**
   * Everything the turns of the message just answered wrote, drawn before its answer is: waits until each turn that
   * began since the last settle has ended — at most `SETTLE_MAX_MS` — or briefly when none began (nobody answered,
   * or a command did).
   */
  settle(): Promise<void>;
  stop(): void;
}

/**
 * How each line is drawn: `doing` — `▸`, timed while it runs: a call, a wait, the model at work; `thinking` — `│`, the
 * model's own account, which under the action mark read as something it had done; `said` — `·`, a result or the daemon
 * remarking, which carries its own timing. Every kind the executor says, or this does not compile; a kind newer than
 * this CLI is not drawn.
 */
export const MARKS = {
  thinking: "doing",
  reasoning: "thinking",
  tool: "doing",
  tool_done: "said",
  note: "said",
  waiting: "doing",
  retry: "said",
  compact: "said",
} as const satisfies Record<ActivityKind, "doing" | "thinking" | "said">;

/** The kinds drawn as progress: what the turn did, not what was said to it or about its cost. */
const DRAWN = new Set<string>(Object.keys(MARKS).filter((kind) => kind !== "thinking"));
const RECONNECT_MS = 3_000;
/** Three keep-alives missed: the connection is gone even if nothing said so. */
const IDLE_MS = 45_000;
const SETTLE_MAX_MS = 3_000;
const SETTLE_NONE_MS = 300;
const SETTLE_TICK_MS = 20;
/** Drops in a row before the screen is told — one is a blip, and saying so at once reads as an event of its own. */
const QUIET_FAILURES = 3;

export function followChat(deps: {
  open(path: string): Promise<ReadableStream<Uint8Array>>;
  gatewayId: string;
  chatId: string;
  /** Draw one line. Called only while `drawing()` is true: a row after the answer is not drawn under the next prompt. */
  draw(line: FollowedLine): void;
  drawing(): boolean;
  /** One line to the operator, for the states worth telling them about. */
  notice(line: string): void;
  sleep?: (ms: number) => Promise<void>;
}): ChatFollower {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let stopped = false;
  /** The response being read, cancelled by `stop`. */
  let current: { cancel(): Promise<void> } | null = null;
  /** The stream's cursor: what a reconnect resumes after. Null until the first stream says where it starts. */
  let last: number | null = null;
  /** Turns begun and not yet ended, and whether any began since the last settle. */
  const open = new Set<string>();
  let began = false;
  /**
   * A delegate's own turns (1.4, `turn.via`): a helper working in the background, an ask moved there. In this chat's
   * stream and no turn of the conversation — nothing here waits on one or draws its steps, as nothing did before they
   * had a turn of their own.
   */
  const delegated = new Set<string>();

  const take = (row: { seq: number; turnId: string | null; kind: string; data: Record<string, unknown> }): void => {
    last = row.seq;
    if (row.turnId && delegated.has(row.turnId)) return;
    if (row.kind === "turn") {
      const phase = row.data.phase;
      if (phase === "start" && row.turnId && typeof row.data.via === "string") {
        delegated.add(row.turnId);
        return;
      }
      if (phase === "start" && row.turnId) {
        open.add(row.turnId);
        began = true;
      } else if ((phase === "end" || phase === "note") && row.turnId) {
        if (phase === "note") began = true;
        open.delete(row.turnId);
      }
      return;
    }
    // A step as one line of the screen: a model's reasoning arrives with its own line breaks, and printed as it came the
    // lines after the first lost their mark, "1." and "2." of a list bare between the `│` lines.
    if (DRAWN.has(row.kind) && typeof row.data.text === "string" && deps.drawing()) deps.draw({ kind: row.kind, text: joinLines(row.data.text) });
  };

  const thinking = (data: StreamFrameData["thinking"]): void => {
    if (deps.drawing()) deps.draw({ kind: "thinking", text: joinLines(data.text) });
  };

  const run = async (): Promise<void> => {
    let failures = 0;
    let warned = false;
    while (!stopped) {
      const params = new URLSearchParams({ chat: deps.chatId, gateway: deps.gatewayId, frames: "1" });
      if (last === null) params.set("tail", "1");
      else params.set("since", String(last));
      try {
        const body = await deps.open(`/events/stream?${params.toString()}`);
        // Read through a reader of its own, which `stop` can cancel: the parser holds the response locked, and an open
        // response keeps the process alive after the chat ends.
        const reader = body.getReader();
        current = reader;
        if (stopped) return void current.cancel().catch(() => {});
        const readable = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          cancel: () => reader.cancel(),
        });
        for await (const item of readFrames(readable, IDLE_MS)) {
          if (failures > 0 && warned) deps.notice("progress feed is back");
          failures = 0;
          warned = false;
          if (item.row) take(item.row);
          else if (item.frame.event === "thinking") thinking(item.frame.data);
          else if (item.frame.event === "hello" && last === null) last = item.frame.data.latest;
          else if (item.frame.event === "reset") last = item.frame.data.latest;
          if (stopped) return;
        }
      } catch (err) {
        if (stopped) return;
        const status = (err as { status?: number }).status;
        // Refused, not dropped: asking again would ask the same question for the rest of the session.
        if (status !== undefined && ((status >= 400 && status < 500 && status !== 408 && status !== 429) || status === 501)) {
          deps.notice(`no progress feed: the daemon refused its event stream (${status}); the answer will still arrive`);
          return;
        }
      }
      failures += 1;
      if (failures >= QUIET_FAILURES && !warned) {
        warned = true;
        deps.notice("progress feed is not responding, but the answer will still arrive");
      }
      await sleep(RECONNECT_MS);
    }
  };
  void run().catch(() => {});

  return {
    async settle(): Promise<void> {
      const startedAt = Date.now();
      for (;;) {
        if (stopped || (began && open.size === 0)) break;
        const waited = Date.now() - startedAt;
        if (waited >= SETTLE_MAX_MS || (!began && open.size === 0 && waited >= SETTLE_NONE_MS)) break;
        await new Promise((resolve) => setTimeout(resolve, SETTLE_TICK_MS));
      }
      began = false;
    },
    stop(): void {
      stopped = true;
      // The open response would keep the process alive after the chat ends.
      void current?.cancel().catch(() => {});
    },
  };
}

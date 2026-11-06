/**
 * What a coding CLI says between turns (0.8.6). Claude Code goes on by itself when a command it left running in the
 * background ends: it reads the output and says what came of it, over ACP, with no prompt running (measured on the box,
 * 2026-10-28). Nouride dropped those updates, so Nix's "I'll tell you when it is done" never came.
 *
 * Now they are kept here, by session, and the agent's chat is woken once for them: a turn of its own reads them
 * (`runner.ts`), so what the CLI said reaches the chat and the conversation as any answer does. A prompt that opens
 * first reads them before its own, in the order they came. A session that answers no chat of its agent's — another
 * agent's ask, a mission's — wakes nothing: its words wait for its next prompt.
 */

import type { SessionUpdate } from "@nouride/acp";
import { contained, createLogger } from "@nouride/shared";
import type { UpdateReader } from "./updates.ts";

const log = createLogger("external-agents");

/** A session as kept here: its agent's, since two CLIs may number their sessions alike. */
export const ownKey = (agentId: string, sessionId: string): string => `${agentId}|${sessionId}`;

/** The chat a session answers: the agent's own conversation there. */
export interface OwnChat {
  agentId: string;
  gatewayId: string;
  chatId: string;
}

/**
 * How long the CLI is quiet, with no step open, before what it said is its whole answer: it has no word for the end of
 * work it started itself. Between one step and the next a model thinks for seconds; what comes after this is a stretch
 * of its own, and wakes the chat again.
 */
const QUIET_MS = 10_000;

/** What starts a stretch: words, a thought, a step. What else a CLI sends with no prompt running — its commands, its context's size — says nothing. */
function says(update: SessionUpdate): boolean {
  return update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk" || update.sessionUpdate === "tool_call";
}

export class OwnWords {
  private readonly kept = new Map<string, SessionUpdate[]>();
  private readonly chats = new Map<string, OwnChat>();
  private readonly woken = new Set<string>();
  private readonly following = new Map<string, (update: SessionUpdate) => void>();

  constructor(
    private readonly wake: (chat: OwnChat) => void,
    private readonly quietMs = QUIET_MS,
  ) {}

  /** The chat a session answers from now on, or null where it answers none of its agent's own. */
  answers(sessionId: string, chat: OwnChat | null): void {
    if (chat) this.chats.set(sessionId, chat);
    else this.chats.delete(sessionId);
  }

  /** An update for a session nobody is prompting. */
  heard(sessionId: string, update: SessionUpdate): void {
    const follow = this.following.get(sessionId);
    if (follow) return follow(update);
    const kept = this.kept.get(sessionId);
    if (!kept && !says(update)) return;
    if (kept) kept.push(update);
    else this.kept.set(sessionId, [update]);
    const chat = this.chats.get(sessionId);
    if (!chat || this.woken.has(sessionId)) return;
    this.woken.add(sessionId);
    this.wake(chat);
  }

  /** Whether the CLI said something in the session that no turn has read yet. */
  unread(sessionId: string): boolean {
    return (this.kept.get(sessionId)?.length ?? 0) > 0;
  }

  /** What the CLI said that no turn has read, taken. */
  take(sessionId: string): SessionUpdate[] {
    const kept = this.kept.get(sessionId) ?? [];
    this.kept.delete(sessionId);
    this.woken.delete(sessionId);
    return kept;
  }

  /**
   * What the CLI said, into `read`, and what it says on, until it has been quiet with no step open — or the turn is
   * stopped, or the CLI is gone. Nothing, where nothing is kept.
   */
  async follow(sessionId: string, read: UpdateReader, until: { signal?: AbortSignal; gone: () => boolean }): Promise<void> {
    const kept = this.take(sessionId);
    // A prompt that opened while this turn waited for its chat read them: there is nothing left to follow.
    if (kept.length === 0) return;
    for (const update of kept) read.read(update);
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = contained(log, "could not end the turn following what a CLI said by itself", () => {
        clearTimeout(timer);
        if (this.following.get(sessionId) === onUpdate) this.following.delete(sessionId);
        until.signal?.removeEventListener("abort", done);
        resolve();
      });
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(contained(log, "could not follow what a CLI said by itself", () => (read.working && !until.gone() ? arm() : done())), this.quietMs);
      };
      const onUpdate = (update: SessionUpdate) => {
        read.read(update);
        arm();
      };
      if (until.signal?.aborted || until.gone()) return done();
      this.following.set(sessionId, onUpdate);
      until.signal?.addEventListener("abort", done, { once: true });
      arm();
    });
  }

  /** A session let go: what it kept goes with it. */
  forget(sessionId: string): void {
    this.kept.delete(sessionId);
    this.chats.delete(sessionId);
    this.woken.delete(sessionId);
  }
}

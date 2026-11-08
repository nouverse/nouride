/**
 * The turns running now, by agent, chat and connection: whether one is busy, a peer turn held there, what a turn
 * read while it worked and what it never did, who waits for it to end, and stopping it.
 *
 * The table and its rules, apart from the per-turn facts beside it in `turn-context.ts` (workspaces, read roots, the
 * person, spend, approval level). `TurnContext` extends it, so the pipeline and the three things that run turns ask
 * one object, as before.
 */

import { createLogger, type ChatMessage, type MessageEnvelope } from "@nouride/shared";
import type { PipelineDeps } from "./deps.ts";
import { isTell, STEER_CAP, steerMessage } from "./steering.ts";
import { inboxIds } from "./inbox.store.ts";
import { mergeEnvelopes } from "./messages.ts";

const log = createLogger("pipeline.active-turns");

/**
 * Why a turn was aborted, when a person is the reason.
 *
 * The distinction the reply path needs. A turn that ran out of clock should still say what it
 * managed — going silent there is the failure `emptyTurnMessage` exists for. A turn somebody stopped
 * should say nothing at all: they have already been told "Paused, and cancelled what I was doing",
 * and a second message afterwards is the agent getting the last word after being asked to stop.
 *
 * A reason on the signal rather than a flag beside it, because `AbortSignal` carries one and every
 * layer between here and the reply path already forwards the signal itself.
 */
export const STOPPED_BY_PERSON = "stopped-by-person";

/**
 * The abort reason a shutdown gives the turns it could not wait for. Told apart from a stop and from the
 * deadline because the turn is closed as interrupted by a restart, and the person is told so.
 */
export const RESTARTING = "daemon-restarting";

/**
 * One in-flight turn: what stops it, and where to say something about it.
 *
 * The address is *stored* rather than parsed back out of the turn key, and that is not a
 * convenience. A chat id can contain a colon — a cron session's is `cron:<jobId>` — so
 * `<agent>:<chat>:<gateway>` cannot be split back into three reliably, which is why
 * `cancelTurnsInChat` matches with `endsWith` instead of splitting. The shutdown notice needs all
 * three parts, so guessing was not an option.
 */
export interface ActiveTurn {
  controller: AbortController;
  agentId: string;
  chatId: string;
  gatewayId: string;
  /** Messages sent while it works, read at its next step — `steering.ts`. Absent on a turn nobody steers. */
  steers?: MessageEnvelope[];
  /** How many it has read: past `STEER_CAP` the next waits for it to finish. */
  steered?: number;
  /**
   * Past its last step: the answer is written, and what is left is sending it and tidying up — compacting
   * the conversation can take half a minute. A message sent now is the next turn's, taken without the
   * "I'll read that before my next step" there is no next step to keep.
   */
  answered?: boolean;
  /** A steering reply is being written (`steer-reply.ts`): one at a time. */
  replying?: boolean;
  /** Stops that reply: the turn read the message, answered or ended first, and its own answer is the reply now. */
  replyAbort?: AbortController;
  /** Steering replies sent and not yet shown to the model with the messages they answered. */
  replied?: string[];
  /** Its record, found the first time a message steering it was drawn there (`steer-accept.ts`). */
  recordId?: string;
  /** The steps drawn there for each message it has not read — taken back if it never does (`releaseTurn`). */
  drawn?: Map<MessageEnvelope, number[]>;
  /** When it began — what "busy for how long" is measured from (`busyNotice`). */
  startedAt?: number;
  /** The message it answers: who may steer it in a room, and what it is working on. */
  trigger?: MessageEnvelope;
  /** Who has been told it is busy, so each is told once (`whileBusy`). */
  told?: Set<string>;
  /** Messages past `STEER_CAP` drawn on it with the notice that they wait (`steer-accept.ts`): taken back when it ends. */
  waiting?: MessageEnvelope[];
  /** What it read as it worked, by message id: an edit of one is a correction to its work, as one of its question is. */
  read?: Map<string, string>;
  /**
   * Called when a message is put in front of it while it works — a steer, a person's `tell` to its mission (0.8.10). A
   * coding CLI's turn listens while a prompt runs, to hand the words over then rather than once the prompt ends.
   */
  onSteer?: () => void;
}

export class ActiveTurns {
  /** Turn key (`<agent>:<chat>:<gateway>`) → the turn it identifies. */
  readonly activeTurns = new Map<string, ActiveTurn>();
  /** Peer turns, by the same key: an agent at work for another agent is at work in that chat (`holdPeer`). */
  private readonly peerTurns = new Map<string, ActiveTurn>();
  private readonly turnEndWaiters = new Map<string, (() => void)[]>();
  /** Where a steer no turn read goes — the queue, as the next turn. Set by the pipeline. */
  requeue?: (envelope: MessageEnvelope) => void;
  /** A person's `tell` its mission's turn was handed (0.8.10): marked read on the mission. Set where missions run. */
  toldRead?: (missionId: string, tellIds: string[]) => void;
  /**
   * Those messages, and the agent each was for: its next turn, not a message to route again. A room's has been
   * routed already — a second pass would ask every agent it named, and meet the claim it took the first time —
   * and the queue would take it for a platform's redelivery of the same id.
   */
  readonly returned = new WeakMap<MessageEnvelope, string>();

  constructor(readonly deps: PipelineDeps) {}

  /**
   * Whether this agent already has a turn running in this chat.
   *
   * `activeTurns` existed for cancellation and nothing ever asked it this — `set` simply overwrote,
   * so a second message to a busy agent started a second turn that wrote to the same session as the
   * first. The chat queue hid it: one turn at a time per chat meant a second message waited. A room
   * runs several turns at once on purpose, so the guard has to be real rather than incidental.
   *
   * The key is the same string `runTurn` builds, and it is built here so the two cannot drift.
   */
  isBusy(agentId: string, chatId: string, gatewayId: string): boolean {
    return this.turnIn(agentId, chatId, gatewayId) !== undefined;
  }

  /** The turn this agent has running in this chat, if it has one — its own, or a peer turn for another agent. */
  turnIn(agentId: string, chatId: string, gatewayId: string): ActiveTurn | undefined {
    const key = ActiveTurns.turnKey(agentId, chatId, gatewayId);
    return this.activeTurns.get(key) ?? this.peerTurns.get(key);
  }

  /**
   * A peer turn, held in the chat it runs in so its agent is at work there: a person addressing it is told so,
   * a scheduled turn and a job's wake-up wait, and a second ask is refused. Null when the agent already is. Without
   * the request it answers, which the room never saw and a busy notice must not quote, and with nothing to steer.
   */
  holdPeer(agentId: string, chatId: string, gatewayId: string): (() => void) | null {
    if (this.isBusy(agentId, chatId, gatewayId)) return null;
    const key = ActiveTurns.turnKey(agentId, chatId, gatewayId);
    const turn: ActiveTurn = { controller: new AbortController(), agentId, chatId, gatewayId, startedAt: Date.now() };
    this.peerTurns.set(key, turn);
    return () => {
      if (this.peerTurns.get(key) !== turn) return;
      this.peerTurns.delete(key);
      this.wakeWaiters(key);
    };
  }

  /**
   * Remove a finished turn and wake anything waiting for this key to become free.
   *
   * Both call-sites (the budget refusal and the `finally` block) used to call `activeTurns.delete`
   * directly, which meant a `wakeForJob` push into a room's queue could arrive before the delete
   * and be dropped by `isBusy` — the agent was still "busy" even though the turn was over in every
   * way that mattered. Funnelling through here lets `waitUntilFree` resolve the moment the turn is
   * actually gone.
   */
  releaseTurn(turnKey: string): void {
    // Sent while it worked and never read — it was writing its answer, or it was stopped: the next turn's.
    const turn = this.activeTurns.get(turnKey);
    const unread = turn?.steers?.splice(0) ?? [];
    turn?.replyAbort?.abort();
    this.activeTurns.delete(turnKey);
    // Waiting in the queue already, each the next turn's question: only the lines drawn for it come off.
    if (turn?.waiting?.length) this.undraw(turn, turn.waiting);
    if (turn && unread.length > 0) this.undraw(turn, unread);
    // A `tell` its turn never read stays unread on the mission, and its next turn's page carries it — as the next
    // message it would start a turn whose reason is the person's words, or be dropped by a mission no longer running.
    const chat = unread.filter((envelope) => !isTell(envelope));
    if (turn && chat.length > 0) {
      const merged = chat.reduce((first, next) => mergeEnvelopes(first, next));
      this.returned.set(merged, turn.agentId);
      this.requeue?.(merged);
    }
    this.wakeWaiters(turnKey);
  }

  /** Whatever waits for this agent to be free in this chat, once it is — its own turn and any peer turn gone. */
  private wakeWaiters(turnKey: string): void {
    if (this.activeTurns.has(turnKey) || this.peerTurns.has(turnKey)) return;
    const waiters = this.turnEndWaiters.get(turnKey);
    if (waiters) {
      this.turnEndWaiters.delete(turnKey);
      for (const resolve of waiters) resolve();
    }
  }

  /**
   * Off the turn's record, what was drawn there for messages it never read: each is the next turn's question now,
   * and drawn in both it would read as sent twice. "Got it" goes with it — it was said of a step that never came.
   */
  private undraw(turn: ActiveTurn, unread: readonly MessageEnvelope[]): void {
    const seqs = unread.flatMap((envelope) => turn.drawn?.get(envelope) ?? []);
    if (!turn.recordId || seqs.length === 0) return;
    try {
      this.deps.turns?.unstep(turn.recordId, seqs);
    } catch (err) {
      log.debug("steering steps not taken back", { turn: turn.recordId, error: String(err) });
    }
  }

  /** Past its last step — `ActiveTurn.answered`. */
  answered(turnKey: string): void {
    const turn = this.activeTurns.get(turnKey);
    if (turn) turn.answered = true;
    turn?.replyAbort?.abort();
  }

  /**
   * The messages sent to this turn since its last step, as one for the model — `steering.ts`. Each is
   * handled as far as the inbox is concerned the moment it is read, so a restart does not answer it twice.
   */
  takeSteers(turnKey: string): ChatMessage | null {
    const turn = this.activeTurns.get(turnKey);
    const read = turn?.steers?.splice(0) ?? [];
    if (!turn || read.length === 0) return null;
    turn.replyAbort?.abort();
    turn.steered = (turn.steered ?? 0) + read.length;
    // Whether an edit read here is of what this turn works on, decided before this round's own messages count as read.
    const own = (messageId: string) => ActiveTurns.works(turn, messageId) !== undefined;
    const agent = this.deps.registry.get(turn.agentId);
    const message = steerMessage(read, [turn.agentId, agent?.config.displayName ?? ""], turn.replied?.splice(0), own, { ownShell: agent?.config.external !== undefined });
    for (const envelope of read) {
      this.deps.inbox?.settle(inboxIds(envelope), "done");
      for (const id of [envelope.id, ...(envelope.mergedIds ?? []), ...(envelope.edit ? [envelope.edit.of] : [])]) (turn.read ??= new Map()).set(id, envelope.text);
    }
    const told = read.filter(isTell);
    if (told.length > 0) this.toldRead?.(turn.chatId, told.map((envelope) => (envelope.raw as { tell: string }).tell));
    return message;
  }

  /**
   * Words for a turn at work that did not come as a chat message — a person's `tell` to a mission (0.8.10): read at its
   * next step as a steer is, under the same cap, and drawn on its record as one. Where not taken: no turn there, one
   * past its last step, or one that has read all it reads.
   */
  steerInto(agentId: string, chatId: string, gatewayId: string, envelope: MessageEnvelope): "taken" | "full" | "ending" | "none" {
    const turn = this.activeTurns.get(ActiveTurns.turnKey(agentId, chatId, gatewayId));
    if (!turn?.steers) return "none";
    if (turn.answered) return "ending";
    if ((turn.steered ?? 0) + turn.steers.length >= STEER_CAP) return "full";
    turn.steers.push(envelope);
    this.drawTold(turn, envelope);
    turn.onSteer?.();
    return "taken";
  }

  /** On the turn's record, as a steer is drawn (`steer-accept.ts`): the dashboard reads a turn from there. Never fails. */
  private drawTold(turn: ActiveTurn, envelope: MessageEnvelope): void {
    const turns = this.deps.turns;
    if (!turns) return;
    try {
      const recordId = turn.recordId ?? turns.runningFor(turn.agentId, turn.gatewayId, turn.chatId);
      if (!recordId) return;
      turn.recordId = recordId;
      const seq = turns.step(recordId, "steer", `${envelope.senderName ?? "A person"} told it: ${envelope.text}`);
      if (seq > 0) (turn.drawn ??= new Map()).set(envelope, [seq]);
    } catch (err) {
      log.debug("a tell not drawn on the turn", { chat_id: turn.chatId, error: String(err) });
    }
  }

  /**
   * The turn at work on a message — its question, or one it read as it worked — and what that message said: where an edit
   * of it goes. A turn past its last step still counts; what it is sent becomes the next turn's question.
   */
  answering(gatewayId: string, chatId: string, messageId: string): { turn: ActiveTurn; text: string } | undefined {
    for (const turn of this.activeTurns.values()) {
      if (turn.gatewayId !== gatewayId || turn.chatId !== chatId) continue;
      const text = ActiveTurns.works(turn, messageId);
      if (text !== undefined) return { turn, text };
    }
    return undefined;
  }

  /** A message handed to a turn and not yet read that `match` picks — still waiting, for its edit. */
  unread(match: (envelope: MessageEnvelope) => boolean): MessageEnvelope | undefined {
    for (const turn of this.activeTurns.values()) {
      const found = turn.steers?.find(match);
      if (found) return found;
    }
    return undefined;
  }

  /** What `messageId` said, when `turn` works on it — its question, or a message it read — and undefined when it does not. */
  private static works(turn: ActiveTurn, messageId: string): string | undefined {
    const asked = turn.trigger;
    if (asked && (asked.id === messageId || asked.mergedIds?.includes(messageId) || asked.edit?.of === messageId)) return asked.text;
    return turn.read?.get(messageId);
  }

  /**
   * Whether this message is waiting in a turn's steers. A room's is steered from inside the queue's handler,
   * which would mark it handled on the way out (`InboxDesk.track`) — before any turn has read it.
   */
  holds(envelope: MessageEnvelope): boolean {
    for (const turn of this.activeTurns.values()) if (turn.steers?.includes(envelope)) return true;
    return false;
  }

  /**
   * Resolve immediately when this agent is free, or when its current turn ends.
   *
   * Used by `wakeForJob`: in a room the queue's per-key concurrency lets multiple handlers through,
   * and `isBusy` drops the ones that arrive while the agent is still finishing — which is always,
   * because the job that just completed was started by the turn that is still wrapping up. Waiting
   * here means the wake-up enters the queue after the turn key is released, so `isBusy` passes and
   * the queue's own ordering delivers it.
   */
  waitUntilFree(agentId: string, chatId: string, gatewayId: string): Promise<void> {
    const key = ActiveTurns.turnKey(agentId, chatId, gatewayId);
    if (!this.isBusy(agentId, chatId, gatewayId)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const list = this.turnEndWaiters.get(key) ?? [];
      list.push(resolve);
      this.turnEndWaiters.set(key, list);
    });
  }

  /** The one spelling of a turn's identity — agent, chat, connection. */
  static turnKey(agentId: string, chatId: string, gatewayId: string): string {
    return `${agentId}:${chatId}:${gatewayId}`;
  }

  /**
   * Cancel an in-flight turn by turn key. Returns `true` if a turn was actually running and has been
   * aborted.
   */
  cancelTurn(turnKey: string): boolean {
    const turn = this.activeTurns.get(turnKey);
    if (!turn) return false;
    turn.controller.abort(STOPPED_BY_PERSON);
    return true;
  }

  /**
   * Stop what one agent is doing in one conversation, whichever connection started it.
   *
   * What `/stop` needs, and the connection is the part it cannot know. A turn is keyed by the
   * gateway instance that delivered its trigger, and the command is keyed by the one that delivered
   * *the command* — in a channel where several bots are present those are routinely different, so
   * looking the turn up by full key found nothing and `/stop` answered "Paused. I'll stay connected
   * but won't reply." while the agent carried on working. Seen live, and the wording is what gave it
   * away: the cancelled branch never ran.
   *
   * A turn is one agent in one conversation. Which socket carried the message that started it is
   * bookkeeping, and matching on it made `/stop` unreliable in exactly the rooms it matters in.
   */
  cancelTurnsForAgent(agentId: string, chatId: string): number {
    let stopped = 0;
    for (const turn of this.activeTurns.values()) {
      if (turn.agentId !== agentId || turn.chatId !== chatId) continue;
      turn.controller.abort(STOPPED_BY_PERSON);
      stopped += 1;
    }
    return stopped;
  }

  /**
   * Every turn running right now, with its address.
   *
   * A copy, because the caller — the shutdown notice — aborts as it goes, and aborting is what
   * removes entries from this map. Iterating it directly would be mutating while iterating.
   */
  running(): ActiveTurn[] {
    return [...this.activeTurns.values()];
  }

  /**
   * Stop whatever is running in one conversation, whichever agent is running it.
   *
   * The caller here is a person watching a turn go wrong — from the dashboard, they have a chat id
   * and not an agent id, because the agent was chosen by the router and never shown to them. Asking
   * the browser to name the agent would mean asking it to reimplement routing.
   */
  cancelTurnsInChat(gatewayId: string, chatId: string): number {
    let stopped = 0;
    for (const turn of this.activeTurns.values()) {
      // Compared field by field now that the address is stored. It used to match the key with
      // `endsWith` because the key cannot be split — see `ActiveTurn`.
      if (turn.chatId === chatId && turn.gatewayId === gatewayId) {
        turn.controller.abort(STOPPED_BY_PERSON);
        stopped += 1;
      }
    }
    return stopped;
  }
}

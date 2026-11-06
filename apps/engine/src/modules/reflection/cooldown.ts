/**
 * Everything that decides whether the reflection pass runs at all.
 *
 * Three pieces of per-process bookkeeping — how much work a conversation has accumulated, when an
 * agent was last examined, and when a skill was last written unattended — split out of `index.ts`
 * because that file is over its line budget and may only shrink.
 *
 * One concern rather than a convenient grouping: each is consulted on the same path before anything
 * is spent, each answers "not yet" or "go ahead", and each is state a restart is allowed to forget.
 * What they are *not* is the decision itself — the engine reads them and decides.
 */

import type { ObservedTurn } from "./types.ts";

/** Conversations tracked for the effort counter before the table is dropped. */
const EFFORT_MAX_SESSIONS = 500;

/** Everything this needs from the engine's config, so it can be tested without one. */
export interface CooldownConfig {
  cooldownMs: number;
  rapidFollowUpMs: number;
}

export class Cooldowns {
  /**
   * Model round-trips per conversation since the loop last looked at it.
   *
   * Hermes' `_iters_since_skill`, kept per session rather than per agent because a conversation is
   * the unit of work — one agent can be three exchanges into a hard problem in one chat and idle in
   * another. Reset whenever the pass *runs*, whatever it answered: a decline that left the counter
   * high would re-ask on the very next turn and keep paying for the same refusal.
   *
   * In memory, and a restart losing it only delays a draft — the safe direction, unlike `ToolMemory`,
   * where a lost set would cause false positives and therefore had to be in the database.
   */
  private readonly effort = new Map<string, { units: number; lastMessageAt: number }>();

  /**
   * When each agent was last *looked at*, whether or not it produced anything.
   *
   * Timing from the draft alone meant a pass that declined started no cooldown, so the next
   * qualifying turn paid for triage again, and the turn after that: a quiet agent was the expensive
   * one. In memory rather than on disk because the cost it bounds is per-process — a restart has
   * already stopped whatever loop this was damping.
   */
  private readonly looked = new Map<string, number>();

  /**
   * When each *skill* was last written without anybody being asked (`auto`), by name.
   *
   * `auto` removed the thing that used to stop repeats. Under `ask` a second
   * lesson about the same skill supersedes the draft still waiting for a decision, so the queue
   * holds one; approve immediately and there is never a pending draft to supersede, so the same
   * skill is rewritten every time effort crosses the threshold again. Observed on a live box: the
   * same skill three times in twenty-one minutes, each one reloading every agent.
   *
   * Keyed on the skill, not the agent. An earlier version keyed it on the agent and stopped
   * *everything* that agent might learn for ten minutes — a strange thing to do to somebody who
   * turned autonomous learning on to get more of it, and it suppresses the case the loop exists for
   * in order to damp the case it does not. The pool is shared, too: two agents rewriting one skill
   * within minutes is the same noise as one agent doing it twice.
   */
  private readonly written = new Map<string, number>();

  constructor(
    private readonly config: CooldownConfig,
    private readonly now: () => number,
  ) {}

  /**
   * Add this turn to the conversation's running count, and say what the total is now.
   *
   * A turn is worth its model round-trips, plus one when it arrived inside
   * `TUNING.rapidFollowUpMs` of the last thing the agent said. That second term is the whole of the density idea: no language,
   * no sentiment, just whether the person is still pushing on the same thing right now.
   *
   * It is the one proxy for correction density that survived measurement. A reply arriving quickly
   * means the person is working, not browsing: ten exchanges spread across a day is a conversation; ten
   * in fifteen minutes is somebody steering. Measured from the agent's last word to the next message,
   * so it is the *person's* latency and not the turn's duration.
   *
   * Replaying 228 real turns off this box's journal: total reflections unchanged at 22 over 44 hours,
   * but a conversation of one-round turns reaches the threshold in **6 turns instead of 10** (the
   * first turn has nothing to be prompt after, so it is 1 + 2(n-1)) — which is exactly the tool-free
   * chain that missed live on 2026-09-01.
   *
   * **Rejected:** counting a turn extra when it repeated work the conversation had already done (same
   * tool, same arguments). Over 550 recorded tool-using turns it moved the mean turn weight by 5% and
   * the number of reflections by zero, and it would have meant holding a fingerprint of every tool
   * argument in memory. Measured, then not built.
   */
  accumulate(turn: ObservedTurn): number {
    const previous = this.effort.get(turn.sessionId);
    const askedAt = turn.messages[0]?.timestamp;

    // Both timestamps or nothing. A missing one means "cannot tell", and guessing rapid would inflate
    // every conversation in a build where the pipeline stopped stamping messages.
    const rapid =
      previous !== undefined &&
      previous.lastMessageAt > 0 &&
      askedAt !== undefined &&
      this.config.rapidFollowUpMs > 0 &&
      askedAt - previous.lastMessageAt < this.config.rapidFollowUpMs;

    const units = (previous?.units ?? 0) + Math.max(1, turn.iterations) + (rapid ? 1 : 0);
    const lastMessageAt = turn.messages.reduce((latest, message) => Math.max(latest, message.timestamp ?? 0), 0);

    // Cleared wholesale on overflow rather than evicted one at a time — the same shape the pipeline's
    // drop-notice table uses. Losing the counts costs a delayed draft and nothing else.
    if (this.effort.size > EFFORT_MAX_SESSIONS) this.effort.clear();
    this.effort.set(turn.sessionId, { units, lastMessageAt });
    return units;
  }

  /**
   * The count goes back to zero; the clock does not.
   *
   * `lastMessageAt` is kept deliberately — it is what the *next* turn measures its own promptness
   * against, and dropping it would make the first turn after every reflection look like the start of
   * a fresh conversation.
   */
  spend(sessionId: string): void {
    const entry = this.effort.get(sessionId);
    if (entry) this.effort.set(sessionId, { units: 0, lastMessageAt: entry.lastMessageAt });
  }

  /** Mark that this agent was examined — a decline counts, which is the whole point. */
  looking(agentId: string): void {
    this.looked.set(agentId, this.now());
  }

  /** `true` when the pass ran for this agent recently enough that it should not run again. */
  tooSoonToLook(agentId: string, lastDraftAt: number): boolean {
    const last = Math.max(lastDraftAt, this.looked.get(agentId) ?? 0);
    return last > 0 && this.now() - last < this.config.cooldownMs;
  }

  /** Mark that this skill reached the pool without anybody approving it. */
  wrote(skill: string): void {
    this.written.set(skill, this.now());
  }

  /**
   * `true` when this skill was written unattended a moment ago.
   *
   * Ten minutes, or ten times the ordinary cooldown when that is longer. The ordinary one is short
   * on purpose — a busy afternoon should not be blind — and this one can afford to be long because
   * the lesson is already on disk rather than waiting in a queue.
   */
  tooSoonToRewrite(skill: string): boolean {
    const last = this.written.get(skill) ?? 0;
    const window = Math.max(this.config.cooldownMs * 10, 10 * 60_000);
    return last > 0 && this.now() - last < window;
  }
}

/**
 * Whether the nightly pass keeps up (M4) — `docs/SPEC.md` §12.2.
 *
 * The pass files at most `pass_per_night` conversations per agent a night (`passQueue`), and the rest wait. An agent
 * whose conversations bring more than that a day falls further behind every night, and that was said only as a count
 * waiting. The count stays — it is what a night may cost, the owner's to set — and this says the rest of it, from what
 * the index holds: what each agent has waiting, how many a day its conversations brought lately, and the count that
 * would file what waits within a week at that pace. Every number is a count or an average of counts; none is guessed.
 *
 * Pure but for the reads it is handed.
 */

import type { MemoryAnalyticsPort } from "./memory-analytics.store.ts";
import { countedUnder, passCandidates, type RunDeps } from "./run.ts";

const DAY_MS = 86_400_000;
/** The stretch a pace is measured over: a week — or, on a box younger than that, since its first conversation. */
const PACE_DAYS = 7;
/** The nights what waits should be filed within, at the count suggested. */
const CLEAR_NIGHTS = 7;

export interface PassBacklog {
  /** Conversations the pass may still file, every agent's. */
  waiting: number;
  /** The day of the oldest of them, or null with none. */
  oldest: string | null;
  /** `[memory] pass_per_night`, as it is now. */
  perNight: number;
  /** The days `perDay` is an average over: seven, or fewer on a younger box. */
  days: number;
  /** Each agent with something waiting or begun lately: how many wait, and how many conversations it began a day. */
  agents: { agent: string; waiting: number; perDay: number }[];
  /** The agents that began more conversations a day than the pass files a night — further behind every night. */
  behind: string[];
  /** The `pass_per_night` that files what waits within a week at this pace — null when the one set already does. */
  enough: number | null;
}

const tenths = (n: number) => Math.round(n * 10) / 10;

export function passBacklog(deps: Pick<RunDeps, "index" | "state" | "config"> & { analytics: Pick<MemoryAnalyticsPort, "begunSince"> }, now: number): PassBacklog {
  const candidates = passCandidates(deps);
  const waiting = new Map<string, number>();
  for (const episode of candidates) waiting.set(countedUnder(episode), (waiting.get(countedUnder(episode)) ?? 0) + 1);

  // The week before now — and a box whose first conversation is more recent than that is averaged over the days since
  // it, a day at least: counted over a week, a new box's first busy days would read as a quiet one.
  const { byAgent: begun, first } = deps.analytics.begunSince(now - PACE_DAYS * DAY_MS);
  const days = first === null ? PACE_DAYS : Math.min(PACE_DAYS, Math.max(1, (now - first) / DAY_MS));

  const perNight = deps.config.memory.passPerNight;
  const agents = [...new Set([...waiting.keys(), ...begun.keys()])].sort().map((agent) => ({ agent, waiting: waiting.get(agent) ?? 0, perDay: (begun.get(agent) ?? 0) / days }));
  const needed = Math.max(0, ...agents.map((row) => Math.ceil(row.perDay + row.waiting / CLEAR_NIGHTS)));
  const oldest = candidates.reduce<{ day: string; startedAt: number } | null>((found, episode) => (found && found.startedAt <= episode.startedAt ? found : episode), null);
  return {
    waiting: candidates.length,
    oldest: oldest?.day ?? null,
    perNight,
    days: tenths(days),
    agents: agents.map((row) => ({ ...row, perDay: tenths(row.perDay) })),
    behind: agents.filter((row) => row.perDay > perNight).map((row) => row.agent),
    enough: needed > perNight ? needed : null,
  };
}

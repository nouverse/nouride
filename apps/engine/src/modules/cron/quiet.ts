/**
 * The install's quiet hours (`[cron] quiet_hours`), for what automations say.
 *
 * Inside them a run still runs: a check at three in the morning is how the morning knows what changed in the night.
 * What it would say to a chat is kept (`cron_held`) and sent when the hours end, as one message a chat: each
 * automation by its name with what it said, failures first. A question a step waits on is asked then too, and its
 * time to answer counts from then.
 *
 * Not held: a run a person started by hand, since they are there; a job marked to tell at once; a delivery to a URL
 * or to nowhere, which wakes nobody; and a mission's own notices, which are the mission's to send.
 */

import { createLogger, isQuiet, minutesToQuietEnd, parseQuietHours, type Job, type JobTarget, type QuietHours } from "@nouride/shared";
import { localTime, safeTimeZone } from "@/commons/clock.ts";
import { deliveryTarget } from "./addressing.ts";
import type { CronPort } from "./cron.store.ts";
import type { CronExecutors } from "./scheduler.ts";
import type { StepRuns } from "./step-runs.ts";
import type { HeldKind, HeldLine, WatchStore } from "./watch.store.ts";

const log = createLogger("cron.quiet");

export interface QuietDeps {
  /** `[cron] quiet_hours` as it is written now: read at each use, so a change applies to the next thing said. */
  hours: () => string;
  /** The daemon's time zone, which the hours are in. */
  timeZone: () => string;
  now: () => number;
}

/** A whole message's room, under what a chat platform takes in one. */
const DIGEST_CHARS = 3600;
/** The least of an automation's words a crowded message still shows. */
const LEAST_CHARS = 200;

export class Quiet {
  constructor(private readonly deps: QuietDeps) {}

  private get span(): QuietHours | null {
    return parseQuietHours(this.deps.hours());
  }

  private minuteNow(): number {
    const [hour = "0", minute = "0"] = localTime(this.deps.now(), safeTimeZone(this.deps.timeZone())).time.split(":");
    return Number(hour) * 60 + Number(minute);
  }

  /** Whether the hours are on now. */
  now(): boolean {
    const span = this.span;
    return span !== null && isQuiet(span, this.minuteNow());
  }

  /** Whether what this job says now is kept for later: it reports to a chat, and was not marked to tell at once. */
  holds(job: Job, byHand: boolean): boolean {
    return !byHand && job.delivery.mode === "announce" && job.delivery.atOnce !== true && this.now();
  }

  /** When the hours that are on now end. */
  endsAt(): number {
    const span = this.span;
    return span === null ? this.deps.now() : this.deps.now() + minutesToQuietEnd(span, this.minuteNow()) * 60_000;
  }

  /** The hours as a person reads them, `22:00 to 07:00`; empty when none are set. */
  words(): string {
    return parseQuietHours(this.deps.hours()) ? this.deps.hours().trim().replace("-", " to ") : "";
  }

  /** The clock time a line was kept at, in the daemon's zone. */
  clock(at: number): string {
    return localTime(at, safeTimeZone(this.deps.timeZone())).time;
  }
}

/**
 * The quiet hours with what they keep: what the scheduler asks before it says anything, and what it calls when the
 * hours are over.
 */
export class Keeper {
  constructor(
    private readonly watch: WatchStore,
    private readonly quiet: Quiet,
  ) {}

  /** Whether what this job would say now is kept. */
  holds(job: Job, byHand: boolean): boolean {
    return this.quiet.holds(job, byHand);
  }

  /** The line kept for the end of the hours, when they hold this job now; false when it is to be said at once. */
  keep(job: Job, byHand: boolean, line: { runId: string; stepId?: string; kind: HeldKind; text: string }): boolean {
    if (!this.quiet.holds(job, byHand)) return false;
    this.watch.hold({ jobId: job.id, ...line });
    return true;
  }

  /** When the hours that are on now end: what a kept question's time to answer counts from. */
  endsAt(): number {
    return this.quiet.endsAt();
  }

  /** What is kept now, a job id for each line, and when it is to be said; null while nothing is kept. */
  kept(): { jobIds: string[]; until: number } | null {
    const jobIds = this.watch.heldJobs();
    return jobIds.length > 0 ? { jobIds, until: this.quiet.endsAt() } : null;
  }

  /** The hours are over: what was kept is said, and each kept question asked where its job reports. */
  async say(store: Pick<CronPort, "get">, executors: Pick<CronExecutors, "deliver" | "ask" | "alert">, runs: Pick<StepRuns, "keptAsk">): Promise<void> {
    await sayKept(this.watch, this.quiet, {
      jobs: (id) => store.get(id),
      deliver: (target, text, said) => executors.deliver(target, text, said),
      ask: async (line) => {
        const kept = line.runId && line.stepId ? runs.keptAsk(line.runId, line.stepId) : null;
        if (!kept) return;
        const card = await executors.ask?.(kept.job, line.runId!, kept.step, line.text, kept.until);
        if (card) kept.carded(card);
      },
      ...(executors.alert ? { alert: (key: string, text: string) => executors.alert!(key, text) } : {}),
    });
  }
}

/** One message of what was kept, for one chat as one agent. */
interface Digest {
  job: Job;
  text: string;
}

/**
 * What was kept, as the messages to send: one a chat and agent, in the order of each chat's first line, with failures
 * first inside it. `jobs` finds a line's job as it is now; a line whose job is gone is left out, since there is nowhere
 * to say it. Questions are not part of a message: they are asked after it, each on its own card.
 */
function digests(lines: readonly HeldLine[], jobs: (id: string) => Job | null, quiet: Pick<Quiet, "words" | "clock">): Digest[] {
  const groups = new Map<string, { job: Job; entries: { failed: boolean; text: string }[] }>();
  for (const line of lines) {
    if (line.kind === "ask") continue;
    const job = jobs(line.jobId);
    if (!job) continue;
    const to = deliveryTarget(job);
    const key = `${job.agentId}\n${to.gatewayId}\n${to.chatId}`;
    const group = groups.get(key) ?? { job, entries: [] };
    groups.set(key, group);
    const failed = line.kind === "failed";
    group.entries.push({ failed, text: `**${job.name}**${failed ? " failed" : ""} at ${quiet.clock(line.at)}\n${line.text.trim()}` });
  }
  return [...groups.values()].map(({ job, entries }) => {
    const ordered = [...entries.filter((entry) => entry.failed), ...entries.filter((entry) => !entry.failed)];
    const room = Math.max(LEAST_CHARS, Math.floor(DIGEST_CHARS / ordered.length));
    const body = ordered.map((entry) => (entry.text.length > room ? `${entry.text.slice(0, room)}\n…(cut)` : entry.text)).join("\n\n");
    const hours = quiet.words();
    return { job, text: `Kept during the quiet hours${hours ? ` (${hours})` : ""}:\n\n${body}` };
  });
}

/** What saying the kept lines needs. */
interface KeptHands {
  jobs(id: string): Job | null;
  deliver(target: JobTarget, text: string, said?: { agentId: string; job: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** A kept question, asked now where its job reports. */
  ask(line: HeldLine): Promise<void>;
  alert?(key: string, text: string): Promise<unknown>;
}

/**
 * The hours are over: what was kept is said, one message a chat, and then each kept question is asked on its own card.
 * Taken out of the store first, so a line is sent once or not at all: a chat that will not take the message is said in
 * the log and on the daemon's alert channel, and the next night starts empty.
 */
async function sayKept(watch: WatchStore, quiet: Quiet, hands: KeptHands): Promise<void> {
  if (quiet.now() || !watch.holding()) return;
  const lines = watch.release();
  for (const one of digests(lines, hands.jobs, quiet)) {
    const target = deliveryTarget(one.job);
    try {
      const sent = await hands.deliver(target, one.text, { agentId: one.job.agentId, job: "quiet hours" });
      if (sent.ok) continue;
      log.warn("what was kept during the quiet hours could not be delivered", { gateway: target.gatewayId, chat: target.chatId, reason: sent.reason });
      await hands.alert?.(`cron_quiet:${target.gatewayId}:${target.chatId}`, `What automations said during the quiet hours could not be delivered to ${target.gatewayId} ${target.chatId}: ${sent.reason}`);
    } catch (err) {
      log.warn("what was kept during the quiet hours could not be delivered", { gateway: target.gatewayId, chat: target.chatId, error: String(err) });
    }
  }
  for (const line of lines) {
    if (line.kind !== "ask") continue;
    try {
      await hands.ask(line);
    } catch (err) {
      log.warn("a question kept during the quiet hours could not be asked", { job: line.jobId, error: String(err) });
    }
  }
  log.info("said what was kept during the quiet hours", { lines: lines.length });
}

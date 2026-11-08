/**
 * The morning line (0.8.0, SMART_AUTOMATION §3.4): once a day, at the time a person set (`[[people]] morning`), a
 * message to their own chat on what happened while they were away — scheduled runs that failed, approvals and missions
 * waiting on them, missions that finished or ended, and for an admin what was spent.
 *
 * Off unless a person sets a time. Written by the daemon from its own records, so it costs no tokens and says nothing
 * the records do not. A quiet morning sends nothing: silence means everything ran. A line due while the daemon was
 * down comes within the hour after its time, or not that day.
 */

import { clip, contained, createLogger, cutAtWord, oneLine, type Person } from "@nouride/shared";
import { localTime } from "@/commons/clock.ts";
import { formatTokens } from "@/modules/hooks/format.ts";

const log = createLogger("people.morning");

/** How often the time is looked at. */
const TICK_MS = 60_000;
/** How late a line may still come — a restart at 07:20 — before that day's is let go. */
const LATE_MS = 60 * 60_000;
/** What a line looks back over. */
const MORNING_SPAN_MS = 24 * 60 * 60_000;

/** What happened, for one person, since `from`. */
export interface MorningFacts {
  failed: { job: string; why: string }[];
  approvals: { agent: string; what: string }[];
  needsYou: { goal: string; what: string }[];
  ended: { goal: string; status: "done" | "failed" | "stopped"; why?: string }[];
  /** An admin's: what was spent, and by whom — dollars when every request had a price, else tokens. */
  spent?: { usd: number | null; tokens: number; top: { agent: string; model: string; usd: number; tokens: number }[] };
}

/** How many of a kind are named; the rest are counted. */
const NAMED = 4;

/**
 * A mission by the first sentence of its goal, cut at a word — as its page names it. A goal is often a paragraph, and
 * a list of them cut mid-word ran into one wall of text. Code marks go: a cut inside one left it open.
 */
function titled(goal: string, max = 70): string {
  const flat = oneLine(goal.replace(/`/g, ""));
  const first = /^.+?[.!?](?=\s|$)/.exec(flat)?.[0] ?? flat;
  return cutAtWord(first, max, Math.ceil(max * 0.6));
}

/** A bold heading with its count, then one item a line. */
function section(title: string, items: string[]): string {
  const named = items.slice(0, NAMED).map((item) => `• ${item}`);
  if (items.length > NAMED) named.push(`• and ${items.length - NAMED} more`);
  return [`**${title} · ${items.length}**`, ...named].join("\n");
}

/** The line, or null for a quiet morning: nothing failed, waiting, finished or ended. Spending alone is not news. */
export function morningText(facts: MorningFacts): string | null {
  const done = facts.ended.filter((one) => one.status === "done");
  const ended = facts.ended.filter((one) => one.status !== "done");
  if (facts.failed.length + facts.approvals.length + facts.needsYou.length + facts.ended.length === 0) return null;
  // What a person can act on comes first; what is only news after it.
  const needs = [
    ...facts.approvals.map((one) => `${one.agent} asks to run ${one.what}`),
    ...facts.needsYou.map((one) => `${titled(one.goal)} (${clip(oneLine(one.what), 80)})`),
  ];
  const sections = ["☀ **Since yesterday morning**"];
  if (needs.length) sections.push(section("Needs you", needs));
  if (facts.failed.length) sections.push(section("Scheduled runs failed", facts.failed.map((one) => `${one.job} (${clip(oneLine(one.why), 80)})`)));
  if (done.length) sections.push(section("Missions done", done.map((one) => titled(one.goal))));
  if (ended.length) sections.push(section("Missions stopped or failed", ended.map((one) => `${titled(one.goal)} (${one.why ? clip(oneLine(one.why), 60) : one.status})`)));
  if (facts.spent) {
    const priced = facts.spent.usd !== null;
    const amount = (usd: number, tokens: number) => (priced ? `$${usd.toFixed(2)}` : `${formatTokens(tokens)} tokens`);
    const top = facts.spent.top.map((one) => `${one.agent} on ${one.model}: ${amount(one.usd, one.tokens)}`);
    const total = `**Spent in the last day · ${amount(facts.spent.usd ?? 0, facts.spent.tokens)}**`;
    sections.push([total, ...top.map((item) => `• ${item}`)].join("\n"));
  }
  return sections.join("\n\n");
}

export interface MorningLinesDeps {
  people: () => readonly Person[];
  timezone: () => string;
  isAdmin: (person: Person) => boolean;
  facts: (person: Person, from: number, admin: boolean) => MorningFacts;
  /** To the person's own chat. False when none of theirs could be reached. */
  send: (person: Person, text: string) => Promise<boolean>;
  /** The day each person's line last came, so a restart says nothing twice. */
  said: { load(): Record<string, string>; save(said: Record<string, string>): void };
  now?: () => number;
}

export class MorningLines {
  constructor(private readonly deps: MorningLinesDeps) {}

  /** Each person whose time has come today and whose line has not: theirs, or none on a quiet morning. Keys sent to. */
  async tick(): Promise<string[]> {
    const now = (this.deps.now ?? Date.now)();
    const zone = this.deps.timezone();
    const clock = localTime(now, zone);
    const said = this.deps.said.load();
    const sent: string[] = [];
    for (const person of this.deps.people()) {
      const at = person.morning;
      if (!at || said[person.key] === clock.day || clock.time < at) continue;
      said[person.key] = clock.day;
      this.deps.said.save(said);
      // Past the hour after its time — set later in the day, or a daemon down all morning — that day's is let go.
      if (minutesOf(clock.time) - minutesOf(at) > LATE_MS / 60_000) continue;
      const text = morningText(this.deps.facts(person, now - MORNING_SPAN_MS, this.deps.isAdmin(person)));
      if (!text) {
        log.info("a quiet morning: no line sent", { key: person.key });
        continue;
      }
      if (await this.deps.send(person, text)) {
        sent.push(person.key);
        log.info("a morning line sent", { key: person.key, lines: text.split("\n").length - 1 });
      } else log.warn("a morning line could not reach any chat of theirs", { key: person.key });
    }
    return sent;
  }
}

function minutesOf(time: string): number {
  const [hours = "0", minutes = "0"] = time.split(":");
  return Number(hours) * 60 + Number(minutes);
}

export function startMorningLines(deps: MorningLinesDeps): ReturnType<typeof setInterval> {
  const lines = new MorningLines(deps);
  return setInterval(contained(log, "could not look at whether a morning line is due", () => lines.tick()), TICK_MS);
}

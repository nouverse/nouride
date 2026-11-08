/**
 * The daemon's hint under `careful`: a new install asks a lot, and the person being asked is told —
 * once — that `balanced` asks only the few that matter, and where it is set.
 *
 * The daemon's words in the approval message, never the agent's: a model talked into wanting fewer questions could
 * otherwise argue a person down. After five questions in a day, at most once a day per person, and never once they have
 * moved — a person who set a level for themselves chose it, whichever it is. `trusted` is never named.
 *
 * Kept in memory: a restart that says it a second time in a day costs a line, and a table for it would cost a migration.
 */

import type { ApprovalResolution } from "@nouride/policy";
import { startOfLocalDay } from "@/commons/clock.ts";

/** Questions in a day before the hint is said. */
const ASKED_BEFORE_HINT = 5;
/** People held at once; the oldest go first, and the worst a lost one does is hear the hint again. */
const HELD = 512;

/**
 * `balanced`'s own few, not the classes every level asks as well: moving to it changes nothing about those, and a hint
 * that listed them would bury the few it is there to name. So "still", never "only".
 */
const BALANCED_ASKS_IN_WORDS =
  "which still asks before a config.toml changes, someone is given access, this daemon stops, a stored secret is replaced, a credential leaves this machine, or its system packages change";

/** The hint, by who set the level a person is asked at. Null where the person set it themselves. */
export function carefulHintText(source: ApprovalResolution["source"]): string | null {
  if (source === "person") return null;
  return source === "agent"
    ? `_This agent asks at careful for everyone who talks to it. Its Access tab in the dashboard can set it to balanced, ${BALANCED_ASKS_IN_WORDS}._`
    : `_That is a lot of questions today. \`/approvals balanced\` stops them for you, ${BALANCED_ASKS_IN_WORDS}. The dashboard can set it for every agent._`;
}

export class CarefulHints {
  private readonly asked = new Map<string, { day: number; count: number; said: boolean }>();

  constructor(private readonly options: { timeZone: () => string; now?: () => number }) {}

  /** Count one question put to `person` at `resolution`, and the hint to carry with it — or null. */
  next(person: string, resolution: ApprovalResolution): string | null {
    if (resolution.level !== "careful" || resolution.source === "person") return null;
    const day = startOfLocalDay((this.options.now ?? Date.now)(), this.options.timeZone());
    const held = this.asked.get(person);
    const today = held && held.day === day ? held : { day, count: 0, said: false };
    today.count += 1;
    this.asked.delete(person);
    this.asked.set(person, today);
    while (this.asked.size > HELD) this.asked.delete(this.asked.keys().next().value!);
    if (today.said || today.count < ASKED_BEFORE_HINT) return null;
    today.said = true;
    return carefulHintText(resolution.source);
  }
}

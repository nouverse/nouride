/**
 * Skills read again when their folders change (0.8.13): a skill added to, removed from or whose `SKILL.md` is edited in
 * the built-in folder or the shared pool reaches every agent's prompt within a minute — without a restart, and without
 * a reload, which reconnects every agent's MCP servers. Built-in skills were read only as the daemon started: skills
 * copied onto the live box waited for the next deploy.
 */

import { contained, createLogger } from "@nouride/shared";
import { skillsStamp } from "@nouride/persona";

const log = createLogger("boot.skills-watch");

/** How often the folders are looked at — a starting value: a minute beside a person editing, a stat per skill a time. */
const EVERY_MS = 60_000;

export class SkillsWatch {
  private seen: string;
  private busy = false;

  constructor(private readonly input: { dirs: () => readonly string[]; refresh: () => Promise<string[]> }) {
    this.seen = skillsStamp(input.dirs());
  }

  /** The agents whose skills were read again, or null when the folders hold what they did. */
  async check(): Promise<string[] | null> {
    if (this.busy) return null;
    const now = skillsStamp(this.input.dirs());
    if (now === this.seen) return null;
    this.busy = true;
    try {
      const changed = await this.input.refresh();
      // Only once read: a refresh that failed is tried again at the next look.
      this.seen = now;
      log.info("skills changed on disk, read again", { agents: changed });
      return changed;
    } finally {
      this.busy = false;
    }
  }

  start(): ReturnType<typeof setInterval> {
    return setInterval(contained(log, "could not look at the skill folders", () => this.check()), EVERY_MS);
  }
}

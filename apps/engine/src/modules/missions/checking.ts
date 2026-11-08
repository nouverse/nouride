/**
 * Done means checked — what happens once the agent says a mission is done:
 *
 * 1. **The commands**, run by the daemon in the mission's folder (`checks.ts`). One failing is the next turn, with its
 *    output on the page.
 * 2. **The reviewer**, on every mission unless turned off: a helper with a fresh context and no part in the work, on the
 *    agent's high tier, holding only the tools that read. The commands are written by the agent doing the work and can
 *    be as lenient as its word; a separate reader is easier to make sceptical. It never overrides a failed command —
 *    it runs only once they pass — and its fail is a failed check like any other. A review that runs out of its clock
 *    has not judged the work, and is no fail: the next pass goes on from its notes, `REVIEW_PASSES` in all, and then a
 *    person decides.
 * 3. **A person**, where nothing could check: no commands, or a mission that asked for an accept.
 *
 * The same failure three times in a row — a command failing the same way, or the reviewer's same finding — is a loop the
 * turns would only pay for: the mission waits as stuck, and a person decides. So is the reviewer failing it three times in
 * a row, whatever each finding says: done, rejected, done is the loop, and a new finding each time never repeats one. So
 * does a check that would ask a person: the agent could only call `done` into it again.
 */

import { createLogger } from "@nouride/shared";
import type { CheckResult } from "./checks.ts";
import { limitReached } from "./decide.ts";
import { REVIEW_PASSES, REVIEW_REJECTIONS, SAME_CHECK } from "./limits.ts";
import type { Missions } from "./missions.ts";
import type { MissionsDeps } from "./deps.ts";
import { shortId } from "./page.ts";
import { unreadTold, waitsForAccept } from "./tell.ts";
import { toldBy, type Mission } from "./types.ts";

const log = createLogger("missions");

/** What the reviewer said: pass, or what is missing — and what it cost. */
export interface Review {
  pass: boolean;
  findings: string;
  tokens: number;
  /** It ran out of its clock or its rounds before it judged the work: `findings` are its notes, not a fail. */
  unfinished?: boolean;
}

/** The reviewer at work on a mission: which pass, of how many, since when. */
export interface Reviewing {
  pass: number;
  of: number;
  since: number;
}

export class Checking {
  /** The same failure in a row, by mission. */
  private readonly same = new Map<string, { count: number; last: string }>();
  /** The reviewer's fails in a row, by mission, whatever each said. */
  private readonly rejected = new Map<string, number>();
  /**
   * The review at work, by mission. A review takes minutes — ten a pass, three passes — and the page said only "Running
   * its checks" all along: a person took a mission under review for a stuck one (live, 0.8.10).
   */
  private readonly reviewing = new Map<string, Reviewing>();

  constructor(
    private readonly missions: Missions,
    private readonly deps: MissionsDeps,
  ) {}

  /** Counting starts again: a person said to go on, or it ended. */
  forget(id: string): void {
    this.same.delete(id);
    this.rejected.delete(id);
  }

  /** The reviewer at work on this mission, or null — `Missions.reviewing`. */
  reviewingNow(id: string): Reviewing | null {
    return this.reviewing.get(id) ?? null;
  }

  /** Missions with a failure counted — `Missions.tables`. */
  entries(): number {
    return this.same.size + this.rejected.size;
  }

  async run(id: string): Promise<void> {
    const mission = this.deps.store.get(id);
    if (!mission || mission.status !== "checking") return;
    let result: CheckResult;
    try {
      result = mission.checks.length > 0 ? await this.deps.check(mission) : { passed: true, failed: null };
    } catch (err) {
      result = { passed: false, failed: { command: mission.checks[0] ?? "(checks)", output: `The checks could not run: ${String(err)}` } };
    }
    const checked = this.current(id);
    if (!checked) return;
    if (!result.passed && result.failed?.refused) {
      // Not a failure the agent can fix: it cannot change its checks, and handed back it went round "done", refused,
      // ask the person, until it gave up (live box, 0.8.6). Started before checks were judged at the start (`start.ts`),
      // or judged differently since: a person decides — accept it as it is, or stop it.
      log.info("a mission's check would ask a person, so it was not run; it waits for one", { mission: id, command: result.failed.command });
      checked.lastCheck = `$ ${result.failed.command}\n${result.failed.output}`;
      return this.missions.wait(checked, "stuck", `its check \`${result.failed.command}\` cannot run with nobody to ask, and a mission cannot change its own checks`);
    }
    if (!result.passed && result.failed) {
      log.info("a mission's check failed", { mission: id, command: result.failed.command });
      return this.failed(checked, `$ ${result.failed.command}\n${result.failed.output}`, `the check \`${result.failed.command}\``);
    }
    log.info("a mission's checks passed", { mission: id, checks: checked.checks.length });
    // An earlier round's failure is not this one's: shown through a review that then could not run, it read as the
    // reviewer's verdict on work it never judged (msn_b97876, live, 0.8.10).
    if (checked.lastCheck !== null) {
      checked.lastCheck = null;
      this.deps.store.save(checked);
    }
    if (checked.reviewOn && this.deps.review) return await this.review(id, checked);
    this.passed(checked);
  }

  /**
   * The reviewer's passes. One that runs out of its clock has not judged the work, so its words are never a failed check:
   * read as one (live, 0.8.10), the agent "fixed" what the reviewer had not finished checking and called done, and the
   * next reviewer ran out of time again — four rounds and 28M tokens, going on by itself to its limits. The next pass
   * goes on from its notes instead; when none of them finishes, or a limit is reached first, a person decides.
   */
  private async review(id: string, checked: Mission): Promise<void> {
    try {
      await this.passes(id, checked);
    } finally {
      this.reviewing.delete(id);
    }
  }

  private async passes(id: string, checked: Mission): Promise<void> {
    let mission = checked;
    let earlier: string | undefined;
    for (let pass = 1; ; pass += 1) {
      this.reviewing.set(id, { pass, of: REVIEW_PASSES, since: (this.deps.now ?? Date.now)() });
      const review = await this.reviewed(mission, earlier);
      const reviewedNow = this.current(id);
      if (!reviewedNow) return;
      // A reviewer that could not run is not a pass: a person accepts instead.
      if (!review) {
        // What an earlier pass checked before its time ran out goes with it: the person decides without a verdict.
        const checkedBefore = earlier ? `\nWhat an earlier pass checked before its time ran out:\n${earlier}` : "";
        return this.missions.wait(reviewedNow, "accept", `(The reviewer could not run, so this waits for you.)${checkedBefore}`);
      }
      reviewedNow.tokensUsed += review.tokens;
      // The reviewer is metered as a helper of the mission's conversation: counted here, not again at the next turn's end.
      this.missions.helpersCounted(reviewedNow);
      reviewedNow.turnsUsed += 1;
      if (review.unfinished) {
        log.info("a mission's reviewer ran out of time before it judged the work", { mission: id, pass });
        // At a limit, as a failed check is: the person raises it or not, with the reviewer's notes on its page.
        const reached = limitReached(reviewedNow, (this.deps.now ?? Date.now)(), this.missions.inForce(reviewedNow));
        if (reached) {
          reviewedNow.lastCheck = `Reviewer, out of time before it judged the work: ${review.findings}`;
          return this.missions.limitHit(reviewedNow, reached);
        }
        if (pass < REVIEW_PASSES) {
          this.deps.store.save(reviewedNow);
          mission = reviewedNow;
          earlier = review.findings;
          continue;
        }
        return this.missions.wait(reviewedNow, "accept", `The reviewer ran out of time ${REVIEW_PASSES} times before it judged the work. What it checked and found:\n${review.findings}`);
      }
      if (!review.pass) {
        log.info("a mission's reviewer found it not done", { mission: id });
        const rejected = (this.rejected.get(id) ?? 0) + 1;
        this.rejected.set(id, rejected);
        if (rejected >= REVIEW_REJECTIONS) {
          reviewedNow.lastCheck = `Reviewer: ${review.findings}`;
          return this.missions.wait(reviewedNow, "stuck", `the reviewer failed it ${REVIEW_REJECTIONS} times in a row, each time for what it found then. Its last finding is on the page`);
        }
        return this.failed(reviewedNow, `Reviewer: ${review.findings}`, "the reviewer's same finding");
      }
      reviewedNow.reviewed = true;
      return this.passed(reviewedNow);
    }
  }

  /** Still checking — a person may have stopped it meanwhile. */
  private current(id: string): Mission | null {
    const mission = this.deps.store.get(id);
    return mission && mission.status === "checking" ? mission : null;
  }

  private async reviewed(mission: Mission, earlier?: string): Promise<Review | null> {
    try {
      return await this.deps.review!(mission, earlier);
    } catch (err) {
      log.warn("a mission's reviewer could not run, so a person accepts it instead", { mission: mission.id, error: String(err) });
      return null;
    }
  }

  private passed(mission: Mission): void {
    mission.lastCheck = null;
    this.same.delete(mission.id);
    this.rejected.delete(mission.id);
    // Where no command could tell, or it asked for one, a person has the last word — but not on a job's run, whose
    // person accepted the work when they turned the job on: a run every Monday must not wait for a tap.
    const accept = waitsForAccept(mission);
    // Told something while it was being checked, and not read (0.8.10): never closed over a person's words. Where a
    // person decides anyway, they are shown them beside the result and decide; where it would end by itself, it goes one
    // more turn to read them, and its next `done` is checked again.
    const unread = unreadTold(mission);
    if (unread.length > 0) {
      log.info("a mission's checks passed with words told to it unread", { mission: mission.id, unread: unread.length });
      if (accept) {
        const said = unread.map((one) => `${toldBy(one)}: "${one.text}"`).join("\n");
        return this.missions.wait(mission, "accept", `Told while it was being checked, and not read yet. /mission continue ${shortId(mission.id)} has it work on this:\n${said}`);
      }
      mission.status = "running";
      mission.updatedAt = (this.deps.now ?? Date.now)();
      this.deps.store.save(mission);
      this.deps.changed?.(mission);
      return this.missions.queueTurn(mission, "your checks passed, but while they ran a person told you something you have not read. It is on this page. If it changes the work, do it; if not, call `mission` done again.");
    }
    if (accept) return this.missions.wait(mission, "accept", "");
    this.missions.end(mission, "done");
  }

  private failed(mission: Mission, text: string, what: string): void {
    mission.status = "running";
    mission.lastCheck = text;
    mission.updatedAt = (this.deps.now ?? Date.now)();
    const before = this.same.get(mission.id);
    const count = before?.last === text ? before.count + 1 : 1;
    this.same.set(mission.id, { count, last: text });
    if (count >= SAME_CHECK) return this.missions.wait(mission, "stuck", `${what} failed the same way ${SAME_CHECK} times in a row`);
    this.deps.store.save(mission);
    this.deps.changed?.(mission);
    const reached = limitReached(mission, (this.deps.now ?? Date.now)(), this.missions.inForce(mission));
    if (reached) return this.missions.limitHit(mission, reached);
    this.missions.queueTurn(mission, "a check failed. What it said is on this page. Fix it, then call `mission` done again.");
  }
}

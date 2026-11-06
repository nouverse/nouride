/**
 * A box updates itself, through the licensed release channel.
 *
 * An appliance owner does not run `nouride update`. So, when the owner has not turned it off on My
 * Box, the box installs an offered update by itself in a nightly window, and only when nobody is
 * talking to it: no turn in flight, no approval waiting for an answer. The dashboard's own update
 * page still works at any hour ("Update now").
 *
 * **A critical release does not wait for the night.** Marked from the admin page for a fix that is
 * already out on boxes that need it, it is installed as soon as the box is idle — at any hour, and
 * even when the owner has turned automatic updates off. The box asks on every tick, all day, so one
 * that comes back online finds it within a tick. A box that is never idle gets it after
 * {@link CRITICAL_MAX_WAIT_MS} anyway: a fix held back indefinitely by a busy chat is not a fix.
 * Everything else still holds — the signature, the checksum, the rollback, and the rule that a build
 * this box rolled back from is not taken again automatically.
 *
 * Where the release comes from, and whether it is safe, are not decided here: the appliance's
 * release source asks the Nouverse gate, and the update plugin verifies the signature and checksum
 * and keeps the previous version. This file is only *when*, and what to tell the fleet afterwards —
 * plus the new version's proof of life, which is what lets the unit's guard stand down
 * (`modules/update/confirm.ts`).
 */

import { contained, createLogger } from "@nouride/shared";
import { localTime, safeTimeZone } from "@/commons/clock.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { rolledBackFrom, watchPendingUpdate } from "@/modules/update/confirm.ts";
import { installDirFor } from "@/modules/update/facts.ts";
import { refreshInstalledUnit } from "@/service/drift.ts";
import { applyUpdate, checkForUpdate, type UpdateCheck } from "@/modules/update/index.ts";

const log = createLogger("appliance.updates");

/** Local hours, `[daemon] timezone`, in which an automatic install may start. */
export const UPDATE_WINDOW = { from: 2, to: 5 } as const;
const TICK_MS = 20 * 60_000;
/** How long a critical release waits for the box to be idle before it is installed anyway. */
export const CRITICAL_MAX_WAIT_MS = 60 * 60_000;

/**
 * What this file needs from the appliance runner, declared here: only the seam (`appliance.ts`) may
 * name the plugin, so an edition without it cannot pick up an edge to it through this file.
 */
export interface UpdatingRunner {
  reportUpdate(report: {
    tag: string;
    outcome: "installed" | "rolled_back" | "failed_download" | "failed_verify" | "failed_install";
    reason?: string;
  }): Promise<void>;
  updatePolicy(): { automatic: boolean };
  isCritical(tag: string): boolean;
  syncedSinceBoot(): boolean;
}

export interface ApplianceUpdateDeps {
  /** Whether someone is using the box right now: a turn in flight, or an approval waiting. */
  busy(): boolean;
  requestRestart(reason: string): void;
}

/** The local hour and date of `at` in `timeZone`, or UTC when the zone is not one the runtime knows. */
export function localClock(at: Date, timeZone: string): { hour: number; date: string } {
  const local = localTime(at.getTime(), safeTimeZone(timeZone));
  return { hour: Number(local.time.slice(0, 2)), date: local.day };
}

/** Whether an automatic install may start now. Once a night: `lastTried` is the local date it last did. */
export function mayInstallNow(input: {
  automatic: boolean;
  busy: boolean;
  hour: number;
  date: string;
  lastTried: string | null;
}): boolean {
  if (!input.automatic || input.busy) return false;
  if (input.hour < UPDATE_WINDOW.from || input.hour >= UPDATE_WINDOW.to) return false;
  return input.lastTried !== input.date;
}

/**
 * What to do about an offered release, now.
 *
 * `install`, `wait` (a critical one, until the box is idle or the wait is over), or `no` (a normal
 * one outside what the owner and the window allow).
 */
export function decideInstall(input: {
  critical: boolean;
  automatic: boolean;
  busy: boolean;
  hour: number;
  date: string;
  lastTried: string | null;
  /** When a critical release was first seen waiting on a busy box, or null. */
  waitingSince: number | null;
  now: number;
}): "install" | "wait" | "no" {
  if (input.critical) {
    if (!input.busy) return "install";
    return input.waitingSince !== null && input.now - input.waitingSince >= CRITICAL_MAX_WAIT_MS ? "install" : "wait";
  }
  return mayInstallNow(input) ? "install" : "no";
}

/**
 * Which report a failed automatic install gets — and so whether the release is tried again: a `failed_verify` one is
 * not, until the daemon restarts. The plugin's refusals name their step.
 *
 * A file the channel answered with an error status is a transfer that failed, whatever the file: the plugin says
 * `fetching checksums answered 404 (…)` for the checksum file and its signature alike. Read for the word `checksum`,
 * that was `failed_verify`: reported to the fleet as a bad release, and refused — a critical one too — until the
 * daemon restarted. A box that looked while a release was being published, its tarball up and its checksum file not
 * yet, would not take that release by itself until then.
 */
export function failureOutcome(message: string): "failed_download" | "failed_verify" | "failed_install" {
  if (/\banswered \d{3}\b/.test(message)) return "failed_download";
  if (/signed|signature|checksum/i.test(message)) return "failed_verify";
  if (/download/i.test(message)) return "failed_download";
  return "failed_install";
}

/**
 * An offered release this box cannot take, said once per release — in the journal, and to the fleet.
 *
 * The tick returned silently, so an OpenWrt box whose init script declared no supervisor refused every update as
 * "a stop", critical ones too, and Fleet showed only a Version that stopped moving (`pro-procd-boxes-never-update`).
 * Reported as `failed_install`: the outcomes the service accepts are fixed, and this is an install that did not
 * happen, with its reason beside it.
 */
export function cannotTakeReporter(
  report: UpdatingRunner["reportUpdate"],
  warn: (message: string, data: Record<string, unknown>) => void,
): (tag: string, reason: string, instead: readonly string[]) => void {
  const said = new Set<string>();
  return (tag, reason, instead) => {
    if (said.has(tag)) return;
    said.add(tag);
    warn("an update is offered and this box cannot take it", { tag, reason, instead });
    void report?.({ tag, outcome: "failed_install", reason: `this box cannot update itself: ${reason}` }).catch(() => undefined);
  };
}

/** What a tick reads of the channel's answer: an {@link UpdateCheck}, narrowed to that. */
type Offer = Pick<UpdateCheck, "current" | "latest" | "newer"> & {
  plan?: { can: true } | { can: false; reason: string; instead: readonly string[] };
};

/**
 * Everything one look at the channel reads and does, handed in. {@link startApplianceUpdates} wires the real ones;
 * a test hands in its own and runs a tick with no timer, no release channel and no update plugin. The tick's
 * decisions were untested while they lived inside the interval — the only check on them read the source.
 */
export interface UpdateTickDeps {
  /** The channel's answer. One that cannot be had is no offer, and no update failure. */
  check(): Promise<Offer | null>;
  /** Download, verify and install what is offered. Throws the step that refused. */
  apply(): Promise<{ plan: { to: string } }>;
  /** The release this box last rolled back from (`confirm.ts`). */
  rolledBackFrom(): string | null;
  isCritical(tag: string): boolean;
  /** The owner's switch on My Box, read on every tick: it changes while the daemon runs. */
  automatic(): boolean;
  busy(): boolean;
  now(): number;
  /** `[daemon] timezone`: the window is the box's own night. */
  timeZone(): string;
  report: UpdatingRunner["reportUpdate"];
  requestRestart(reason: string): void;
}

/**
 * One look at the channel and what follows from it — the tick {@link startApplianceUpdates} runs every
 * {@link TICK_MS} — with what it remembers between looks: the night it last tried, the critical release it is
 * waiting on, and the releases whose files did not verify.
 */
export function updateTick(deps: UpdateTickDeps): () => Promise<void> {
  let lastTried: string | null = null;
  let running = false;
  /** A critical release waiting for the box to be idle, and since when. */
  let waiting: { tag: string; since: number } | null = null;
  /** Releases whose files did not verify: not retried every tick until the daemon restarts. */
  const refused = new Set<string>();
  const sayCannotTake = cannotTakeReporter(deps.report, (message, data) => log.warn(message, data));

  return async () => {
    if (running) return;
    running = true;
    let attempting: string | null = null;
    try {
      // Every tick, all day: a critical release must be found whenever the box is online. Cheap —
      // the source caches its answer, and the gate allows far more than three checks an hour.
      const check = await deps.check().catch(() => null);
      if (check?.newer && check.plan && !check.plan.can) sayCannotTake(check.latest, check.plan.reason, check.plan.instead);
      if (!check?.newer || !check.plan?.can) {
        waiting = null;
        return;
      }
      const tag = check.latest;
      // Not the build this box already rolled back from: that one waits for a person, or a newer tag.
      if (deps.rolledBackFrom() === tag || refused.has(tag)) return;

      const critical = deps.isCritical(tag);
      const busy = deps.busy();
      const now = deps.now();
      if (critical && busy && waiting?.tag !== tag) {
        waiting = { tag, since: now };
        log.info("a critical update is waiting for the box to be idle", { tag });
      }
      const { hour, date } = localClock(new Date(now), deps.timeZone());
      const decision = decideInstall({
        critical,
        automatic: deps.automatic(),
        busy,
        hour,
        date,
        lastTried,
        waitingSince: waiting?.tag === tag ? waiting.since : null,
        now,
      });
      if (decision !== "install") return;

      if (!critical) lastTried = date;
      attempting = tag;
      log.info(critical ? "installing a critical update" : "installing an update automatically", {
        from: check.current,
        to: tag,
        ...(critical && busy ? { waited_ms: now - (waiting?.since ?? now) } : {}),
      });
      const { plan } = await deps.apply();
      deps.requestRestart(`${critical ? "critical" : "automatic"} update to ${plan.to}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("automatic update failed: staying on this version", { error: message });
      // Only a release it actually tried: a check that could not reach the service is not an update failure.
      if (attempting) {
        const outcome = failureOutcome(message);
        if (outcome === "failed_verify") refused.add(attempting);
        void deps.report({ tag: attempting, outcome, reason: message }).catch(() => undefined);
      }
    } finally {
      running = false;
    }
  };
}

export function startApplianceUpdates(ctx: DaemonContext, runner: UpdatingRunner, version: string, deps: ApplianceUpdateDeps): void {
  const dataDir = ctx.config.daemon.dataDir;
  const installDir = installDirFor(dataDir);
  const report = runner.reportUpdate.bind(runner);

  // The new version's proof of life on a box is the service answering its sync: it booted, it has
  // a network, and the one thing a box must keep doing works. Without it the guard puts the old one back.
  watchPendingUpdate({
    installDir,
    version,
    // No answer is no proof: the plugin always says, and a missing method used to count as alive.
    healthy: () => runner.syncedSinceBoot(),
    report,
    requestRestart: deps.requestRestart,
    // The unit this version writes, on a privileged install running as root: what an update alone never changed.
    onConfirmed: () => refreshInstalledUnit({ info: log.info.bind(log), warn: log.warn.bind(log) }),
    timers: ctx.backgroundTimers,
  });

  const tick = updateTick({
    check: () => checkForUpdate(dataDir),
    apply: () => applyUpdate(dataDir),
    rolledBackFrom: () => rolledBackFrom(installDir),
    isCritical: (tag) => runner.isCritical(tag),
    automatic: () => runner.updatePolicy().automatic,
    busy: () => deps.busy(),
    now: () => Date.now(),
    timeZone: () => ctx.config.daemon.timezone,
    report,
    requestRestart: (reason) => deps.requestRestart(reason),
  });
  const timer = setInterval(contained(log, "the automatic update check failed", tick), TICK_MS);
  timer.unref?.();
  ctx.backgroundTimers.push(timer);
}

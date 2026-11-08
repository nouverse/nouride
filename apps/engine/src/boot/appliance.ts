/**
 * The seam between this daemon and `nouride-appliance`, and nothing else.
 *
 * Hardware pairing and licensing live in that plugin, outside this source tree, so that
 * `--external nouride-appliance` genuinely removes them from every build but Pro.
 * What is left here is the load, the schedule and the refusal — the three things that are about
 * *this daemon* rather than about appliances.
 *
 * ## The refusal
 *
 * A build with no plugin that finds a `device.json` **stops**, rather than starting and quietly
 * being an ordinary daemon. The same shape as `[dashboard.oauth]` on a build with no sign-in flow,
 * and for the same reason: the alternative is a box that boots, never appears in its owner's
 * account, and gives nobody a sentence to search for. Somebody would check the QR code, the claim
 * page and the network before suspecting the download.
 *
 * ## Why the timer is here
 *
 * The plugin schedules nothing. `ctx.backgroundTimers` is what shutdown clears before the database
 * closes, and a subsystem that holds its own timers is one that fires inside the shutdown sequence.
 */

import { busyWith } from "@/modules/update/self-update.ts";
import { contained, createLogger, NourideError } from "@nouride/shared";
import { fileExists, join } from "@nouride/runtime";
import type { ApplianceEvent, ApplianceRunner } from "nouride-appliance";
import type { DaemonContext } from "@/commons/context.ts";
import type { JobsPort } from "@/modules/jobs/jobs.store.ts";
import { setReleaseSource } from "@/modules/update/index.ts";
import { startApplianceUpdates } from "@/boot/appliance-updates.ts";
import { provedHealthy, watchPendingUpdate } from "@/modules/update/confirm.ts";
import { buildHealth } from "@/modules/web/health.ts";
import { gatherInstallFacts, installDirFor, installTarget } from "@/modules/update/facts.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { refreshInstalledUnit } from "@/service/drift.ts";

/** What the seam needs from the rest of boot for updates: whether anyone is using the daemon, and a way to restart it. */
export interface UpdateBootDeps {
  pipeline: { stats(): { running: number; waiting: number; completed: number } };
  jobs: Pick<JobsPort, "listSnapshots">;
  requestRestart(reason: string): void;
}

/**
 * Load the appliance plugin when this build has it, and — box or not — confirm an update this
 * process is the new version of (`modules/update/confirm.ts`). On a box the proof of life is a sync
 * the service answered; anywhere else `offBoxHealthy`.
 */
export async function startApplianceIfPresent(
  ctx: DaemonContext,
  version: string,
  gateway: { resetAccounts(): Promise<number> } | null | undefined,
  deps: UpdateBootDeps,
): Promise<void> {
  const busy = busyWith(deps.pipeline, deps.jobs);
  const boxHandlesUpdates = await startBox(ctx, version, gateway, { busy, requestRestart: deps.requestRestart });
  if (!boxHandlesUpdates) {
    watchPendingUpdate({
      installDir: installDirFor(ctx.config.daemon.dataDir),
      version,
      healthy: () => offBoxHealthy(ctx, deps.pipeline),
      requestRestart: deps.requestRestart,
      // The unit this version writes, on a privileged install running as root: what an update alone never changed.
      onConfirmed: () => refreshInstalledUnit({ info: log.info.bind(log), warn: log.warn.bind(log) }),
      timers: ctx.backgroundTimers,
    });
  }
}

/** Proof of life where no box service vouches for a new version: what `/health` reports, and what the queue has done. */
export function offBoxHealthy(ctx: DaemonContext, pipeline: UpdateBootDeps["pipeline"], now = Date.now()): boolean {
  const { payload } = buildHealth(ctx);
  return provedHealthy({ status: payload.status, gateways: Object.values(payload.gateways), handled: pipeline.stats().completed, upMs: now - ctx.startedAt });
}

const log = createLogger("appliance");

/**
 * Whether this install was flashed as a box, asked without understanding the answer.
 *
 * Deliberately only `exists`: what is *in* `device.json` is the plugin's business, and a build with
 * no plugin must still be able to tell that it is looking at a box it cannot serve. One path, no
 * parsing, no schema — the engine learns nothing about pairing from this.
 */
async function applianceIdentityPresent(dataDir: string): Promise<boolean> {
  return fileExists(join(dataDir, "appliance", "device.json"));
}

class ApplianceUnsupportedError extends NourideError {
  override name = "ApplianceUnsupportedError";
  constructor(message: string) {
    super("appliance_unsupported", message, "This build cannot pair with Nouverse as an appliance.");
  }
}

function emit(events: ApplianceEvent[]): void {
  for (const event of events) log[event.level](event.message, event.data ?? {});
}

/**
 * Load the plugin, start the sync loop, and leave `ctx.appliance` set when this is a paired box.
 * Answers whether the box took over updates — its release source, schedule and proof of life — so
 * the caller knows not to confirm a pending update a second way.
 *
 * Nothing waits on the first sync. A box whose uplink is down must reach `ready` exactly as fast as
 * one whose uplink is up: the licence it already holds was verified offline while this ran, and a
 * sync that never answers changes nothing about whether the daemon can hold a conversation.
 */
async function startBox(
  ctx: DaemonContext,
  version: string,
  gateway: { resetAccounts(): Promise<number> } | null | undefined,
  updates: { busy(): boolean; requestRestart(reason: string): void },
): Promise<boolean> {
  let created: { runner: ApplianceRunner; events: ApplianceEvent[] } | null = null;

  try {
    const mod = await import("nouride-appliance");
    // Calling the verifier is what keeps the build marker alive through minification, and the
    // cheapest proof that what resolved is the real module rather than an empty object a bundler
    // left behind.
    if (typeof mod.verifyApplianceEdition !== "function" || !mod.verifyApplianceEdition()) {
      throw new Error("nouride-appliance resolved to something that is not the plugin");
    }
    const dataDir = ctx.config.daemon.dataDir;
    const users = new UserStore({ db: ctx.db });
    created = mod.createAppliance({
      dataDir,
      version,
      // The engine's facts, handed in: the plugin worked them out again and got the port wrong once an owner moved it.
      dashboardPort: ctx.config.dashboard.port,
      gatewayPort: gateway ? ctx.config.nougate.port : null,
      installDir: installDirFor(dataDir),
      target: installTarget(await gatherInstallFacts(dataDir)),
      accounts: { reset: async () => users.resetAll() },
      ...(gateway ? { gateway } : {}),
    });
  } catch {
    // Absent is the correct state for every edition but Pro, so it is only a
    // failure when this install was flashed as a box.
    if (await applianceIdentityPresent(ctx.config.daemon.dataDir)) {
      throw new ApplianceUnsupportedError(
        "This install has an appliance identity (appliance/device.json in the data directory), " +
          "but this build has no appliance support. Only the pro edition carries " +
          "pairing and licensing. Either run a device build, or remove that file to run this as an " +
          "ordinary daemon.",
      );
    }
    return false;
  }

  // No identity, on a build that could have used one. A Device binary somebody is developing
  // against, or a box whose device.json was removed — an ordinary daemon either way.
  if (!created) return false;

  emit(created.events);
  const runner = created.runner;
  ctx.appliance = runner;
  // A box's updates come from the Nouverse service, not the public mirror, which carries no Pro build. The update
  // plugin still verifies and swaps; this only says where to look.
  setReleaseSource(runner.releaseSource());
  startApplianceUpdates(ctx, runner, version, updates);

  applianceLoop("sync", () => runner.sync(), 0, ctx.backgroundTimers);
  // The local step: the setup hotspot and its portal when the box has no network, and on every board the
  // upkeep that must not wait on Wi-Fi.
  applianceLoop("local step", () => runner.onboard(), 0, ctx.backgroundTimers);
  return true;
}

/**
 * One loop per job the plugin has — the sync, and the box's local step (Wi-Fi onboarding and the upkeep beside it) —
 * each rescheduled by its own answer. A step that answers null ends its loop.
 *
 * Each timer goes into `timers`, `ctx.backgroundTimers`, so the shutdown sequence can clear it before the database
 * closes underneath it; and it is `unref`'d, so a pending step never holds the process open through shutdown.
 */
export function applianceLoop(
  name: string,
  step: () => Promise<{ nextInSeconds: number; events: ApplianceEvent[] } | null>,
  seconds: number,
  timers: ReturnType<typeof setInterval>[],
): void {
  const timer = setTimeout(
    contained(log, "an appliance loop could not go on", () =>
      // `then(step)`, not `step()`: a step that throws before it has a promise to reject takes the same path as one
      // that rejects. Called bare, that throw was an uncaught exception, which ended the loop and the daemon with it.
      Promise.resolve()
        .then(step)
        .then((result) => {
          if (!result) return;
          emit(result.events);
          applianceLoop(name, step, result.nextInSeconds, timers);
        })
        .catch((err: unknown) => {
          // A step that throws must not end the loop, or one bad response retires the box.
          log.warn(`appliance ${name} threw`, { error: String(err) });
          applianceLoop(name, step, 300, timers);
        }),
    { loop: name }),
    seconds * 1000,
  );
  timer.unref?.();
  timers.push(timer as unknown as ReturnType<typeof setInterval>);
}

/**
 * When a box installs an update by itself: overnight, once, and never while someone is using it.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CRITICAL_MAX_WAIT_MS,
  UPDATE_WINDOW,
  decideInstall,
  failureOutcome,
  localClock,
  mayInstallNow,
  startApplianceUpdates,
  updateTick,
  type UpdateTickDeps,
} from "@/boot/appliance-updates.ts";
import type { DaemonContext } from "@/commons/context.ts";

const at = (hour: number) => ({ automatic: true, busy: false, hour, date: "2026-09-25", lastTried: null as string | null });

describe("the nightly window", () => {
  test(`from ${UPDATE_WINDOW.from}:00 up to ${UPDATE_WINDOW.to}:00, local`, () => {
    expect(mayInstallNow(at(1))).toBe(false);
    expect(mayInstallNow(at(2))).toBe(true);
    expect(mayInstallNow(at(4))).toBe(true);
    expect(mayInstallNow(at(5))).toBe(false);
    expect(mayInstallNow(at(14))).toBe(false);
  });

  test("once a night, never while busy, and never when the owner turned it off", () => {
    expect(mayInstallNow({ ...at(3), lastTried: "2026-09-25" })).toBe(false);
    expect(mayInstallNow({ ...at(3), lastTried: "2026-09-24" })).toBe(true);
    expect(mayInstallNow({ ...at(3), busy: true })).toBe(false);
    expect(mayInstallNow({ ...at(3), automatic: false })).toBe(false);
  });

  test("the hour is the box's own, and an unknown zone falls back to UTC rather than throwing", () => {
    const instant = new Date("2026-09-24T20:30:00Z");
    expect(localClock(instant, "Asia/Jakarta")).toEqual({ hour: 3, date: "2026-09-25" });
    expect(localClock(instant, "UTC")).toEqual({ hour: 20, date: "2026-09-24" });
    expect(localClock(instant, "Not/AZone")).toEqual({ hour: 20, date: "2026-09-24" });
  });
});

describe("a critical release", () => {
  const base = { critical: true, automatic: true, busy: false, hour: 14, date: "2026-09-25", lastTried: null, waitingSince: null, now: 1_000_000 };

  test("is installed at any hour, and even with automatic updates turned off", () => {
    expect(decideInstall(base)).toBe("install");
    expect(decideInstall({ ...base, automatic: false })).toBe("install");
    // …and again the same day: "once a night" is the normal path's rule.
    expect(decideInstall({ ...base, lastTried: "2026-09-25" })).toBe("install");
  });

  test("waits for a busy box, but not for ever", () => {
    expect(decideInstall({ ...base, busy: true, waitingSince: null })).toBe("wait");
    expect(decideInstall({ ...base, busy: true, waitingSince: base.now - CRITICAL_MAX_WAIT_MS + 1 })).toBe("wait");
    expect(decideInstall({ ...base, busy: true, waitingSince: base.now - CRITICAL_MAX_WAIT_MS })).toBe("install");
  });

  test("a normal release still keeps to the window and the owner's choice", () => {
    const normal = { ...base, critical: false };
    expect(decideInstall(normal)).toBe("no");
    expect(decideInstall({ ...normal, hour: 3 })).toBe("install");
    expect(decideInstall({ ...normal, hour: 3, automatic: false })).toBe("no");
  });
});

type Offer = Awaited<ReturnType<UpdateTickDeps["check"]>>;
type Report = Parameters<UpdateTickDeps["report"]>[0];

/** 03:00 on 25 September on the box: Asia/Jakarta is UTC+7, so this is 20:00 the day before in UTC. */
const NIGHT = Date.parse("2026-09-24T20:00:00Z");
const TICK = 20 * 60_000;

/**
 * A box, its channel and its installer, each a field a test sets, with every effect a tick has recorded. Offered:
 * v0.7.11, an ordinary release this box can take; the clock is inside the window, and nobody is using the box.
 */
function box() {
  const state = {
    offer: { current: "0.7.10", latest: "v0.7.11", newer: true, plan: { can: true } } as Offer,
    critical: false,
    busy: false,
    automatic: true,
    rolledBackFrom: null as string | null,
    /** What the next install throws; null installs. */
    failWith: null as string | null,
    /** An install in progress waits on this, when it is set. */
    hold: null as Promise<void> | null,
    clock: NIGHT,
    installs: [] as string[],
    restarts: [] as string[],
    reports: [] as Report[],
  };
  const tick = updateTick({
    check: async () => state.offer,
    apply: async () => {
      const tag = state.offer!.latest;
      state.installs.push(tag);
      await state.hold;
      if (state.failWith) throw new Error(state.failWith);
      return { plan: { to: tag } };
    },
    rolledBackFrom: () => state.rolledBackFrom,
    isCritical: () => state.critical,
    automatic: () => state.automatic,
    busy: () => state.busy,
    now: () => state.clock,
    timeZone: () => "Asia/Jakarta",
    report: async (report) => void state.reports.push(report),
    requestRestart: (reason) => void state.restarts.push(reason),
  });
  return { state, tick };
}

describe("a look at the channel", () => {
  test("an ordinary release goes in at night by the box's clock, and a try that failed waits for the next night", async () => {
    const { state, tick } = box();
    // 03:00 in UTC is 10:00 on this box: not its night.
    state.clock = Date.parse("2026-09-24T03:00:00Z");
    await tick();
    expect(state.installs).toEqual([]);

    state.clock = NIGHT;
    state.failWith = "the download did not finish: connection reset";
    await tick();
    expect(state.installs).toEqual(["v0.7.11"]);
    expect(state.reports).toEqual([{ tag: "v0.7.11", outcome: "failed_download", reason: "the download did not finish: connection reset" }]);

    state.failWith = null;
    state.clock = NIGHT + TICK;
    await tick();
    expect(state.installs).toHaveLength(1);

    state.clock = NIGHT + 24 * 60 * 60_000;
    await tick();
    expect(state.installs).toEqual(["v0.7.11", "v0.7.11"]);
    expect(state.restarts).toEqual(["automatic update to v0.7.11"]);
  });

  test("the owner's switch is read at every look: off, an ordinary release waits — without using up the night", async () => {
    const { state, tick } = box();
    state.automatic = false;
    await tick();
    expect(state.installs).toEqual([]);

    state.automatic = true;
    state.clock = NIGHT + TICK;
    await tick();
    expect(state.installs).toEqual(["v0.7.11"]);
  });

  test("a critical release waits for a busy box an hour from the look that first saw it — not from each look — then goes in", async () => {
    const { state, tick } = box();
    state.critical = true;
    state.busy = true;
    // 14:00 on the box: a critical release keeps no window.
    const seen = Date.parse("2026-09-25T07:00:00Z");
    state.clock = seen;
    await tick();
    state.clock = seen + CRITICAL_MAX_WAIT_MS - 1;
    await tick();
    expect(state.installs).toEqual([]);

    state.clock = seen + CRITICAL_MAX_WAIT_MS;
    await tick();
    expect(state.installs).toEqual(["v0.7.11"]);
    expect(state.restarts).toEqual(["critical update to v0.7.11"]);
  });

  test("the build this box rolled back from is not taken again by itself; a newer one is", async () => {
    const { state, tick } = box();
    state.critical = true;
    state.rolledBackFrom = "v0.7.11";
    await tick();
    expect(state.installs).toEqual([]);
    expect(state.reports).toEqual([]);

    state.offer = { ...state.offer!, latest: "v0.7.12" };
    await tick();
    expect(state.installs).toEqual(["v0.7.12"]);
  });

  test("a release whose files did not verify is not tried again until a restart; a newer one is", async () => {
    const { state, tick } = box();
    state.critical = true;
    // It names the download too; what failed is the check.
    state.failWith = "checksum mismatch for nouride-linux-x64.tar.gz: the channel says aa11, the download is bb22";
    await tick();
    expect(state.reports).toEqual([{ tag: "v0.7.11", outcome: "failed_verify", reason: state.failWith }]);

    state.failWith = null;
    await tick();
    expect(state.installs).toEqual(["v0.7.11"]);

    state.offer = { ...state.offer!, latest: "v0.7.12" };
    await tick();
    expect(state.installs).toEqual(["v0.7.11", "v0.7.12"]);
  });

  test("a release that did not download is tried again at the next look", async () => {
    const { state, tick } = box();
    state.critical = true;
    state.failWith = "the download did not finish: connection reset";
    await tick();
    state.failWith = null;
    await tick();
    expect(state.installs).toEqual(["v0.7.11", "v0.7.11"]);
    expect(state.reports).toEqual([{ tag: "v0.7.11", outcome: "failed_download", reason: "the download did not finish: connection reset" }]);
    expect(state.restarts).toEqual(["critical update to v0.7.11"]);
  });

  test("a checksum file the channel would not serve is tried again at the next look, not refused until a restart", async () => {
    // What a box can see while a release is being published — its tarball up, its checksum file not yet — or on a
    // 503. Refused, even a critical release waited for the daemon's next restart.
    const { state, tick } = box();
    state.critical = true;
    state.failWith = "fetching checksums answered 404 (https://releases.example/v0.7.11/SHA256SUMS)";
    await tick();
    state.failWith = null;
    await tick();
    expect(state.installs).toEqual(["v0.7.11", "v0.7.11"]);
    expect(state.reports).toEqual([{ tag: "v0.7.11", outcome: "failed_download", reason: "fetching checksums answered 404 (https://releases.example/v0.7.11/SHA256SUMS)" }]);
  });

  test("an offer this box cannot take is said once, and nothing is installed — a critical one too", async () => {
    // The tick used to return on it in silence: an OpenWrt box with no supervisor refused every update, and the fleet
    // saw only a version that stopped moving (`pro-procd-boxes-never-update`). `procd.test.ts` has the reporter.
    const { state, tick } = box();
    state.critical = true;
    state.offer = {
      current: "0.7.10",
      latest: "v0.7.11",
      newer: true,
      plan: { can: false, reason: "nothing would restart this daemon after the swap", instead: ["nouride service install"] },
    };
    for (let look = 0; look < 3; look++) await tick();
    expect(state.installs).toEqual([]);
    expect(state.reports).toEqual([
      { tag: "v0.7.11", outcome: "failed_install", reason: "this box cannot update itself: nothing would restart this daemon after the swap" },
    ]);
  });

  test("a look that comes while the last one is still installing does nothing", async () => {
    // A download can outlast the twenty minutes between looks; a second install of the same release beside it would
    // swap the binary twice.
    const { state, tick } = box();
    state.critical = true;
    let finish!: () => void;
    state.hold = new Promise<void>((resolve) => (finish = resolve));
    const first = tick();
    const second = tick();
    finish();
    await Promise.all([first, second]);
    expect(state.installs).toEqual(["v0.7.11"]);
    expect(state.restarts).toHaveLength(1);
  });
});

describe("starting the looks", () => {
  test("their timer is registered where shutdown clears it: one that is not fires inside the shutdown", () => {
    const root = mkdtempSync(join(tmpdir(), "nouride-appliance-updates-"));
    // `<install>/.nouride/data`, so the install directory is the temporary root: no update pending in it.
    const dataDir = join(root, ".nouride", "data");
    mkdirSync(dataDir, { recursive: true });
    const ctx = { config: { daemon: { dataDir, timezone: "UTC" } }, backgroundTimers: [] } as unknown as DaemonContext;
    const runner = { reportUpdate: async () => {}, updatePolicy: () => ({ automatic: true }), isCritical: () => false, syncedSinceBoot: () => true };
    try {
      startApplianceUpdates(ctx, runner, "0.7.10", { busy: () => false, requestRestart: () => {} });
      expect(ctx.backgroundTimers).toHaveLength(1);
    } finally {
      for (const timer of ctx.backgroundTimers) clearInterval(timer);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("what a failed install is reported as", () => {
  test("files that did not verify — unsigned, or a checksum that does not match — whatever else the message names", () => {
    expect(failureOutcome("the release's checksum file is not signed by Nouverse — refusing to install it")).toBe("failed_verify");
    expect(failureOutcome("v0.7.11 must be signed, and came with no signature — refusing to install it")).toBe("failed_verify");
    expect(failureOutcome("checksum mismatch for nouride-linux-x64.tar.gz: the channel says aa11, the download is bb22")).toBe("failed_verify");
  });

  test("a file the channel would not serve is a transfer that failed, not files that did not verify", () => {
    // The plugin says "fetching checksums" for the checksum file and its signature alike; read for the word, a 503
    // was reported to the fleet as a bad release.
    expect(failureOutcome("fetching checksums answered 503 (https://releases.example/v0.7.11/SHA256SUMS)")).toBe("failed_download");
    expect(failureOutcome("fetching checksums answered 404 (https://releases.example/v0.7.11/SHA256SUMS.sig)")).toBe("failed_download");
  });

  test("a transfer that did not finish is a download failure, and anything else an install failure", () => {
    expect(failureOutcome("the download did not finish: downloading https://example.test/nouride.tar.gz answered 503")).toBe("failed_download");
    expect(failureOutcome("the swap failed and was rolled back: EACCES")).toBe("failed_install");
    expect(failureOutcome("the tarball has no `nouride` executable in it")).toBe("failed_install");
  });
});

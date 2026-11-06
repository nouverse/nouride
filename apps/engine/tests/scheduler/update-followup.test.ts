/**
 * The follow-up turn has to outlast the update, not the request for it.
 *
 * This is a regression test for something that happened on a Raspberry Pi rather than
 * something imagined. The job was created before the swap — correctly, because that is the
 * only way it survives a swap that kills the process — and its clock started there too. The
 * download took 36 seconds, the 25-second follow-up fired into the *old* process while it
 * was still downloading, the restart aborted the turn four seconds later, and the job was a
 * one-shot so it was gone. The daemon came back on the new version and nobody was told.
 *
 * So: created early, armed late. Both halves are asserted here, because fixing either one
 * alone puts the other failure back.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { addLogSink, type LogEntry } from "@nouride/shared";
import type { JobSnapshot } from "@/modules/jobs/jobs.store.ts";
import { eventually } from "../helpers.ts";
import { sleep } from "../wait.ts";

/** How long the fake swap takes. Long enough that "before" and "after" are not the same ms. */
const SWAP_MS = 20;

/** Called as the fake swap starts — what a test needs to know about the moment nothing has been touched yet. */
let onSwap: (() => void) | null = null;

/**
 * The real module underneath, with only the three calls this file fakes replaced, and only while its own tests run.
 *
 * `mock.module` replaces the module for the whole test process, not this file. Listing only the fakes
 * left every other export missing, so `self-update.ts` failed to link on `installDownloaded` whenever
 * this file shared a run with another that loaded it — green in the full suite by the luck of file
 * order, red when the scheduler tests ran on their own. And the fakes outlived the file: a test of the update track
 * run after it in the same process got this fake check, which knows no track (CI's file order, 2026-11-04). Past this
 * file's last test each call is the real one again.
 */
const real = await import("@/modules/update/index.ts");
// Copied before the mock: the namespace is updated in place by it, and a call through it would be the fake again.
const original = { ...real };
let faking = true;
afterAll(() => {
  faking = false;
});

mock.module("@/modules/update/index.ts", () => ({
  ...original,
  updateSupported: () => (faking ? true : original.updateSupported()),
  checkForUpdate: async (...args: Parameters<typeof real.checkForUpdate>) =>
    faking ? { current: "0.3.1", latest: "v0.3.2", newer: true } : await original.checkForUpdate(...args),
  applyUpdate: async (...args: Parameters<typeof real.applyUpdate>) => {
    if (!faking) return await original.applyUpdate(...args);
    onSwap?.();
    await sleep(SWAP_MS);
    return {
      report: { replaced: ["nouride"], backupDir: "/srv/nouride/.nouride-previous", bytes: 1, sha256: "ab" },
      plan: { can: true as const, from: "0.3.1", to: "v0.3.2", artifact: "a", tarballUrl: "u", checksumUrl: "c", checksumFile: "f" },
    };
  },
}));

const { busyWith, describeJobs, runSelfUpdate, restartWhenIdle, workingJobs } = await import("@/modules/update/self-update.ts");

/**
 * The restart — and the re-arm with it — happens on a timer after the swap: wait for it. It used to give up after two
 * seconds without a word, so a restart that never came was left for the assertions after it to notice, or not.
 */
const restarted = (restarts: string[]) => eventually(() => restarts.length > 0, 4_000, "the restart");

/** A restart's pacing for tests: it first looks after 5 ms, not 250, and again every 5 ms, not every 2 s. */
const PACING = { beatMs: 5, pollMs: 5 };

/** A `busy` that counts how often it was asked, so "it waited" is said from the looks it took rather than a quiet interval. */
function counted(answer: () => boolean): { busy: () => boolean; looks: () => number } {
  let looks = 0;
  return {
    busy: () => {
      looks += 1;
      return answer();
    },
    looks: () => looks,
  };
}

interface Recorded {
  at: number;
  message: string;
}

function fakeCron(): { created: Recorded[]; rearmed: Recorded[]; port: never } {
  const created: Recorded[] = [];
  const rearmed: Recorded[] = [];
  const port = {
    create(input: { trigger: { at: number }; payload: { message: string } }) {
      created.push({ at: input.trigger.at, message: input.payload.message });
      return { id: "cron_test" };
    },
    update(_id: string, patch: { trigger?: { at: number }; payload?: { message: string } }) {
      rearmed.push({ at: patch.trigger?.at ?? 0, message: patch.payload?.message ?? "" });
      return { id: "cron_test" };
    },
  };
  return { created, rearmed, port: port as never };
}

describe("the follow-up is created before the swap and armed after it", () => {
  test("it is parked out of reach until the swap is done, then armed", async () => {
    const { created, rearmed, port } = fakeCron();
    const restarts: string[] = [];
    const startedAt = Date.now();

    await runSelfUpdate(
      { dataDir: "/tmp/x", cron: port, requestRestart: (reason) => restarts.push(reason), pacing: PACING },
      {
        message: "say which version you are on",
        delaySeconds: 30,
        agentId: "ren",
        gatewayId: "web:dashboard",
        chatId: "c1",
      },
    );
    await restarted(restarts);

    expect(created).toHaveLength(1);
    expect(rearmed).toHaveLength(1);

    /**
     * The row starts parked far out — fifteen minutes — and lands on the delay the caller
     * asked for. Both halves matter and each one alone is a failure that happened:
     *
     * - armed at creation, it fires *during* a download longer than the delay (34s on a Pi
     *   against a 30s follow-up), is aborted by the restart, and a one-shot is then gone.
     * - never re-armed, it fires fifteen minutes after a restart nobody is still watching.
     */
    const parkedFor = created[0]!.at - startedAt;
    const armedFor = rearmed[0]!.at - startedAt;
    expect(parkedFor).toBeGreaterThan(10 * 60 * 1000);
    expect(armedFor).toBeGreaterThanOrEqual(30_000);
    expect(armedFor).toBeLessThan(45_000);
    // And the arming happened after the swap, not before it.
    expect(rearmed[0]!.at - created[0]!.at).toBeLessThan(0);
  });

  test("the row exists before anything is touched, so a swap that kills the process leaves it behind", async () => {
    /**
     * The property the re-arm must not cost. `create` is called while `applyUpdate` has not
     * returned; if it were moved after, a swap that ended the process would leave no way back.
     */
    const { created, port } = fakeCron();
    let createdBeforeSwap = false;
    // As the swap starts — not half way through it by the clock — the row is already there.
    onSwap = () => void (createdBeforeSwap = created.length === 1);
    try {
      await runSelfUpdate(
        { dataDir: "/tmp/x", cron: port, requestRestart: () => undefined },
        { message: "m", delaySeconds: 30, agentId: "a", gatewayId: "g", chatId: "c" },
      );
    } finally {
      onSwap = null;
    }

    expect(createdBeforeSwap).toBe(true);
  });

  test("the re-armed turn is told which version it should be on", async () => {
    // A scheduled turn has nobody to ask, so every tool that could check is refused. Telling
    // it what to expect is the difference between a report and a shrug.
    const { created, rearmed, port } = fakeCron();
    const restarts: string[] = [];
    await runSelfUpdate(
      { dataDir: "/tmp/x", cron: port, requestRestart: (reason) => restarts.push(reason), pacing: PACING },
      { message: "report back", delaySeconds: 30, agentId: "a", gatewayId: "g", chatId: "c" },
    );
    await restarted(restarts);
    expect(created[0]!.message).not.toContain("v0.3.2");
    expect(rearmed[0]!.message).toContain("v0.3.2");
    expect(rearmed[0]!.message).toContain("report back");
    expect(rearmed[0]!.message).toContain("no human behind it");
  });

  test("a watched update schedules nothing at all", async () => {
    // The dashboard's path: the operator pressing the button is the one watching.
    const { created, rearmed, port } = fakeCron();
    const result = await runSelfUpdate(
      { dataDir: "/tmp/x", cron: port, requestRestart: () => undefined },
      { watched: true },
    );
    expect(created).toHaveLength(0);
    expect(rearmed).toHaveLength(0);
    expect(result.followUp).toBeNull();
  });
});

describe("the restart waits for the daemon to go idle", () => {
  test("not while a turn runs: it restarts once nothing is running", async () => {
    let busy = true;
    let restarts = 0;
    const turn = counted(() => busy);
    restartWhenIdle({ busy: turn.busy, restart: () => (restarts += 1), ...PACING, maxWaitMs: 60_000 });
    await eventually(() => turn.looks() >= 3, 4_000, "three looks at a busy daemon");
    expect(restarts).toBe(0);
    busy = false;
    await eventually(() => restarts === 1, 4_000, "the restart once idle");
  });

  test("busy while a background job works, though no turn runs — a restart would kill it", () => {
    const quiet = { stats: () => ({ running: 0, waiting: 0 }) };
    let jobs = [{ id: "job_build", status: "running" }];
    const busy = busyWith(quiet, { listSnapshots: () => jobs as unknown as JobSnapshot[] });
    expect(busy()).toBe(true);
    jobs = [{ id: "job_build", status: "succeeded" }];
    expect(busy()).toBe(false);
    expect(busyWith(quiet, undefined)()).toBe(false);
  });

  test("busy while a coding CLI still runs a command it left in the background, waited for as a job is (0.8.6)", () => {
    // A restart stops each CLI, and the command with it: Claude Code's background build, cut off, never reports.
    let left = [{ id: "cli:nix", command: "nix's Claude Code", startedAt: 1 }];
    const pipeline = { stats: () => ({ running: 0, waiting: 0 }), cliCommands: () => left };
    expect(busyWith(pipeline, undefined)()).toBe(true);
    expect(workingJobs(undefined, pipeline)()).toEqual([{ id: "cli:nix", command: "nix's Claude Code", startedAt: 1 }]);
    left = [];
    expect(busyWith(pipeline, undefined)()).toBe(false);
    expect(workingJobs(undefined, pipeline)()).toEqual([]);
  });

  test("but not for a service: it serves until stopped, so waiting for it could only end at the timeout", () => {
    const jobs = [{ id: "job_preview", status: "running", service: true }] as unknown as JobSnapshot[];
    expect(busyWith({ stats: () => ({ running: 0, waiting: 0 }) }, { listSnapshots: () => jobs })()).toBe(false);
  });

  test("nor for an approval waiting on a person: a restart keeps it and asks it again (D8) — only its turn is waited for", () => {
    // Taking the pending approvals as a parameter is how it used to wait on them, up to ten minutes, for a question nobody
    // was answering — and then answered it "deny". `busyWith` has no way to ask about them now: its turn is what counts.
    expect(busyWith.length).toBe(2);
    expect(busyWith({ stats: () => ({ running: 0, waiting: 0 }) }, undefined)()).toBe(false);
    expect(busyWith({ stats: () => ({ running: 1, waiting: 0 }) }, undefined)()).toBe(true);
  });

  test("but not for ever: past the limit it restarts anyway — a turn it cuts off is closed with its work kept", async () => {
    let restarts = 0;
    let clock = 0;
    const turn = counted(() => true);
    restartWhenIdle({ busy: turn.busy, restart: () => (restarts += 1), ...PACING, maxWaitMs: 60_000, now: () => clock });
    await eventually(() => turn.looks() >= 2, 4_000, "two looks inside the limit");
    expect(restarts).toBe(0);
    clock = 60_000;
    await eventually(() => restarts === 1, 4_000, "the restart past the limit");
  });

  test("but a background job is waited for past that, however long it takes — cut off, it starts again from nothing", async () => {
    let restarts = 0;
    let jobs = [{ id: "job_build", command: "make", startedAt: 0 }];
    let looks = 0;
    // Past the cap from the first look: a turn alone would be cut off at once.
    restartWhenIdle({
      busy: () => true,
      jobs: () => {
        looks += 1;
        return jobs;
      },
      restart: () => (restarts += 1),
      ...PACING,
      maxWaitMs: 50,
      now: (() => {
        let clock = 0;
        return () => (clock += 1_000);
      })(),
    });
    await eventually(() => looks >= 3, 4_000, "three looks at a working job");
    expect(restarts).toBe(0);
    // The job ends; a turn still running past the cap no longer holds it.
    jobs = [];
    await eventually(() => restarts === 1, 4_000, "the restart once the job ended");
  });

  test("and says which, so a person can decide to cut them off", () => {
    const at = 1_000_000_000;
    expect(describeJobs([{ id: "j1", command: "make build", startedAt: at - 12 * 60_000 }], at)).toBe("the background job `make build` (12m)");
    const many = ["a", "b", "c", "d"].map((command, i) => ({ id: `j${i}`, command, startedAt: at - 60_000 }));
    expect(describeJobs(many, at)).toBe("the 4 background jobs `a` (1m), `b` (1m), `c` (1m) and 1 more");
    // A job that has only just started is not a minute old.
    expect(describeJobs([{ id: "j9", command: "sleep 75", startedAt: at - 6_000 }], at)).toBe("the background job `sleep 75` (6s)");
  });

  test("and the follow-up is armed when the restart happens, not at the swap — so it cannot fire before it", async () => {
    const { rearmed, port } = fakeCron();
    const restarts: string[] = [];
    let busy = true;
    const turn = counted(() => busy);
    await runSelfUpdate(
      { dataDir: "/tmp/x", cron: port, requestRestart: (reason) => restarts.push(reason), busy: turn.busy, pacing: PACING },
      { message: "m", delaySeconds: 30, agentId: "a", gatewayId: "g", chatId: "c" },
    );
    await eventually(() => turn.looks() >= 3, 4_000, "three looks at a busy daemon");
    expect(rearmed).toHaveLength(0);
    busy = false;
    await restarted(restarts);
    expect(restarts).toHaveLength(1);
    expect(rearmed).toHaveLength(1);
  });
});

/**
 * Each look runs on a timer and reads the queue, the approvals and the job table. Out of a timer a throw was an uncaught
 * exception — the daemon shuts down on one, which is a restart, but not the one that was waiting — and it ended the
 * wait. Bun fails the running test on one.
 */
describe("a restart whose look fails", () => {
  const said: LogEntry[] = [];
  addLogSink((entry) => void (entry.component === "update.self" && entry.level !== "info" && entry.level !== "debug" && said.push(entry)));
  const lines = () => said.map((line) => [line.message, line.data?.error]);

  test("looks again as though something were running, and restarts once a look says idle", async () => {
    said.length = 0;
    let restarts = 0;
    let looks = 0;
    const busy = () => {
      looks += 1;
      if (looks === 1) throw new Error("database is locked");
      return false;
    };
    restartWhenIdle({ busy, restart: () => (restarts += 1), ...PACING, maxWaitMs: 60_000 });
    await eventually(() => restarts === 1, 4_000, "the restart after a look that failed");
    expect(looks).toBe(2);
    expect(lines()).toEqual([["could not tell whether anything is still running: waiting on", "Error: database is locked"]]);
  });

  test("a store that never answers still ends at the limit", async () => {
    let restarts = 0;
    let clock = 0;
    let looks = 0;
    const busy = () => {
      looks += 1;
      throw new Error("Cannot use a closed database");
    };
    restartWhenIdle({ busy, restart: () => (restarts += 1), ...PACING, maxWaitMs: 60_000, now: () => clock });
    await eventually(() => looks >= 2, 4_000, "two looks inside the limit");
    expect(restarts).toBe(0);
    clock = 60_000;
    await eventually(() => restarts === 1, 4_000, "the restart past the limit");
  });

  test("an update still restarts when its follow-up cannot be armed — the files are already swapped", async () => {
    said.length = 0;
    const restarts: string[] = [];
    const cron = {
      create: () => ({ id: "cron_test" }),
      update: () => {
        throw new Error("database is locked");
      },
    };
    await runSelfUpdate(
      { dataDir: "/tmp/x", cron: cron as never, requestRestart: (reason) => restarts.push(reason), pacing: PACING },
      { message: "m", delaySeconds: 30, agentId: "a", gatewayId: "g", chatId: "c" },
    );
    await restarted(restarts);
    expect(restarts).toEqual(["update to v0.3.2"]);
    expect(lines()).toEqual([["could not arm the update's follow-up, so it fires at its parked time instead", "Error: database is locked"]]);
  });
});

/**
 * One restart for every way of asking — the dashboard, `nouride restart`, `/daemon-restart`, an agent's `--then`.
 *
 * What `modules/update/restart.ts` promises, each against the failure it replaced: the process ended 50 ms
 * after being asked, cutting a running turn and a background job in half; the wake-up was counted from the
 * request, not the restart; and a refused restart still left a wake-up behind, which fired ten seconds later
 * into a daemon that had never gone down.
 */

import { describe, expect, test } from "bun:test";
import type { AuditEntry } from "@/commons/audit.store.ts";
import { DaemonRestart, type DaemonRestartDeps } from "@/modules/update/restart.ts";
import { eventually } from "../helpers.ts";
import { sleep } from "../wait.ts";

interface Parked {
  id: string;
  name: string;
  at: number;
  payload: { kind: string; message?: string; text?: string };
}

function bench(overrides: Partial<DaemonRestartDeps> = {}) {
  const restarts: number[] = [];
  const parked: Parked[] = [];
  const armed: { id: string; at: number }[] = [];
  const audited: AuditEntry[] = [];
  let busy = false;
  let looks = 0;
  const restart = new DaemonRestart({
    requestRestart: () => void restarts.push(Date.now()),
    supervisor: () => ({ kind: "systemd", restartsOnExit: true }),
    busy: () => {
      looks += 1;
      return busy;
    },
    // It first looks after 5 ms and again every 5, not after 250 and every 2 s: the tests wait on what it did, not on it.
    pacing: { beatMs: 5, pollMs: 5 },
    cron: {
      create: (input) => {
        const id = `cron_${parked.length + 1}`;
        parked.push({ id, name: input.name, at: (input.trigger as { at: number }).at, payload: input.payload as Parked["payload"] });
        return { id } as never;
      },
      update: (id, patch) => {
        armed.push({ id, at: (patch.trigger as { at: number }).at });
        return { id } as never;
      },
    },
    audit: { record: (entry) => void audited.push(entry) },
    ...overrides,
  });
  /**
   * `looked(n)`: it has asked whether anything is running `n` more times — so "it is still waiting" is said from the
   * looks it took and turned down, not from a quiet interval that a slow machine could stretch past the next look.
   */
  const looked = (n: number) => {
    const target = looks + n;
    return eventually(() => looks >= target, 4_000, `${n} more looks`);
  };
  const restarted = () => eventually(() => restarts.length > 0, 4_000, "the restart");
  return { restart, restarts, parked, armed, audited, looked, restarted, setBusy: (value: boolean) => void (busy = value) };
}
const TURN = { kind: "turn" as const, agentId: "nouva", gatewayId: "telegram:nouva", chatId: "42", message: "check every gateway reconnected" };

describe("a restart", () => {
  test("is refused when nothing would start the daemon again — and leaves no wake-up behind", async () => {
    const b = bench({ supervisor: () => ({ kind: "none", restartsOnExit: false }) });
    const outcome = b.restart.request({ by: "cli", followUp: TURN });

    expect(outcome).toMatchObject({ ok: false, error: "nothing would restart this daemon", supervisor: "none" });
    expect({ parked: b.parked, restarts: b.restarts, audited: b.audited, waiting: b.restart.waiting }).toEqual({ parked: [], restarts: [], audited: [], waiting: false });
  });

  test("goes ahead without a supervisor when forced, which is a stop said on purpose", async () => {
    const b = bench({ supervisor: () => ({ kind: "none", restartsOnExit: false }) });
    expect(b.restart.request({ by: "cli", force: true })).toMatchObject({ ok: true, note: "restarting now: nothing will start it again" });
    await b.restarted();
    expect(b.restarts).toHaveLength(1);
  });

  test("waits while anything is running, and goes once nothing is", async () => {
    const b = bench();
    b.setBusy(true);
    expect(b.restart.request({ by: "admin" })).toMatchObject({ ok: true, waiting: true });

    await b.looked(3);
    expect(b.restarts).toEqual([]);
    b.setBusy(false);
    await b.restarted();
    expect(b.restarts).toHaveLength(1);
  });

  test("does not wait with `now`, whatever is running", async () => {
    const b = bench();
    b.setBusy(true);
    expect(b.restart.request({ by: "admin", now: true })).toMatchObject({ ok: true, waiting: false });
    await b.restarted();
    expect(b.restarts).toHaveLength(1);
  });

  test("waits for a background job however long it takes, says which, and `now` stops waiting for it", async () => {
    const jobs = [{ id: "job_1", command: "opencode run", startedAt: Date.now() - 5 * 60_000 }];
    let jobLooks = 0;
    const b = bench({
      jobs: () => {
        jobLooks += 1;
        return jobs;
      },
    });
    const outcome = b.restart.request({ by: "cli" });
    expect(outcome).toMatchObject({ ok: true, waitingFor: "the background job `opencode run` (5m)" });
    expect(outcome.ok ? outcome.note : "").toContain("however long that takes");

    // The request itself asked once; three more are looks the wait took.
    await eventually(() => jobLooks >= 4, 4_000, "three looks at a working job");
    expect(b.restarts).toEqual([]);
    expect(b.restart.request({ by: "cli", now: true })).toMatchObject({ ok: true, waiting: false, note: expect.stringContaining("restarting now") });
    await b.restarted();
    expect(b.restarts).toHaveLength(1);
  });

  test("is audited with who asked", () => {
    const b = bench();
    b.restart.request({ by: "telegram:nouva:814", followUp: { ...TURN, kind: "notice", text: "back" } });
    expect(b.audited).toEqual([
      {
        action: "daemon_restart",
        actor: "telegram:nouva:814",
        agentId: "nouva",
        gatewayId: "telegram:nouva",
        chatId: "42",
        details: { now: false, follow_up: "notice" },
      },
    ]);
  });
});

describe("its follow-up", () => {
  test("is written before anything happens, parked out of reach, and armed from the moment the process ends", async () => {
    const b = bench();
    b.setBusy(true);
    const asked = Date.now();
    const outcome = b.restart.request({ by: "cli", followUp: { ...TURN, delaySeconds: 30 } });

    expect(outcome).toMatchObject({ ok: true, followUpSeconds: 30 });
    expect(b.parked).toHaveLength(1);
    expect(b.parked[0]!.at).toBeGreaterThanOrEqual(asked + 800_000);
    expect(b.parked[0]!.payload.kind).toBe("agentTurn");
    expect(b.parked[0]!.payload.message).toContain("check every gateway reconnected");
    expect(b.parked[0]!.payload.message).toContain("it has restarted since");

    // A long turn finishes first: the thirty seconds start at the restart, not at the request. Three looks at a busy
    // daemon put the end of the turn at least a few milliseconds after the request; counted from the request, the
    // wake-up would land before thirty seconds after that.
    await b.looked(3);
    const freed = Date.now();
    expect(freed).toBeGreaterThan(asked);
    b.setBusy(false);
    await b.restarted();
    expect(b.armed).toEqual([{ id: "cron_1", at: expect.any(Number) }]);
    expect(b.armed[0]!.at).toBeGreaterThanOrEqual(freed + 30_000);
    expect(b.armed[0]!.at).toBeLessThanOrEqual(b.restarts[0]! + 30_000);
  });

  test("from a chat command is a line from the daemon, which needs no model to arrive", () => {
    const b = bench();
    b.restart.request({ by: "telegram:nouva:814", followUp: { ...TURN, kind: "notice", text: "✓ Restarted, I'm back." } });
    expect(b.parked[0]!.payload).toEqual({ kind: "systemEvent", text: "✓ Restarted, I'm back." });
  });

  test("is refused, before anything happens, when there is no scheduler to fire it", async () => {
    const b = bench({ cron: undefined });
    expect(b.restart.request({ by: "cli", followUp: TURN })).toMatchObject({ ok: false, error: expect.stringContaining("scheduler is off") });
    expect({ restarts: b.restarts, waiting: b.restart.waiting }).toEqual({ restarts: [], waiting: false });
  });

  test("of a second request joins the first: one restart, both armed, and its `now` ends the wait", async () => {
    const b = bench();
    b.setBusy(true);
    b.restart.request({ by: "cli", followUp: TURN });
    const second = b.restart.request({ by: "telegram:nouva:814", now: true, followUp: { ...TURN, kind: "notice", text: "back" } });
    expect(second).toMatchObject({ ok: true, waiting: false });

    await b.restarted();
    // One wait, so one restart: the second request joined the first rather than starting a wait of its own. A second
    // wait, with `now`, would restart on its first look — a timer set before this one, for a shorter beat, so it fires
    // first. Ordered by the timers, not by how long this sleeps.
    await sleep(10);
    expect(b.restarts).toHaveLength(1);
    expect(b.armed.map((entry) => entry.id)).toEqual(["cron_1", "cron_2"]);
  });
});

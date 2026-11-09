/**
 * Shutdown order.
 *
 * From a real log: `shutdown timed out — forcing exit` after the full 30 seconds, every time a turn was
 * parked on an approval. The cause was ordering — pending approvals were expired *after*
 * `pipeline.drain()`, so the drain waited on a turn waiting on a human who could no longer answer, because
 * the gateways had already stopped.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { drain } from "@/index.ts";
import { tempDir } from "../helpers.ts";
import { announceInterrupted } from "@/boot/interrupted.ts";
import { eventually, sleep } from "../wait.ts";

/** Records the order the steps run in, and lets `drain` resolve only if approvals let go of their waiters first. */
function harness() {
  const order: string[] = [];
  let releasedBeforeDrain = false;

  const approvals = {
    // Kept for the next process now, not expired — but whoever waits on one is still let go of first.
    handOver: () => {
      order.push("handOver");
      releasedBeforeDrain = true;
      return 1;
    },
    // Ordering matters as much as the call: the timers have to be dead before the database closes, or
    // one of them fires against a closed handle and throws where nobody is catching.
    shutDown: () => {
      order.push("approvals.shutDown");
    },
  };

  /**
   * Turns in flight when the signal arrives. Asked to pause, the dashboard turn stops at its next step;
   * the cron turn is in the middle of a long call and does not, so it is the one aborted.
   */
  const aborts: { turn: string; reason: unknown }[] = [];
  let paused = false;
  const inFlight = [
    {
      controller: { abort: (reason?: unknown) => aborts.push({ turn: "nouva:web-1", reason }) } as unknown as AbortController,
      agentId: "nouva",
      chatId: "web-1",
      gatewayId: "web:dashboard",
    },
    // A cron session, whose chat id no platform can deliver to. It must still be aborted.
    {
      controller: { abort: (reason?: unknown) => aborts.push({ turn: "nero:cron", reason }) } as unknown as AbortController,
      agentId: "nero",
      chatId: "cron:job-1",
      gatewayId: "web:dashboard",
    },
  ];

  const pipeline = {
    drain: async () => {
      order.push("drain");
      // The real failure, modelled: a parked turn only completes once its approval has been resolved.
      // Without that, this would never resolve — which is what the 30-second timeout was hiding.
      if (!releasedBeforeDrain) await new Promise(() => {});
    },
    pause: () => {
      order.push("pause");
      paused = true;
    },
    // The dashboard turn ends at its boundary once paused; an aborted turn ends once it closes.
    runningTurns: () =>
      inFlight.filter((turn) => {
        const key = `${turn.agentId}:${turn.chatId.startsWith("cron:") ? "cron" : turn.chatId}`;
        if (aborts.some((a) => a.turn === key)) {
          order.push(`closed ${key}`);
          return false;
        }
        return !(paused && key === "nouva:web-1");
      }),
  };

  const notified: { chatId: string; text: string }[] = [];
  const notifier = {
    toChat: async (target: { chatId: string }, text: string) => {
      order.push("notify");
      notified.push({ chatId: target.chatId, text });
      return true;
    },
  };

  const audit = {
    record: () => order.push("audit.record"),
    stop: () => order.push("audit.stop"),
  };

  const jobs = { killAll: () => (order.push("jobs.killAll"), 0) };
  const server = { stop: async () => void order.push("server.stop") };
  const lock = { release: () => order.push("lock.release") };
  const db = { close: () => order.push("db.close") };
  // A real interval, ticking fast, so "the sweeps were stopped" is observed rather than asserted
  // against a mock that cannot fail. The daemon's own sweeps are `unref`'d — which stops them
  // holding the process open and does nothing about them firing during the shutdown sequence, while
  // the database is closing under them.
  const sweeps = setInterval(() => order.push("sweep"), 1);
  const ctx = {
    gateways: new Map([["web:dashboard", { stop: async () => void order.push("gateway.stop") }]]),
    backgroundTimers: [sweeps],
    // A tight budget, so the wait for the turn that does not stop at a boundary fits in a test.
    config: { daemon: { shutdownTimeoutMs: 120 } },
  };

  return { order, ctx, db, pipeline, audit, approvals, jobs, server, lock, sweeps, notifier, notified, aborts };
}

describe("draining on shutdown", () => {
  test("stops the periodic sweeps before the database closes", async () => {
    const h = harness();

    await drain(
      h.ctx as never,
      h.db as never,
      h.pipeline as never,
      h.audit as never,
      h.approvals as never,
      h.jobs as never,
      h.server as never,
      h.lock,
    );

    const after = h.order.length;
    await sleep(25);
    clearInterval(h.sweeps); // harmless if drain already did it; fatal to the test run if it did not

    // Nothing ticked after shutdown finished. The retention sweep writes to the database, so one
    // firing here is the "Cannot use a closed database" crash arriving from a direction nobody is
    // watching.
    expect(h.order.slice(after)).toEqual([]);
  });


  test("says which step it is waiting on, for the line a stop that runs out of time logs", async () => {
    // Live (2026-11-01): a stop on the box sat its full 30 s with nothing logged after "shutting down".
    const h = harness();
    const progress = { step: "" };
    const scheduler = { stop: () => new Promise<void>(() => {}) };
    void drain(h.ctx as never, h.db as never, h.pipeline as never, h.audit as never, h.approvals as never, h.jobs as never, h.server as never, h.lock, scheduler, undefined, undefined, undefined, progress);
    await eventually(() => progress.step === "stopping the scheduler", 1_000, "the scheduler step");
    expect(progress.step).toBe("stopping the scheduler");
    // It never got as far as the gateways — which is what the live log showed.
    expect(h.order).not.toContain("gateway.stop");
    clearInterval(h.sweeps);
  });

  test("lets go of whoever waits on an approval before waiting for turns to finish — the question itself is kept", async () => {
    const h = harness();

    const outcome = await drain(
      h.ctx as never,
      h.db as never,
      h.pipeline as never,
      h.audit as never,
      h.approvals as never,
      h.jobs as never,
      h.server as never,
      h.lock,
    );

    expect(outcome).toBe("clean");
    expect(h.order.indexOf("handOver")).toBeLessThan(h.order.indexOf("drain"));
    // And the timers stop before the database does, which is the half that was missing.
    expect(h.order.indexOf("approvals.shutDown")).toBeLessThan(h.order.indexOf("db.close"));
  });

  test("nothing new starts mid-shutdown: the pipeline is paused first, the gateways stop after", async () => {
    // Paused first, not disconnected first: the gateways have to stay up while the turns in flight close
    // and say what they did. Nothing new starts meanwhile — a message arriving now waits in the inbox for
    // the next boot (`Pipeline.pause`).
    const h = harness();
    await drain(
      h.ctx as never,
      h.db as never,
      h.pipeline as never,
      h.audit as never,
      h.approvals as never,
      h.jobs as never,
      h.server as never,
      h.lock,
    );

    expect(h.order[0]).toBe("pause");
    expect(h.order.indexOf("pause")).toBeLessThan(h.order.indexOf("gateway.stop"));
  });

  test("the database closes last, after the final audit write", async () => {
    const h = harness();
    await drain(
      h.ctx as never,
      h.db as never,
      h.pipeline as never,
      h.audit as never,
      h.approvals as never,
      h.jobs as never,
      h.server as never,
      h.lock,
    );

    // A write after the close is the `Cannot use a closed database` class of bug this ordering prevents.
    expect(h.order.indexOf("audit.record")).toBeLessThan(h.order.indexOf("db.close"));
    expect(h.order.at(-1)).toBe("db.close");
  });

  /**
   * The hosted LLM gateway writes what it holds — buffered usage rows, a debounced state file — when it stops. The
   * process ends right after `drain` returns, so a stop that is not awaited loses them.
   */
  test("the hosted gateway's stop is waited for: what it holds is written before the shutdown ends", async () => {
    const h = harness();
    const nougate = {
      stop: async () => {
        h.order.push("nougate.stop");
        await sleep(5);
        h.order.push("nougate.written");
      },
    };
    await drain(h.ctx as never, h.db as never, h.pipeline as never, h.audit as never, h.approvals as never, h.jobs as never, h.server as never, h.lock, undefined, nougate);

    expect(h.order.indexOf("drain")).toBeLessThan(h.order.indexOf("nougate.stop"));
    expect(h.order.indexOf("nougate.written")).toBeGreaterThan(-1);
    expect(h.order.indexOf("nougate.written")).toBeLessThan(h.order.indexOf("db.close"));
  });

  test("background jobs are stopped before the database goes", async () => {
    const h = harness();
    await drain(
      h.ctx as never,
      h.db as never,
      h.pipeline as never,
      h.audit as never,
      h.approvals as never,
      h.jobs as never,
      h.server as never,
      h.lock,
    );

    // `killAll` marks the store closed, so a child exiting later cannot write to a closed handle.
    expect(h.order.indexOf("jobs.killAll")).toBeLessThan(h.order.indexOf("db.close"));
  });

  test("a clean stop says so, once the database has closed — the next boot may skip its check", async () => {
    const h = harness();
    const dir = tempDir("clean-stop");
    const marker = join(dir, "clean-shutdown.json");
    Object.assign(h.ctx.config.daemon, { dataDir: dir });
    Object.assign(h.ctx, { integrity: { ok: true, checkedAt: 1 } });
    let markedBeforeClose = true;
    h.db.close = () => {
      markedBeforeClose = existsSync(marker);
      return h.order.push("db.close");
    };

    try {
      await drain(h.ctx as never, h.db as never, h.pipeline as never, h.audit as never, h.approvals as never, h.jobs as never, h.server as never, h.lock);

      expect(markedBeforeClose).toBe(false);
      expect(existsSync(marker)).toBe(true);
    } finally {
      removePath(dir);
    }
  });
});

/**
 * The notice a turn in flight gets, and the one thing about it that is not negotiable: it goes out
 * **before the gateways stop**.
 *
 * Reported as "progress agent jadi nyangkut selamanya" — stop the daemon mid-`web_search` and the
 * person waiting is told nothing, ever. The reason it has to be first is in `resilience.ts`: after a
 * gateway's `stop()` its status is `disconnected`, and `send()` on a disconnected gateway buffers
 * into a 100-entry in-memory ring with no table behind it. A message written one line later is a
 * message that dies with the process, and it dies looking like it was sent.
 */
describe("stopping the turns in flight", () => {
  const run = (h: ReturnType<typeof harness>) =>
    drain(h.ctx as never, h.db as never, h.pipeline as never, h.audit as never, h.approvals as never, h.jobs as never, h.server as never, h.lock);

  test("they are stopped, and closed, before any gateway is", async () => {
    const h = harness();
    await run(h);
    // The assertion the whole feature rests on: a turn closes by telling its chat what it did, and after
    // the gateways stop nothing can be told — the message would land in a buffer that dies with the process.
    expect(h.order.indexOf("pause")).toBeLessThan(h.order.indexOf("gateway.stop"));
    expect(h.order.indexOf("closed nero:cron")).toBeLessThan(h.order.indexOf("gateway.stop"));
    // And before the drain, which only waits.
    expect(h.order.indexOf("pause")).toBeLessThan(h.order.indexOf("drain"));
  });

  test("a turn that stops at its next step is not aborted; one still running when the wait ends is, as a restart", async () => {
    const h = harness();
    await run(h);
    expect(h.aborts).toEqual([{ turn: "nero:cron", reason: "daemon-restarting" }]);
  });

  test("the daemon says nothing of its own: each turn tells its chat what it had done", async () => {
    const h = harness();
    expect(await run(h)).toBe("clean");
    expect(h.notified).toEqual([]);
  });
});

/**
 * The other half: a daemon that was killed rather than asked to stop.
 *
 * `kill -9`, the OOM killer, a lost power supply. No handler runs and nothing can be sent, so the
 * only honest moment is the next boot — which is why `interruptOrphaned` reports the conversations
 * it corrected instead of only counting them.
 */
describe("reporting turns the last process did not finish", () => {
  test("one message per conversation, however many turns it held", async () => {
    const sent: { chatId: string; text: string }[] = [];
    const notifier = {
      toChat: async (target: { chatId: string }, text: string) => {
        sent.push({ chatId: target.chatId, text });
        return true;
      },
    };

    await announceInterrupted({
      conversations: [
        { gatewayId: "telegram:main", chatId: "-100123" },
        // The same room, a second agent. One room, one message.
        { gatewayId: "telegram:main", chatId: "-100123" },
        { gatewayId: "discord:nero", chatId: "9911" },
        // And a scheduled job, which has no address.
        { gatewayId: "telegram:main", chatId: "cron:nightly" },
      ],
      notifier,
    });

    expect(sent.map((s) => s.chatId).sort()).toEqual(["-100123", "9911"]);
    // Past tense and an instruction: by the time this is read, the daemon is up again.
    expect(sent[0]!.text).toContain("stopped unexpectedly");
    expect(sent[0]!.text).toContain("send it again");
  });

  test("nothing found means nothing sent", async () => {
    let calls = 0;
    const told = await announceInterrupted({
      conversations: [],
      notifier: { toChat: async () => (calls += 1, true) },
    });

    expect(told).toBe(0);
    expect(calls).toBe(0);
  });

  test("a gateway that refuses the message does not take the boot down", async () => {
    // Best-effort by construction: this runs while the daemon is coming up, and a platform that is
    // unreachable at that moment must not be able to stop it.
    const told = await announceInterrupted({
      conversations: [{ gatewayId: "telegram:main", chatId: "-100123" }],
      notifier: {
        toChat: async () => {
          throw new Error("telegram is having a day");
        },
      },
    });

    expect(told).toBe(1);
  });
});

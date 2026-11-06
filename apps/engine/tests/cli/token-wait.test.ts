/**
 * No control token yet: a daemon of this install that is starting is waited for, and anything else is said as what it
 * is (`cli-no-token-while-booting`).
 *
 * Found in 0.7.10's end-to-end run: `/health` answered — `starting` — and the CLI, finding no token, said to start the
 * daemon once. The token is written when the control plane starts, near the end of boot, so on a first start that
 * window is the whole boot. Each case hands `awaitControlToken` a boot of its own: one that gets there, one that never
 * does, one that dies on the way, and the daemons that are not starting at all.
 */

import { describe, expect, test } from "bun:test";
import { awaitControlToken, type TokenWaitDeps } from "@/cli/token-wait.ts";
import type { Seen } from "@/cli/wait-back.ts";

const MINE = "aaaaaaaaaaaa";
const starting = (phase: string, install = MINE): Seen => ({ reachable: true, status: "starting", phase, install });
const up: Seen = { reachable: true, status: "ok", install: MINE };
const gone: Seen = { reachable: false };

/**
 * A boot, as `/health` tells it, one look at a time — the last repeating — and the look at which the token appears
 * (never, when absent). A fake clock that each sleep moves on.
 */
function boot(looks: Seen[], tokenAtLook?: number, overrides: Partial<TokenWaitDeps> = {}) {
  let at = 0;
  let clock = 0;
  let slept = 0;
  const said: string[] = [];
  const deps: TokenWaitDeps = {
    look: async () => {
      // A wait that never ends would spin on this fake clock without yielding, and hang the run rather than fail it.
      if (at > 10_000) throw new Error("looked at /health for ever");
      return looks[Math.min(at++, looks.length - 1)]!;
    },
    tokenExists: async () => tokenAtLook !== undefined && at >= tokenAtLook,
    say: (line) => void said.push(line),
    install: MINE,
    path: "/srv/nouride/.nouride/data/.control-token",
    baseUrl: "http://localhost:18254",
    controlEnabled: true,
    startHint: () => "Start it: `nouride start`.",
    now: () => clock,
    sleep: async (ms) => {
      slept += 1;
      clock += ms;
    },
    ...overrides,
  };
  return { deps, said, slept: () => slept, looks: () => at };
}

describe("a daemon of this install that is starting", () => {
  test("is waited for until its token is there, each step it is on said once", async () => {
    const run = boot([starting("loading agents"), starting("loading agents"), starting("starting the control plane"), up], 4);
    expect(await awaitControlToken(run.deps)).toBeNull();
    expect(run.said).toEqual([
      "nouride is starting (loading agents); waiting for its control token",
      "nouride is starting (starting the control plane); waiting for its control token",
    ]);
  });

  test("is not waited on for ever: a boot that does not get there is said to be still starting", async () => {
    const run = boot([starting("connecting MCP servers")], undefined, { timeoutMs: 5_000 });
    const why = await awaitControlToken(run.deps);
    expect(why?.message).toBe(
      "The daemon at http://localhost:18254 is still starting (connecting MCP servers), and has not written its control token yet.",
    );
    expect(why?.hint).toContain("Try again in a moment");
    // It looked more than once — this is a wait, not a single look — and said the step once.
    expect(run.slept()).toBeGreaterThan(5);
    expect(run.said).toHaveLength(1);
  });

  test("one that stops on the way is said to have stopped, with how to start it here", async () => {
    const why = await awaitControlToken(boot([starting("checking the database"), gone]).deps);
    expect(why?.message).toBe("The daemon at http://localhost:18254 stopped while it was starting, before it wrote its control token.");
    expect(why?.hint).toContain("Start it: `nouride start`.");
  });

  test("one that finishes starting and wrote none has its control API off — said, when the config says so", async () => {
    const why = await awaitControlToken(boot([starting("starting the control plane"), up], undefined, { controlEnabled: false }).deps);
    expect(why?.message).toContain("[control] enabled = false");
  });
});

describe("no daemon of this install starting", () => {
  test("nothing answers: none has run here — said with how to start it, and nothing waited for", async () => {
    const run = boot([gone]);
    const why = await awaitControlToken(run.deps);
    expect(why).toEqual({
      message: "No control token found.",
      hint:
        "Expected /srv/nouride/.nouride/data/.control-token, which the daemon writes the first time it starts. Start it: `nouride start`. " +
        "For a daemon elsewhere, set $NOURIDE_URL and $NOURIDE_TOKEN.",
    });
    expect(run.slept()).toBe(0);
    expect(run.said).toEqual([]);
  });

  test("another install's daemon starting on the port is not waited for — its token is not this install's to write", async () => {
    const run = boot([starting("loading agents", "bbbbbbbbbbbb")]);
    const why = await awaitControlToken(run.deps);
    expect(why?.hint).toContain("is another install's daemon");
    expect(run.slept()).toBe(0);
  });

  test("this install's daemon up with no token this user can see: a permission, or a token deleted since it started", async () => {
    const why = await awaitControlToken(boot([up]).deps);
    expect(why?.message).toBe("The daemon at http://localhost:18254 is up, and there is no control token at /srv/nouride/.nouride/data/.control-token that this user can see.");
    expect(why?.hint).toContain("sudo usermod -aG nouride");
    expect(why?.hint).toContain("a restart writes a new one");
  });

  test("a token that appeared between the first look and this one is used", async () => {
    expect(await awaitControlToken(boot([up], 1).deps)).toBeNull();
  });
});

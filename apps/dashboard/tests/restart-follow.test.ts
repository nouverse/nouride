/**
 * Following a restart back (`commons/lib/restart.ts`, config-restart-ux): the page holds its queries while the daemon
 * is away, waits for the session's own answer, then refetches in place — or reloads into a build that changed — and a
 * restart nobody here asked for never reloads the page out from under whoever is typing in it.
 *
 * Driven through `follow` with a scripted daemon: each look at `/health` is the next answer in a list.
 */

import { afterAll, describe, expect, test } from "bun:test";
import type { HealthPayload } from "@/commons/lib/api";
import { entryScript, follow, following, markRestartPending, restartPending, restartState, type RestartIo } from "@/commons/lib/restart";
import { POLL_MS } from "@/commons/lib/restart-watch";

const health = (uptime: number, status: HealthPayload["status"] = "ok", version = "0.7.11"): HealthPayload => ({ status, uptime, version, agents: 1, gateways: {} });

/** A daemon that answers `/health` from `looks` in turn, `/auth/me` after `meAfter` asks, and serves `served`. */
function scripted(input: { looks: (HealthPayload | null)[]; served?: string; page?: string; meAfter?: number }) {
  const log: string[] = [];
  let at = 1_000_000;
  let asked = 0;
  const looks = [...input.looks];
  const io: RestartIo = {
    health: async () => {
      const next = looks.length > 1 ? looks.shift()! : looks[0]!;
      log.push(`health:${next ? `${next.status}/${next.uptime}` : "none"}`);
      return next;
    },
    answersForSession: async () => {
      asked += 1;
      const answers = asked > (input.meAfter ?? 0);
      log.push(`me:${answers ? "answers" : "not yet"}`);
      return answers;
    },
    servedBuild: async () => input.served ?? "/dashboard/assets/index-aaaa.js",
    pageBuild: () => input.page ?? "/dashboard/assets/index-aaaa.js",
    setOnline: (online) => log.push(online ? "queries run" : "queries held"),
    refetchAll: () => log.push("refetch"),
    reload: () => log.push("reload"),
    now: () => at,
    sleep: async (ms) => {
      at += Math.max(ms, POLL_MS);
    },
  };
  return { io, log };
}

/**
 * The follower is the module's, and bun runs every test file in one process: these tests end it rolled back, and a file
 * after this one — the mount test, on Linux, where the order differs — met a page with a rollback still on it. An outage
 * that comes back leaves it idle, as a tab with nothing to follow is.
 */
afterAll(async () => {
  await follow(scripted({ looks: [health(9_000)] }).io, { kind: "outage", before: null, held: true });
  expect(restartState().phase).toBe("idle");
});

describe("a restart asked for here", () => {
  test("holds the page's queries once the daemon is away, waits for the session's answer, then refetches in place", async () => {
    const { io, log } = scripted({ looks: [health(3_600), null, health(2, "starting"), health(3)], meAfter: 1 });
    await follow(io, { kind: "restart", before: 3_600, note: "waiting for 1 turn" });
    // The old process still answering is waiting, and holds nothing: the page keeps working while it finishes.
    expect(log.indexOf("queries held")).toBeGreaterThan(log.indexOf("health:ok/3600"));
    // Nothing is refetched into a daemon that is starting, or before the session answers.
    expect(log.slice(log.indexOf("health:ok/3"))).toEqual(["health:ok/3", "me:not yet", "me:answers", "queries run", "refetch", "queries run"]);
    expect(log).not.toContain("reload");
  });

  test("going down at once holds the queries from the start, and says restarting — not waiting for work", async () => {
    const { io, log } = scripted({ looks: [null, health(1)] });
    const said: string[] = [];
    const look = io.health;
    io.health = async () => {
      said.push(restartState().phase);
      return await look();
    };
    await follow(io, { kind: "restart", before: 50, held: true });
    expect(said[0]).toBe("restarting");
    expect(log[0]).toBe("queries held");
    expect(log).toContain("refetch");
  });

  test("back on another build reloads into it — and refetches nothing into the page that is going", async () => {
    const { io, log } = scripted({ looks: [null, health(1)], served: "/dashboard/assets/index-bbbb.js" });
    await follow(io, { kind: "restart", before: 50 });
    expect(log.at(-1)).toBe("reload");
    expect(log).not.toContain("refetch");
    // Held to the end: a query let loose now would ask the new daemon with the old code.
    expect(log.filter((entry) => entry.startsWith("queries")).at(-1)).toBe("queries held");
  });

  test("a restart applies every save that waited for one; a blip applies none", async () => {
    markRestartPending("Web search");
    await follow(scripted({ looks: [health(9_000)] }).io, { kind: "outage", before: null, held: true });
    expect(restartPending()).toEqual(["Web search"]);
    await follow(scripted({ looks: [null, health(1)] }).io, { kind: "restart", before: 50 });
    expect(restartPending()).toEqual([]);
  });
});

describe("a restart nobody here asked for", () => {
  test("a blip — the same process answering again — refetches and holds nothing back", async () => {
    const { io, log } = scripted({ looks: [health(9_000)] });
    await follow(io, { kind: "outage", before: null, held: true });
    expect(log).toEqual(["queries held", "health:ok/9000", "me:answers", "queries run", "refetch", "queries run"]);
  });

  test("back on another build does not reload: whoever is typing here did not ask for it", async () => {
    const { io, log } = scripted({ looks: [null, null, health(1)], served: "/dashboard/assets/index-bbbb.js" });
    await follow(io, { kind: "outage", before: null, held: true });
    expect(log).not.toContain("reload");
    expect(log).toContain("refetch");
  });
});

describe("an update's restart", () => {
  test("back on the version installed reloads, whatever the build says", async () => {
    const { io, log } = scripted({ looks: [health(3_600, "ok", "0.7.10"), null, health(2, "ok", "0.7.11")] });
    await follow(io, { kind: "install", before: 3_600, expected: "v0.7.11", note: "installed" });
    expect(log.at(-1)).toBe("reload");
  });

  test("back on another version is a rollback: said, the page kept, its queries let go", async () => {
    const { io, log } = scripted({ looks: [null, health(2, "ok", "0.7.10")] });
    await follow(io, { kind: "install", before: 3_600, expected: "v0.7.11", note: "installed" });
    expect(log).not.toContain("reload");
    expect(log.slice(-2)).toEqual(["refetch", "queries run"]);
  });
});

/**
 * What starting another follow waits for. It was any phase but idle, and a rollback's and a stuck follow's phase stay to
 * be said: the next outage in that tab went unfollowed — no strip, nothing held — and Restart did nothing. Found when the
 * test above ran before the mount test on Linux, which then waited for a strip that never came.
 */
describe("what counts as following", () => {
  test("a follow while it runs; not one that ended in a rollback or stuck, though both are still said", async () => {
    const during: boolean[] = [];
    const rolledBack = scripted({ looks: [null, health(2, "ok", "0.7.10")] });
    const look = rolledBack.io.health;
    rolledBack.io.health = async () => {
      during.push(following());
      return look();
    };
    await follow(rolledBack.io, { kind: "install", before: 3_600, expected: "v0.7.11", note: "installed" });
    expect(during.every(Boolean)).toBe(true);
    expect({ phase: restartState().phase, following: following() }).toEqual({ phase: "rolled-back", following: false });

    // Nothing answers for longer than a restart takes: said, and over. The first look at the clock is when it began.
    const { io } = scripted({ looks: [null] });
    const started = io.now();
    let looked = 0;
    io.now = () => (looked++ === 0 ? started : started + 13 * 60 * 60_000);
    await follow(io, { kind: "restart", before: 50 });
    expect({ phase: restartState().phase, following: following() }).toEqual({ phase: "stuck", following: false });
  });
});

describe("which build a page is", () => {
  test("is the hashed module script index.html loads, not the theme script before it", () => {
    const html = `<!doctype html><html><head><script src="/dashboard/theme-boot.js"></script>
      <script type="module" crossorigin src="/dashboard/assets/index-Ab12Cd.js"></script>
      <link rel="stylesheet" href="/dashboard/assets/index-Ef34.css"></head></html>`;
    expect(entryScript(html)).toBe("/dashboard/assets/index-Ab12Cd.js");
    expect(entryScript("<html><body>no scripts</body></html>")).toBeNull();
  });
});

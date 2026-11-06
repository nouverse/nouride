/**
 * Following a restart, one look at a time (`commons/lib/restart-watch.ts`) — for Overview's Restart and for the update
 * page's card, which had its own copy from before the daemon waited for running work: after 45 s of the old version
 * still answering, it said the daemon was not answering and pointed at `systemctl`.
 */

import { describe, expect, test } from "bun:test";
import type { HealthPayload } from "@/commons/lib/api";
import { BOOT_PATIENCE_MS, lookAgain, lookAtInstall, type RestartWatch } from "@/commons/lib/restart-watch";

const health = (version: string, uptime: number, status: HealthPayload["status"] = "ok"): HealthPayload => ({
  status,
  uptime,
  version,
  agents: 1,
  gateways: {},
});
const fresh: RestartWatch = { before: 3_600, awaySince: null };
const T = 1_000_000;

describe("an update's restart", () => {
  test("the old version still answering a minute on is waiting for its work — not a daemon that does not answer", () => {
    expect(lookAtInstall(fresh, health("0.7.6", 3_660), "v0.7.7", T + 60_000).phase).toBe("waiting");
    expect(lookAtInstall(fresh, health("0.7.6", 3_600 + 6 * 3_600), "v0.7.7", T + 6 * 3_600_000).phase).toBe("waiting");
  });

  test("nothing answering is restarting, and stuck only after longer than a shutdown and a boot take", () => {
    const away = lookAtInstall(fresh, null, "v0.7.7", T);
    expect(away.phase).toBe("restarting");
    expect(lookAtInstall(away.watch, null, "v0.7.7", T + 30_000).phase).toBe("restarting");
    expect(lookAtInstall(away.watch, null, "v0.7.7", T + BOOT_PATIENCE_MS + 1).phase).toBe("stuck");
  });

  test("the version installed, done starting, is back — whatever the uptime, and even unseen going down", () => {
    expect(lookAtInstall(fresh, health("0.7.7", 5), "v0.7.7", T).phase).toBe("back");
    expect(lookAtInstall({ before: null, awaySince: null }, health("0.7.7", 9_999), "v0.7.7", T).phase).toBe("back");
    // Answering while it boots is not back yet: every route but /health is a 503 until it is done.
    expect(lookAtInstall(fresh, health("0.7.7", 1, "starting"), "v0.7.7", T).phase).toBe("restarting");
  });

  test("a new process on another version is the install not taking — the one it replaced came back", () => {
    const away = lookAtInstall(fresh, null, "v0.7.7", T);
    expect(lookAtInstall(away.watch, health("0.7.6", 4), "v0.7.7", T + 20_000).phase).toBe("rolled-back");
    expect(lookAtInstall(fresh, health("0.7.6", 4), "v0.7.7", T).phase).toBe("rolled-back");
  });
});

describe("Overview's restart", () => {
  test("the same process is waiting, a silence then an answer is back", () => {
    expect(lookAgain(fresh, health("0.7.7", 3_700), T).phase).toBe("waiting");
    const away = lookAgain(fresh, null, T);
    expect(away.watch.awaySince).toBe(T);
    expect(lookAgain(away.watch, health("0.7.7", 2), T + 10_000).phase).toBe("back");
  });
});

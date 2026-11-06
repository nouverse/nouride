/**
 * `nouride update` and the update track (0.8.18): it says which track the install follows and what the other offers,
 * and `--track` sets it before checking, for an install nobody opens the dashboard of.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@/cli/client.ts";
import { update } from "@/cli/commands/update.ts";

const INSTALL = { version: "1.0.5", edition: "basic", installDir: "/srv/nouride", supervisor: "systemd", compiled: true, platform: "linux", arch: "x64", musl: false };

function daemon(check: Record<string, unknown>): Client & { posted: { path: string; body: unknown }[]; lines: string[] } {
  const posted: { path: string; body: unknown }[] = [];
  const lines: string[] = [];
  spyOn(console, "log").mockImplementation((line?: unknown) => {
    lines.push(String(line ?? ""));
  });
  return {
    posted,
    lines,
    get: async <T>() => ({ supported: true, install: INSTALL, check }) as T,
    post: async <T>(path: string, body?: unknown) => {
      posted.push({ path, body });
      return { ok: true, track: (body as { track: string }).track } as T;
    },
  } as unknown as Client & { posted: { path: string; body: unknown }[]; lines: string[] };
}

afterEach(() => {
  (console.log as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("nouride update and its track", () => {
  test("on lts, up to date on its line: names the track and the newer line it does not move to", async () => {
    const client = daemon({ current: "1.0.7", latest: "1.0.7", newer: false, track: "lts", publishedAt: null, notesUrl: null, otherTrack: { track: "latest", tag: "v1.1.0" } });
    await update(client, []);
    const said = plain(client.lines);
    expect(said).toContain("track        lts");
    expect(said).toContain("v1.1.0, new, is on the latest track; this install follows lts and stays on its line (`nouride update --track latest` moves it on)");
  });

  test("on latest, with a newer release: says the long-term line's newest beside it", async () => {
    const client = daemon({
      current: "1.0.5",
      latest: "v1.1.0",
      newer: true,
      track: "latest",
      publishedAt: null,
      notesUrl: null,
      otherTrack: { track: "lts", tag: "v1.0.7" },
      plan: { can: true, from: "1.0.5", to: "v1.1.0", artifact: "nouride-linux-x64" },
    });
    await update(client, []);
    const said = plain(client.lines);
    expect(said).toContain("1.0.5 → v1.1.0");
    expect(said).toContain("v1.0.7 is the long-term line's newest (`nouride update --track lts` stays on that line)");
  });

  test("--track sets the track first, then checks", async () => {
    const client = daemon({ current: "1.0.5", latest: "v1.0.7", newer: true, track: "lts", publishedAt: null, notesUrl: null, plan: { can: true, from: "1.0.5", to: "v1.0.7", artifact: "nouride-linux-x64" } });
    await update(client, ["--track", "lts"]);
    expect(client.posted).toEqual([{ path: "/update/track", body: { track: "lts" } }]);
    expect(plain(client.lines)).toContain("this install follows the lts track");
  });

  test("a daemon before 0.8.18 sends no track, and nothing is said about one", async () => {
    const client = daemon({ current: "0.8.17", latest: "0.8.17", newer: false, publishedAt: null, notesUrl: null });
    await update(client, []);
    expect(plain(client.lines)).not.toContain("track");
  });
});

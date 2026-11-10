/**
 * `nouride update` when the newest release needs a newer version first (the upgrade floor).
 *
 * The check offers the stepping stone as `latest`; the command says why it is not the newest release, `--start` takes
 * the stone and never the release that needs it, and with no stone it does not call the install up to date.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@nouride/cli-kit";
import { update } from "../src/commands/update.ts";

const INSTALL = {
  version: "0.7.11",
  edition: "basic",
  installDir: "/srv/nouride",
  supervisor: "systemd",
  compiled: true,
  platform: "linux",
  arch: "arm64",
  musl: false,
};
const FLOOR = { release: "v0.8.0", needs: "0.7.14", message: "update to 0.7.14 first; 0.8.0 needs it" };

function daemon(check: Record<string, unknown>): Client & { bodies: unknown[]; lines: string[] } {
  const bodies: unknown[] = [];
  const lines: string[] = [];
  spyOn(console, "log").mockImplementation((line?: unknown) => {
    lines.push(String(line ?? ""));
  });
  return {
    bodies,
    lines,
    get: async <T>() => ({ supported: true, install: INSTALL, check }) as T,
    post: async <T>(_path: string, body?: unknown) => {
      bodies.push(body);
      return { note: "swapped", to: "v0.7.14" } as T;
    },
  } as unknown as Client & { bodies: unknown[]; lines: string[] };
}

afterEach(() => {
  (console.log as unknown as { mockRestore?: () => void }).mockRestore?.();
});

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("nouride update, below a release's floor", () => {
  const STONE = {
    current: "0.7.11",
    latest: "v0.7.14",
    newer: true,
    publishedAt: null,
    notesUrl: null,
    latestElsewhere: "v0.8.0",
    floor: FLOOR,
    plan: { can: true, from: "0.7.11", to: "v0.7.14", artifact: "nouride-linux-arm64" },
  };

  test("offers the stepping stone and says why", async () => {
    const client = daemon(STONE);
    await update(client, []);
    const out = plain(client.lines);
    expect(out).toContain("0.7.11 → v0.7.14");
    expect(out).toContain("update to 0.7.14 first; 0.8.0 needs it");
  });

  test("with no stone on the channel, says what to do rather than that it is up to date", async () => {
    const message = "update to 0.7.14 first; 0.8.1 needs it, and no release this install can take now reaches it — install 0.7.14 by hand, start it once, then update";
    const client = daemon({ current: "0.7.11", latest: "0.7.11", newer: false, publishedAt: null, notesUrl: null, floor: { ...FLOOR, release: "v0.8.1", message } });
    await update(client, []);
    const out = plain(client.lines);
    expect(out).toContain(message);
    expect(out).not.toContain("up to date");
  });
});

/** A Pro licence past its year of updates: not "up to date" — newer releases exist — and not an outage. */
describe("nouride update, past a licence's year of updates", () => {
  test("says the updates ended and that the install keeps working", async () => {
    const notice =
      "this licence's updates ended on 2027-10-27 — Nouride keeps working as it is, and releases marked critical still come; newer releases come with a renewal";
    const client = daemon({ current: "0.8.4", latest: "0.8.4", newer: false, publishedAt: null, notesUrl: null, notice });
    await update(client, []);
    const out = plain(client.lines);
    expect(out).toContain(`! ${notice}.`);
    expect(out).not.toContain("up to date");
  });
});

/**
 * The scratchpad sweep — the half of the bargain the operator never sees.
 *
 * The exemption in `@nouride/policy` is what lets an agent delete inside `.scratchpad/` without an
 * approval nobody can pre-grant; this is what stops that directory becoming a place files go to live
 * forever instead. If the sweep is wrong, the feature is a disk leak with a friendly name.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateWorkspace, scratchpadFor, sharedWorkspace, sweepScratchpads } from "@nouride/persona";
import { runAgentCommandsThrough } from "@nouride/runtime";

let root: string;
const NOW = Date.UTC(2026, 7, 25, 12, 0, 0);
const daysAgo = (days: number) => (NOW - days * 24 * 60 * 60_000) / 1000;

/** A file in `agent`'s scratchpad, last touched `days` ago. */
function place(agent: string, name: string, days: number): string {
  const dir = scratchpadFor(privateWorkspace(root, agent));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "x");
  utimesSync(path, daysAgo(days), daysAgo(days));
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nouride-scratchpad-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sweepScratchpads", () => {
  test("removes what is older than the window and keeps the rest", async () => {
    const stale = place("nouva", "screen.png", 5);
    const fresh = place("nouva", "report.pdf", 1);

    expect(await sweepScratchpads(root, 3, NOW)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("every agent, not just the first one found", async () => {
    place("nouva", "a.png", 9);
    place("nox", "b.png", 9);

    expect(await sweepScratchpads(root, 3, NOW)).toBe(2);
  });

  test("a stale directory goes as a unit", async () => {
    const dir = join(scratchpadFor(privateWorkspace(root, "nouva")), "build");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "out.js"), "x");
    utimesSync(dir, daysAgo(9), daysAgo(9));

    expect(await sweepScratchpads(root, 3, NOW)).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  test("0 keeps everything — the off position, not `delete all`", async () => {
    const old = place("nouva", "ancient.png", 400);

    expect(await sweepScratchpads(root, 0, NOW)).toBe(0);
    expect(existsSync(old)).toBe(true);
  });

  test("nothing outside the scratchpad is touched, however old it is", async () => {
    // The private directory is where drafts and handover notes live. A sweep that walked one level
    // higher would delete an agent's work while it was still being written.
    const own = privateWorkspace(root, "nouva");
    mkdirSync(own, { recursive: true });
    const draft = join(own, "NOTES.md");
    writeFileSync(draft, "x");
    utimesSync(draft, daysAgo(400), daysAgo(400));
    // And the scratchpad exists, so the walk definitely reaches this agent.
    place("nouva", "throwaway.png", 400);

    expect(await sweepScratchpads(root, 3, NOW)).toBe(1);
    expect(existsSync(draft)).toBe(true);
  });

  test("each agent's entries are removed as that agent — where it is its own user, they are its files", async () => {
    // A stand-in for the helper's client: it says whose command it runs, then runs it.
    const said = join(root, "ran-as.log");
    runAgentCommandsThrough({ prefix: (agent) => ["sh", "-c", `printf '%s\\n' "${agent}" >> "${said}"; exec "$@"`, "sh"], put: () => [] });
    try {
      const a = place("nouva", "a.png", 9);
      const b = place("nox", "b.png", 9);
      expect(await sweepScratchpads(root, 3, NOW)).toBe(2);
      expect(existsSync(a) || existsSync(b)).toBe(false);
      expect(readFileSync(said, "utf8").trim().split("\n").sort()).toEqual(["nouva", "nox"]);
    } finally {
      runAgentCommandsThrough(null);
    }
  });

  test("an install with no workspace on disk yet is not an error", async () => {
    expect(await sweepScratchpads(join(root, "never-created"), 3, NOW)).toBe(0);
  });

  test("the scratchpad sits inside the private directory, not beside it", async () => {
    // Load-bearing: it is why `read`, `write` and `send_file` reach a scratchpad file with no new
    // sandbox root, and why no other agent can see what is in there.
    expect(scratchpadFor(privateWorkspace(root, "nouva")).startsWith(privateWorkspace(root, "nouva"))).toBe(true);
    expect(scratchpadFor(privateWorkspace(root, "nouva")).startsWith(sharedWorkspace(root))).toBe(false);
  });
});

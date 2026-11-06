/**
 * What the daemon's routes answer, written down for the dashboard's mount test to answer with
 * (`apps/dashboard/tests/fixtures/wire.json`) — `dash-practice-wire-contract-unchecked`.
 *
 * The mount test's fixtures were written by hand from the dashboard's own copies of the wire types, so a field renamed or
 * retyped in a route's answer left the copy, the fixture and every check agreeing, and the page failed only in a browser.
 * The answers in that file are the routes' own, asked of an install wired as the daemon wires it
 * (`dashboard-wire/install.ts`): every route the mount test answers by default, but the update check, whose plugin
 * and release channel the engine's tests cannot reach. They are compared here, whole; a route that answers otherwise
 * fails until the file is written again (`WRITE_WIRE_FIXTURES=1 bun test <this file>`), and the mount test then renders
 * the new answer. A fixture this test no longer writes fails it too.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wireAnswers } from "./dashboard-wire/install.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "dashboard", "tests", "fixtures", "wire.json");

describe("the dashboard's mount fixtures are the routes' own answers", () => {
  test("every route the mount test answers, as the routes answer it", async () => {
    const now = await wireAnswers();
    if (process.env.WRITE_WIRE_FIXTURES === "1") writeFileSync(FIXTURES, `${JSON.stringify(now, null, 2)}\n`);
    const kept = JSON.parse(readFileSync(FIXTURES, "utf8")) as Record<string, unknown>;
    // Every fixture is one this test writes — the mount test answers from nothing else in the file.
    expect(Object.keys(kept).sort()).toEqual(Object.keys(now).sort());
    expect(kept).toEqual(now);
  }, 30_000);
});

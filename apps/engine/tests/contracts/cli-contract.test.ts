/**
 * Every path the CLI calls, checked against the routes the daemon actually registers.
 *
 * The sibling of `dashboard-contract.test.ts`, and it exists because the hole it closes was not
 * theoretical. `nouride update --then "…"` posts to `/update/apply`; the commit that gave the
 * dashboard its download / pause / install steps replaced that route with those four and did not
 * touch the CLI. From v0.4.0 the command answered `not_found` on every install — in a terminal, and
 * for an agent, which the prompt tells to use exactly that command. It reads as a missing release
 * rather than as a missing route, so the agent went looking for a way to do the job by hand.
 *
 * The dashboard had this test and the CLI did not, which is the only reason one side was caught and
 * the other was not. Both sides of that boundary are now held the same way.
 *
 * Deliberately not a mock: `mountControlRoutes` runs for real and `app.routes` is Hono's own table,
 * so a module that stops registering something fails here.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";

const CLI_DIR = join(dirname(import.meta.path), "..", "..", "src", "cli");

/** One path as segments, with anything variable marked. `null` matches any one segment. */
type Shape = (string | null)[];

const shapeOf = (path: string): Shape =>
  path
    // A query string is not part of the route; `?all=1` and `${query}` both come off here.
    .split("?")[0]!
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => (segment.includes("${") || segment.startsWith(":") ? null : segment));

const matches = (call: Shape, route: Shape): boolean =>
  call.length === route.length &&
  call.every((segment, index) => {
    const other = route[index]!;
    return segment === null || other === null || segment === other;
  });

function registered(): Shape[] {
  const app = new Hono();
  // Nothing is called, so the deps can be empty: this is about the route table, and a fake that
  // answered would be testing the fake.
  mountControlRoutes(app, { token: "t" } as unknown as ControlDeps);
  return app.routes
    .map((route) => shapeOf(route.path.replace(/^\/api\/control/, "")))
    .filter((shape) => shape.length > 0 && !shape.includes("*"));
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Every `client.get("…")` / `client.post("…")` in the CLI, with the file it came from.
 *
 * Read as text rather than by calling anything, so a command that is only reachable behind a flag
 * is covered as fully as one on the default path — which is the shape of the bug: `--then` is a
 * branch nothing in the suite ever took.
 */
function called(): { shape: Shape; raw: string; file: string }[] {
  const pattern = /client\.(?:get|post)\s*(?:<[^>]*>)?\s*\(\s*[`"']([^`"']*)[`"']/g;
  return sources(CLI_DIR).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(pattern)]
      .map((match) => match[1] as string)
      .filter((raw) => raw.startsWith("/"))
      .map((raw) => ({ shape: shapeOf(raw), raw, file: file.slice(file.indexOf("src/cli")) }));
  });
}

describe("the CLI and the daemon agree on every path", () => {
  test("every path the CLI calls is a route the daemon registers", () => {
    const routes = registered();
    const missing = called().filter((call) => !routes.some((route) => matches(call.shape, route)));

    expect(missing.map((entry) => `${entry.raw}  (${entry.file})`)).toEqual([]);
  });

  test("and the one-shot update is among them, by name", () => {
    /**
     * Named rather than left to the sweep above, because this is the path that broke and the sweep
     * would go quiet the day somebody deletes the call as well as the route — which is how a
     * capability disappears without a failing test.
     */
    const raws = called().map((entry) => entry.raw);
    expect(raws).toContain("/update/apply");
    expect(registered().some((route) => matches(shapeOf("/update/apply"), route))).toBe(true);
  });

  test("it finds a useful number of calls, so a broken scanner cannot pass by finding none", () => {
    expect(called().length).toBeGreaterThan(20);
  });
});

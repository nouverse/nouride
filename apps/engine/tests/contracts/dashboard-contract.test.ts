/**
 * Every path the dashboard calls, checked against the routes the daemon actually registers.
 *
 * `apps/dashboard` has no workspace dependency on the engine by design (ARCHITECTURE §3): it speaks
 * HTTP and holds its own wire types. That is the right boundary and it has exactly one hole — a
 * path can be renamed on one side and not the other, and nothing says so until somebody clicks the
 * thing. The dashboard has 93 of them.
 *
 * This is the one test that closes it, and it reads the dashboard as **text** rather than importing
 * it, so the dependency direction is unchanged: nothing here can end up in the daemon's bundle. The reading is
 * `scripts/dashboard-calls.ts`, which `plain-replies.test.ts` reads the same calls through.
 *
 * It is deliberately not a mock. `mountControlRoutes` is called for real and `app.routes` is Hono's
 * own table, so a route module that stops registering something fails here — including one that
 * fails to register because a *different* module now shadows it, which is the failure the comment
 * at the top of `routes/files.ts` exists for.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { CLIENT_FILES, dashboardCalls, matches, routeShape, type Shape } from "../../../../scripts/dashboard-calls.ts";

interface Route {
  method: string;
  shape: Shape;
}

function registered(): Route[] {
  const app = new Hono();
  // Nothing is called, so the seven required fields can be empty: this test is about the route
  // table, and a fake that answered would be testing the fake.
  mountControlRoutes(app, { token: "t" } as unknown as ControlDeps);
  // A `*` counts as a prefix only behind a literal segment: `/api/control/*` is the auth middleware's, and as a
  // prefix it matched every call there is — the check passed whatever was renamed. One that is not last is unreadable.
  return app.routes
    .map((route) => ({ method: route.method, shape: routeShape(route.path) }))
    .filter((route) => route.shape.length > 0 && !route.shape.slice(0, -1).includes("*") && !(route.shape.length === 1 && route.shape[0] === "*"));
}

describe("the dashboard's calls", () => {
  test("there are enough of them for this test to mean anything", () => {
    // A regex that stopped matching would make every assertion below pass on an empty list — the
    // fail-open shape this repo has been bitten by twice, in the migration scan and in check-sql.
    expect(dashboardCalls().length).toBeGreaterThan(170);
    expect(registered().length).toBeGreaterThan(60);
    // No route that matches everything: a catch-all counted as a prefix would pass any call at all.
    expect(registered().filter((route) => route.shape.every((segment) => segment === "*"))).toEqual([]);
    // Every surface split out of `api.ts` is read: a file that builds a control path cannot be missed.
    for (const file of ["api.ts", "api.memory.ts", "api.people.ts", "api.update.ts", "api.appliance.ts", "api.jobs.ts", "api.secrets.ts", "api.advisories.ts"]) {
      expect(CLIENT_FILES).toContain(`apps/dashboard/src/commons/lib/${file}`);
    }
  });

  test("every one of them is a route this daemon registers — for the method it is called with", () => {
    const routes = registered();
    const missing = dashboardCalls().filter(
      (call) => !routes.some((route) => (call.method === null || route.method === call.method || route.method === "ALL") && matches(call.shape, route.shape)),
    );

    // Named individually, because the useful failure is *which* path, not how many.
    expect(missing.map((call) => `${call.method ?? "?"} ${call.raw}  (${call.file})`)).toEqual([]);
  });

  test("a query, or a value that only makes one, is no segment of the path (0.8.20)", () => {
    // Cut at the `?` inside `${query ? `?${query}` : ""}`, these were one segment of anything, and matched every route
    // of one segment: renaming `/sessions` would have passed.
    const shape = (start: string) => dashboardCalls().find((call) => call.raw.startsWith(start))?.shape;
    expect(shape("/sessions${query")).toEqual(["sessions"]);
    expect(shape("/missions${query")).toEqual(["missions"]);
    expect(shape("/cron${all")).toEqual(["cron"]);
    expect(shape("/memory/changes${subject")).toEqual(["memory", "changes"]);
  });

  test("the method is read for nearly every call — a reader that found none would check paths alone", () => {
    const calls = dashboardCalls();
    expect(calls.filter((call) => call.method !== null).length).toBeGreaterThan(calls.length - 5);
  });
});

/**
 * A route that works for minutes keeps its own connection open (`keepOpen`), and the browser has to wait as long: its
 * client gives a call fifteen seconds unless the call says otherwise. `POST /skills/review` did not, so "Review now"
 * was cut while the review ran on, and the page said Nouride was probably restarting.
 */
describe("a route that works for minutes", () => {
  const ROUTES = join(import.meta.dir, "../../src/modules/web/control/routes");

  /** Each route whose handler holds its request open past the server's idle timeout. */
  function heldOpen(): Route[] {
    const held: Route[] = [];
    for (const name of readdirSync(ROUTES).filter((file) => file.endsWith(".ts"))) {
      const source = readFileSync(join(ROUTES, name), "utf8");
      const routes = [...source.matchAll(/\bcontrol\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)];
      for (const hold of source.matchAll(/keepOpen\?\.\(/g)) {
        const route = routes.filter((found) => found.index < hold.index).at(-1);
        if (route) held.push({ method: route[1]!.toUpperCase(), shape: routeShape(route[2]!) });
      }
    }
    return held;
  }

  test("is called with a wait of the call's own, not the client's seconds", () => {
    const held = heldOpen();
    // The review, the memory pass, forgetting a person and the tag tidies at least: none found is a reader that broke.
    expect(held.length).toBeGreaterThanOrEqual(8);
    expect(held).toContainEqual({ method: "POST", shape: ["skills", "review"] });

    const impatient = dashboardCalls().filter((call) => !call.patient && held.some((route) => route.method === call.method && matches(call.shape, route.shape)));
    expect(impatient.map((call) => `${call.method} ${call.raw}  (${call.file})`)).toEqual([]);
  });

  test("the reader sees a wait where a call gives one, and none where it does not", () => {
    const patient = (start: string) => dashboardCalls().find((call) => call.raw.startsWith(start))?.patient;
    expect(patient("/memory/pass")).toBe(true);
    expect(patient("/skills/learning")).toBe(false);
  });
});

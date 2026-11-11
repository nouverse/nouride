/**
 * Every answer the dashboard reads is one its route is held to, by the compiler, in the same words.
 *
 * The dashboard declares what it reads where it asks (`request<{ jobs: JobSummary[] }>(…)`); the route says the same
 * type after its answer (`c.json(body satisfies { jobs: JobSummary[] })`). The compiler does the checking. This holds
 * the two declarations to each other, which no compiler sees: a type changed on one side alone, an answer added to a
 * route with no type after it, or a type of the engine's that only shares the wire's name.
 *
 * What it found the day it was written: the audit log's rows sent with no `id`, which the page keys its rows by; a
 * saved web-search setting answered without its restart note; a job answered without its line of words after a
 * change; a room, a job and an account answered as `null` where the page reads one; a skill's `project` scope and a
 * draft's removed files the wire never named.
 */

import { describe, expect, test } from "bun:test";
import { routeAnswers } from "../../../../scripts/route-answers.ts";

/**
 * Routes whose answers this cannot read, each with why. The answer is made in a function the route hands the request
 * to, or the route answers by an action in its path and each action's caller declares its own.
 */
const NOT_READ: Record<string, string> = {
  "GET /memory/graph": "answered gzipped, through `jsonGzipped`",
  "GET /memory/facets": "answered gzipped, through `jsonGzipped`",
  "POST /knowledge/:id/pending/:decision": "answers by its decision: a saved document, or a plain yes",
  "POST /mcp/library/:server/oauth/start": "answered by `start`, shared with the agent's own route",
  "POST /agents/:id/mcp/:server/oauth/start": "answered by `start`, shared with the library's route",
  "DELETE /mcp/library/:server/oauth": "answered by `forget`, shared with the agent's own route",
  "DELETE /agents/:id/mcp/:server/oauth": "answered by `forget`, shared with the library's route",
  "POST /agents/:id/:action": "answers by its action: sleep, wake, approvals, a setting, a switch",
  "POST /access/:action": "answers by its action: approve, deny, block, revoke",
  "POST /update/install": "answered by the update's own plan, built outside the route",
};

const routes = routeAnswers();
const failing = (route: (typeof routes)[number]): string[] => {
  if (route.answers.length === 0) return [`${route.route} (${route.file}): no answer found to hold`];
  return route.answers
    .filter((answer) => answer.held === null || !route.declared.includes(answer.held))
    .map((answer) => `${route.route} (${route.file}:${answer.line}): ${answer.held === null ? "held to no type" : `held to ${answer.held}`}; its caller declares ${route.declared.join(" | ")}`);
};

describe("a control route's answer", () => {
  test("there are enough of them read for this to mean anything", () => {
    expect(routes.length).toBeGreaterThan(220);
    expect(routes.flatMap((route) => route.answers).filter((answer) => answer.held !== null).length).toBeGreaterThan(230);
  });

  test("is held to the type its dashboard caller declares, word for word", () => {
    expect(routes.filter((route) => !(route.route in NOT_READ)).flatMap(failing)).toEqual([]);
  });

  test("names the wire's types, never one of the engine's that shares a name", () => {
    expect(routes.filter((route) => route.notWire.length > 0).map((route) => `${route.route} (${route.file}): ${route.notWire.join(", ")}`)).toEqual([]);
  });

  test("the routes left out are ones it still cannot read: one that can be is taken off the list", () => {
    const known = new Map(routes.map((route) => [route.route, route]));
    expect(Object.keys(NOT_READ).filter((route) => !known.has(route))).toEqual([]);
    expect(Object.keys(NOT_READ).filter((route) => failing(known.get(route)!).length === 0)).toEqual([]);
  });
});

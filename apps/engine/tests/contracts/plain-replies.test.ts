/**
 * The server's refusals and notes on the dashboard, in everyday words (0.8.20). The CLI and the dashboard read the same
 * replies, and what a route says for the command line (a section of the config file, a flag, a command, a `git` word)
 * reached people who are not technical as it was: Memory's embed button with semantic search off said "it needs
 * [memory.semantic] enabled, provider and model", and deleting a mission with work left in its folder said "Commit it
 * there first" (2026-11-05). Such a reply carries a third field, `plain`, in the dashboard's words; the dashboard shows
 * it and puts the route's own `error` and `note` under Details, and the CLI prints them as it always did.
 *
 * Read by the parser through `scripts/route-words.ts`, every route the dashboard calls (`scripts/dashboard-calls.ts`,
 * the calls `dashboard-contract.test.ts` holds to the route table), and the guard's replies, which answer any of them.
 * Each `error` and `note` written in the route passes the dashboard's wording rule (`technical()` in
 * `scripts/dashboard-words.ts`, the rule `plain-dashboard.test.ts` holds the dashboard to), or the reply carries a
 * `plain` that does, whatever else it holds. Words the route did not write, a domain's refusal or an exception's
 * message, pass only with a `plain`, worded at the route from what the domain returned. A note the page shows from a
 * success is held the same way. `bun run scripts/route-words.ts --technical` lists what this would refuse.
 */

import { describe, expect, test } from "bun:test";
import { dashboardCalls, matches, routeShape } from "../../../../scripts/dashboard-calls.ts";
import { controlSources, dashboardReplies, repliesIn, routesIn } from "../../../../scripts/route-words.ts";

const at = (file: string, line: number) => `${file.replace("apps/engine/src/modules/web/control/", "")}:${line}`;

describe("the server's refusals and notes on the dashboard", () => {
  test("there are enough of them for this test to mean anything", () => {
    // A reader that stopped finding replies would pass everything below on an empty list.
    const replies = dashboardReplies();
    expect(new Set(replies.map(({ reply }) => at(reply.file, reply.line))).size).toBeGreaterThan(700);
    expect(replies.filter(({ reply }) => reply.error.length > 0).length).toBeGreaterThan(450);
    expect(replies.filter(({ reply }) => reply.method === "*").length).toBeGreaterThan(2);
  });

  test("every route the dashboard calls is one this reads", () => {
    const routes = controlSources().flatMap((path) => routesIn(path));
    const unread = dashboardCalls().filter(
      (call) => !routes.some((route) => (call.method === null || route.method === "ALL" || call.method === route.method) && matches(call.shape, routeShape(route.path))),
    );
    expect(unread.map((call) => `${call.method ?? "?"} ${call.raw} (${call.file})`)).toEqual([]);
  });

  test("each reads as everyday words, or carries them", () => {
    const refused = new Map<string, string>();
    for (const { reply, why } of dashboardReplies()) {
      if (why.length > 0) refused.set(at(reply.file, reply.line), `${reply.method} ${reply.path}: ${why.join("; ")}`);
    }
    expect([...refused].map(([where, why]) => `${where} ${why}`)).toEqual([]);
  });

  test("the two that set it off say what happened in everyday words, and the CLI's own words are as they were", () => {
    const reply = (file: string, path: string, method: string) =>
      repliesIn(controlSources().find((source) => source.endsWith(file))!).filter((one) => one.path === path && one.method === method);
    const embed = reply("routes/memory.ts", "/memory/embed", "POST").find((one) => one.status?.includes(409))!;
    expect(embed.error.map((said) => said.text)).toEqual(["semantic search is off: it needs [memory.semantic] enabled, provider and model"]);
    expect(embed.plainAlways).toBe(true);
    const deleted = reply("routes/missions.ts", "/missions/:id", "DELETE").find((one) => one.note.length > 0)!;
    expect(deleted.note.map((said) => said.text)).toEqual(["With force (`--force`, or Delete anyway on its page) that work is lost."]);
    expect(deleted.plainAlways).toBe(true);
  });
});

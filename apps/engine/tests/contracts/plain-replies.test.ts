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
import { NOT_SAVED, notSaved } from "@/modules/web/control/plain.ts";
import { dashboardCalls, matches, routeShape } from "../../../../scripts/dashboard-calls.ts";
import { controlSources, dashboardReplies, repliesIn, routesIn } from "../../../../scripts/route-words.ts";

const at = (file: string, line: number) => `${file.replace("apps/engine/src/modules/web/control/", "")}:${line}`;

/**
 * The saves that answer "Nothing was saved. Check what you entered" with no field to name (0.8.23), and why: nothing a
 * person typed or picked there can be what was refused, or the whole of what they sent is one text. Every other save the
 * dashboard makes names the field its writer refused, as the page names it (`notSaved`); a new route that answers
 * `NOT_SAVED` fails below until it does, or is added here with its reason.
 */
const NO_ONE_FIELD: Record<string, string> = {
  "POST /access/mode": "a switch: on or off is never the wrong value, only the settings file can refuse it",
  "POST /agents/:id/tools": "switches, each a tool the page offered",
  "POST /agents/:id/access": "a choice of three the route has already checked",
  "POST /agents/:id/effort": "a choice the route has already checked",
  "POST /agents/:id/skills": "switches, each a skill the page offered",
  "POST /agents/:id/:action": "a switch (on, the programs every agent runs) or a choice the route has already checked (approvals, the second look)",
  "POST /agents/:id/cli": "its model and permissions are refused only by the agent's file as a whole, and its effort is a checked choice",
  "POST /auth/password-login": "a switch, refused while no other way to sign in is set up: a step not taken, not a field",
  "POST /agents/:id/files/:name": "a whole file, edited as text: what was entered is all of it",
  "POST /config": "the whole settings file, edited as text",
  "POST /knowledge": "a collection's settings, refused in a sentence of the route's: naming its field waits on the other change to knowledge.ts in this release",
  "PATCH /knowledge/:id": "as a new collection's",
  "PUT /mcp-server": "a switch",
  "PUT /memory/people/:key/facts": "a choice the route has already checked",
  "PUT /memory/people/:key/recall": "a switch",
  "POST /mentions": "its switch; the hop limit beside it is named",
  "POST /setup/gateway": "a button with no field: what it refuses is an account not yet signed in",
  "POST /skills/:name/source": "a whole skill, edited as text",
  "POST /skills/:name/global": "a switch",
  "POST /skills/:name/files/write": "a whole file of a skill, edited as text",
  "POST /skills/:name/agents/:agentId": "a switch",
  "POST /update/track": "a choice of the two the page offers",
};

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

  test("a save refused names the field it refused, as the page names it, but where no one field can be at fault", () => {
    // `notSaved`'s sentence with its field standing as a value: what a reply naming one is read as.
    const named = notSaved("{}");
    const generic = dashboardReplies()
      .map(({ reply }) => ({ route: `${reply.method} ${reply.path}`, texts: reply.plain.map((said) => said.text) }))
      .filter(({ texts }) => texts.includes(NOT_SAVED) && !texts.includes(named))
      .map(({ route }) => route);
    expect([...new Set(generic)].sort()).toEqual(Object.keys(NO_ONE_FIELD).sort());
    // And the replies that do name one are read as such: a reader that stopped would pass the list above on nothing.
    expect(dashboardReplies().filter(({ reply }) => reply.plain.some((said) => said.text === named)).length).toBeGreaterThan(30);
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

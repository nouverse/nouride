/**
 * `/helpers`: who is working for this agent in the background now, its helpers and the agents it asked.
 *
 * A person could stop them with `/stop` and had nothing to see them with. Only what is running, for whoever may see
 * it: a room sees what was started from that room; a direct chat its own, what the person started elsewhere, and
 * for an admin all of the agent's.
 */

import { describe, expect, test } from "bun:test";
import { helperHooks, helpersSaid, type WorkingInBackground } from "@/modules/hooks/builtins/helpers.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";

const NOW = 1_795_000_000_000;
const MIN = 60_000;
const one = (more: Partial<WorkingInBackground>): WorkingInBackground => ({ id: "job_aaaa", asked: null, what: "Fix the third slide", gatewayId: "telegram:nouva", chatId: "555", senderId: "u1", startedAt: NOW - 12 * MIN, lastWroteAt: NOW - 40_000, ...more });
const here = (job: WorkingInBackground) => job.gatewayId === "telegram:nouva" && job.chatId === "555";
const said = (working: WorkingInBackground[]) => helpersSaid({ agent: "Nouva", working, here, nameOf: (id) => (id === "nexa" ? "Nexa" : id), now: NOW });

describe("what /helpers says", () => {
  test("nobody at work is said in one line", () => {
    expect(said([])).toBe("Nobody is working for Nouva in the background now.");
  });

  test("a helper and an asked agent, the oldest first: who, how long, its last step, what it was given, its id", () => {
    const text = said([one({ id: "job_bbbb", asked: "nexa", what: "Design  the\ncover", startedAt: NOW - 3 * MIN, lastWroteAt: NOW - 5_000 }), one({})]);
    expect(text.split("\n")).toEqual([
      "2 at work for Nouva in the background:",
      "1. A helper, 12m so far, last step 40s ago: Fix the third slide (job_aaaa)",
      "2. Nexa, asked, 3m so far, last step 5s ago: Design the cover (job_bbbb)",
      "/stop ends what was started from this chat.",
    ]);
  });

  test("one that has made no step says so, and one from another chat says where; /stop is offered only for this chat's", () => {
    const text = said([one({ chatId: "999", lastWroteAt: null })]);
    expect(text).toContain("1. A helper, 12m so far, no step yet, started in another chat: Fix the third slide (job_aaaa)");
    expect(text).not.toContain("/stop");
  });

  test("a long brief is cut, not the line dropped", () => {
    const text = said([one({ what: "word ".repeat(200) })]);
    expect(text.split("\n")[1]!.length).toBeLessThan(260);
    expect(text).toContain("(job_aaaa)");
  });
});

describe("who sees what", () => {
  const helpers = helperHooks.find((hook) => hook.command === "/helpers")!;
  const all = [
    one({ id: "job_here" }),
    one({ id: "job_mine_elsewhere", chatId: "777", senderId: "u1" }),
    one({ id: "job_theirs", chatId: "888", senderId: "u2" }),
    one({ id: "job_mine_other_gateway", gatewayId: "discord:nouva", chatId: "c1", senderId: "u1" }),
  ];
  const ctx = (options: { chatType: "dm" | "group"; admin?: boolean; working?: WorkingInBackground[] | null }): HookContext =>
    ({
      agent: { config: { id: "nouva", displayName: "Nouva" } },
      gatewayId: "telegram:nouva",
      chatId: "555",
      senderId: "u1",
      args: [],
      envelope: { gateway: "telegram", gatewayId: "telegram:nouva", chatId: "555", chatType: options.chatType },
      deps: {
        registry: { get: () => undefined },
        isAdmin: () => options.admin === true,
        ...(options.working === null ? {} : { workingInBackground: (agentId: string) => (agentId === "nouva" ? (options.working ?? all) : []) }),
      },
    }) as unknown as HookContext;
  const ids = async (c: HookContext) => [...((await helpers.handler(c)).reply ?? "").matchAll(/\((job_[a-z_]+)\)/g)].map((match) => match[1]);

  test("a room sees only what was started from that room, an admin there too", async () => {
    expect(await ids(ctx({ chatType: "group" }))).toEqual(["job_here"]);
    expect(await ids(ctx({ chatType: "group", admin: true }))).toEqual(["job_here"]);
  });

  test("a direct chat sees its own and what this person started elsewhere on the connection, not another person's", async () => {
    // A sender id means a person only on its own connection: the same number on another platform is someone else.
    expect(await ids(ctx({ chatType: "dm" }))).toEqual(["job_here", "job_mine_elsewhere"]);
  });

  test("an admin in a direct chat sees all of the agent's", async () => {
    expect(await ids(ctx({ chatType: "dm", admin: true }))).toEqual(["job_here", "job_mine_elsewhere", "job_theirs", "job_mine_other_gateway"]);
  });

  test("answers at once, asleep or not, and says so where no background work is run", async () => {
    expect(helpers.worksWhilePaused).toBe(true);
    const result = await helpers.handler(ctx({ chatType: "dm", working: null }));
    expect(result).toEqual({ handled: true, reply: "Background work is not run in this process." });
  });
});

/**
 * `/mission` with nothing after it: what has not ended, as the dashboard's board has it. Needs you, Working, Backlog.
 *
 * It listed the chat's missions in one run with the last five ended under them, and a draft read "needs you (accept)".
 * A person asking what an agent has on its plate wants the three stages and nothing that is over; in a direct chat,
 * the agent's own missions wherever each was started, for whoever may see them.
 */

import { describe, expect, test } from "bun:test";
import { missionHooks, missionsSaid, stageOf } from "@/modules/hooks/builtins/mission.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";
import type { Mission } from "@/modules/missions/types.ts";

let made = 0;
const mission = (more: Partial<Mission>): Mission =>
  ({ id: `msn_${String(++made).padStart(4, "0")}aaaaaaaaaaaaaaaa`, title: "A mission", agentId: "nouva", status: "running", waitKind: null, startedAt: 1, createdAt: made, gatewayId: "telegram:nouva", chatId: "555", startedBy: "u1", answers: [], told: [], ...more }) as Mission;
const draft = (more: Partial<Mission> = {}) => mission({ status: "waiting", waitKind: "accept", startedAt: null, ...more });
const isHere = (one: Mission) => one.gatewayId === "telegram:nouva" && one.chatId === "555";

describe("the stage a mission is in", () => {
  test("a draft is the backlog; one that waits on a person needs them; the rest is at work", () => {
    expect(stageOf(draft())).toBe("backlog");
    for (const waitKind of ["input", "approval", "stuck", "limit", "paused", "unknown_outcome"] as const) expect(stageOf(mission({ status: "waiting", waitKind }))).toBe("needs");
    // Its result to accept: started, so not a draft.
    expect(stageOf(mission({ status: "waiting", waitKind: "accept", startedAt: 5 }))).toBe("needs");
    for (const status of ["queued", "running", "checking"] as const) expect(stageOf(mission({ status }))).toBe("working");
  });

  test("one held up for its model tries again by itself: at work, and asks nothing of anybody", () => {
    expect(stageOf(mission({ status: "waiting", waitKind: "retry" }))).toBe("working");
  });
});

describe("what /mission lists", () => {
  test("three stages in the order a chat reads them, each with its count, the newest first, an empty one left out", () => {
    const text = missionsSaid([draft({ title: "Later" }), mission({ title: "Older work" }), mission({ title: "Newer work" }), mission({ status: "waiting", waitKind: "input", title: "A question" })], isHere);
    const lines = text.split("\n");
    expect(lines.filter((line) => line.startsWith("**"))).toEqual(["**Needs you** (1)", "**Working** (2)", "**Backlog** (1) · /mission accept <id> starts one"]);
    expect(lines.findIndex((line) => line.startsWith("• Newer work"))).toBeLessThan(lines.findIndex((line) => line.startsWith("• Older work")));
    expect(missionsSaid([mission({})], isHere).split("\n")[0]).toBe("**Working** (1)");
  });

  test("laid out to be read: a stage's name stands out, a blank line parts the stages, a mission is one line that leads with its name", () => {
    const question = mission({ status: "waiting", waitKind: "input", title: "A question" });
    const work = mission({ title: "Some work" });
    expect(missionsSaid([question, work], isHere).split("\n")).toEqual([
      "**Needs you** (1)",
      `• A question · \`${question.id.slice(0, 10)}\` · needs you (input)`,
      "",
      "**Working** (1)",
      `• Some work · \`${work.id.slice(0, 10)}\` · running`,
    ]);
  });

  test("a room's list says whose each is; a direct chat's does not repeat the agent it is talking to", () => {
    const work = mission({ title: "Some work" });
    expect(missionsSaid([work], isHere, true)).toContain(`• Some work · \`${work.id.slice(0, 10)}\` · nouva · running`);
    expect(missionsSaid([work], isHere)).not.toContain("nouva");
  });

  test("a draft is said as a draft, not as a result to accept", () => {
    const text = missionsSaid([draft({ title: "Later" })], isHere);
    expect(text).toMatch(/^• Later · `msn_[0-9a]+` · draft$/m);
    expect(text).not.toContain("needs you");
  });

  test("one started in another chat says so, and is not offered a start from here", () => {
    const text = missionsSaid([draft({ chatId: "999", title: "Elsewhere" })], isHere);
    expect(text.split("\n")).toEqual(["**Backlog** (1)", expect.stringMatching(/^• Elsewhere · `msn_[0-9a]+` · draft · started in another chat$/)]);
  });

  test("a mission with no name is still a line", () => {
    expect(missionsSaid([mission({ title: "  " })], isHere)).toMatch(/^• untitled · `msn_/m);
  });

  test("nothing open says so, with how the command is used", () => {
    const text = missionsSaid([], isHere);
    // How one is asked for, and no more of the usage: there is no mission to stop, pause or answer.
    expect(text.split("\n")).toEqual(["No mission is in the backlog, at work or waiting here.", "", expect.stringMatching(/^`\/mission <goal>`: this agent drafts one/)]);
  });
});

describe("whose missions a chat is shown", () => {
  const command = missionHooks.find((hook) => hook.command === "/mission")!;
  const here = [mission({ title: "Here, at work" }), mission({ status: "done", title: "Here, done" }), mission({ status: "failed", title: "Here, failed" }), mission({ status: "stopped", title: "Here, stopped" })];
  const elsewhere = [
    mission({ chatId: "777", startedBy: "u1", title: "Mine, another chat" }),
    mission({ chatId: "888", startedBy: "u2", title: "Another person's" }),
    mission({ gatewayId: "web:dashboard", chatId: "d1", startedBy: "u1", title: "Same id, another connection" }),
  ];
  const asked: string[] = [];
  const reply = async (options: { chatType: "dm" | "group"; admin?: boolean }) => {
    asked.length = 0;
    const ctx = {
      agent: { config: { id: "nouva", displayName: "Nouva" } },
      gatewayId: "telegram:nouva",
      chatId: "555",
      senderId: "u1",
      args: [],
      envelope: { gateway: "telegram", gatewayId: "telegram:nouva", chatId: "555", chatType: options.chatType },
      deps: {
        isAdmin: () => options.admin === true,
        missions: { forChat: () => here, openFor: (agentId: string) => (asked.push(agentId), [...here.filter((one) => one.status === "running"), ...elsewhere]) },
      },
    } as unknown as HookContext;
    return (await command.handler(ctx)).reply ?? "";
  };
  const titles = (text: string) => ["Here, at work", "Here, done", "Here, failed", "Here, stopped", "Mine, another chat", "Another person's", "Same id, another connection"].filter((title) => text.includes(title));

  test("what has ended is not listed: done, failed or stopped", async () => {
    expect(titles(await reply({ chatType: "group" }))).toEqual(["Here, at work"]);
    expect(await reply({ chatType: "group" })).not.toContain("Ended");
  });

  test("a room is shown the room's, and the agent's others are not asked for", async () => {
    expect(titles(await reply({ chatType: "group", admin: true }))).toEqual(["Here, at work"]);
    expect(asked).toEqual([]);
  });

  test("a direct chat is shown the agent's own that this person started on the connection too, each once", async () => {
    const text = await reply({ chatType: "dm" });
    expect(titles(text)).toEqual(["Here, at work", "Mine, another chat"]);
    expect(asked).toEqual(["nouva"]);
    expect(text.match(/Here, at work/g)).toHaveLength(1);
    expect(text).toMatch(/^• Mine, another chat · `msn_[0-9a]+` · running · started in another chat$/m);
  });

  test("a room's lines say whose each mission is, a direct chat's do not", async () => {
    expect(await reply({ chatType: "group" })).toMatch(/^• Here, at work · `msn_[0-9a]+` · nouva · running$/m);
    expect(await reply({ chatType: "dm" })).toMatch(/^• Here, at work · `msn_[0-9a]+` · running$/m);
  });

  test("an admin in a direct chat is shown all of the agent's", async () => {
    expect(titles(await reply({ chatType: "dm", admin: true }))).toEqual(["Here, at work", "Mine, another chat", "Another person's", "Same id, another connection"]);
  });
});

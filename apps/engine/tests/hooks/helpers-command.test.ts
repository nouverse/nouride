/**
 * `/helpers` and `/backgrounds`: what is at work for this agent in the background now.
 *
 * `/helpers` is its helpers and the agents it asked; `/backgrounds` the commands it left running. A person could stop
 * the first with `/stop` and had nothing to see either with. `/helpers` came first and left commands out: told "run
 * sleep 30 in the background", an agent did, and `/helpers` said twice that nobody was working. Each list now says
 * when the other has something.
 *
 * For whoever may see it: a room sees what was started from that room; a direct chat its own, what the person
 * started elsewhere, and for an admin all of the agent's.
 *
 * And whom the agent itself is working for: an ask is a job of the agent that asked, so the agent doing the work said
 * "no helper is working" and nothing more. Its `/helpers` names the agents it is at work for.
 */

import { describe, expect, test } from "bun:test";
import { backgroundSaid, helperHooks, type WorkingForAnother, type WorkingInBackground } from "@/modules/hooks/builtins/helpers.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";

const NOW = 1_795_000_000_000;
const MIN = 60_000;
const one = (more: Partial<WorkingInBackground>): WorkingInBackground => ({
  id: "job_aaaa",
  kind: "helper",
  asked: null,
  service: false,
  what: "Fix the third slide",
  gatewayId: "telegram:nouva",
  chatId: "555",
  senderId: "u1",
  startedAt: NOW - 12 * MIN,
  lastWroteAt: NOW - 40_000,
  ...more,
});
const command = (more: Partial<WorkingInBackground> = {}) => one({ id: "job_cccc", kind: "command", what: "sleep 30", startedAt: NOW - 20_000, lastWroteAt: null, ...more });
const here = (job: WorkingInBackground) => job.gatewayId === "telegram:nouva" && job.chatId === "555";
const said = (which: "helpers" | "commands", working: WorkingInBackground[]) => backgroundSaid({ which, agent: "Nouva", working, here, nameOf: (id: string) => (id === "nexa" ? "Nexa" : id), now: NOW });

describe("what /helpers says", () => {
  test("nobody at work is said in one line", () => {
    expect(said("helpers", [])).toBe("No helper is working for Nouva now.");
  });

  test("a helper and an asked agent, the oldest first: three short lines each, a blank line between", () => {
    const text = said("helpers", [one({ id: "job_bbbb", kind: "ask", asked: "nexa", what: "Design  the\ncover", startedAt: NOW - 3 * MIN, lastWroteAt: NOW - 5_000 }), one({})]);
    expect(text.split("\n")).toEqual([
      "**Helpers working for Nouva** (2)",
      "",
      "**1. A helper** · 12m · last step 40s ago",
      "Fix the third slide",
      "`job_aaaa`",
      "",
      "**2. Nexa**, asked · 3m · last step 5s ago",
      "Design the cover",
      "`job_bbbb`",
      "",
      "/stop ends the ones started from this chat.",
    ]);
  });

  test("one that has made no step says so, and one from another chat says where; /stop is offered only for this chat's", () => {
    const text = said("helpers", [one({ chatId: "999", lastWroteAt: null })]);
    expect(text).toContain("**1. A helper** · 12m · no step yet · started in another chat\nFix the third slide\n`job_aaaa`");
    expect(text).not.toContain("/stop");
  });

  test("a log written only as it started is no step: one just begun does not say its last step was when it began", () => {
    // The log opens with what it was given, at the start.
    expect(said("helpers", [one({ startedAt: NOW - 13_000, lastWroteAt: NOW - 13_000 + 400 })])).toContain("**1. A helper** · 13s · no step yet\n");
    expect(said("helpers", [one({ startedAt: NOW - 13_000, lastWroteAt: NOW - 5_000 })])).toContain("**1. A helper** · 13s · last step 5s ago\n");
    // A command's log holds only what it printed: a write is output, however soon.
    expect(said("commands", [command({ lastWroteAt: NOW - 19_000 })])).toContain("**1. A command** · 20s · last output 19s ago\n");
  });

  test("a long brief is cut, not the entry dropped", () => {
    const lines = said("helpers", [one({ what: "word ".repeat(200) })]).split("\n");
    expect(lines[3]!.length).toBeLessThan(170);
    expect(lines[4]).toBe("`job_aaaa`");
  });

  // The case that was found live: a command ran, and the answer was that nobody was working.
  test("a command is not a helper, and is never passed over in silence: the list says how many run and where to see them", () => {
    expect(said("helpers", [command()])).toBe("No helper is working for Nouva now.\n\n1 command runs in the background: /backgrounds");
    const both = said("helpers", [one({}), command(), command({ id: "job_dddd" })]);
    expect(both).toContain("**Helpers working for Nouva** (1)");
    expect(both).not.toContain("sleep 30");
    expect(both.split("\n").at(-1)).toBe("2 commands run in the background: /backgrounds");
  });
});

describe("whom the agent is working for", () => {
  const forOthers = [
    { by: "nouva", task: "Check last night's backups\nand say which failed", startedAt: NOW - 3 * MIN - 12_000 },
    { by: "nexa", task: null, startedAt: NOW - 40_000 },
  ];
  const at = (which: "helpers" | "commands", working: WorkingInBackground[], asks = forOthers) =>
    backgroundSaid({ which, agent: "Nix", working, here, nameOf: (id: string) => ({ nouva: "Nouva", nexa: "Nexa" })[id] ?? id, now: NOW, forOthers: asks });

  test("with no helper of its own it still says whom it is at work for: who, since when, and what was asked", () => {
    expect(at("helpers", []).split("\n")).toEqual([
      "No helper is working for Nix now.",
      "",
      "**Nix is working for** (2)",
      "",
      "**1. Nouva** · 3m",
      "Check last night's backups and say which failed",
      "",
      "**2. Nexa** · 40s · asked from another chat",
    ]);
  });

  test("under its own helpers, before the line about commands, and never in /backgrounds", () => {
    const lines = at("helpers", [one({}), command()]).split("\n");
    expect(lines[0]).toBe("**Helpers working for Nix** (1)");
    expect(lines.indexOf("**Nix is working for** (2)")).toBeGreaterThan(lines.indexOf("`job_aaaa`"));
    expect(lines.at(-1)).toBe("1 command runs in the background: /backgrounds");
    expect(lines.indexOf("**Nix is working for** (2)")).toBeLessThan(lines.length - 1);
    expect(at("commands", [command()])).not.toContain("is working for");
  });

  test("at work for nobody, the list is as it was", () => {
    expect(at("helpers", [], [])).toBe("No helper is working for Nix now.");
    expect(backgroundSaid({ which: "helpers", agent: "Nix", working: [], here, nameOf: (id) => id, now: NOW })).toBe("No helper is working for Nix now.");
  });

  test("a long ask is cut to a line a phone shows", () => {
    const said = at("helpers", [], [{ by: "nouva", task: "x".repeat(400), startedAt: NOW - MIN }]);
    expect(said.split("\n").at(-1)!.length).toBeLessThanOrEqual(161);
  });
});

describe("what /backgrounds says", () => {
  test("nothing running is said in one line", () => {
    expect(said("commands", [])).toBe("No command of Nouva's runs in the background now.");
  });

  test("a command and a server: what each is, how long, its last output, its own line as code, its job, and who stops one", () => {
    const text = said("commands", [command(), command({ id: "job_eeee", service: true, what: "bun run dev --port 3417", startedAt: NOW - 90 * MIN, lastWroteAt: NOW - 2 * MIN })]);
    expect(text.split("\n")).toEqual([
      "**Running in the background for Nouva** (2)",
      "",
      "**1. A server** · 1h 30m · last output 2m ago",
      "`bun run dev --port 3417`",
      "`job_eeee`",
      "",
      "**2. A command** · 20s · no output yet",
      "`sleep 30`",
      "`job_cccc`",
      "",
      "Nouva stops one when you ask, by its job.",
    ]);
    // `/stop` ends turns in the background and no command: it is not offered here.
    expect(text).not.toContain("/stop");
  });

  test("a command line of several lines is one line of code, and a backtick in it does not end the code", () => {
    const text = said("commands", [command({ what: "bash -lc cd /srv/x &&\n  echo `date`" })]);
    expect(text).toContain("\n`bash -lc cd /srv/x && echo 'date'`\n");
  });

  test("helpers are not commands, and are pointed at", () => {
    expect(said("commands", [one({})])).toBe("No command of Nouva's runs in the background now.\n\n1 helper at work: /helpers");
    expect(said("commands", [command(), one({}), one({ id: "job_bbbb", kind: "ask", asked: "nexa" })]).split("\n").at(-1)).toBe("2 helpers at work: /helpers");
  });
});

describe("who sees what", () => {
  const hook = (name: string) => helperHooks.find((entry) => entry.command === name)!;
  const all = [
    one({ id: "job_here" }),
    one({ id: "job_mine_elsewhere", chatId: "777", senderId: "u1" }),
    one({ id: "job_theirs", chatId: "888", senderId: "u2" }),
    one({ id: "job_mine_other_gateway", gatewayId: "discord:nouva", chatId: "c1", senderId: "u1" }),
    command({ id: "job_cmd_here" }),
    command({ id: "job_cmd_theirs", chatId: "888", senderId: "u2" }),
  ];
  /** Asks made of Nouva by other agents, each from its own conversation: the asking agent's connection and chat. */
  const asks: WorkingForAnother[] = [
    { by: "nix", task: "the task asked from this chat", gatewayId: "telegram:nouva", chatId: "555", senderId: "u1", startedAt: NOW - 5 * MIN },
    { by: "nexa", task: "the task this person asked elsewhere", gatewayId: "telegram:nouva", chatId: "777", senderId: "u1", startedAt: NOW - 4 * MIN },
    { by: "nero", task: "the task of another person", gatewayId: "telegram:nero", chatId: "999", senderId: "u2", startedAt: NOW - 3 * MIN },
  ];
  const ctx = (options: { chatType: "dm" | "group"; admin?: boolean; working?: WorkingInBackground[] | null; asks?: WorkingForAnother[] }): HookContext =>
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
        ...(options.asks ? { workingForOthers: (agentId: string) => (agentId === "nouva" ? options.asks! : []) } : {}),
      },
    }) as unknown as HookContext;
  const ids = async (name: string, c: HookContext) => [...((await hook(name).handler(c)).reply ?? "").matchAll(/`(job_[a-z_]+)`/g)].map((match) => match[1]);

  test("a room sees only what was started from that room, an admin there too", async () => {
    expect(await ids("/helpers", ctx({ chatType: "group" }))).toEqual(["job_here"]);
    expect(await ids("/helpers", ctx({ chatType: "group", admin: true }))).toEqual(["job_here"]);
    expect(await ids("/backgrounds", ctx({ chatType: "group", admin: true }))).toEqual(["job_cmd_here"]);
  });

  test("a direct chat sees its own and what this person started elsewhere on the connection, not another person's", async () => {
    // A sender id means a person only on its own connection: the same number on another platform is someone else.
    expect(await ids("/helpers", ctx({ chatType: "dm" }))).toEqual(["job_here", "job_mine_elsewhere"]);
    expect(await ids("/backgrounds", ctx({ chatType: "dm" }))).toEqual(["job_cmd_here"]);
  });

  test("an admin in a direct chat sees all of the agent's", async () => {
    expect(await ids("/helpers", ctx({ chatType: "dm", admin: true }))).toEqual(["job_here", "job_mine_elsewhere", "job_theirs", "job_mine_other_gateway"]);
    expect(await ids("/backgrounds", ctx({ chatType: "dm", admin: true }))).toEqual(["job_cmd_here", "job_cmd_theirs"]);
  });

  test("what the other list is said to hold is only what this reader may see of it", async () => {
    // Another person's command is not counted for someone who would not be shown it.
    const reply = (await hook("/helpers").handler(ctx({ chatType: "dm" }))).reply ?? "";
    expect(reply.split("\n").at(-1)).toBe("1 command runs in the background: /backgrounds");
  });

  test("whom it works for is said to everyone, and what was asked only where that chat's own work would be shown", async () => {
    const shown = async (c: HookContext) => ((await hook("/helpers").handler(c)).reply ?? "").split("\n").filter((line) => line.startsWith("the task") || line.includes("asked from another chat") || line.includes("is working for**")).map((line) => line.replace(/ · \S+ · asked/, " · asked"));
    // (How long is the clock's, which the handler reads itself: the list's own test above holds it.)
    // An admin in a direct chat: every task.
    expect(await shown(ctx({ chatType: "dm", admin: true, working: [], asks }))).toEqual(["**Nouva is working for** (3)", "the task asked from this chat", "the task this person asked elsewhere", "the task of another person"]);
    // The person in their own chat: what was asked from it and what they asked elsewhere on the connection, not another's.
    expect(await shown(ctx({ chatType: "dm", working: [], asks }))).toEqual(["**Nouva is working for** (3)", "the task asked from this chat", "the task this person asked elsewhere", "**3. nero** · asked from another chat"]);
    // A room: only what was asked from that room, an admin there too.
    expect(await shown(ctx({ chatType: "group", admin: true, working: [], asks }))).toEqual(["**Nouva is working for** (3)", "the task asked from this chat", "**2. nexa** · asked from another chat", "**3. nero** · asked from another chat"]);
    // /backgrounds says none of it, and an agent asked nothing by anyone has no such section.
    expect((await hook("/backgrounds").handler(ctx({ chatType: "dm", admin: true, working: [], asks }))).reply).toBe("No command of Nouva's runs in the background now.");
    expect((await hook("/helpers").handler(ctx({ chatType: "dm", admin: true, working: [], asks: [] }))).reply).toBe("No helper is working for Nouva now.");
  });

  test("both answer at once, asleep or not, and say so where no background work is run", async () => {
    for (const name of ["/helpers", "/backgrounds"]) {
      expect(hook(name).worksWhilePaused).toBe(true);
      expect(await hook(name).handler(ctx({ chatType: "dm", working: null }))).toEqual({ handled: true, reply: "Background work is not run in this process." });
    }
  });
});

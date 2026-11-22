/**
 * What an agent's own missions told a chat reaches that agent, with the next message there, once.
 *
 * A mission's notices are sent to the chat it reports to under its agent's name: queued, started, how far it is, what
 * it needs, done with its result. They were kept for the dashboard only. Nix started a mission from its chat; the chat
 * was told it had passed its checks and then that it was done; and a minute later Nix answered the same person that
 * the mission was still at work. Checked, as the rest of the table is, against what the provider was actually sent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { removePath } from "@nouride/runtime";
import { ChatEventStore, missionNotice, type ChatEvent } from "@/modules/chat-events/chat-events.store.ts";
import { formatMissionNotices } from "@/modules/chat-events/format.ts";
import { openAndMigrate } from "@/db/index.ts";
import { LocalGateway } from "@/modules/gateways/local.ts";
import type { LoadedAgent } from "@nouride/shared";
import type { ExecutorDeps, TurnBrain, TurnRequest } from "@/modules/llm/executor/types.ts";
import { envelope, tempDir } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";
import { eventually } from "../wait.ts";

let cleanup: (() => void)[] = [];
beforeEach(() => {
  cleanup = [];
});
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
});

/** The clock moved on: a window opens after the last message's own millisecond. */
async function nextMoment(): Promise<void> {
  const mark = Date.now();
  await eventually(() => Date.now() > mark, 1_000, "the next millisecond");
}

async function openStore() {
  const dataDir = tempDir("mission-notices");
  cleanup.push(() => removePath(dataDir));
  const db = await openAndMigrate(join(dataDir, "test.db"));
  cleanup.push(() => db.close());
  return new ChatEventStore(db);
}

const MISSION = { id: "msn_d20ba6b0706043ada14f", agentId: "nox", gatewayId: "web:dashboard", chatId: "room-1" };
const PASSED = "☑ Back to Nouride Home asks (msn_d20ba6) passed its checks.\n\nPR 14 is merged to main.";
const DONE = "✓ Back to Nouride Home asks (msn_d20ba6) done (checks passed, accepted).\n\nPR 14 is merged to main.";
const window = { gatewayId: "web:dashboard", chatId: "room-1", agentId: "nox", after: 0, before: 1_000, limit: 24 };

describe("what a store hands back of a mission's notices", () => {
  test("its agent's, in the window, oldest first: every notice a mission keeps", async () => {
    const store = await openStore();
    store.record({ ...missionNotice(MISSION, "▶ started"), at: 10 });
    store.record({ ...missionNotice(MISSION, "… 7 of 11 steps done", true), at: 20 });
    store.record({ ...missionNotice(MISSION, PASSED), at: 30 });
    store.record({ ...missionNotice(MISSION, DONE), at: 40 });
    const told = store.toldByMissions(window);
    expect(told.map((event) => event.text)).toEqual(["▶ started", "… 7 of 11 steps done", PASSED, DONE]);
    expect(told[1]!.details).toEqual({ mission: MISSION.id, progress: true });
    expect(store.toldByMissions({ ...window, after: 20, before: 30 }).map((event) => event.text)).toEqual([PASSED]);
  });

  test("not another agent's, another chat's, a note that is no mission's, or a room's event", async () => {
    const store = await openStore();
    store.record({ ...missionNotice({ ...MISSION, agentId: "nouva" }, "another agent's mission"), at: 10 });
    store.record({ ...missionNotice({ ...MISSION, chatId: "room-2" }, "another chat's"), at: 11 });
    store.record({ ...missionNotice({ ...MISSION, gatewayId: "telegram:nox" }, "another connection's"), at: 12 });
    store.record({ gatewayId: "web:dashboard", chatId: "room-1", audience: "ui", kind: "note", text: "a note of the daemon's own", agentId: "nox", at: 13 });
    store.record({ gatewayId: "web:dashboard", chatId: "room-1", audience: "ui", kind: "dropped", text: "a dropped message", agentId: "nox", details: { mission: MISSION.id }, at: 14 });
    store.record({ gatewayId: "web:dashboard", chatId: "room-1", audience: "agents", kind: "joined", text: "somebody joined", at: 15 });
    expect(store.toldByMissions(window)).toEqual([]);
    // And a room's replay still never holds a mission's notice: that is its agent's alone.
    store.record({ ...missionNotice(MISSION, DONE), at: 16 });
    expect(store.since({ gatewayId: "web:dashboard", chatId: "room-1", after: 0, before: 1_000 }).map((event) => event.text)).toEqual(["somebody joined"]);
  });

  test("the newest of a long silence, still oldest first", async () => {
    const store = await openStore();
    for (let i = 1; i <= 30; i += 1) store.record({ ...missionNotice(MISSION, `notice ${i}`), at: i });
    const told = store.toldByMissions({ ...window, limit: 3 });
    expect(told.map((event) => event.text)).toEqual(["notice 28", "notice 29", "notice 30"]);
    expect(store.toldByMissions({ ...window, limit: 0 })).toEqual([]);
  });
});

describe("what the missions keep of what they say", () => {
  // The wiring is the daemon's own (`boot/missions.ts`): every notice through one shape, a progress line marked.
  test("each notice is kept in the shape the store reads back, and a progress line says it is one", () => {
    const boot = readFileSync(join(import.meta.dir, "../../src/boot/missions.ts"), "utf8");
    expect(boot).toContain("params.chatEvents.record(missionNotice(mission, text, progress));");
    expect(boot).toMatch(/await progressed\.say\(mission\.id, reportsTo\(mission\), text\);\s+noted\(mission, text, true\);/);
    expect(missionNotice(MISSION, "x")).toEqual({ gatewayId: "web:dashboard", chatId: "room-1", audience: "ui", kind: "note", text: "x", agentId: "nox", details: { mission: MISSION.id } });
  });
});

describe("the block in front of a question", () => {
  const event = (text: string, at: number, details: Record<string, unknown> = { mission: MISSION.id }): ChatEvent => ({ id: `e${at}`, gatewayId: "g", chatId: "c", audience: "ui", kind: "note", text, agentId: "nox", details, at });
  const clock = (at: number) => `19:${String(at).padStart(2, "0")}`;

  test("says whose words these are, that the person has read them, and that the newest is how a mission stands", () => {
    expect(formatMissionNotices([event(PASSED, 50), event(DONE, 55)], clock)).toBe(
      [
        "[Since your last message here, your own missions told this chat 2 things under your name. The person has read them and you had not: background for what they say next, not something to answer. A mission's newest line is how it stands now]",
        "- 19:50 ☑ Back to Nouride Home asks (msn_d20ba6) passed its checks. PR 14 is merged to main.",
        "- 19:55 ✓ Back to Nouride Home asks (msn_d20ba6) done (checks passed, accepted). PR 14 is merged to main.",
      ].join("\n"),
    );
    expect(formatMissionNotices([event(DONE, 55)], clock)).toStartWith("[Since your last message here, your own missions told this chat 1 thing under your name. The person has read it and you had not:");
    expect(formatMissionNotices([], clock)).toBe("");
  });

  test("of a mission's progress lines only the newest is said, another mission's kept", () => {
    const block = formatMissionNotices(
      [
        event("… 3 of 11 steps done", 10, { mission: MISSION.id, progress: true }),
        event("… 2 of 4 steps done", 11, { mission: "msn_other", progress: true }),
        event("… 7 of 11 steps done", 33, { mission: MISSION.id, progress: true }),
        event(DONE, 55),
      ],
      clock,
    );
    expect(block).not.toContain("3 of 11");
    expect(block).toContain("- 19:11 … 2 of 4 steps done");
    expect(block).toContain("- 19:33 … 7 of 11 steps done");
    expect(block).toContain("3 things under your name");
  });

  test("a long notice is cut, and over its budget the block keeps the newest", () => {
    expect(formatMissionNotices([event(`done ${"x".repeat(900)}`, 1)], clock)).toContain(`- 19:01 done ${"x".repeat(695)}…`);
    const many = Array.from({ length: 12 }, (_, i) => event(`notice ${i} ${"y".repeat(500)}`, i));
    const block = formatMissionNotices(many, clock);
    expect(block).toContain("notice 11 ");
    expect(block).not.toContain("notice 0 ");
    expect(block.length).toBeLessThan(3_300);
    // The newest is said whatever its length.
    expect(formatMissionNotices([event("z".repeat(5_000), 1)], clock, 100)).toContain("- 19:01 zzz");
  });
});

async function room(turns: { text?: string }[]) {
  const local = new LocalGateway();
  let chatEvents!: ChatEventStore;
  const bench = await pipelineBench({
    turns,
    agents: ["nouva", "nox"],
    config: { agents: { mentions_enabled: true, mention_max_hops: 2, groups_require_mention: true } },
    gateways: [local],
    deps: ({ db }) => ({ chatEvents: (chatEvents = new ChatEventStore(db)) }),
  });
  cleanup.push(bench.dispose);
  bench.pipeline.setTools(new Map());
  bench.pipeline.attach();
  return {
    chatEvents,
    async say(text: string) {
      local.dispatch({ text, chatId: "room-1", chatType: "group" });
      await bench.pipeline.idle();
    },
    /** The message the provider was sent last, as the model reads it. */
    lastUser(): string {
      const sent = JSON.parse(JSON.stringify(bench.requests.at(-1))) as { messages: { content: unknown }[] };
      // The request ends with the daemon's own section on who is speaking: the message is the one before it.
      const said = sent.messages.map((message) => JSON.stringify(message.content)).filter((content) => !content.includes("<<<NOURIDE:DYNAMIC>>>"));
      return said.at(-1) ?? "";
    },
  };
}

describe("what reaches the agent", () => {
  test("its mission's notices arrive with the next message in that chat, as the person read them", async () => {
    const h = await room([{ text: "noted" }]);
    h.chatEvents.record(missionNotice(MISSION, PASSED));
    h.chatEvents.record(missionNotice(MISSION, DONE));
    await h.say("@nox is the files download still needed?");
    expect(h.lastUser()).toContain("your own missions told this chat 2 things under your name");
    expect(h.lastUser()).toContain("✓ Back to Nouride Home asks (msn_d20ba6) done (checks passed, accepted). PR 14 is merged to main.");
    expect(h.lastUser()).toContain("is the files download still needed?");
  });

  test("another agent of the room is not told", async () => {
    const h = await room([{ text: "noted" }]);
    h.chatEvents.record(missionNotice(MISSION, DONE));
    await h.say("@nouva what is new here?");
    expect(h.lastUser()).not.toContain("Back to Nouride Home asks");
    expect(h.lastUser()).not.toContain("your own missions");
  });

  test("once: the message after carries none of it again, and a notice since then alone", async () => {
    const h = await room([{ text: "one" }, { text: "two" }, { text: "three" }]);
    h.chatEvents.record(missionNotice(MISSION, DONE));
    await h.say("@nox first");
    expect(h.lastUser()).toContain("done (checks passed, accepted)");
    await nextMoment();
    await h.say("@nox second");
    expect(h.lastUser()).not.toContain("your own missions");
    await nextMoment();
    h.chatEvents.record(missionNotice({ ...MISSION, id: "msn_bbbb00000000000000000000" }, "⏸ The pear note (msn_bbbb00) needs you: a limit reached"));
    await nextMoment();
    await h.say("@nox third");
    expect(h.lastUser()).toContain("told this chat 1 thing under your name");
    expect(h.lastUser()).toContain("The pear note (msn_bbbb00) needs you: a limit reached");
    expect(h.lastUser()).not.toContain("done (checks passed, accepted)");
  });
});

describe("an agent on a coding CLI", () => {
  // Nix is one. Its prompt is the message itself, and its conversation is kept as that message was asked.
  test("is told the same in its own chat, in the message it is given, once", async () => {
    const seen: TurnRequest[] = [];
    const cli = {
      runnerFor: (_agent: LoadedAgent, d: ExecutorDeps): TurnBrain => ({
        run: async (req) => {
          seen.push(req);
          d.onText?.("ok");
          const turn = [req.userMessage, { role: "assistant" as const, content: "ok", timestamp: Date.now() }];
          const compaction = { threshold: 1e9, limit: 1e9, totalLimit: 1e9, source: "test", summaryModel: "", summarizerWindow: 0 };
          return { text: "ok", messages: [...req.history, ...turn], turnMessages: turn, usage: { inputTokens: 0, outputTokens: 0 }, toolCalls: 0, iterations: 0, approvalsRefused: 0, toolSteps: [], stopReason: "stop", contextTokens: 0, truncated: false, compaction, pressure: { threshold: 1e9, tokens: 0 } } as never;
        },
      }),
    };
    let chatEvents!: ChatEventStore;
    const bench = await pipelineBench({ agentToml: '[llm]\nprovider = "test"\n\n[external]\ncli = "fake"\n', deps: (({ db }: { db: never }) => ({ externalAgents: cli, chatEvents: (chatEvents = new ChatEventStore(db)) })) as never });
    cleanup.push(bench.dispose);
    bench.pipeline.attach();
    let sent = 0;
    const say = (text: string) => bench.gateway.receive(envelope({ id: `m${++sent}`, gatewayId: "telegram:main", chatId: "814", chatType: "dm", senderId: "u1", senderName: "Gading", text, timestamp: Date.now() }));
    chatEvents.record({ ...missionNotice({ ...MISSION, agentId: "nouva", gatewayId: "telegram:main", chatId: "814" }, DONE), at: Date.now() - 60_000 });
    say("hello, anything new?");
    await eventually(() => seen.length > 0, 5_000, "the first turn");
    const first = JSON.stringify(seen[0]!.userMessage.content);
    expect(first).toContain("your own missions told this chat 1 thing under your name");
    expect(first).toContain("done (checks passed, accepted)");
    await nextMoment();
    say("and now?");
    await eventually(() => seen.length > 1, 5_000, "the second turn");
    expect(JSON.stringify(seen[1]!.userMessage.content)).not.toContain("your own missions");
  });
});

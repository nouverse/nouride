/**
 * The chat list's order and the Groups tab's, as `lib/chat-list.ts` decides them: the orchestrator always first and
 * pinned, then agents, rooms and pinned groups mixed by when they last moved, then the agents nobody has talked to here
 * yet; Groups newest first, narrowed by an app's chip that counts it, with a group quiet for two weeks folded away;
 * and a group read here as one conversation across the agents in it.
 */

import { describe, expect, test } from "bun:test";
import type { AgentSummary, ChatListGroup, ChatListPayload, ChatTurn, LiveTurn } from "@nouride/wire";
import { chatsView, groupsView, QUIET_AFTER_MS } from "@/modules/chat/lib/chat-list";
import { chatOpen, onChats } from "@/commons/lib/chat-place";
import { groupStream } from "@/modules/chat/lib/group-stream";

const NOW = 1_800_000_000_000;
const agent = (id: string, displayName = id[0]!.toUpperCase() + id.slice(1)): AgentSummary => ({ id, displayName, enabled: true, state: "running", provider: "p", model: "m", tools: [], approvals: "careful" }) as AgentSummary;
const AGENTS = ["nouva", "nestor", "nix", "nero", "kuro", "nox"].map((id) => agent(id));
const said = (text: string) => ({ from: "agent" as const, text });

const LIST: ChatListPayload = {
  agents: [
    // The orchestrator's conversation is the oldest of all, and it still comes first.
    { agentId: "nouva", sessionId: "s-nouva", at: NOW - 5_000_000, last: said("morning summary"), working: false, helpers: 0 },
    { agentId: "nestor", sessionId: "s-nestor", at: NOW - 1_000, last: said("reading"), working: true, helpers: 3 },
    { agentId: "nix", sessionId: "s-nix", at: NOW - 300_000, last: said("PR is green"), working: false, helpers: 0 },
    { agentId: "nero", sessionId: "s-nero", at: NOW - 900_000, last: said("draft ready"), working: false, helpers: 0 },
    { agentId: "kuro", working: false, helpers: 0 },
    { agentId: "nox", working: false, helpers: 0 },
  ],
  rooms: [{ chatId: "room-1", title: "Harness research", members: ["nouva", "nix"], at: NOW - 100_000, working: false }],
  groups: [
    { platform: "telegram", chatId: "-100", name: "Office", agents: ["nouva"], sessions: [], at: NOW - 200_000, working: false, people: 2 },
    { platform: "discord", chatId: "881", name: "#general", agents: ["nero"], sessions: [], at: NOW - 50_000, working: false, people: 1 },
  ],
};

const view = (over: Partial<Parameters<typeof chatsView>[0]> = {}) =>
  chatsView({ agents: AGENTS, orchestrator: "nouva", list: LIST, pinnedGroups: [], query: "", nameOf: (id) => id, ...over });
const keys = (rows: { key: string }[]) => rows.map((row) => row.key);

describe("Chats", () => {
  test("the orchestrator first, whatever it last did; then the newest; then nobody talked to yet", () => {
    const chats = view();
    expect(chats.pinned?.key).toBe("agent:nouva");
    expect(keys(chats.recent)).toEqual(["agent:nestor", "room:room-1", "agent:nix", "agent:nero"]);
    expect(keys(chats.untouched)).toEqual(["agent:kuro", "agent:nox"]);
  });

  test("an agent and a room are one order: a room that moved after an agent comes before it", () => {
    const moved = { ...LIST, rooms: [{ ...LIST.rooms[0]!, at: NOW }] };
    expect(keys(view({ list: moved }).recent)[0]).toBe("room:room-1");
  });

  test("a group pinned to Chats joins it by when it moved; one not pinned stays in Groups", () => {
    const chats = view({ pinnedGroups: ["discord:881"] });
    expect(keys(chats.recent)).toEqual(["agent:nestor", "group:discord:881", "room:room-1", "agent:nix", "agent:nero"]);
    expect(keys(chats.recent)).not.toContain("group:telegram:-100");
  });

  test("an orchestrator nobody has talked to is still first, and not under Not talked to yet", () => {
    const chats = view({ list: { ...LIST, agents: LIST.agents.filter((entry) => entry.agentId !== "nouva") } });
    expect(chats.pinned?.key).toBe("agent:nouva");
    expect(keys(chats.untouched)).not.toContain("agent:nouva");
  });

  test("a search finds names and last lines, in every part of the list", () => {
    expect(keys(view({ query: "green" }).recent)).toEqual(["agent:nix"]);
    const kuro = view({ query: "kur" });
    expect(kuro.pinned).toBeNull();
    expect(keys(kuro.untouched)).toEqual(["agent:kuro"]);
    expect(keys(view({ query: "harness" }).recent)).toEqual(["room:room-1"]);
  });

  test("before the list has come, every agent is listed, the orchestrator first and the rest not talked to", () => {
    const chats = view({ list: undefined });
    expect(chats.pinned?.key).toBe("agent:nouva");
    expect(chats.recent).toEqual([]);
    expect(chats.untouched).toHaveLength(5);
  });
});

describe("Groups", () => {
  const group = (chatId: string, platform: string, at: number, name = chatId): ChatListGroup => ({ platform, chatId, name, agents: ["nouva"], sessions: [], at, working: false, people: 1 });
  const GROUPS = [
    group("a", "telegram", NOW - 60_000),
    group("b", "discord", NOW - 1_000),
    group("c", "telegram", NOW - QUIET_AFTER_MS - 1),
    group("d", "discord", NOW - 3 * QUIET_AFTER_MS, "#bookmarks"),
    group("e", "telegram", NOW - 120_000),
  ];
  const groups = (over: Partial<Parameters<typeof groupsView>[1]> = {}) =>
    groupsView(GROUPS, { platform: "all", query: "", now: NOW, nameOf: (id) => id, platformName: (id) => id[0]!.toUpperCase() + id.slice(1), ...over });

  test("newest first, and two weeks of quiet folds a group away, newest first there too", () => {
    const view = groups();
    expect(view.active.map((one) => one.chatId)).toEqual(["b", "a", "e"]);
    expect(view.quiet.map((one) => one.chatId)).toEqual(["c", "d"]);
  });

  test("a chip for All and for each app there is a group on, with how many: the busiest app first", () => {
    expect(groups().chips).toEqual([
      { value: "all", label: "All", count: 5 },
      { value: "telegram", label: "Telegram", count: 3 },
      { value: "discord", label: "Discord", count: 2 },
    ]);
  });

  test("a chip narrows the list to its app; a search narrows it further, the chips' counts unchanged", () => {
    expect(groups({ platform: "telegram" }).active.map((one) => one.chatId)).toEqual(["a", "e"]);
    const searched = groups({ platform: "discord", query: "bookmarks" });
    expect([...searched.active, ...searched.quiet].map((one) => one.chatId)).toEqual(["d"]);
    expect(searched.chips[0]).toEqual({ value: "all", label: "All", count: 5 });
  });
});

describe("a group read here", () => {
  const turn = (id: string, agentId: string, prompt: string, startedAt: number, status: ChatTurn["status"] = "done") =>
    ({ id, agentId, chatId: "-100", prompt, reply: `${agentId} answers`, status, toolCalls: 0, startedAt, steps: [] }) as ChatTurn;

  test("each agent's turns there in the order they happened, a message two agents answered drawn once", () => {
    const stream = groupStream(
      [turn("t3", "nix", "and the build?", 9_000), turn("t1", "nouva", "@nouva @nestor deploy?", 1_000), turn("t2", "nestor", "@nouva @nestor deploy?", 1_500)],
      [],
    );
    expect(stream.map((entry) => [entry.turn.id, entry.showPrompt])).toEqual([["t1", true], ["t2", false], ["t3", true]]);
  });

  test("the same words asked again later, or by the same agent, are drawn again", () => {
    const later = groupStream([turn("a", "nouva", "status?", 0), turn("b", "nestor", "status?", 120_000), turn("c", "nestor", "status?", 121_000)], []);
    expect(later.map((entry) => entry.showPrompt)).toEqual([true, true, true]);
  });

  test("a turn at work is the live feed's until the transcript has it finished", () => {
    const live = { ...turn("t9", "nouva", "go", 5_000, "running"), cursor: 3 } as LiveTurn;
    expect(groupStream([], [live]).map((entry) => entry.live)).toEqual([true]);
    expect(groupStream([turn("t9", "nouva", "go", 5_000)], [live]).map((entry) => entry.live)).toEqual([false]);
  });
});

describe("where the chat page is", () => {
  test("Chats is the chat page and anything under it, and nothing named like it", () => {
    expect(onChats("/chat")).toBe(true);
    expect(onChats("/chat/room/r1")).toBe(true);
    expect(onChats("/chatbot")).toBe(false);
    expect(onChats("/agents/chat")).toBe(false);
  });

  test("a conversation is open by its address, or by the agent or draft a new chat names; the bare list is not", () => {
    expect(chatOpen("/chat", "")).toBe(false);
    expect(chatOpen("/chat/ses_1", "")).toBe(true);
    expect(chatOpen("/chat/group/telegram/-100", "")).toBe(true);
    expect(chatOpen("/chat", "?agent=nix")).toBe(true);
    expect(chatOpen("/chat", "?draft=hello")).toBe(true);
    expect(chatOpen("/agents", "?agent=nix")).toBe(false);
  });
});

/**
 * The chat page as a person meets it: the list beside the conversation (its order, Groups, a group pinned to Chats), a
 * conversation from a chat app read here with nothing to write in, and an agent's History holding only its own
 * conversations.
 */

import { describe, expect, test } from "bun:test";
import type { ChatListPayload } from "@nouride/wire";
import { answer, dom, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const STATUS = WIRE["/status"] as { agents: Record<string, unknown>[] } & Record<string, unknown>;
const agent = (id: string) => ({ ...STATUS.agents[0], id, displayName: id[0]!.toUpperCase() + id.slice(1), headline: null });
const status = { ...STATUS, orchestrator: "nouva", agents: ["nouva", "nestor", "nix", "kuro"].map(agent) };
const NOW = Date.now();
const LIST: ChatListPayload = {
  agents: [
    { agentId: "nouva", sessionId: "ses_1", at: NOW - 3_600_000, last: { from: "agent", name: "nouva", text: "Morning summary is ready" }, working: false, helpers: 0 },
    { agentId: "nestor", sessionId: "ses_nestor", at: NOW - 60_000, last: { from: "person", text: "compare the caching" }, working: true, helpers: 3 },
    { agentId: "nix", sessionId: "ses_nix", at: NOW - 600_000, last: { from: "agent", name: "nix", text: "PR is green" }, working: false, helpers: 0 },
    { agentId: "kuro", working: false, helpers: 0 },
  ],
  rooms: [{ chatId: "room_1", title: "Harness research", members: ["nouva", "nix"], at: NOW - 120_000, working: false, untagged: "nouva" }],
  groups: [
    { platform: "telegram", chatId: "-100", name: "Nouverse Office", agents: ["nouva", "nestor"], sessions: [{ agentId: "nouva", sessionId: "ses_g1", gatewayId: "telegram:nouva" }], at: NOW - 30_000, last: { from: "person", name: "Sam", text: "thanks" }, working: false, people: 2 },
    { platform: "discord", chatId: "881", name: "#general", agents: ["nix"], sessions: [], at: NOW - 900_000, working: false, people: 1 },
    { platform: "discord", chatId: "882", name: "#bookmarks", agents: ["nix"], sessions: [], at: NOW - 40 * 86_400_000, working: false, people: 1 },
  ],
};
const list = { "/status": { status: 200, body: status }, "/chat-list": { status: 200, body: LIST } };

const aside = (host: HTMLElement) => host.querySelector('aside[aria-label="Chats"]') as HTMLElement | null;
/** The names of the list's rows, in order. */
const rowNames = (host: HTMLElement) => [...(aside(host)?.querySelectorAll("a, button[aria-expanded]") ?? [])].map((row) => row.querySelector(".truncate.font-display")?.textContent?.trim()).filter(Boolean);
const byText = (root: ParentNode, text: string) => [...root.querySelectorAll("button, a")].find((el) => el.textContent?.trim().startsWith(text)) as HTMLElement | undefined;

describe("the list beside the chat", () => {
  test("the orchestrator first and tagged, then the newest, then the agents nobody has talked to yet", async () => {
    answer(list);
    let names: unknown[] = [];
    let text = "";
    await renderPage("/chat", async (host) => {
      await eventually(() => rowNames(host).includes("Kuro"), 3_000, "the list");
      names = rowNames(host);
      text = aside(host)!.textContent ?? "";
    });
    expect(names).toEqual(["Nouva", "Nestor", "Harness research", "Nix", "Kuro"]);
    expect(text).toContain("Orchestrator");
    expect(text).toContain("Working · 3 helpers");
    expect(text.indexOf("Not talked to yet")).toBeLessThan(text.indexOf("Say hi to Kuro"));
  });

  test("an agent's row carries on its newest conversation; one nobody talked to starts a new chat with it", async () => {
    answer(list);
    let hrefs: Record<string, string> = {};
    await renderPage("/chat", async (host) => {
      await eventually(() => rowNames(host).includes("Kuro"), 3_000, "the list");
      const link = (name: string) => [...aside(host)!.querySelectorAll("a")].find((a) => a.textContent?.includes(name))!.getAttribute("href") ?? "";
      hrefs = { nix: link("PR is green"), kuro: link("Say hi to Kuro"), room: link("Harness research") };
    });
    expect(hrefs.nix).toBe("/dashboard/chat/ses_nix");
    expect(hrefs.kuro).toContain("/dashboard/chat?agent=");
    expect(hrefs.kuro).toContain("kuro");
    expect(hrefs.room).toBe("/dashboard/chat/room/room_1");
  });

  test("Groups: one row each, newest first, a chip per app with its count, and the quiet ones folded until asked", async () => {
    answer(list);
    const seen: Record<string, unknown> = {};
    await renderPage("/chat", async (host) => {
      await eventually(() => byText(aside(host)!, "Groups") !== undefined, 3_000, "the switch");
      byText(aside(host)!, "Groups")!.click();
      await eventually(() => aside(host)!.textContent?.includes("Nouverse Office") === true, 2_000, "Groups");
      seen.rows = rowNames(host);
      seen.chips = [...aside(host)!.querySelectorAll('[role="group"] button')].map((chip) => chip.textContent);
      byText(aside(host)!, "1 quiet group")!.click();
      await eventually(() => rowNames(host).includes("#bookmarks"), 2_000, "the quiet group");
      seen.opened = rowNames(host);
      byText(aside(host)!, "Discord")!.click();
      await eventually(() => !rowNames(host).includes("Nouverse Office"), 2_000, "Discord only");
      seen.discord = rowNames(host);
    });
    expect(seen.rows).toEqual(["Nouverse Office", "#general", "1 quiet group"]);
    expect(seen.chips).toEqual(["All3", "Discord2", "Telegram1"]);
    expect(seen.opened).toEqual(["Nouverse Office", "#general", "1 quiet group", "#bookmarks"]);
    expect(seen.discord).toEqual(["#general", "1 quiet group", "#bookmarks"]);
  });

  test("a group pinned to Chats in this browser is in Chats, by when it moved", async () => {
    answer(list);
    dom.localStorage.setItem("nouride-chat-pinned-groups", JSON.stringify(["telegram:-100"]));
    let names: unknown[] = [];
    try {
      await renderPage("/chat", async (host) => {
        await eventually(() => rowNames(host).includes("Nouverse Office"), 3_000, "the pinned group");
        names = rowNames(host);
      });
    } finally {
      dom.localStorage.removeItem("nouride-chat-pinned-groups");
    }
    expect(names).toEqual(["Nouva", "Nouverse Office", "Nestor", "Harness research", "Nix", "Kuro"]);
  });
});

describe("a conversation from a chat app", () => {
  test("a private chat on Telegram: its app on the cat and in the header, and a note where the box would be", async () => {
    const transcript = { session: { id: "ses_dm", agentId: "nouva", chatId: "555", gatewayId: "telegram:nouva", updatedAt: NOW, writable: false }, earlier: [], turns: [], events: [], messages: [] };
    answer({ ...list, "/sessions/ses_dm/turns": { status: 200, body: transcript }, "/sessions/ses_dm/notes": { status: 404, body: { error: "no notes" } } });
    const seen: Record<string, unknown> = {};
    await renderPage("/chat/ses_dm", async (host) => {
      await eventually(() => host.querySelector('[role="note"]') !== null, 3_000, "the note");
      seen.note = host.querySelector('[role="note"]')!.textContent;
      seen.box = host.querySelector("textarea") !== null;
      seen.header = host.querySelector("header h2")?.closest("header")?.textContent;
      seen.mark = host.querySelector('header [role="img"][aria-label="Telegram"]') !== null;
    });
    expect(seen.box).toBe(false);
    expect(seen.note).toContain("Read-only here. This chat lives on Telegram");
    expect(seen.header).toContain("Read-only");
    expect(seen.mark).toBe(true);
  });

  test("a group: read-only, nothing to write in, and Pin to Chats keeps it in this browser", async () => {
    answer(list);
    const seen: Record<string, unknown> = {};
    try {
      await renderPage("/chat/group/telegram/-100", async (host) => {
        await eventually(() => host.querySelector('[role="note"]') !== null, 3_000, "the note");
        seen.note = host.querySelector('[role="note"]')!.textContent;
        seen.box = host.querySelector("textarea") !== null;
        seen.header = host.querySelector("header h2")?.closest("header")?.textContent;
        (host.querySelector('button[aria-label="Pin to Chats"]') as HTMLElement).click();
        await eventually(() => host.querySelector('button[aria-label="Unpin from Chats"]') !== null, 2_000, "pinned");
        seen.kept = dom.localStorage.getItem("nouride-chat-pinned-groups");
      });
    } finally {
      dom.localStorage.removeItem("nouride-chat-pinned-groups");
    }
    expect(seen.box).toBe(false);
    expect(seen.note).toContain("This group lives on Telegram: write there, and the agents answer there.");
    expect(seen.header).toContain("Telegram group");
    expect(seen.header).toContain("Agents here: Nouva, Nestor");
    expect(seen.kept).toBe(JSON.stringify(["telegram:-100"]));
  });
});

describe("an agent's History", () => {
  test("lists only that agent's conversations: its own here and on chat apps, never a room's or a group's", async () => {
    const mine = (id: string, chatId: string, gatewayId = "web:dashboard", title = id) => ({ id, agentId: "nouva", chatId, gatewayId, updatedAt: NOW - 1_000, title });
    const sessions = [mine("ses_1", "web-1", "web:dashboard", "is the disk full?"), mine("ses_dm", "555", "telegram:nouva", "a private chat"), mine("ses_r", "room_1", "web:dashboard", "in the room"), mine("ses_g1", "-100", "telegram:nouva", "in the group")];
    answer({ ...list, "/sessions?agent=nouva": { status: 200, body: { sessions, total: 4 } } });
    let rows: string[] = [];
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => host.querySelector(`button[aria-label="Nouva's conversations"]`) !== null, 3_000, "History");
      (host.querySelector(`button[aria-label="Nouva's conversations"]`) as HTMLElement).click();
      const panel = () => dom.document.body.querySelector(`[role="dialog"][aria-label="Nouva's conversations"]`);
      await eventually(() => (panel()?.textContent ?? "").includes("a private chat"), 3_000, "the History");
      rows = [...panel()!.querySelectorAll("a[href*='/chat/ses']")].map((row) => row.textContent ?? "");
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("is the disk full?");
    expect(rows[1]).toContain("a private chat");
    expect(rows[1]).toContain("Telegram · read-only");
  });
});

describe("New room, from the list's +", () => {
  // A fieldset is as wide as its widest line unless told otherwise: a long headline ran past the dialog's edge on a
  // phone, cut off with no ellipsis, where each line is meant to end in one.
  test("lists every agent with its headline, each line cut inside the dialog rather than running past it", async () => {
    answer({ ...list, "/status": { status: 200, body: { ...status, agents: status.agents.map((one) => ({ ...one, headline: "A headline far longer than any phone is wide, about the odd jobs nobody else wants" })) } } });
    const seen: Record<string, unknown> = {};
    await renderPage("/chat", async (host) => {
      await eventually(() => host.querySelector('button[aria-label="Start a chat or a room"]') !== null, 3_000, "the +");
      (host.querySelector('button[aria-label="Start a chat or a room"]') as HTMLElement).click();
      await eventually(() => byText(host.ownerDocument.body, "New room") !== undefined, 2_000, "the menu");
      byText(host.ownerDocument.body, "New room")!.click();
      const dialog = () => dom.document.body.querySelector('[role="dialog"][aria-label="New room"]');
      await eventually(() => dialog()?.querySelector("fieldset") != null, 2_000, "the dialog");
      const fieldset = dialog()!.querySelector("fieldset")!;
      seen.fieldset = fieldset.className.split(/\s+/);
      seen.names = [...fieldset.querySelectorAll("label")].map((label) => label.querySelector(".truncate")?.textContent);
      seen.lines = [...fieldset.querySelectorAll("label > span.flex-col")].map((span) => span.className.split(/\s+/));
    });
    expect(seen.fieldset).toContain("min-w-0");
    expect(seen.names).toEqual(["Nouva", "Nestor", "Nix", "Kuro"]);
    expect(seen.lines).toHaveLength(4);
    for (const line of seen.lines as string[][]) expect(line).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
  });
});

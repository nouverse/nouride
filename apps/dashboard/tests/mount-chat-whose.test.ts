/**
 * Whose chats the chat page lists: the reader's own, and — an admin's alone — everyone's, set apart by person, with
 * the scheduled jobs' own and the chats nobody in People is known for last. Anyone else has nothing to pick: the
 * daemon answers them with their own whatever is asked (`whose.ts`), and the page offers no choice it would not keep.
 */

import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "@nouride/wire";
import { groupByPerson, ownConversations } from "@/modules/chat/lib/history";
import { EVERYONE_WORDS } from "@/modules/chat/components/EveryoneList";
import { peopleOptions } from "@/modules/chat/components/PeopleFilter";
import { answer, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";


useMountHarness();

const NOW = Date.now();
const row = (id: string, more: Partial<SessionSummary>): SessionSummary => ({ id, agentId: "nouva", chatId: id, gatewayId: "web:dashboard", updatedAt: NOW, kind: "private", ...more });
const EVERYONE: SessionSummary[] = [
  row("ses_r1", { title: "resep rendang", person: { key: "rina", name: "Rina" } }),
  row("ses_job", { title: "the morning line", kind: "job", gatewayId: "telegram:nouva" }),
  row("ses_g1", { title: "gaji bulan ini", person: { key: "gading", name: "Gading" } }),
  row("ses_x", { title: "siapa ini", gatewayId: "whatsapp:nouva" }),
  row("ses_r2", { title: "belanja", person: { key: "rina", name: "Rina" } }),
];

describe("everyone's, set apart", () => {
  test("by person in the order of their newest, then the scheduled jobs' own, then nobody known — each newest first", () => {
    expect(groupByPerson(EVERYONE, EVERYONE_WORDS).map((group) => [group.label, group.sessions.map((one) => one.id)])).toEqual([
      ["Rina", ["ses_r1", "ses_r2"]],
      ["Gading", ["ses_g1"]],
      ["Scheduled jobs", ["ses_job"]],
      ["Not known", ["ses_x"]],
    ]);
  });

  test("a group's or a room's conversation is not one of an agent's own, as the daemon says what each is", () => {
    const listed = [row("a", {}), row("b", { kind: "group" }), row("c", { kind: "room" }), row("d", { kind: "job" })];
    expect(ownConversations(listed, undefined).map((one) => one.id)).toEqual(["a", "d"]);
  });
});

const ME = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
const signedIn = (role: string) => ({ ...ME, role, user: { ...ME.user, role } });
const tabs = (host: HTMLElement) => [...host.querySelectorAll('[role="tablist"]')].map((list) => list.getAttribute("aria-label"));

describe("the chat list", () => {
  test("offers an admin Mine and Everyone, and Everyone lists each person's chats under their name", async () => {
    answer({ "/auth/me": { status: 200, body: signedIn("admin") }, "/sessions": { status: 200, body: { sessions: EVERYONE, total: EVERYONE.length } } });
    let lists: (string | null)[] = [];
    let headings: string[] = [];
    await renderPage("/chat", async (host) => {
      await eventually(() => tabs(host).includes("Whose chats"), 3_000, "the choice");
      lists = tabs(host);
      ([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.trim() === "Everyone") as HTMLElement).click();
      await eventually(() => (host.querySelector('aside[aria-label="Chats"]')?.textContent ?? "").includes("Not known"), 3_000, "everyone's");
      headings = [...host.querySelectorAll('aside[aria-label="Chats"] section')].map((section) => section.getAttribute("aria-label") ?? "");
      // Put back: the choice is kept in this browser, and the next test opens on Mine.
      ([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.trim() === "Mine") as HTMLElement).click();
    });
    expect(lists).toContain("Whose chats");
    expect(headings).toEqual(["Rina", "Gading", "Scheduled jobs", "Not known"]);
  });

  test("narrows everyone's to one person, found by typing part of their name", async () => {
    const sams = [row("ses_s1", { title: "jadwal arisan", person: { key: "sam", name: "Kak Sam" } })];
    answer({
      "/auth/me": { status: 200, body: signedIn("admin") },
      "/sessions": { status: 200, body: { sessions: EVERYONE, total: EVERYONE.length } },
      "/sessions?whose=person:sam": { status: 200, body: { sessions: sams, total: 1 } },
    });
    let offered: string[] = [];
    let headings: string[] = [];
    await renderPage("/chat", async (host) => {
      await eventually(() => tabs(host).includes("Whose chats"), 3_000, "the choice");
      ([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.trim() === "Everyone") as HTMLElement).click();
      await eventually(() => host.querySelector('input[aria-label="Whose chats, by person"]') !== null, 3_000, "the person filter");
      const field = host.querySelector('input[aria-label="Whose chats, by person"]') as HTMLInputElement;
      field.focus();
      type(field, "sam");
      await eventually(() => document.querySelectorAll('[role="listbox"][aria-label="People"] [role="option"]').length > 0, 3_000, "the people listed");
      offered = [...document.querySelectorAll('[role="listbox"][aria-label="People"] [role="option"]')].map((option) => option.textContent?.trim() ?? "");
      (document.querySelector('[role="listbox"][aria-label="People"] [role="option"] button') as HTMLElement).click();
      await eventually(() => (host.querySelector('aside[aria-label="Chats"]')?.textContent ?? "").includes("jadwal arisan"), 3_000, "her chats");
      headings = [...host.querySelectorAll('aside[aria-label="Chats"] section')].map((section) => section.getAttribute("aria-label") ?? "");
      // Put back: the choices are kept in this browser, and the next test opens on Mine.
      (host.querySelector('button[aria-label="All people"]') as HTMLElement | null)?.click();
      ([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.trim() === "Mine") as HTMLElement).click();
    });
    expect(offered).toEqual(["Kak Sam"]);
    expect(headings).toEqual(["Kak Sam"]);
  });

  test("lists every person, by name, between all of them and nobody known", () => {
    expect(peopleOptions([{ key: "raka", name: "Raka" }, { key: "sam", name: "Kak Sam" }]).map((option) => `${option.value}=${option.label}`)).toEqual(["=All people", "person:sam=Kak Sam", "person:raka=Raka", "unknown=Not known"]);
  });

  test("offers nothing to pick to anyone else", async () => {
    answer({ "/auth/me": { status: 200, body: signedIn("operator") } });
    let lists: (string | null)[] = [];
    await renderPage("/chat", async (host) => {
      await eventually(() => tabs(host).includes("What to list"), 3_000, "the list");
      lists = tabs(host);
    });
    expect(lists).not.toContain("Whose chats");
  });
});

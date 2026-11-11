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
const tablists = (host: HTMLElement) => [...host.querySelectorAll('[role="tablist"]')].map((list) => list.getAttribute("aria-label"));
const trigger = (host: HTMLElement) => host.querySelector('button[aria-label^="Whose chats:"]') as HTMLButtonElement | null;
const offered = () => [...document.querySelectorAll('[role="listbox"][aria-label="Whose chats"] [role="option"]')].map((option) => option.textContent?.trim() ?? "");
const choose = (label: string) => ([...document.querySelectorAll('[role="listbox"][aria-label="Whose chats"] [role="option"] button')].find((button) => button.textContent?.trim() === label) as HTMLElement).click();
const headings = (host: HTMLElement) => [...host.querySelectorAll('aside[aria-label="Chats"] section')].map((section) => section.getAttribute("aria-label") ?? "");

describe("the chat list", () => {
  test("gives an admin one dropdown beside the search, Mine first, and no second bar of tabs", async () => {
    answer({ "/auth/me": { status: 200, body: signedIn("admin") }, "/sessions": { status: 200, body: { sessions: EVERYONE, total: EVERYONE.length } } });
    let label = null as string | null;
    let lists: (string | null)[] = [];
    let list: string[] = [];
    let after: string[] = [];
    let sameRow = false;
    await renderPage("/chat", async (host) => {
      await eventually(() => trigger(host) !== null, 3_000, "the dropdown");
      label = trigger(host)!.getAttribute("aria-label");
      lists = tablists(host);
      // In the search's row, right after it: not a row of its own under it.
      const before = trigger(host)!.previousElementSibling;
      sameRow = before?.tagName === "LABEL" && before.querySelector(':scope > input[type="search"]') !== null;
      trigger(host)!.click();
      await eventually(() => offered().length > 0, 3_000, "the list");
      list = offered();
      choose("Everyone");
      await eventually(() => (host.querySelector('aside[aria-label="Chats"]')?.textContent ?? "").includes("Not known"), 3_000, "everyone's");
      after = headings(host);
      // Put back: the choice is kept in this browser, and the next test opens on Mine.
      trigger(host)!.click();
      await eventually(() => offered().length > 0, 3_000, "the list again");
      choose("Mine");
    });
    expect(label).toBe("Whose chats: Mine");
    expect(sameRow).toBe(true);
    expect(lists).toEqual(["What to list"]);
    expect(list).toEqual(["Mine", "Everyone", "Gading", "Kak Sam", "Raka", "Not known"]);
    expect(after).toEqual(["Rina", "Gading", "Scheduled jobs", "Not known"]);
  });

  test("finds a person as their name is typed, and picking them lists only theirs", async () => {
    const sams = [row("ses_s1", { title: "jadwal arisan", person: { key: "sam", name: "Kak Sam" } })];
    answer({
      "/auth/me": { status: 200, body: signedIn("admin") },
      "/sessions": { status: 200, body: { sessions: EVERYONE, total: EVERYONE.length } },
      "/sessions?whose=person:sam": { status: 200, body: { sessions: sams, total: 1 } },
    });
    let found: string[] = [];
    let shown: string[] = [];
    await renderPage("/chat", async (host) => {
      await eventually(() => trigger(host) !== null, 3_000, "the dropdown");
      trigger(host)!.click();
      await eventually(() => document.querySelector('input[aria-label="Find a person"]') !== null, 3_000, "the field");
      type(document.querySelector('input[aria-label="Find a person"]') as HTMLInputElement, "sam");
      await eventually(() => offered().length === 1, 3_000, "one person found");
      found = offered();
      choose("Kak Sam");
      await eventually(() => (host.querySelector('aside[aria-label="Chats"]')?.textContent ?? "").includes("jadwal arisan"), 3_000, "her chats");
      shown = headings(host);
      trigger(host)!.click();
      await eventually(() => offered().length > 0, 3_000, "the list again");
      choose("Mine");
    });
    expect(found).toEqual(["Kak Sam"]);
    expect(shown).toEqual(["Kak Sam"]);
  });

  test("lists Mine, Everyone, each person by name, then nobody known", () => {
    expect(peopleOptions([{ key: "raka", name: "Raka" }, { key: "sam", name: "Kak Sam" }]).map((option) => `${option.value}=${option.label}`)).toEqual([
      "mine=Mine",
      "everyone=Everyone",
      "person:sam=Kak Sam",
      "person:raka=Raka",
      "unknown=Not known",
    ]);
  });

  test("leaves the reader's own person out of the names: Mine is theirs already", async () => {
    expect(peopleOptions([{ key: "raka", name: "Raka" }, { key: "gading", name: "Gading" }], "gading").map((option) => option.label)).toEqual(["Mine", "Everyone", "Raka", "Not known"]);
    // Nobody to leave out for an account that is no person, or one whose person is not in the list.
    expect(peopleOptions([{ key: "gading", name: "Gading" }], undefined).map((option) => option.label)).toEqual(["Mine", "Everyone", "Gading", "Not known"]);

    answer({
      "/auth/me": { status: 200, body: signedIn("admin") },
      "/sessions": { status: 200, body: { sessions: EVERYONE, total: EVERYONE.length } },
      "/people/me": { status: 200, body: { person: { key: "gading", name: "Gading" } } },
    });
    let list: string[] = [];
    await renderPage("/chat", async (host) => {
      await eventually(() => trigger(host) !== null, 3_000, "the dropdown");
      trigger(host)!.click();
      await eventually(() => offered().length > 0 && !offered().includes("Gading"), 3_000, "the list without the reader's own name");
      list = offered();
    });
    expect(list).toEqual(["Mine", "Everyone", "Kak Sam", "Raka", "Not known"]);
  });

  test("a choice of their own name, kept from before, is Mine", async () => {
    localStorage.setItem("nouride-chat-whose", JSON.stringify("person:gading"));
    answer({
      "/auth/me": { status: 200, body: signedIn("admin") },
      "/sessions": { status: 200, body: { sessions: EVERYONE, total: EVERYONE.length } },
      "/people/me": { status: 200, body: { person: { key: "gading", name: "Gading" } } },
    });
    let label = null as string | null;
    await renderPage("/chat", async (host) => {
      await eventually(() => trigger(host)?.getAttribute("aria-label") === "Whose chats: Mine", 3_000, "the dropdown reading Mine");
      label = trigger(host)!.getAttribute("aria-label");
    });
    expect(label).toBe("Whose chats: Mine");
    expect(JSON.parse(localStorage.getItem("nouride-chat-whose") ?? "null")).toBe("mine");
  });

  test("offers nothing to pick to anyone else", async () => {
    answer({ "/auth/me": { status: 200, body: signedIn("operator") } });
    let present = true;
    await renderPage("/chat", async (host) => {
      await eventually(() => tablists(host).includes("What to list"), 3_000, "the list");
      present = trigger(host) !== null;
    });
    expect(present).toBe(false);
  });
});

/**
 * The agents open to everyone, kept apart from the Access page: a page of their own, one agent's people at a time, and
 * the word "Open" beside such an agent wherever the orchestrator's crown would be.
 *
 * Each case is a way an open agent's strangers would be put among the household's senders (a row, a count, a filter on
 * the Access page), two open agents' people put together in one list, the list or its search still on the agent's
 * tab, the main-agent button offered to an agent the daemon refuses it for, or an open agent nobody could tell apart in
 * a list. Mounted over the shared harness (`mount-harness.ts`), the daemon's answers as it gives them.
 */

import { describe, expect, test } from "bun:test";
import type { AgentOpen, AgentSummary, ChatListPayload, PublicConversation } from "@nouride/wire";
import { OPEN_TO_EVERYONE } from "../src/commons/components/agents/AgentName.tsx";
import { limitsSaid } from "../src/modules/access/open-agents.page.tsx";
import { answer, dropdown, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const STATUS = WIRE["/status"] as { agents: AgentSummary[] } & Record<string, unknown>;
const ME = WIRE["/auth/me"] as { role: string; user: { role: string } };
const OPERATOR = { "/auth/me": ok({ ...ME, role: "operator", user: { ...ME.user, role: "operator" } }) };
const AT = Date.now() - 3_600_000;

const LIMITS = { maxDailyTokens: 200_000, maxDailyMessagesPerPerson: 30, closedReply: null };
const OPEN_NORA: AgentOpen = { never: null, notes: false, connections: ["telegram:nora", "whatsapp:shop"], limits: LIMITS, today: { tokens: 1_200, estimated: false, people: 2, messages: 5 } };
const OPEN_OMAR: AgentOpen = { never: null, notes: false, connections: ["telegram:omar"], limits: { ...LIMITS, maxDailyMessagesPerPerson: 1 }, today: { tokens: 300, estimated: false, people: 1, messages: 1 } };
const agent = (id: string, access: AgentSummary["access"], open?: AgentOpen): AgentSummary => ({ ...STATUS.agents[0]!, id, displayName: id[0]!.toUpperCase() + id.slice(1), access, ...(open ? { open } : {}) });
const NOUVA = agent("nouva", "follow");
const NIX = agent("nix", "follow");
/** Nora, open; and as she is once closed again, her limits kept. */
const NORA = agent("nora", "open", OPEN_NORA);
const NORA_CLOSED = agent("nora", "follow", { ...OPEN_NORA, today: undefined });
const OMAR = agent("omar", "open", OPEN_OMAR);
const statusOf = (...agents: AgentSummary[]) => ok({ ...STATUS, orchestrator: "nouva", agents });

const gateway = (id: string, agentId: string) => ({ id, platform: id.split(":")[0], name: id.split(":")[1], enabled: true, tokenSecret: "", agent: agentId, status: "connected", hasCredential: true });
const GATEWAYS = ok({ gateways: [gateway("telegram:nouva", "nouva"), gateway("telegram:nix", "nix"), gateway("telegram:nora", "nora"), gateway("whatsapp:shop", "nora"), gateway("telegram:omar", "omar")], editable: true });
const sender = (gatewayId: string, senderId: string, senderName: string, status: string) => ({
  gatewayId, senderId, senderName, status, code: status === "pending" ? "ABC123" : null, chatId: null, requestedAt: AT,
  expiresAt: status === "pending" || status === "denied" ? AT + 86_400_000 : null, resolvedAt: status === "pending" ? null : AT, resolvedBy: status === "pending" ? null : "gading",
});
/** The household's senders on Nouva's bot, and what Nora's and Omar's connections hold: one let in before Nora was opened, and the blocked. */
const SENDERS = [
  sender("telegram:nouva", "1001", "Sam Waiting", "pending"),
  sender("telegram:nouva", "1002", "Alex Approved", "approved"),
  sender("telegram:nouva", "1003", "Dina Denied", "denied"),
  sender("telegram:nouva", "1004", "Spam Account", "blocked"),
  sender("telegram:nora", "2001", "Rudi Before", "approved"),
  sender("telegram:nora", "2002", "Bot Spammer", "blocked"),
  sender("whatsapp:shop", "62812@s.whatsapp.net", "Siti Rude", "blocked"),
  sender("telegram:omar", "3001", "Omar Troll", "blocked"),
];
const ACCESS = ok({ mode: "pair", editable: true, allowlist: ["telegram:nouva:5555", "telegram:nora:7777", "9999"], senders: SENDERS, approvedTotal: 2 });
const HISTORY = ok({
  entries: [
    { action: "access_approved", actor: "gading", gatewayId: "telegram:nouva", details: { sender: "1002", sender_name: "Alex Approved" }, timestamp: AT },
    { action: "access_blocked", actor: "gading", gatewayId: "telegram:nora", details: { sender: "2002", sender_name: "Bot Spammer" }, timestamp: AT + 1 },
  ],
});
const row = (sessionId: string, gatewayId: string, name: string): PublicConversation => ({ sessionId, gatewayId, chatId: sessionId, kind: "private", sender: { id: sessionId, name, blocked: false }, title: `asked by ${name}`, updatedAt: AT });
const PUBLIC = {
  // Two of her four conversations on the page: what the count card counts is all four.
  "/agents/nora/public": ok({ conversations: [row("ses_budi", "telegram:nora", "Budi"), row("ses_ani", "whatsapp:shop", "Ani")], total: 4, nextBefore: AT }),
  "/agents/omar/public": ok({ conversations: [row("ses_joko", "telegram:omar", "Joko")], total: 1 }),
};
const house = (...agents: AgentSummary[]) => ({ "/status": statusOf(...agents), "/gateways": GATEWAYS, "/access": ACCESS, "/access/history": HISTORY, ...PUBLIC });

const tab = (host: HTMLElement, label: string) => ([...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((one) => one.textContent?.trim().startsWith(label)) as HTMLElement).click();
const tabs = (host: HTMLElement) => [...host.querySelectorAll('[role="tab"]')].map((one) => one.textContent?.replace(/\s+/g, "").trim());
const people = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-public-conversations] > li")].map((one) => one.dataset.row);
/** The page's own list under its tabs, by the title it starts with. */
const listCard = (host: HTMLElement, starts: string) => [...host.querySelectorAll<HTMLElement>("section")].find((one) => one.querySelector("h2, h3")?.textContent?.startsWith(starts));
const text = (host: HTMLElement) => host.textContent ?? "";
/** Every address under `/agents/` the page asks for from here, by path. */
function asking() {
  const asked: string[] = [];
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost");
    if (url.pathname.includes("/public")) asked.push(url.pathname.replace(/^\/api\/control/, ""));
    if (init?.method === "POST") asked.push(`POST ${url.pathname.replace(/^\/api\/control/, "")}${url.search}`);
    return (spy as typeof fetch)(input as RequestInfo, init);
  }) as typeof fetch;
  return { asked, restore: () => void (globalThis.fetch = spy) };
}

describe("the Access page", () => {
  test("is the household's alone: an open agent is no filter, and its connections' people are in no tab and no count", async () => {
    answer(house(NOUVA, NIX, NORA, OMAR));
    const seen = { options: [] as string[], tabs: [] as unknown[], pending: "", approved: "", denied: "", blocked: "", history: "" };
    await renderPage("/access", async (host) => {
      await eventually(() => text(host).includes("Sam Waiting"), 3_000, "the list");
      seen.tabs = tabs(host);
      seen.pending = text(host);
      tab(host, "Approved");
      await eventually(() => text(host).includes("Alex Approved"), 2_000, "Approved");
      seen.approved = text(host);
      tab(host, "Denied");
      await eventually(() => text(host).includes("Dina Denied"), 2_000, "Denied");
      seen.denied = text(host);
      tab(host, "Blocked");
      await eventually(() => text(host).includes("Spam Account"), 2_000, "Blocked");
      seen.blocked = text(host);
      tab(host, "History");
      await eventually(() => text(host).includes("Alex Approved"), 2_000, "History");
      seen.history = text(host);
      seen.options = await dropdown(host, "Agent").open();
    });
    expect(seen.options).toEqual(["All agents", "♛ nouva", "nix"]);
    // Rudi, let in on Nora's bot before she was opened, is not counted while she is open: the server's 2 less him.
    expect(seen.tabs).toEqual(["Pending1", "Approved1", "Denied1", "Blocked1", "History"]);
    expect(seen.approved).not.toContain("Rudi Before");
    // A qualified id on her bot is not shown let in; one on every connection is.
    expect(seen.approved).not.toContain("telegram:nora:7777");
    for (const one of [seen.pending, seen.approved, seen.denied, seen.blocked, seen.history]) {
      expect(one).not.toContain("Bot Spammer");
      expect(one).not.toContain("Siti Rude");
      expect(one).not.toContain("Omar Troll");
    }
  });

  test("a link from before to an open agent says where its people are; closed again, they are back here by themselves", async () => {
    answer(house(NOUVA, NORA));
    let said = "";
    let link = "";
    await renderPage("/access?agent=nora", async (host) => {
      await eventually(() => text(host).includes("nora is open to everyone"), 3_000, "the pointer");
      said = text(host);
      link = [...host.querySelectorAll("a")].find((one) => one.textContent?.trim() === "Open agents" && one.closest("section"))?.getAttribute("href") ?? "";
    });
    expect(said).toContain("Nobody asks it for a code, so it has nobody waiting, approved or denied here.");
    expect(said).not.toContain("Bot Spammer");
    expect(link).toBe("/dashboard/open-agents?agent=nora");

    answer(house(NOUVA, NIX, NORA_CLOSED, OMAR));
    let back = { tabs: [] as unknown[], blocked: "", options: [] as string[] };
    await renderPage("/access?tab=blocked", async (host) => {
      await eventually(() => text(host).includes("Siti Rude"), 3_000, "her blocked, back");
      back = { tabs: tabs(host), blocked: text(host), options: await dropdown(host, "Agent").open() };
    });
    expect(back.blocked).toContain("Bot Spammer");
    expect(back.tabs).toEqual(["Pending1", "Approved2", "Denied1", "Blocked3", "History"]);
    // Hers back, Omar's, still open, not.
    expect(back.blocked).not.toContain("Omar Troll");
    expect(back.options).toEqual(["All agents", "♛ nouva", "nix", "nora"]);
  });
});

describe("the Open agents page", () => {
  test("is the Access page's template: its rules, then the tabs, the filter and the agent in the row that stays, and the tab's list", async () => {
    answer(house(NOUVA, NORA));
    const calls = asking();
    const seen = { options: [] as string[], today: "", tabs: [] as unknown[], rows: [] as unknown[], filter: "", blocked: "", title: "", where: {} as Record<string, unknown> };
    try {
      await renderPage("/open-agents", async (host, app) => {
        await eventually(() => people(host).length === 2 && tabs(host).join() === "Wrote4,Letin1,Blocked2", 3_000, "the page");
        seen.tabs = tabs(host);
        seen.today = host.querySelector("[data-open-today]")?.textContent ?? "";
        seen.rows = people(host);
        // The filter and the tabs in the one row that stays at the top, as on the Access page.
        const row = host.querySelector<HTMLElement>("[data-sticky-bar]");
        seen.filter = row?.querySelector('input[placeholder="Filter people"]') && row.querySelector('[role="tablist"]') ? "in the row" : "elsewhere";
        // The picker is there with one open agent too, as Access's is: hers alone, and no "All".
        seen.options = await dropdown(host, "Agent").open();
        tab(host, "Blocked");
        await eventually(() => listCard(host, "Blocked (") !== undefined, 2_000, "Blocked");
        const blocked = listCard(host, "Blocked (")!;
        seen.blocked = blocked.textContent ?? "";
        const unblock = [...blocked.querySelectorAll<HTMLElement>("li")].find((one) => one.textContent?.includes("Siti Rude"))!.querySelector("button")!;
        seen.title = unblock.getAttribute("title") ?? "";
        unblock.click();
        await eventually(() => calls.asked.some((one) => one.startsWith("POST /access/unblock")), 2_000, "the unblock");
        seen.where = app.search();
      });
    } finally {
      calls.restore();
    }
    expect(seen.tabs).toEqual(["Wrote4", "Letin1", "Blocked2"]);
    expect(seen.filter).toBe("in the row");
    expect(seen.options).toEqual(["Nora"]);
    expect(seen.today).toBe("1,200 of 200,000 tokens used today; 2 people have written, 5 messages answered.At most 200,000 tokens a day, and 30 messages from one person a day. Change them on its Access tab.");
    expect(seen.rows).toEqual(["ses_budi", "ses_ani"]);
    // Hers alone: Nouva's blocked spammer is the Access page's.
    expect(seen.blocked).toContain("Blocked (2)");
    expect(seen.blocked).toContain("Bot Spammer");
    expect(seen.blocked).not.toContain("Spam Account");
    expect(seen.title).toBe("Answer them again: their next message is answered, as anyone's is while this agent is open.");
    expect(calls.asked).toContain("POST /access/unblock?gateway=whatsapp%3Ashop&sender=62812%40s.whatsapp.net");
    // The tab kept in the address, as Access keeps its own.
    expect(seen.where).toEqual({ tab: "blocked" });
    // Only her list was asked for.
    expect([...new Set(calls.asked.filter((one) => !one.startsWith("POST")))]).toEqual(["/agents/nora/public"]);
    expect(limitsSaid({ ...LIMITS, maxDailyMessagesPerPerson: 1 })).toBe("At most 200,000 tokens a day, and 1 message from one person a day.");
  });

  test("the filter in the row narrows the tab that is open, as the Access page's does", async () => {
    answer(house(NOUVA, NORA));
    const seen = { wrote: [] as unknown[], none: "", blocked: "" };
    await renderPage("/open-agents", async (host) => {
      await eventually(() => people(host).length === 2, 3_000, "the rows");
      type(host.querySelector<HTMLInputElement>('input[placeholder="Filter people"]')!, "ani");
      await eventually(() => people(host).length === 1, 2_000, "narrowed");
      seen.wrote = people(host);
      type(host.querySelector<HTMLInputElement>('input[placeholder="Filter people"]')!, "zzz");
      await eventually(() => text(host).includes("Nothing matches “zzz”."), 2_000, "nobody");
      seen.none = text(host);
      type(host.querySelector<HTMLInputElement>('input[placeholder="Filter people"]')!, "siti");
      tab(host, "Blocked");
      await eventually(() => listCard(host, "Blocked (") !== undefined, 2_000, "Blocked");
      seen.blocked = listCard(host, "Blocked (")!.textContent ?? "";
    });
    expect(seen.wrote).toEqual(["ses_ani"]);
    expect(seen.blocked).toContain("Siti Rude");
    expect(seen.blocked).not.toContain("Bot Spammer");
  });

  test("two open agents: one at a time, picked by name and kept in the address, never their people in one list", async () => {
    answer(house(NOUVA, NORA, OMAR));
    const calls = asking();
    const seen = { options: [] as string[], first: [] as unknown[], firstBlocked: "", then: [] as unknown[], thenBlocked: "", search: {} as Record<string, unknown> };
    try {
      await renderPage("/open-agents?tab=wrote", async (host, app) => {
        await eventually(() => people(host).length === 2, 3_000, "Nora's people");
        const picker = dropdown(host, "Agent");
        seen.options = await picker.open();
        seen.first = people(host);
        await picker.pick("Omar");
        await eventually(() => people(host).join() === "ses_joko", 3_000, "Omar's people");
        seen.then = people(host);
        tab(host, "Blocked");
        await eventually(() => text(host).includes("Omar Troll"), 3_000, "Omar's blocked");
        seen.thenBlocked = listCard(host, "Blocked (")!.textContent ?? "";
        seen.search = app.search();
      });
    } finally {
      calls.restore();
    }
    expect(seen.options).toEqual(["Nora", "Omar"]);
    expect(seen.first).toEqual(["ses_budi", "ses_ani"]);
    expect(seen.then).toEqual(["ses_joko"]);
    expect(seen.thenBlocked).not.toContain("Bot Spammer");
    expect(seen.thenBlocked).not.toContain("Siti Rude");
    expect(seen.search).toEqual({ agent: "omar", tab: "blocked" });
    // Each agent's list asked of its own address, never one for both.
    expect([...new Set(calls.asked)]).toEqual(["/agents/nora/public", "/agents/omar/public"]);
  });

  test("no agent open: it says so and where one is opened, with no list, no tabs and no picker", async () => {
    answer(house(NOUVA, NIX));
    let seen = { said: "", rows: -1, tabs: [] as unknown[], picker: true };
    await renderPage("/open-agents", async (host) => {
      await eventually(() => text(host).includes("No agent is open to everyone"), 3_000, "the empty page");
      seen = { said: text(host), rows: people(host).length, tabs: tabs(host), picker: host.querySelector('button[aria-haspopup="listbox"]') !== null };
    });
    expect(seen.said).toContain("An admin opens an agent to everyone on that agent's own Access tab.");
    expect(seen).toMatchObject({ rows: 0, tabs: [], picker: false });
  });
});

describe("an open agent's own Access tab", () => {
  const card = (host: HTMLElement, title: string) => [...host.querySelectorAll<HTMLElement>("section")].find((one) => one.querySelector("h2, h3")?.textContent?.trim() === title);
  const tiles = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[data-open-tile]")].map((one) => `${one.dataset.openTile} ${one.textContent?.replace(/\s+/g, " ").trim()} ${one.getAttribute("href")}`);

  test("counts the people who wrote and leads to their list, with no list, search or Block of its own, and no Senders card", async () => {
    answer(house(NOUVA, NORA));
    const seen = { tiles: [] as string[], link: "", rows: -1, field: true, senders: true, said: "", pressable: [] as string[] };
    await renderPage("/agents/nora/access", async (host) => {
      await eventually(() => tiles(host).length === 3 && !tiles(host).some((one) => one.includes("–")), 3_000, "the counts");
      seen.tiles = tiles(host);
      seen.link = [...card(host, "People who wrote")!.querySelectorAll("a")].find((one) => one.textContent?.trim() === "Open the list")?.getAttribute("href") ?? "";
      seen.rows = people(host).length;
      seen.field = host.querySelector('input[aria-label="Look for a person who wrote"]') !== null;
      seen.senders = card(host, "Senders") !== undefined;
      seen.said = card(host, "People who wrote")!.textContent ?? "";
      seen.pressable = [...card(host, "People who wrote")!.querySelectorAll("button")].map((one) => one.textContent?.trim() ?? "");
    });
    // Each opens the page on the tab it counts.
    expect(seen.tiles).toEqual([
      "conversations Conversations4 /dashboard/open-agents?agent=nora&tab=wrote",
      "today Wrote today2 /dashboard/open-agents?agent=nora&tab=wrote",
      "blocked Blocked2 /dashboard/open-agents?agent=nora&tab=blocked",
    ]);
    expect(seen.link).toBe("/dashboard/open-agents?agent=nora&tab=wrote");
    expect(seen).toMatchObject({ rows: 0, field: false, senders: false });
    expect(seen.pressable).toEqual([]);
    expect(seen.said).toContain("Who wrote to Nora while it is open, and who it keeps out.");
  });

  test("an operator is not given the count of who wrote, an admin's to read; a closed agent's tab keeps its Senders card", async () => {
    answer({ ...house(NOUVA, NORA), ...OPERATOR });
    let operator: string[] = [];
    await renderPage("/agents/nora/access", async (host) => {
      await eventually(() => tiles(host).length === 2 && !tiles(host).some((one) => one.includes("–")), 3_000, "the counts");
      operator = tiles(host).map((one) => one.split(" ")[0]!);
    });
    expect(operator).toEqual(["today", "blocked"]);

    answer(house(NOUVA, NORA_CLOSED));
    let closed = { senders: false, people: true };
    await renderPage("/agents/nora/access", async (host) => {
      await eventually(() => card(host, "Senders") !== undefined, 3_000, "the Senders card");
      closed = { senders: true, people: card(host, "People who wrote") !== undefined };
    });
    expect(closed).toEqual({ senders: true, people: false });
  });
});

describe("an open agent beside the others", () => {
  const badge = (root: ParentNode | null | undefined) => root?.querySelector<HTMLElement>("[data-open-badge]") ?? null;

  test("its page offers no Make orchestrator, which the daemon refuses it, and says Open beside its state; a closed agent's still offers it", async () => {
    answer(house(NOUVA, NIX, NORA));
    let open = { make: true, badge: "", title: "", label: "", classes: "" };
    await renderPage("/agents/nora/access", async (host) => {
      await eventually(() => host.querySelector("h1")?.textContent?.trim() === "Nora", 3_000, "the header");
      const header = host.querySelector("h1")!.parentElement!;
      const word = badge(header);
      open = { make: text(host).includes("Make orchestrator"), badge: word?.textContent?.trim() ?? "", title: word?.getAttribute("title") ?? "", label: word?.getAttribute("aria-label") ?? "", classes: word?.className ?? "" };
    });
    expect(open).toMatchObject({ make: false, badge: "Open", title: OPEN_TO_EVERYONE, label: OPEN_TO_EVERYONE });
    expect(open.classes.split(" ")).toEqual(expect.arrayContaining(["whitespace-nowrap", "shrink-0", "font-mono"]));
    expect(OPEN_TO_EVERYONE).toBe("Open to everyone: anyone may write to it");

    let closed = { make: false, badge: true };
    await renderPage("/agents/nix/access", async (host) => {
      await eventually(() => host.querySelector("h1")?.textContent?.trim() === "Nix", 3_000, "the header");
      closed = { make: text(host).includes("Make orchestrator"), badge: badge(host.querySelector("h1")!.parentElement) !== null };
    });
    expect(closed).toEqual({ make: true, badge: false });
  });

  test("the Agents list marks it Open beside its name, which gives way in a narrow row while the word stays whole", async () => {
    answer(house(NOUVA, NIX, NORA));
    let seen = { marked: [] as string[], title: "", name: "" };
    await renderPage("/agents", async (host) => {
      await eventually(() => badge(host) !== null, 3_000, "the list");
      const marked = [...host.querySelectorAll<HTMLElement>("[data-open-badge]")];
      seen = {
        marked: marked.map((one) => one.parentElement?.querySelector(".truncate")?.textContent?.trim() ?? ""),
        title: marked[0]?.getAttribute("title") ?? "",
        name: marked[0]?.parentElement?.querySelector(".truncate")?.className ?? "",
      };
    });
    expect(seen.marked).toEqual(["Nora"]);
    expect(seen.title).toBe(OPEN_TO_EVERYONE);
    expect(seen.name.split(" ")).toEqual(expect.arrayContaining(["truncate"]));
  });

  test("the chat list tags it Open where the orchestrator is tagged, talked to or not yet", async () => {
    const LIST: ChatListPayload = {
      gone: [],
      agents: [
        { agentId: "nouva", sessionId: "ses_1", at: Date.now() - 60_000, last: { from: "agent", name: "nouva", text: "Morning" }, working: false, helpers: 0 },
        { agentId: "nora", sessionId: "ses_nora", at: Date.now() - 120_000, last: { from: "person", text: "try the bot" }, working: false, helpers: 0 },
        { agentId: "omar", working: false, helpers: 0 },
        { agentId: "nix", working: false, helpers: 0 },
      ],
      rooms: [],
      groups: [],
    };
    answer({ ...house(NOUVA, NIX, NORA, OMAR), "/chat-list": ok(LIST) });
    let tagged: string[] = [];
    let later = "";
    await renderPage("/chat", async (host) => {
      const aside = () => host.querySelector('aside[aria-label="Chats"]');
      await eventually(() => (aside()?.querySelectorAll(`[title="${OPEN_TO_EVERYONE}"]`).length ?? 0) === 2, 3_000, "the tags");
      tagged = [...aside()!.querySelectorAll<HTMLElement>(`[title="${OPEN_TO_EVERYONE}"]`)].map((tag) => {
        const name = tag.parentElement?.querySelector(".truncate");
        return `${name?.textContent?.trim()}: ${tag.textContent?.trim()} ${tag.getAttribute("aria-label") === OPEN_TO_EVERYONE} ${tag.className.includes("whitespace-nowrap") && tag.className.includes("shrink-0")} ${name?.className.includes("min-w-0")}`;
      });
      later = aside()!.textContent ?? "";
    });
    expect(tagged).toEqual(["Nora: Open true true true", "Omar: Open true true true"]);
    // Omar under the heading of those nobody talked to yet, tagged there too; the orchestrator keeps its own word.
    expect(later.indexOf("Not talked to yet")).toBeLessThan(later.indexOf("Omar"));
    expect(later).toContain("Orchestrator");
  });
});

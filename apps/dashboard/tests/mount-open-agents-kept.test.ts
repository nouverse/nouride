/**
 * What an open agent's page and the Access page keep in view of each other, past the cases of `mount-open-agents`.
 *
 * Each case is a person or a count that went missing or went wrong once open agents were taken off the Access page:
 * someone let in by name on an open agent's connection, who the daemon still answers as known, shown on neither page;
 * an unblock that left the People who wrote list saying "Blocked" for half a minute; the Approved count taken from the
 * newest 500 sent rather than from everyone; a request on an open agent's connection counted in the menu and on Home
 * while its tab lists nothing; and the Access page drawing an open agent's rows before it knew the agent was open.
 */

import { describe, expect, test } from "bun:test";
import type { AgentOpen, AgentSummary, PublicConversation } from "@nouride/wire";
import { answer, overrides, recordPosts, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const STATUS = WIRE["/status"] as { agents: AgentSummary[] } & Record<string, unknown>;
const AT = Date.now() - 3_600_000;

const LIMITS = { maxDailyTokens: 200_000, maxDailyMessagesPerPerson: 30, closedReply: null };
const OPEN_NORA: AgentOpen = { never: null, notes: false, connections: ["telegram:nora", "whatsapp:shop"], limits: LIMITS, today: { tokens: 1_200, estimated: false, people: 2, messages: 5 } };
const OPEN_OMAR: AgentOpen = { never: null, notes: false, connections: ["telegram:omar"], limits: LIMITS, today: { tokens: 0, estimated: false, people: 0, messages: 0 } };
const agent = (id: string, access: AgentSummary["access"], open?: AgentOpen): AgentSummary => ({ ...STATUS.agents[0]!, id, displayName: id[0]!.toUpperCase() + id.slice(1), access, ...(open ? { open } : {}) });
const NOUVA = agent("nouva", "follow");
const NORA = agent("nora", "open", OPEN_NORA);
const OMAR = agent("omar", "open", OPEN_OMAR);
const statusOf = (...agents: AgentSummary[]) => ok({ ...STATUS, orchestrator: "nouva", agents });

const gateway = (id: string, agentId: string) => ({ id, platform: id.split(":")[0], name: id.split(":")[1], enabled: true, tokenSecret: "", agent: agentId, status: "connected", hasCredential: true });
const GATEWAYS = ok({ gateways: [gateway("telegram:nouva", "nouva"), gateway("telegram:nora", "nora"), gateway("whatsapp:shop", "nora"), gateway("telegram:omar", "omar")], editable: true });
const sender = (gatewayId: string, senderId: string, senderName: string, status: string) => ({
  gatewayId, senderId, senderName, status, code: status === "pending" ? "ABC123" : null, chatId: null, requestedAt: AT,
  expiresAt: status === "pending" || status === "denied" ? AT + 86_400_000 : null, resolvedAt: status === "pending" ? null : AT, resolvedBy: status === "pending" ? null : "gading",
});
const SENDERS = [
  sender("telegram:nouva", "1001", "Sam Waiting", "pending"),
  sender("telegram:nouva", "1002", "Alex Approved", "approved"),
  // Let in on Nora's bot before she was opened, and a code asked of it then and not yet run out.
  sender("telegram:nora", "2001", "Rudi Before", "approved"),
  sender("telegram:nora", "2003", "Nina Asked Before", "pending"),
  sender("whatsapp:shop", "62812@s.whatsapp.net", "Siti Rude", "blocked"),
];
/** The daemon counts each connection's approved: more than the newest it sends of Nouva's, and of Nora's. */
const APPROVED_ON = { "telegram:nouva": 600, "telegram:nora": 20 };
const accessOf = (senders: unknown[], mode = "pair") =>
  ok({ mode, editable: true, allowlist: ["telegram:nouva:5555", "telegram:nora:7777", "9999"], senders, approvedTotal: 620, approvedOn: APPROVED_ON });
const row = (id: string, name: string, blocked: boolean): PublicConversation => ({ sessionId: `ses_${id}`, gatewayId: "whatsapp:shop", chatId: id, kind: "private", sender: { id, name, blocked }, title: `asked by ${name}`, updatedAt: AT });
const publicOf = (blocked: boolean) => ok({ conversations: [row("62812@s.whatsapp.net", "Siti Rude", blocked)], total: 1 });
const house = (...agents: AgentSummary[]) => ({
  "/status": statusOf(...agents),
  "/gateways": GATEWAYS,
  "/access": accessOf(SENDERS),
  "/access/history": ok({ entries: [] }),
  "/agents/nora/public": publicOf(true),
  "/agents/omar/public": ok({ conversations: [], total: 0 }),
});

const text = (host: HTMLElement) => host.textContent ?? "";
const tabs = (host: HTMLElement) => [...host.querySelectorAll('[role="tab"]')].map((one) => one.textContent?.replace(/\s+/g, "").trim());
const card = (host: HTMLElement, starts: string) => [...host.querySelectorAll<HTMLElement>("section")].find((one) => one.querySelector("h2, h3")?.textContent?.startsWith(starts));
const dialogButton = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent?.trim() === label);

describe("an open agent's people let in by name", () => {
  test("are on its Open agents page, with Revoke and Block, counted on its connections: never the household's, never a bare id", async () => {
    answer(house(NOUVA, NORA));
    const posted = recordPosts({ "/access/revoke": ok({ ok: true }) });
    const seen = { title: "", said: "", rows: "", more: "" };
    try {
      await renderPage("/open-agents", async (host) => {
        await eventually(() => card(host, "Let in by name") !== undefined, 3_000, "the let-in card");
        const letIn = card(host, "Let in by name")!;
        seen.title = letIn.querySelector("h2, h3")?.textContent ?? "";
        seen.said = letIn.textContent ?? "";
        seen.more = letIn.querySelector("[data-approved-more]")?.textContent ?? "";
        seen.rows = [...(card(host, "Always allowed")?.querySelectorAll("li") ?? [])].map((one) => one.textContent).join(" | ");
        [...letIn.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Revoke")!.click();
        await eventually(() => dialogButton("Revoke") !== undefined, 2_000, "the question");
        dialogButton("Revoke")!.click();
        await eventually(() => posted.posts.length === 1, 2_000, "the revoke");
      });
    } finally {
      posted.restore();
    }
    // Nora's twenty, of whom the page was sent one, not the household's six hundred.
    expect(seen.title).toBe("Let in by name (20)");
    expect(seen.said).toContain("Rudi Before");
    expect(seen.said).toContain("They are not strangers to it: they are answered as people you let in, and keep that when it is closed.");
    expect(seen.said).not.toContain("Alex Approved");
    expect(seen.more).toContain("The newest 1 of 20 are listed.");
    // Her connection's own entry of the config's list; a bare id, every connection's, and Nouva's, not.
    expect(seen.rows).toContain("telegram:nora:7777");
    expect(seen.rows).not.toContain("9999");
    expect(seen.rows).not.toContain("telegram:nouva:5555");
    expect(posted.posts.map((one) => one.path)).toEqual(["/access/revoke"]);
  });

  test("an open agent nobody was let in on shows no such card", async () => {
    answer(house(NOUVA, NORA, OMAR));
    let seen = { letIn: true, blocked: false };
    await renderPage("/open-agents?agent=omar", async (host) => {
      await eventually(() => card(host, "Blocked (") !== undefined, 3_000, "Omar's page");
      seen = { letIn: card(host, "Let in by name") !== undefined, blocked: true };
    });
    expect(seen).toEqual({ letIn: false, blocked: true });
  });
});

describe("an unblock on the Open agents page", () => {
  test("refreshes who wrote at once: the row is no longer said to be blocked, and can be blocked again", async () => {
    answer(house(NOUVA, NORA));
    const posted = recordPosts({ "/access/unblock": ok({ ok: true }) });
    let after = { badge: true, block: false };
    try {
      await renderPage("/open-agents", async (host) => {
        const siti = () => host.querySelector<HTMLElement>('[data-public-row="ses_62812@s.whatsapp.net"]');
        await eventually(() => siti()?.textContent?.includes("Blocked") === true, 3_000, "her row, blocked");
        // The daemon's next answers: she is let back.
        overrides["/agents/nora/public"] = publicOf(false);
        overrides["/access"] = accessOf(SENDERS.filter((one) => one.status !== "blocked"));
        const blocked = card(host, "Blocked (")!;
        [...blocked.querySelectorAll<HTMLElement>("li")].find((one) => one.textContent?.includes("Siti Rude"))!.querySelector("button")!.click();
        await eventually(() => posted.posts.length === 1, 2_000, "the unblock");
        // Well inside the list's own half-minute refresh.
        await eventually(() => !(siti()?.textContent ?? "").includes("Blocked"), 2_000, "her row, unblocked");
        after = { badge: false, block: [...siti()!.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Block") };
      });
    } finally {
      posted.restore();
    }
    expect(after).toEqual({ badge: false, block: true });
  });
});

describe("the Access page's Approved count", () => {
  test("is everyone approved on the household's connections, from the daemon's count on each, past the newest it sends", async () => {
    answer(house(NOUVA, NORA));
    let all: unknown[] = [];
    let nouva: unknown[] = [];
    await renderPage("/access", async (host) => {
      await eventually(() => text(host).includes("Sam Waiting"), 3_000, "the list");
      all = tabs(host);
    });
    await renderPage("/access?agent=nouva", async (host) => {
      await eventually(() => text(host).includes("Sam Waiting"), 3_000, "Nouva's list");
      nouva = tabs(host);
    });
    // Nouva's six hundred: not 620 less the one of Nora's it was sent, nor the one of Nouva's.
    expect(all).toEqual(["Pending1", "Approved600", "Denied", "Blocked", "History"]);
    expect(nouva).toEqual(["Pending1", "Approved600", "Denied", "Blocked", "History"]);
  });
});

describe("a request on an open agent's connection", () => {
  test("is counted nowhere the Pending tab does not list it: not on Home", async () => {
    answer(house(NOUVA, NORA));
    let said = "";
    await renderPage("/", async (host) => {
      await eventually(() => /ask(s)? to talk to your agents/.test(text(host)), 3_000, "the request on Home");
      said = text(host);
    });
    // Sam's alone; Nina asked Nora before she was opened, and Nora answers her now with no code.
    expect(said).toContain("Someone asks to talk to your agents");
    expect(said).not.toContain("2 people ask to talk to your agents");
  });
});

describe("the Access page before it knows which agents are open", () => {
  test("lists nobody while the agents are on their way, and says so when they do not come", async () => {
    // Its rule is not the page's default, so it is said only once Access has answered.
    answer({ ...house(NOUVA, NORA), "/access": accessOf(SENDERS, "allowlist"), "/status": { status: 200, body: {}, hold: true } });
    let waiting = { said: "", tabs: [] as unknown[] };
    await renderPage("/access", async (host) => {
      // Access answered: its rule is said; the lists and their counts wait for the agents.
      await eventually(() => text(host).includes("New senders are turned away; only those already approved are answered."), 3_000, "the page");
      waiting = { said: text(host), tabs: tabs(host) };
    });
    for (const name of ["Sam Waiting", "Nina Asked Before", "Rudi Before", "Siti Rude"]) expect(waiting.said).not.toContain(name);
    // Nor a list said to be empty: Sam is waiting, and the page does not know it yet.
    expect(waiting.said).not.toContain("No pending requests");
    // Not Nina's request, nor Nora's twenty approved, counted for a moment as the household's.
    expect(waiting.tabs).toEqual(["Pending", "Approved", "Denied", "Blocked", "History"]);

    answer({ ...house(NOUVA, NORA), "/status": { status: 500, body: { error: "boom" } } });
    let failed = "";
    await renderPage("/access", async (host) => {
      await eventually(() => host.querySelector("[data-open-unknown]") !== null, 3_000, "the note");
      failed = text(host);
    });
    expect(failed).toContain("Nouride did not say which of your agents are open to everyone");
    for (const name of ["Sam Waiting", "Nina Asked Before", "Rudi Before"]) expect(failed).not.toContain(name);
  });
});

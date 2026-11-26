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
import { answer, overrides, recordPosts, renderPage, useMountHarness, WIRE, type, dropdown } from "./mount-harness.ts";
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

/** A tab of the page, pressed. */
const pressTab = (host: HTMLElement, label: string) => ([...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((one) => one.textContent?.trim().startsWith(label)) as HTMLElement).click();
/** The page's filter, in the row that stays at the top of the window. */
const filter = (host: HTMLElement) => host.querySelector<HTMLInputElement>('[data-sticky-bar] input[placeholder="Filter people"]')!;
const searchEveryone = (within: HTMLElement) => [...within.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Search everyone"));

describe("an open agent's people let in by name", () => {
  test("are its Let in tab, with Revoke and Block, counted on its connections: never the household's, never a bare id", async () => {
    answer(house(NOUVA, NORA));
    const posted = recordPosts({ "/access/revoke": ok({ ok: true }) });
    const seen = { tabs: [] as unknown[], title: "", said: "", rows: "", more: "" };
    try {
      await renderPage("/open-agents?tab=let-in", async (host) => {
        await eventually(() => card(host, "Let in by name") !== undefined, 3_000, "the Let in tab");
        seen.tabs = tabs(host);
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
    expect(seen.tabs).toEqual(["Wrote1", "Letin20", "Blocked1"]);
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

  test("more let in than the page was sent, and none of them here: the filter finds one among everyone, asked of its own connections, and Blocked is not narrowed", async () => {
    // The household's newest fill what the daemon sends: none of Nora's five among them.
    answer({ ...house(NOUVA, NORA), "/access": ok({ mode: "pair", editable: true, allowlist: [], senders: SENDERS.filter((one) => one.gatewayId !== "telegram:nora" || one.status !== "approved"), approvedTotal: 605, approvedOn: { "telegram:nouva": 600, "telegram:nora": 5 } }) });
    // Answered only where it is asked on Nora's connections, both and none else: across the install, another agent's many
    // would crowd hers out.
    overrides["/access?q=Rudi&on=telegram%3Anora&on=whatsapp%3Ashop"] = accessOf([SENDERS[2]]);
    const seen = { said: "", searched: "", blocked: "" };
    await renderPage("/open-agents?tab=let-in", async (host) => {
      await eventually(() => card(host, "Let in by name") !== undefined, 3_000, "the Let in tab");
      seen.said = card(host, "Let in by name")!.textContent ?? "";
      type(filter(host), "Rudi");
      await eventually(() => searchEveryone(card(host, "Let in by name")!)?.disabled === false, 2_000, "the search of everyone");
      searchEveryone(card(host, "Let in by name")!)!.click();
      await eventually(() => (card(host, "Let in by name")?.textContent ?? "").includes("Rudi Before"), 3_000, "found among everyone");
      seen.searched = card(host, "Let in by name")?.textContent ?? "";
      // What the search found is the Let in tab's: Blocked is still her whole listing, the filter put away.
      type(filter(host), "");
      pressTab(host, "Blocked");
      await eventually(() => card(host, "Blocked (") !== undefined, 2_000, "Blocked");
      seen.blocked = card(host, "Blocked (")!.textContent ?? "";
    });
    expect(seen.said).toContain("The newest 0 of 5 are listed.");
    expect(seen.said).not.toContain("Nobody was let in by name");
    expect(seen.searched).toContain("Rudi Before");
    expect(seen.searched).toContain("Let in by name (1)");
    expect(seen.blocked).toContain("Siti Rude");
  });

  test("a search of everyone on its way is said as that, with nothing from before given as its answer", async () => {
    answer(house(NOUVA, NORA));
    overrides["/access?q=Rudi"] = { ...accessOf(SENDERS), hold: true };
    let seen = { title: "", said: "", back: false, wrote: "" };
    await renderPage("/open-agents?tab=let-in", async (host) => {
      await eventually(() => (card(host, "Let in by name")?.textContent ?? "").includes("Rudi Before"), 3_000, "the Let in tab");
      type(filter(host), "Rudi");
      await eventually(() => searchEveryone(card(host, "Let in by name")!)?.disabled === false, 2_000, "the search of everyone");
      searchEveryone(card(host, "Let in by name")!)!.click();
      await eventually(() => (card(host, "Let in by name")?.textContent ?? "").includes("Looking among everyone for “Rudi”"), 3_000, "the search said");
      const letIn = card(host, "Let in by name")!;
      seen = {
        title: letIn.querySelector("h2, h3")?.textContent ?? "",
        said: letIn.textContent ?? "",
        back: [...letIn.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Show the newest"),
        wrote: tabs(host)[0] as string,
      };
    });
    // No count, no rows, no "nobody": the listing from before is not what the search found.
    expect(seen.title).toBe("Let in by name");
    expect(seen.said).not.toContain("Rudi Before");
    expect(seen.said).not.toContain("matches that");
    expect(seen.back).toBe(true);
    expect(seen.wrote).toBe("Wrote1");
  });

  test("a search of everyone that does not come back says so, keeps the way to the newest, and leaves Blocked whole", async () => {
    answer(house(NOUVA, NORA));
    overrides["/access?q=Rudi"] = { status: 500, body: { error: "the daemon fell over" } };
    let seen = { said: "", back: "", blocked: "" };
    await renderPage("/open-agents?tab=let-in", async (host) => {
      await eventually(() => card(host, "Let in by name") !== undefined, 3_000, "the Let in tab");
      type(filter(host), "Rudi");
      await eventually(() => searchEveryone(card(host, "Let in by name")!)?.disabled === false, 2_000, "the search of everyone");
      searchEveryone(card(host, "Let in by name")!)!.click();
      await eventually(() => (card(host, "Let in by name")?.textContent ?? "").includes("did not come back"), 3_000, "the failure said");
      seen.said = card(host, "Let in by name")!.textContent ?? "";
      type(filter(host), "");
      [...card(host, "Let in by name")!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Show the newest")!.click();
      await eventually(() => (card(host, "Let in by name")?.textContent ?? "").includes("Rudi Before"), 3_000, "the newest again");
      seen.back = card(host, "Let in by name")!.textContent ?? "";
      pressTab(host, "Blocked");
      await eventually(() => card(host, "Blocked (") !== undefined, 2_000, "Blocked");
      seen.blocked = card(host, "Blocked (")!.textContent ?? "";
    });
    expect(seen.said).toContain("The search for “Rudi” did not come back. Show the newest, or search again.");
    expect(seen.said).not.toContain("matches that");
    expect(seen.back).toContain("Let in by name (20)");
    expect(seen.blocked).toContain("Siti Rude");
  });

  test("a search on one open agent's Let in tab is that agent's: another's opens on its own newest", async () => {
    const OMAR_LET_IN = [...SENDERS, sender("telegram:omar", "3001", "Oki Before", "approved")];
    answer({ ...house(NOUVA, NORA, OMAR), "/access": ok({ mode: "pair", editable: true, allowlist: [], senders: OMAR_LET_IN, approvedTotal: 622, approvedOn: { ...APPROVED_ON, "telegram:omar": 1 } }) });
    overrides["/access?q=Rudi"] = accessOf(SENDERS);
    let seen = "";
    await renderPage("/open-agents?agent=nora&tab=let-in", async (host) => {
      await eventually(() => card(host, "Let in by name") !== undefined, 3_000, "Nora's Let in tab");
      type(filter(host), "Rudi");
      await eventually(() => searchEveryone(card(host, "Let in by name")!)?.disabled === false, 2_000, "the search of everyone");
      searchEveryone(card(host, "Let in by name")!)!.click();
      await eventually(() => (card(host, "Let in by name")?.querySelector("[data-approved-more]")?.textContent ?? "").includes("“Rudi”"), 3_000, "Nora's search");
      // Omar, picked as a person picks him, with the filter put away.
      await dropdown(host, "Agent").pick("Omar");
      type(filter(host), "");
      await eventually(() => (card(host, "Let in by name")?.textContent ?? "").includes("Oki Before"), 3_000, "Omar's own");
      seen = card(host, "Let in by name")?.querySelector("[data-approved-more]")?.textContent ?? "";
    });
    expect(seen).not.toContain("Rudi");
  });

  test("an open agent nobody was let in on says so on its Let in tab", async () => {
    answer(house(NOUVA, NORA, OMAR));
    let seen = { said: "", tabs: [] as unknown[] };
    await renderPage("/open-agents?agent=omar&tab=let-in", async (host) => {
      await eventually(() => text(host).includes("Nobody was let in by name"), 3_000, "Omar's Let in tab");
      seen = { said: text(host), tabs: tabs(host) };
    });
    expect(seen.tabs).toEqual(["Wrote", "Letin", "Blocked"]);
    expect(seen.said).toContain("Let in by name (0)");
  });
});

describe("an unblock on the Open agents page", () => {
  test("refreshes who wrote at once: the row is no longer said to be blocked, and can be blocked again", async () => {
    answer(house(NOUVA, NORA));
    const posted = recordPosts({ "/access/unblock": ok({ ok: true }) });
    let after = { badge: true, block: false };
    try {
      await renderPage("/open-agents", async (host) => {
        const siti = () => host.querySelector<HTMLElement>('[data-public-conversations] > li[data-row="ses_62812@s.whatsapp.net"]');
        await eventually(() => siti()?.textContent?.includes("Blocked") === true, 3_000, "her row, blocked");
        // The daemon's next answers: she is let back.
        overrides["/agents/nora/public"] = publicOf(false);
        overrides["/access"] = accessOf(SENDERS.filter((one) => one.status !== "blocked"));
        pressTab(host, "Blocked");
        await eventually(() => card(host, "Blocked (") !== undefined, 2_000, "the Blocked tab");
        [...card(host, "Blocked (")!.querySelectorAll<HTMLElement>("li")].find((one) => one.textContent?.includes("Siti Rude"))!.querySelector("button")!.click();
        await eventually(() => posted.posts.length === 1, 2_000, "the unblock");
        pressTab(host, "Wrote");
        // Well inside the list's own half-minute refresh, and with nothing read again on its own.
        await eventually(() => siti() !== null && !(siti()?.textContent ?? "").includes("Blocked"), 2_000, "her row, unblocked");
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

  test("a search of everyone approved is asked of the page's own connections: every one of them, and none of an open agent's", async () => {
    /** The connections each search of everyone was asked to hold to, by the `on` values it sent. */
    const searched: string[][] = [];
    const spy = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost");
      if (url.pathname.endsWith("/access") && url.searchParams.has("q")) searched.push(url.searchParams.getAll("on").sort());
      return (spy as typeof fetch)(input as RequestInfo, init);
    }) as typeof fetch;
    const find = async (path: string) => {
      await renderPage(path, async (host) => {
        await eventually(() => text(host).includes("Alex Approved"), 3_000, "the Approved tab");
        type(host.querySelector<HTMLInputElement>('input[placeholder="Filter senders"]')!, "Alex");
        const everyone = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Search everyone"));
        await eventually(() => everyone()?.disabled === false, 2_000, "the search of everyone");
        everyone()!.click();
        await eventually(() => searched.length > 0, 2_000, "asked");
      });
    };
    try {
      answer(house(NOUVA, NORA));
      await find("/access?tab=approved");
      // With every agent: the household's connections, Omar's (not open) among them, and not Nora's two.
      expect(searched.splice(0)).toEqual([["telegram:nouva", "telegram:omar"]]);
      answer(house(NOUVA, NORA));
      await find("/access?tab=approved&agent=nouva");
      // With one picked: its own, and only its own.
      expect(searched.splice(0)).toEqual([["telegram:nouva"]]);
    } finally {
      globalThis.fetch = spy;
    }
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

describe("Agent Settings' count of who is waiting", () => {
  test("leaves out a request on an open agent's connection, as the Access page does", async () => {
    answer(house(NOUVA, NORA));
    let said = "";
    await renderPage("/agents/settings", async (host) => {
      await eventually(() => /sender(s)? waiting/.test(text(host)), 3_000, "the count");
      said = text(host).match(/\d+ senders? waiting/)?.[0] ?? "";
    });
    // Sam asked Nouva; Nina asked Nora before she was opened, and is not on the Access page to approve.
    expect(said).toBe("1 sender waiting");
  });
});

describe("Agent Settings' count before it knows which agents are open", () => {
  test("counts nobody waiting until it knows whose each request is", async () => {
    answer({ ...house(NOUVA, NORA), "/status": { status: 200, body: {}, hold: true } });
    let said = "";
    await renderPage("/agents/settings", async (host) => {
      await eventually(() => text(host).includes("Accept new senders"), 3_000, "the switch");
      said = text(host);
    });
    // Nina asked Nora: while it is not known that Nora is open, she is not counted for a moment as waiting.
    expect(said).not.toMatch(/senders? waiting/);
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

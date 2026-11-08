/**
 * Home (0.8.24, where Overview was): an inbox before a dashboard, in the design rules' order — what needs you, what is
 * moving, Quick chat, the agents — and the cat, waving by day and saying good night late, asleep where the cards would be
 * when nothing waits and nothing moves. The menu's count and the browser tab's title are the same count.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answer, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";
import { greetingAt } from "@/modules/home/components/Hero";
import { doingNow } from "@/modules/home/components/YourAgents";
import { summaryLine } from "@/modules/home/index.page";
import type { AgentSummary } from "@/commons/lib/api";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const agent = (id: string, extra: Partial<AgentSummary> = {}) => ({ id, displayName: id[0]!.toUpperCase() + id.slice(1), enabled: true, state: "running", provider: "p", model: "m", tools: [], approvals: "careful", ...extra });
const approval = { id: "ap1", agentId: "nix", chatId: "web:usr_1", tool: "exec", params: { command: "git push" }, grantable: false, requestedAt: 0, timeoutMs: 60_000 };
const mission = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, agentId: "nix", goal: `Goal ${id}`, status, seen: status === "waiting" ? "needs_you" : "working", waitKind: null, checklist: null, ...extra });

describe("the words", () => {
  test("the greeting follows the hour, and late is the night's, with its own cat", () => {
    expect([6, 11, 12, 17, 18, 21, 22, 4].map((hour) => greetingAt(hour).words)).toEqual([
      "Good morning",
      "Good morning",
      "Good afternoon",
      "Good afternoon",
      "Good evening",
      "Good evening",
      "Good night",
      "Good night",
    ]);
    expect(greetingAt(23).night).toBe(true);
    expect(greetingAt(9).night).toBe(false);
  });

  test("the line says only what is so: nothing awake, moving or waiting is left out, not said as zero", () => {
    expect(summaryLine(4, 2, 1)).toBe("4 agents awake · 2 missions moving · 1 thing needs you");
    expect(summaryLine(1, 1, 3)).toBe("1 agent awake · 1 mission moving · 3 things need you");
    expect(summaryLine(2, 0, 0)).toBe("2 agents awake");
    expect(summaryLine(0, 0, 0)).toBe("");
  });

  test("an agent's line is what it is doing, waiting on you first and missions before plain work", () => {
    const doing = (activity: AgentSummary["activity"] | undefined, extra: Partial<AgentSummary> = {}) => doingNow({ ...agent("nix", extra), ...(activity ? { activity } : {}) } as AgentSummary);
    const base = { working: [], jobs: 0, waiting: 0, unavailable: null };
    expect(doing({ ...base, activity: "waiting" })).toEqual({ words: "Waiting for you", tone: "accent" });
    expect(doing({ ...base, activity: "working", missions: 2 })).toEqual({ words: "2 missions running", tone: "success" });
    expect(doing({ ...base, activity: "working" })).toEqual({ words: "Working", tone: "success" });
    expect(doing({ ...base, activity: "asleep" })).toEqual({ words: "Asleep", tone: "muted" });
    expect(doing(undefined, { enabled: false })).toEqual({ words: "Switched off", tone: "muted" });
    expect(doing(undefined, { state: "error" })).toEqual({ words: "Not running", tone: "muted" });
  });
});

describe("the page", () => {
  test("in order: the greeting, what needs you answered in place, what is moving, Quick chat, then the agents", async () => {
    answer({
      "/status": ok({ status: "ready", gateways: [], providers: [], uptimeMs: 1000, orchestrator: "nouva", agents: [agent("nouva"), agent("nix", { headline: "engineer" })] }),
      "/approvals": ok({ pending: [approval] }),
      "/missions": ok({ missions: [mission("m1", "running", { checklist: { done: 2, total: 5, active: null } }), mission("m2", "waiting", { waitKind: "input" })] }),
      "/knowledge": ok({ collections: [] }),
    });
    let html = "";
    let title = "";
    await renderPage("/", async (host) => {
      await eventually(() => host.textContent?.includes("Goal m1") === true && host.textContent.includes("Your agents"), 3_000, "Home");
      html = host.innerHTML;
      title = host.ownerDocument.title;
    });
    const at = (words: string) => html.indexOf(words);
    // A tool call, answered here; a mission waiting for an answer, which opens its page.
    expect(at("Nix asks to use")).toBeGreaterThan(-1);
    expect(html).toMatch(/> ?Allow once</);
    expect(html).toContain('href="/dashboard/missions/m2"');
    // What is moving, with the checklist's real count, and no bar for a mission without one.
    expect(html).toContain('aria-valuenow="2"');
    expect(html).toContain('aria-valuemax="5"');
    expect(at("Nix asks to use")).toBeLessThan(at("Moving now"));
    expect(at("Moving now")).toBeLessThan(at("Quick chat"));
    expect(at("Quick chat")).toBeLessThan(at("Your agents"));
    // The box's state at the top, in the greeting's corner, before anything that needs you (the owner, 2026-11-08).
    expect(at("Everything is working")).toBeGreaterThan(-1);
    expect(at("Everything is working")).toBeLessThan(at("Nix asks to use"));
    // Quick chat asks the orchestrator first, and says it is the orchestrator.
    expect(html.slice(at("Quick chat"), at("Your agents"))).toMatch(/Ask Nouva<\/span><span[^>]*badge[^>]*>.*?orchestrator<\/span>/);
    // Your agents: the Office's picture, and each agent a chip with its whole name, the orchestrator crowned.
    expect(html).toContain("data-office-teaser");
    expect(html).toMatch(/<span class="shrink-0 text-sm font-semibold text-base-content">Nouva<\/span><svg[^>]*aria-label="orchestrator"/);
    // The greeting's waving or good-night cat, and nothing asleep: something waits.
    expect(html).toMatch(/01-waving|12-good-night/);
    expect(html).not.toContain("Nothing is waiting for you");
    // One count: the approval, the mission, the harness's request, its skill draft and its fact to review.
    expect(html).toContain("A fact waits for your yes or no");
    expect(html).toContain('href="/dashboard/memories?tab=proposals"');
    expect(html).toContain("5 things need you");
    expect(title).toBe("(5) Nouride");
  });

  test("nothing waiting and nothing moving: the cat asleep where the cards were", async () => {
    answer({
      "/approvals": ok({ pending: [] }),
      "/missions": ok({ missions: [] }),
      "/access": ok({ senders: [] }),
      "/skills/drafts": ok({ enabled: true, pending: [], recent: [] }),
      "/memory/proposals": ok({ proposals: [] }),
      "/knowledge": ok({ collections: [] }),
    });
    let html = "";
    let title = "";
    await renderPage("/", async (host) => {
      await eventually(() => host.textContent?.includes("Nothing is waiting for you") === true, 3_000, "the quiet card");
      html = host.innerHTML;
      title = host.ownerDocument.title;
    });
    expect(html).toContain("06-sleeping");
    expect(html).not.toContain("Moving now");
    expect(title).toBe("Nouride");
  });

  test("Quick chat sends to the chosen agent and opens the conversation it started", async () => {
    answer({ "/chat/send": ok({ sessionId: "ses_9", chatId: "web:usr_1", messageId: "m1", agentId: "nouva" }) });
    let sent: unknown = null;
    let landed = "";
    const harness = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(typeof input === "string" ? input : input instanceof URL ? input : input.url).endsWith("/chat/send")) sent = JSON.parse(String(init?.body));
      return harness(input, init);
    }) as typeof fetch;
    try {
      await renderPage("/", async (host, app) => {
        await eventually(() => host.querySelector('input[aria-label^="Message"]') !== null, 3_000, "Quick chat");
        type(host.querySelector('input[aria-label^="Message"]') as HTMLInputElement, "what first?");
        (host.querySelector('form button[aria-label="Send"]') as HTMLButtonElement).click();
        await eventually(() => app.location().startsWith("/chat/"), 3_000, "the conversation to open");
        landed = app.location();
      });
    } finally {
      globalThis.fetch = harness;
    }
    expect(sent).toMatchObject({ text: "what first?" });
    expect(landed).toBe("/chat/ses_9");
  });
});

describe("what waits in Memory", () => {
  const doc = (path: string) => ({ path, title: path, savedAt: 0, agent: "nouva", from: "Gading, in a chat with Nouva" });
  const collection = (id: string, name: string, archived = false) => ({ id, name, description: "", readers: "everyone", agents: null, about: [], archived, documents: 1, sections: 1 });

  test("a document an agent saved for a collection is a card on Home and a count on Memory, and opens Knowledge", async () => {
    answer({
      "/approvals": ok({ pending: [] }),
      "/missions": ok({ missions: [] }),
      "/access": ok({ senders: [] }),
      "/skills/drafts": ok({ enabled: true, pending: [], recent: [] }),
      "/memory/proposals": ok({ proposals: [] }),
      "/knowledge": ok({ collections: [collection("house", "House"), collection("old", "Old", true)] }),
      "/knowledge/house/pending": ok({ pending: [doc("boiler.md"), doc("roof.md")] }),
      // Archived: kept, never searched, and nothing in it is asked about.
      "/knowledge/old/pending": ok({ pending: [doc("stale.md")] }),
    });
    let seen = { card: false, badge: "", title: "", href: "" };
    await renderPage("/", async (host) => {
      await eventually(() => host.textContent?.includes("2 documents wait to be added to House") === true, 3_000, "the documents' card");
      seen = {
        card: true,
        badge: host.querySelector('nav[aria-label="Menu"] a[href="/dashboard/memories"] .badge')?.textContent ?? "",
        title: host.ownerDocument.title,
        href: [...host.querySelectorAll("main a")].find((a) => a.textContent?.includes("documents wait"))?.getAttribute("href") ?? "",
      };
    });
    expect(seen).toEqual({ card: true, badge: "2", title: "(2) Nouride", href: "/dashboard/memories?tab=knowledge" });
  });

  test("the Memory page opens on the tab its address names", async () => {
    let selected = "";
    await renderPage("/memories?tab=proposals", async (host) => {
      await eventually(() => host.querySelector('[aria-selected="true"]') !== null, 3_000, "a tab chosen");
      selected = host.querySelector('[aria-selected="true"]')?.textContent?.trim() ?? "";
    });
    expect(selected).toContain("Proposals");
  });
});

describe("Work's first tab", () => {
  test("lists every thing its badge counts: a tool call to answer, and a mission waiting for an answer", async () => {
    answer({
      "/approvals": ok({ pending: [approval] }),
      "/missions": ok({ missions: [mission("m2", "waiting", { waitKind: "input" }), mission("m3", "waiting", { waitKind: "approval" }), mission("m1", "running")] }),
    });
    let seen = { badge: "", answerable: 0, missions: [] as string[] };
    await renderPage("/work", async (host) => {
      await eventually(() => host.querySelector('main a[href="/dashboard/missions/m2"]') !== null, 3_000, "the waiting mission");
      seen = {
        badge: host.querySelector('nav[aria-label="Menu"] a[href="/dashboard/work"] .badge')?.textContent ?? "",
        answerable: [...host.querySelectorAll("main button")].filter((button) => button.textContent?.includes("Allow once")).length,
        missions: [...host.querySelectorAll('main a[href^="/dashboard/missions/"]')].map((a) => a.getAttribute("href") ?? ""),
      };
    });
    // The mission waiting on a tool's approval is that approval, counted and answered once.
    expect(seen).toEqual({ badge: "2", answerable: 1, missions: ["/dashboard/missions/m2"] });
  });
});

test("an agent's name is never the part cut short, and what it does is kept for a pointer (seen on the box)", () => {
  // Seven agents with long lines about them read "N…" on Home's cards; the chips carry the whole name, the line in their title.
  const source = readFileSync(join(import.meta.dir, "../src/modules/home/components/YourAgents.tsx"), "utf8");
  const name = /<span className="([^"]+)">\{name\}<\/span>/.exec(source)?.[1] ?? "";
  expect(name.split(" ")).toContain("shrink-0");
  expect(name.split(" ")).not.toContain("truncate");
  expect(source).toContain("title={agent.headline ? `${name}: ${agent.headline}` : name}");
});

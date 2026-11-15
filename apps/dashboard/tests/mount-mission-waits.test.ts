/**
 * The missions that wait for the person, on Home and on Work, each said as what it waits for, and a mission at work
 * that asked a question: listed among them, and answered on its page while it works.
 */

import { describe, expect, test } from "bun:test";
import { answer, buttons, enabled, press, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, agentId: "nix", goal: `The work of ${id}.`, status: "waiting", seen: "needs_you", waitKind: "input", checklist: null, answers: [], startedAt: 1, ...extra });
const MISSIONS = [
  row("m_question", { answers: [{ question: "Keep the old sheet?\n\nA) keep it\nB) drop it", at: 1, asked: "wait" }] }),
  row("m_draft", { waitKind: "accept", startedAt: null }),
  row("m_result", { waitKind: "accept" }),
  row("m_limit", { waitKind: "limit" }),
  row("m_stuck", { waitKind: "stuck" }),
  row("m_cut", { waitKind: "unknown_outcome" }),
  row("m_asking", { status: "running", seen: "working", waitKind: null, answers: [{ question: "Mermaid adds 735 KB. Take it?", at: 2, asked: "meanwhile" }] }),
  // None of these waits for the reader.
  row("m_working", { status: "running", seen: "working", waitKind: null }),
  row("m_paused", { waitKind: "retry" }),
  row("m_approval", { waitKind: "approval" }),
  row("m_theirs", { changeable: false }),
];
const LINES: Record<string, string> = {
  m_question: "Waiting for your answer: Keep the old sheet? A) keep it B) drop it",
  m_draft: "A draft, not started yet. Start it or drop it",
  m_result: "Its result is ready. Accept it or send it back",
  m_limit: "Stopped at a limit. Let it go on or end it",
  m_stuck: "Stuck. See what stopped it",
  m_cut: "Cut off by a restart. Check it, then let it go on",
  m_asking: "Asks, and works on meanwhile: Mermaid adds 735 KB. Take it?",
};
const PAGES = {
  "/automations/waiting": ok({ waiting: [] }),
  "/status": ok({ status: "ready", gateways: [], providers: [], uptimeMs: 1000, orchestrator: "nix", agents: [{ id: "nix", displayName: "Nix", enabled: true, state: "running", provider: "p", model: "m", tools: [], approvals: "careful" }] }),
  "/approvals": ok({ pending: [] }),
  "/missions": ok({ missions: MISSIONS }),
  "/knowledge": ok({ collections: [] }),
};

describe("the missions that wait, as their cards say it", () => {
  for (const [page, path] of [["Home", "/"], ["Work", "/work"]] as const) {
    test(`${page}: a card for each wait in its own words, one for a mission at work that asked, none for what does not wait`, async () => {
      answer(PAGES);
      await renderPage(path, async (host) => {
        // The card among what waits, by its tag: one at work is also linked from what is moving now.
        const card = (id: string) => [...host.querySelectorAll<HTMLAnchorElement>(`a[href="/dashboard/missions/${id}"]`)].find((link) => link.textContent?.startsWith("Mission · Nix")) ?? null;
        await eventually(() => card("m_asking") !== null, 3_000, page);
        for (const [id, line] of Object.entries(LINES)) {
          const said = card(id)?.querySelectorAll("p")[1];
          expect(said?.textContent, id).toBe(line);
          // A question is long: its line breaks anywhere and stops at two, the whole of it on a pointer's rest.
          expect(said?.getAttribute("title"), id).toBe(line);
          expect(said?.querySelector("span")?.className.split(" "), id).toEqual(expect.arrayContaining(["line-clamp-2", "[overflow-wrap:anywhere]"]));
        }
        // A draft is not an answer somebody owes.
        expect(card("m_draft")!.textContent).not.toContain("answer");
        for (const id of ["m_working", "m_paused", "m_approval", "m_theirs"]) expect(card(id), id).toBeNull();
      });
    });
  }
});

describe("a mission at work that asked a question, on its page", () => {
  const QUESTION = "Mermaid adds 735 KB for one flowchart. Take it?\n\nA) take it\nB) leave it out";
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  /** Every header's words: the app's own, and the page's with the mission's badge. */
  const headers = (host: HTMLElement) => [...host.querySelectorAll("header")].map((header) => header.textContent ?? "").join(" | ");
  const working = (answers: unknown[]) => ({ "/missions/msn_1": ok({ ...shown, mission: { ...shown.mission, status: "running", seen: "working", waitKind: null, reason: null, told: [], answers } }) });

  test("the question and the box to answer it are there, the answer is sent, and the toast says where it went", async () => {
    answer(working([{ question: QUESTION, at: 1, asked: "meanwhile" }]));
    let sent: { path: string; body: unknown }[] = [];
    let said = "";
    let badge = "";
    let toast = "";
    await renderPage("/missions/msn_1", async (host) => {
      await eventually(() => buttons(host).includes("Answer"), 2_000, "the answer box");
      said = host.querySelector('[role="status"]')?.textContent ?? "";
      badge = headers(host);
      const record = recordPosts({ "/missions/msn_1/answer": ok({ mission: { ...shown.mission, status: "running", seen: "working", answers: [{ question: QUESTION, at: 1, asked: "meanwhile", answer: "ya" }] }, said: "Answered. It reads this before its next step.", plain: "Answered. It reads this before its next step." }) });
      type(host.querySelector<HTMLTextAreaElement>('textarea[placeholder="Your answer"]')!, "  ya, masukin  ");
      await enabled(host, "Answer");
      press(host, "Answer");
      await eventually(() => record.posts.length > 0, 2_000, "the answer");
      await eventually(() => document.body.textContent?.includes("It reads this before its next step") === true, 2_000, "the toast");
      toast = document.body.textContent ?? "";
      record.restore();
      sent = record.posts;
    });
    expect(said).toContain("It asked a question and works on meanwhile. Your answer reaches it while it works.");
    expect(said).toContain("Mermaid adds 735 KB for one flowchart. Take it?");
    expect(badge).toContain("Working · asked a question");
    expect(sent).toEqual([{ path: "/missions/msn_1/answer", body: { text: "ya, masukin" } }]);
    expect(toast).toContain("Answered. It reads this before its next step.");
  });

  test("one at work that asked nothing, or whose question is answered, has no such box", async () => {
    for (const answers of [[], [{ question: QUESTION, at: 1, asked: "meanwhile", answer: "ya" }]]) {
      answer(working(answers));
      await renderPage("/missions/msn_1", async (host) => {
        await eventually(() => host.querySelector("h1") !== null, 2_000, "the page");
        expect(host.querySelector('textarea[placeholder="Your answer"]')).toBeNull();
        expect(headers(host)).not.toContain("asked a question");
      });
    }
  });
});

describe("a mission at work that asked a question, in the list of missions", () => {
  const [first] = (WIRE["/missions"] as { missions: Record<string, unknown>[] }).missions;
  const one = (id: string, more: Record<string, unknown>) => ({ ...first, id, status: "running", seen: "working", waitKind: null, reason: null, answers: [], ...more });
  const LISTED = [
    one("msn_waits", { status: "waiting", seen: "needs_you", waitKind: "input", reason: "Which folder?" }),
    one("msn_asks", { answers: [{ question: "Mermaid adds 735 KB. Take it?", at: 2, asked: "meanwhile" }] }),
    one("msn_works", {}),
  ];
  const tabs = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('main [role="tablist"]')].filter((bar) => bar.textContent?.includes("Needs you")).flatMap((bar) => [...bar.querySelectorAll<HTMLElement>('[role="tab"]')]);
  const tab = (host: HTMLElement, label: string) => tabs(host).find((entry) => entry.textContent?.startsWith(label))!;
  const cards = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('a[href^="/dashboard/missions/msn_"]')].map((card) => card.getAttribute("href")!.split("/").pop()!);
  const group = (host: HTMLElement, label: string) => cards(host.querySelector<HTMLElement>(`main section[aria-label="${label}"]`) ?? document.createElement("div"));

  test("it is counted with what needs the reader, as the menu counts it, and with what works; drawn once, with what needs them", async () => {
    answer({ "/missions": ok({ missions: LISTED }) });
    const seen = { needs: "", works: "", all: [] as string[][], needsTab: [] as string[], worksTab: [] as string[] };
    await renderPage("/missions", async (host) => {
      await eventually(() => cards(host).length === 3, 3_000, "the missions");
      seen.needs = tab(host, "Needs you").textContent ?? "";
      seen.works = tab(host, "Working").textContent ?? "";
      seen.all = [group(host, "Needs you"), group(host, "Working")];
      tab(host, "Needs you").click();
      await eventually(() => !cards(host).includes("msn_works"), 3_000, "what needs the reader");
      seen.needsTab = cards(host);
      tab(host, "Working").click();
      await eventually(() => !cards(host).includes("msn_waits"), 3_000, "what works");
      seen.worksTab = cards(host);
    });
    expect(seen).toEqual({ needs: "Needs you2", works: "Working2", all: [["msn_waits", "msn_asks"], ["msn_works"]], needsTab: ["msn_waits", "msn_asks"], worksTab: ["msn_asks", "msn_works"] });
  });
});

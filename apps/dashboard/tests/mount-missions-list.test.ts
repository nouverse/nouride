/**
 * The Missions board, mounted (from the mockup the owner signed off): Backlog, Working, Needs you, Finished,
 * read only. Each case is a way the board would say something else than the daemon's list does: a draft counted as
 * needing the reader, a card in the wrong column or with the wrong line, Finished's span or chips dropping or keeping
 * the wrong ones, a Start or an Answer sent as something else, or a phone opening on a column with nothing to do.
 * In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { describe, expect, test } from "bun:test";
import type { MissionView } from "@nouride/wire";
import { answer, buttons, dom, dropdown, press, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const FIRST = (WIRE["/missions"] as { missions: MissionView[] }).missions[0]!;
const NOW = Date.now();
const one = (id: string, title: string, more: Partial<MissionView>): MissionView => ({ ...FIRST, id, title, goal: `${title}, whole`, ...more });
const DRAFT = one("msn_d", "The small ones", { status: "waiting", seen: "needs_you", waitKind: "accept", startedAt: null, checklist: null, checks: ["a", "b", "c"], accept: true, createdAt: NOW - 12 * 60_000 });
const RUNNING = one("msn_w", "Downloads in Home", { status: "running", seen: "working", checklist: { done: 5, total: 8, active: "running the Android tests" }, activeAt: NOW - 2 * 60_000 });
const ASKS = one("msn_q", "Metrics to Postgres", { status: "waiting", seen: "needs_you", waitKind: "input", reason: "Keep the SQLite file?", answers: [{ question: "Keep the SQLite file?", at: NOW - 9 * 60_000 }], updatedAt: NOW - 9 * 60_000, checklist: { done: 2, total: 5, active: null } });
const DONE = one("msn_ok", "Home monorepo", { status: "done", seen: "done", endedAt: NOW - 86_400_000, checklist: { done: 9, total: 9, active: null } });
const FAILED = one("msn_f", "Benchmark OpenBot", { status: "failed", seen: "ended", reason: "OpenBot needs a cloud account", endedAt: NOW - 3 * 86_400_000, checklist: { done: 3, total: 7, active: null } });
const STOPPED = one("msn_s", "The gallery", { status: "stopped", seen: "ended", reason: "stopped by gading", endedAt: NOW - 3 * 86_400_000, checklist: { done: 2, total: 4, active: null } });
const BOARD = [ASKS, RUNNING, DRAFT, DONE, FAILED, STOPPED];

const column = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-board-column="${id}"]`);
const idsIn = (root: HTMLElement | null) => [...(root?.querySelectorAll<HTMLElement>("[data-mission]") ?? [])].map((card) => card.dataset.mission);
const card = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-mission="${id}"]`)!;
const lineOf = (host: HTMLElement, id: string) => card(host, id).querySelector("[data-line]")?.textContent ?? null;
const shown = (host: HTMLElement) => host.querySelectorAll("[data-mission]").length > 0;

function asked(): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const harness = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.includes("/api/control/missions?")) urls.push(url);
    return harness(input, init);
  }) as typeof fetch;
  return { urls, restore: () => void (globalThis.fetch = harness) };
}

test("the Limits button says Close limits while they are open, and closes them", async () => {
  let open: string[] = [];
  await renderPage("/missions", async (host) => {
    press(host, "Limits");
    await eventually(() => host.textContent?.includes("of work before it asks to go on") === true, 2_000, "the limits");
    open = buttons(host);
    press(host, "Close limits");
    await eventually(() => host.textContent?.includes("of work before it asks to go on") === false, 2_000, "the limits closed");
  });
  expect(open).toContain("Close limits");
  expect(open).not.toContain("Limits");
});

describe("the board", () => {
  test("four columns in order, each mission in one: a draft in the Backlog, never in Needs you; the counts beside each and under the title", async () => {
    answer({ "/missions": ok({ missions: BOARD }) });
    const seen = { columns: [] as (string | null)[], ids: {} as Record<string, unknown>, counts: [] as string[], said: "" };
    await renderPage("/missions", async (host) => {
      await eventually(() => shown(host), 3_000, "the board");
      seen.columns = [...host.querySelectorAll<HTMLElement>("[data-board-column]")].map((section) => section.getAttribute("aria-label"));
      for (const id of ["backlog", "working", "needs", "finished"]) seen.ids[id] = idsIn(column(host, id));
      seen.counts = [...host.querySelectorAll("[data-board-column] header")].map((head) => head.textContent ?? "");
      seen.said = host.querySelector("main h1")?.parentElement?.textContent ?? "";
    });
    expect(seen.columns).toEqual(["Backlog", "Working", "Needs you", "Finished"]);
    expect(seen.ids).toEqual({ backlog: ["msn_d"], working: ["msn_w"], needs: ["msn_q"], finished: ["msn_ok", "msn_f", "msn_s"] });
    expect(seen.counts).toEqual(["Backlog1", "Working1", "Needs you1", "Finished3"]);
    expect(seen.said).toContain("1 in the backlog, 1 working, 1 needs you");
  });

  test("each card: its badge, its title opening its page, its bar by status, the line its column leads with and one time line", async () => {
    answer({ "/missions": ok({ missions: BOARD }) });
    const seen: Record<string, unknown> = {};
    await renderPage("/missions", async (host) => {
      await eventually(() => shown(host), 3_000, "the board");
      for (const mission of BOARD) {
        const one = card(host, mission.id);
        seen[mission.id] = {
          badge: one.querySelector("[data-badge]")?.textContent,
          bar: one.querySelector<HTMLElement>("[data-bar]")?.className.split(" ").find((name) => name.startsWith("bg-")) ?? null,
          line: lineOf(host, mission.id),
          time: one.querySelector("[data-time]")?.textContent,
        };
      }
      const title = card(host, "msn_w").querySelector("h3 a")!;
      seen.title = [title.textContent, title.getAttribute("href"), title.getAttribute("title")];
    });
    expect(seen).toEqual({
      msn_d: { badge: "Draft", bar: null, line: "Done when3 checks pass, then you accept", time: "drafted 12 min ago" },
      msn_w: { badge: "Working", bar: "bg-primary", line: "Nowrunning the Android tests", time: "last step 2 min ago" },
      msn_q: { badge: "Needs you · a question", bar: "bg-primary", line: "AsksKeep the SQLite file?", time: "asked 9 min ago" },
      msn_ok: { badge: "Done", bar: "bg-success", line: null, time: "ended 1 day ago" },
      // Its own red, never the primary orange nor the theme's error.
      msn_f: { badge: "Failed", bar: "bg-failed", line: "WhyOpenBot needs a cloud account", time: "ended 3 days ago" },
      msn_s: { badge: "Stopped", bar: "bg-base-content/35", line: "Bygading", time: "stopped 3 days ago" },
      title: ["Downloads in Home", "/dashboard/missions/msn_w", "Downloads in Home, whole"],
    });
  });

  test("Start on a draft starts it from the card, and Answer sends what was typed; Drop is not on the card", async () => {
    answer({ "/missions": ok({ missions: BOARD }) });
    const posted = recordPosts({ "/missions/msn_d/accept": ok({ mission: DRAFT }), "/missions/msn_q/answer": ok({ mission: ASKS }) });
    const seen = { draft: [] as string[] };
    try {
      await renderPage("/missions", async (host) => {
        await eventually(() => shown(host), 3_000, "the board");
        seen.draft = [...card(host, "msn_d").querySelectorAll("button, a")].map((one) => one.textContent?.trim() ?? "");
        press(card(host, "msn_d"), "Start");
        press(card(host, "msn_q"), "Answer");
        await eventually(() => card(host, "msn_q").querySelector("textarea") !== null, 2_000, "the answer box");
        type(card(host, "msn_q").querySelector("textarea")!, "Keep it");
        await eventually(() => [...card(host, "msn_q").querySelectorAll("button")].some((one) => one.textContent === "Send" && !one.disabled), 2_000, "Send");
        press(card(host, "msn_q"), "Send");
        await eventually(() => posted.posts.length >= 2, 2_000, "both sent");
      });
    } finally {
      posted.restore();
    }
    expect(seen.draft).not.toContain("Drop");
    expect(posted.posts.map((post) => [post.path, post.body])).toEqual([
      ["/missions/msn_d/accept", {}],
      ["/missions/msn_q/answer", { text: "Keep it" }],
    ]);
  });
});

describe("Finished", () => {
  test("its own span, 7, 14, 21 or 30 days, 7 unless chosen; the page's first list is asked for a week", async () => {
    const record = asked();
    const seen = { holds: "" as string | null, options: [] as string[] };
    try {
      await renderPage("/missions", async (host) => {
        const span = dropdown(column(host, "finished") ?? host, "Ended in");
        await eventually(() => span.button() !== undefined, 3_000, "the span");
        seen.holds = span.holds();
        seen.options = await span.open();
        await span.pick("Last 21 days");
        await eventually(() => record.urls.some((url) => url.includes("days=21")), 2_000, "three weeks asked for");
      });
    } finally {
      record.restore();
    }
    expect(seen).toEqual({ holds: "Last 7 days", options: ["Last 7 days", "Last 14 days", "Last 21 days", "Last 30 days"] });
    expect(record.urls[0]).toContain("days=7");
  });

  test("chips by how they ended, with counts: none chosen is all, one chosen is its own, pressing it again clears it", async () => {
    answer({ "/missions": ok({ missions: BOARD }) });
    const seen = { chips: [] as string[], failed: [] as unknown[], cleared: [] as unknown[] };
    await renderPage("/missions", async (host) => {
      await eventually(() => shown(host), 3_000, "the board");
      const chip = (id: string) => column(host, "finished")!.querySelector<HTMLButtonElement>(`[data-outcome="${id}"]`)!;
      seen.chips = ["done", "failed", "stopped"].map((id) => chip(id).textContent ?? "");
      chip("failed").click();
      await eventually(() => idsIn(column(host, "finished")).length === 1, 2_000, "the failed one");
      seen.failed = idsIn(column(host, "finished"));
      chip("failed").click();
      await eventually(() => idsIn(column(host, "finished")).length === 3, 2_000, "all again");
      seen.cleared = idsIn(column(host, "finished"));
    });
    expect(seen).toEqual({ chips: ["Done 1", "Failed 1", "Stopped 1"], failed: ["msn_f"], cleared: ["msn_ok", "msn_f", "msn_s"] });
  });

  test("the first five, and the rest behind \"N more\" at its foot; the open columns show everything", async () => {
    const done = Array.from({ length: 7 }, (_, at) => one(`msn_d${at}`, `Done ${at}`, { status: "done", seen: "done", endedAt: NOW - at * 60_000 }));
    const working = Array.from({ length: 7 }, (_, at) => one(`msn_w${at}`, `Working ${at}`, { status: "running", seen: "working" }));
    answer({ "/missions": ok({ missions: [...working, ...done] }) });
    const seen = { before: 0, working: 0, after: 0 };
    await renderPage("/missions", async (host) => {
      await eventually(() => shown(host), 3_000, "the board");
      seen.before = idsIn(column(host, "finished")).length;
      seen.working = idsIn(column(host, "working")).length;
      press(column(host, "finished")!, "2 more");
      await eventually(() => idsIn(column(host, "finished")).length === 7, 2_000, "all seven");
      seen.after = idsIn(column(host, "finished")).length;
    });
    expect(seen).toEqual({ before: 5, working: 7, after: 7 });
  });
});

describe("on a phone", () => {
  const phone = () => dom.happyDOM.setViewport({ width: 390, height: 844 });
  const tabs = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('[role="tab"][data-tab]')];

  test("the columns are four tabs with their counts, one column shown; it opens on Needs you when anything does", async () => {
    phone();
    answer({ "/missions": ok({ missions: BOARD }) });
    const seen = { tabs: [] as string[], opened: "" as string | undefined, ids: [] as unknown[], heights: [] as string[], after: [] as unknown[] };
    try {
      await renderPage("/missions", async (host) => {
        await eventually(() => tabs(host).length === 4, 3_000, "the tabs");
        seen.tabs = tabs(host).map((tab) => tab.textContent ?? "");
        seen.opened = tabs(host).find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.tab;
        seen.ids = idsIn(host.querySelector("[data-column-shown]"));
        seen.heights = tabs(host).map((tab) => (tab.className.includes("min-h-11") ? "44" : "less"));
        tabs(host).find((tab) => tab.dataset.tab === "backlog")!.click();
        await eventually(() => idsIn(host.querySelector("[data-column-shown]"))[0] === "msn_d", 2_000, "the backlog");
        seen.after = idsIn(host.querySelector("[data-column-shown]"));
      });
    } finally {
      dom.happyDOM.setViewport({ width: 1024, height: 768 });
    }
    expect(seen).toEqual({ tabs: ["1Backlog", "1Working", "1Needs you", "3Finished"], opened: "needs", ids: ["msn_q"], heights: ["44", "44", "44", "44"], after: ["msn_d"] });
  });

  test("with nothing that needs the reader it opens on Working, and a link that named an old tab lands on its column", async () => {
    phone();
    answer({ "/missions": ok({ missions: [RUNNING, DRAFT, FAILED, DONE] }) });
    const seen = { opened: "" as string | undefined, linked: "" as string | undefined, ids: [] as unknown[] };
    try {
      await renderPage("/missions", async (host) => {
        await eventually(() => tabs(host).length === 4, 3_000, "the tabs");
        seen.opened = tabs(host).find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.tab;
      });
      await renderPage("/missions?tab=failed", async (host) => {
        await eventually(() => tabs(host).length === 4 && shown(host), 3_000, "the tabs");
        seen.linked = tabs(host).find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.tab;
        seen.ids = idsIn(host.querySelector("[data-column-shown]"));
      });
    } finally {
      dom.happyDOM.setViewport({ width: 1024, height: 768 });
    }
    expect(seen).toEqual({ opened: "working", linked: "finished", ids: ["msn_f"] });
  });
});

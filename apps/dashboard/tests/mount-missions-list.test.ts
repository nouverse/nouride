/**
 * The Missions board, mounted: Backlog, Working and Needs you as three columns, Finished as a list under them, read
 * only. Each case is a way the board would say something else than the daemon's list does: a draft counted as needing
 * the reader, a card in the wrong column or with the wrong line, Finished's span or chips dropping or keeping the wrong
 * ones, a column hiding what it holds with no way to it, three empty columns taking the page, a Start or an Answer sent
 * as something else, or a phone opening on a column with nothing to do.
 * In a file of its own over the shared harness (`mount-harness.ts`).
 */

import { describe, expect, test } from "bun:test";
import type { MissionView } from "@nouride/wire";
import { answer, buttons, dom, dropdown, enabled, press, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
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
  test("three columns and Finished under them, each mission in one: a draft in the Backlog, never in Needs you; each head carries its count, and no line of counts under the title", async () => {
    answer({ "/missions": ok({ missions: BOARD }) });
    const seen = { columns: [] as (string | null)[], ids: {} as Record<string, unknown>, counts: [] as string[], said: "", strip: true };
    await renderPage("/missions", async (host) => {
      await eventually(() => shown(host), 3_000, "the board");
      seen.columns = [...host.querySelectorAll<HTMLElement>("[data-board-column]")].map((section) => section.getAttribute("aria-label"));
      for (const id of ["backlog", "working", "needs", "finished"]) seen.ids[id] = idsIn(column(host, id));
      seen.counts = [...host.querySelectorAll("[data-board-column] header")].map((head) => head.textContent ?? "");
      seen.said = host.querySelector("main h1")?.parentElement?.textContent ?? "";
      seen.strip = host.querySelector("[data-board-strip]") !== null;
    });
    // One open mission is enough for the columns: the strip is for a board with nothing open at all.
    expect(seen.strip).toBe(false);
    expect(seen.columns).toEqual(["Backlog", "Working", "Needs you", "Finished"]);
    expect(seen.ids).toEqual({ backlog: ["msn_d"], working: ["msn_w"], needs: ["msn_q"], finished: ["msn_ok", "msn_f", "msn_s"] });
    expect(seen.counts).toEqual(["Backlog1", "Working1", "Needs you1", "Finished3 in the last 7 days"]);
    expect(seen.said).not.toContain("in the backlog");
  });

  test("with nothing open the three columns are one thin strip and Finished has the page", async () => {
    answer({ "/missions": ok({ missions: [DONE, FAILED, STOPPED] }) });
    const seen = { strip: "", columns: [] as (string | null)[], rows: [] as unknown[] };
    await renderPage("/missions", async (host) => {
      await eventually(() => shown(host), 3_000, "the board");
      seen.strip = host.querySelector("[data-board-strip]")?.textContent ?? "";
      seen.columns = [...host.querySelectorAll<HTMLElement>("[data-board-column]")].map((section) => section.dataset.boardColumn ?? null);
      seen.rows = idsIn(column(host, "finished"));
    });
    expect(seen.strip).toBe("0Backlog0Working0Needs youNothing is open. A new mission waits in the backlog until you start it.");
    expect(seen.columns).toEqual(["finished"]);
    expect(seen.rows).toEqual(["msn_ok", "msn_f", "msn_s"]);
  });

  test("each card: its badge, its title opening its page, its bar, the line its column leads with and one time line; a finished one is a row with its steps", async () => {
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
      const row = card(host, "msn_f");
      seen.row = [row.tagName, row.querySelector("a")?.getAttribute("href"), /3 of 7 steps/.test(row.textContent ?? "")];
      // The whole row, and the whole card, opens the mission: the title's link is stretched over it, and what is
      // pressed or hovered on it stands over the link.
      const stretched = (id: string) => card(host, id).querySelector<HTMLElement>("[data-opens]")!.className.includes("after:absolute after:inset-0");
      const over = (el: Element | null | undefined) => el?.className.includes("relative z-10") === true;
      seen.opens = { row: stretched("msn_f"), card: stretched("msn_d"), rowTime: over(row.querySelector("[data-tip]")), start: over([...card(host, "msn_d").querySelectorAll("button")].find((one) => one.textContent === "Start")?.parentElement) };
      // A finished row shows the agent's own picture beside its name, as a card does.
      seen.agent = [row.querySelector("[data-agent]")?.textContent, row.querySelector("[data-agent] img, [data-agent] svg, [data-agent] canvas") !== null || row.querySelector("[data-agent]")!.children.length > 1];
    });
    expect(seen).toEqual({
      msn_d: { badge: "Draft", bar: null, line: "Done when3 checks pass, then you accept", time: "drafted 12 min ago" },
      msn_w: { badge: "Working", bar: "bg-primary", line: "Nowrunning the Android tests", time: "last step 2 min ago" },
      msn_q: { badge: "Needs you · a question", bar: "bg-primary", line: "AsksKeep the SQLite file?", time: "asked 9 min ago" },
      // A finished one is a row: no bar, its steps in words.
      msn_ok: { badge: "Done", bar: null, line: null, time: "ended 1 day ago" },
      msn_f: { badge: "Failed", bar: null, line: "WhyOpenBot needs a cloud account", time: "ended 3 days ago" },
      msn_s: { badge: "Stopped", bar: null, line: "Bygading", time: "stopped 3 days ago" },
      title: ["Downloads in Home", "/dashboard/missions/msn_w", "Downloads in Home, whole"],
      row: ["LI", "/dashboard/missions/msn_f", true],
      opens: { row: true, card: true, rowTime: true, start: true },
      agent: [seen.agent && (seen.agent as unknown[])[0], true],
    });
    expect(String((seen.agent as unknown[])[0]).length).toBeGreaterThan(0);
  });

  test("the day and the minute behind each time line: made for a draft, started too for work, since when for one that waits, ended for a finished one; reached by keyboard", async () => {
    answer({ "/missions": ok({ missions: BOARD }) });
    const seen: Record<string, unknown> = {};
    await renderPage("/missions", async (host) => {
      await eventually(() => shown(host), 3_000, "the board");
      for (const id of ["msn_d", "msn_w", "msn_q", "msn_ok"]) {
        const tip = card(host, id).querySelector<HTMLElement>("[data-tip]")!;
        seen[id] = [(tip.dataset.tip ?? "").split(" · ").map((part) => /^(Created|Started|Waiting since|Ended) .*\d{4}/.exec(part)?.[1] ?? part), tip.querySelector("[data-time]")?.getAttribute("tabindex"), tip.querySelector(".sr-only")?.textContent === `: ${tip.dataset.tip}`];
      }
      // Over the line on a card, whose buttons are under it; to the left on a row, which ends at the page's edge.
      seen.sides = ["msn_d", "msn_ok"].map((id) => card(host, id).querySelector<HTMLElement>("[data-tip]")!.className.split(" ").find((name) => /^tooltip-/.test(name)));
    });
    expect(seen).toEqual({
      msn_d: [["Created"], "0", true],
      msn_w: [["Created", "Started"], "0", true],
      msn_q: [["Created", "Started", "Waiting since"], "0", true],
      msn_ok: [["Created", "Started", "Ended"], "0", true],
      sides: ["tooltip-top", "tooltip-left"],
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

describe("New mission", () => {
  test("New mission saved to the backlog is sent as a draft, and the page stays on the board; Start now starts it and opens its page", async () => {
    let sent: { path: string; body: unknown }[] = [];
    const seen = { buttons: [] as string[], said: "", after: "", closed: false, landed: "" };
    await renderPage("/missions", async (host, app) => {
      press(host, "New mission");
      await eventually(() => buttons(host).includes("Save to backlog"), 2_000, "the form");
      seen.buttons = buttons(host).filter((label) => ["Save to backlog", "Start now", "Start mission"].includes(label));
      seen.said = host.textContent ?? "";
      const record = recordPosts({ "/missions": { status: 201, body: { mission: { ...RUNNING, id: "msn_1" } } } });
      type(host.querySelector('textarea[placeholder^="Upgrade the API"]') as HTMLTextAreaElement, "Summarise last week's logs");
      await enabled(host, "Save to backlog");
      press(host, "Save to backlog");
      await eventually(() => !buttons(host).includes("Save to backlog"), 2_000, "the form closed");
      seen.after = app.location();
      seen.closed = !buttons(host).includes("Start now");
      press(host, "New mission");
      await eventually(() => buttons(host).includes("Start now"), 2_000, "the form again");
      type(host.querySelector('textarea[placeholder^="Upgrade the API"]') as HTMLTextAreaElement, "Tidy the notes");
      await enabled(host, "Start now");
      press(host, "Start now");
      await eventually(() => app.location() === "/missions/msn_1", 2_000, "the mission's page");
      seen.landed = app.location();
      record.restore();
      sent = record.posts;
    });
    // The form's own button saves a draft: a mission a person writes waits in the backlog, as an agent's does.
    expect(seen.buttons).toEqual(["Save to backlog", "Start now"]);
    expect(seen.said).toContain("Saved, it waits in the backlog until you start it. Nothing runs before that.");
    expect(sent).toEqual([
      { path: "/missions", body: { agent: "nouva", goal: "Summarise last week's logs", draft: true } },
      { path: "/missions", body: { agent: "nouva", goal: "Tidy the notes" } },
    ]);
    expect(seen.after).toBe("/missions");
    expect(seen.closed).toBe(true);
    expect(seen.landed).toBe("/missions/msn_1");
  });

  test("the form takes a brief and the mission's own limits, shows the usual limits in the empty fields, and sends no limit that is not a number", async () => {
    const usual = WIRE["/policy/missions"] as { limitHours: number; limitTurns: number; limitTokens: number };
    let sent: { path: string; body: unknown }[] = [];
    const seen = { said: "", placeholders: [] as string[], refused: "", blocked: true };
    await renderPage("/missions", async (host) => {
      press(host, "New mission");
      await eventually(() => buttons(host).includes("Save to backlog"), 2_000, "the form");
      const limits = () => [...host.querySelectorAll<HTMLInputElement>("form input.tabular-nums")];
      await eventually(() => limits()[0]?.placeholder !== "", 2_000, "the usual limits");
      seen.said = host.textContent ?? "";
      seen.placeholders = limits().map((one) => one.placeholder);
      const record = recordPosts({ "/missions": { status: 201, body: { mission: { ...RUNNING, id: "msn_2" } } } });
      type(host.querySelector('textarea[placeholder^="Upgrade the API"]') as HTMLTextAreaElement, "Summarise last week's logs");
      const brief = [...host.querySelectorAll<HTMLTextAreaElement>("form textarea")].find((one) => one.closest("label, div")?.textContent?.includes("Brief") && !one.placeholder)!;
      type(brief, "Read the incident notes first.");
      // Not a number: said under the form, and neither button sends it.
      type(limits()[0]!, "a day");
      await eventually(() => (host.textContent ?? "").includes("A limit is a number"), 2_000, "the limit refused");
      seen.refused = host.textContent ?? "";
      seen.blocked = [...host.querySelectorAll<HTMLButtonElement>("form button")].filter((one) => ["Save to backlog", "Start now"].includes(one.textContent?.trim() ?? "")).every((one) => one.disabled);
      type(limits()[0]!, "24");
      type(limits()[2]!, "400");
      await enabled(host, "Save to backlog");
      press(host, "Save to backlog");
      await eventually(() => !buttons(host).includes("Save to backlog"), 2_000, "the form closed");
      record.restore();
      sent = record.posts;
    });
    expect(seen.said).toContain("Where this mission stops to ask you whether to go on. Only this one. Left empty, it has the limit every mission starts with.");
    expect(seen.placeholders).toEqual([String(usual.limitHours), String(usual.limitTurns), String(usual.limitTokens / 1_000_000)]);
    expect(seen.refused).toContain("A limit is a number: 12, or 0.5 for half an hour.");
    expect(seen.blocked).toBe(true);
    expect(sent).toEqual([{ path: "/missions", body: { agent: "nouva", goal: "Summarise last week's logs", brief: "Read the incident notes first.", limits: { hours: 24, tokens: 400_000_000 }, draft: true } }]);
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

  test("every column shows its first five and the rest behind \"Show N more\", which opens it and folds it again; one of five has no such button", async () => {
    const done = Array.from({ length: 7 }, (_, at) => one(`msn_d${at}`, `Done ${at}`, { status: "done", seen: "done", endedAt: NOW - at * 60_000 }));
    const working = Array.from({ length: 8 }, (_, at) => one(`msn_w${at}`, `Working ${at}`, { status: "running", seen: "working" }));
    const drafts = Array.from({ length: 5 }, (_, at) => one(`msn_b${at}`, `Draft ${at}`, { status: "waiting", seen: "needs_you", waitKind: "accept", startedAt: null }));
    answer({ "/missions": ok({ missions: [...working, ...drafts, ...done] }) });
    const count = (host: HTMLElement, id: string) => idsIn(column(host, id)).length;
    const seen = { before: [] as number[], heads: [] as string[], more: [] as (string | undefined)[], opened: [] as number[], folded: 0 };
    await renderPage("/missions", async (host) => {
      await eventually(() => shown(host), 3_000, "the board");
      seen.before = ["backlog", "working", "finished"].map((id) => count(host, id));
      // The head counts what the column holds, not what it shows.
      seen.heads = ["backlog", "working"].map((id) => column(host, id)!.querySelector("header")?.textContent ?? "");
      seen.more = ["backlog", "working", "finished"].map((id) => column(host, id)!.querySelector(`[data-more="${id}"]`)?.textContent);
      press(column(host, "working")!, "Show 3 more");
      press(column(host, "finished")!, "Show 2 more");
      await eventually(() => count(host, "working") === 8 && count(host, "finished") === 7, 2_000, "both opened");
      seen.opened = [count(host, "working"), count(host, "finished")];
      press(column(host, "working")!, "Show less");
      await eventually(() => count(host, "working") === 5, 2_000, "folded again");
      seen.folded = count(host, "working");
    });
    expect(seen).toEqual({ before: [5, 5, 5], heads: ["Backlog5", "Working8"], more: [undefined, "Show 3 more", "Show 2 more"], opened: [8, 7], folded: 5 });
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

  test("a tab shows its first five and \"Show N more\"; nothing can be hovered, so the day stands beside each time line; Finished is cards under its span and chips", async () => {
    phone();
    const drafts = Array.from({ length: 7 }, (_, at) => one(`msn_b${at}`, `Draft ${at}`, { status: "waiting", seen: "needs_you", waitKind: "accept", startedAt: null, createdAt: NOW - (at + 1) * 60_000 }));
    answer({ "/missions": ok({ missions: [...drafts, DONE] }) });
    const panel = (host: HTMLElement) => host.querySelector<HTMLElement>("[data-column-shown]");
    const seen = { first: 0, more: "" as string | undefined, time: "", tip: true, all: 0, finished: [] as unknown[] };
    try {
      await renderPage("/missions?tab=backlog", async (host) => {
        await eventually(() => tabs(host).length === 4 && shown(host), 3_000, "the tabs");
        seen.first = idsIn(panel(host)).length;
        seen.more = panel(host)!.querySelector('[data-more="backlog"]')?.textContent ?? undefined;
        seen.time = panel(host)!.querySelector("[data-time]")?.textContent ?? "";
        seen.tip = panel(host)!.querySelector("[data-tip]") !== null;
        press(panel(host)!, "Show 2 more");
        await eventually(() => idsIn(panel(host)).length === 7, 2_000, "all seven");
        seen.all = idsIn(panel(host)).length;
        tabs(host).find((tab) => tab.dataset.tab === "finished")!.click();
        await eventually(() => panel(host)?.dataset.columnShown === "finished", 2_000, "Finished");
        const head = panel(host)!.querySelector("[data-finished-head]");
        seen.finished = [panel(host)!.querySelector("[data-mission]")?.tagName, head?.querySelector("[data-outcome]") !== null, head?.textContent?.includes("Last 7 days")];
      });
    } finally {
      dom.happyDOM.setViewport({ width: 1024, height: 768 });
    }
    const today = new Date(NOW - 60_000).toLocaleDateString([], { day: "numeric", month: "short" });
    expect(seen).toEqual({ first: 5, more: "Show 2 more", time: `drafted 1 min ago · ${today}`, tip: false, all: 7, finished: ["ARTICLE", true, true] });
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

/**
 * A mission's page (0.8.0): named by its goal's first sentence, in a size a long goal fits — the whole goal under it,
 * three lines of it until opened. A paragraph of a goal was the page's title, a wall of large type. And (0.8.7) one that
 * waits on anything but an accept can be accepted as it is from here, asked first. In a file of its own over the shared
 * harness (`mount-harness.ts`).
 */

import { expect, test } from "bun:test";
import { answer, buttons, enabled, press, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const GOAL =
  "Automated Nouride test. Deliver the text \"e2e 0.8.0: mission always test\" to web:dashboard:web-1 with the send_message tool, exactly once. " +
  "If that call is parked for approval, end your turn and wait for the answer; this mission is done only once the message has been delivered. " +
  "Then call mission done with a one-line report.";

/** Lay the goal out as a window narrower than it would: taller than its three lines, or not. happy-dom lays out nothing. */
function laidOut(cut: boolean): () => void {
  const proto = Object.getPrototypeOf(document.createElement("p")) as object;
  const before = { scroll: Object.getOwnPropertyDescriptor(proto, "scrollHeight"), client: Object.getOwnPropertyDescriptor(proto, "clientHeight") };
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => (cut ? 120 : 60) });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 60 });
  return () => {
    for (const [key, was] of [["scrollHeight", before.scroll], ["clientHeight", before.client]] as const) {
      if (was) Object.defineProperty(proto, key, was);
      else delete (proto as Record<string, unknown>)[key];
    }
  };
}

test("its title is its name, the whole goal under it, folded until opened", async () => {
  const restore = laidOut(true);
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  answer({ "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, title: "The delivery test", goal: GOAL } } } });
  let title = "";
  let folded = false;
  let opened = false;
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => host.querySelector("h1") !== null, 2_000, "the page");
    title = host.querySelector("h1")?.textContent ?? "";
    const goal = [...host.querySelectorAll("p")].find((p) => p.textContent === GOAL);
    folded = goal?.className.includes("line-clamp-3") === true;
    [...host.querySelectorAll("button")].find((b) => b.textContent === "Show the whole goal")!.click();
    await eventually(() => [...host.querySelectorAll("button")].some((b) => b.textContent === "Show less"), 2_000, "opened");
    opened = !([...host.querySelectorAll("p")].find((p) => p.textContent === GOAL)?.className.includes("line-clamp-3") ?? true);
  });
  restore();
  expect(title).toBe("The delivery test");
  expect(folded).toBe(true);
  expect(opened).toBe(true);
});

test("a goal its three lines show whole offers nothing to open", async () => {
  const restore = laidOut(false);
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  answer({ "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, goal: GOAL } } } });
  const html = await renderPage("/missions/msn_1");
  restore();
  expect(html).toContain("Then call mission done with a one-line report.");
  expect(html).not.toContain("Show the whole goal");
});

test("a short goal is its own name, said once", async () => {
  const html = await renderPage("/missions/msn_1");
  const goal = ((WIRE["/missions/msn_1"] as { mission: { goal: string } }).mission.goal);
  expect(html.split(goal).length - 1).toBe(1);
  expect(html).not.toContain("Show the whole goal");
});

test("one waiting on its question is accepted as it is: asked first — cancelled, nothing is sent; confirmed, the accept — nothing typed", async () => {
  // On the live box a person typed `/mission accept … --outside` into the answer box, where it reached the agent as words.
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  const question = "Close it as done outside? A) yes B) no";
  answer({ "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, status: "waiting", seen: "needs_you", waitKind: "input", reason: question, answers: [{ question, at: 1 }] } } } });
  let sent: { path: string; body: unknown }[] = [];
  let beforeConfirm = -1;
  let afterCancel = -1;
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => buttons(host).includes("Accept as it is"), 2_000, "accept as it is");
    const record = recordPosts();
    // What the open confirmation offers: one answered keeps its words while it closes.
    const asked = () => [...host.querySelectorAll("dialog[open] button")].map((button) => button.textContent?.trim() ?? "");
    // Cancelled: nothing is sent.
    press(host, "Accept as it is");
    await eventually(() => asked().includes("Accept it"), 2_000, "the confirmation");
    press(host, "Cancel");
    await eventually(() => !asked().includes("Accept it"), 2_000, "the confirmation closed");
    afterCancel = record.posts.length;
    press(host, "Accept as it is");
    await eventually(() => asked().includes("Accept it"), 2_000, "the confirmation again");
    beforeConfirm = record.posts.length;
    press(host, "Accept it");
    await eventually(() => record.posts.length > 0, 2_000, "the accept");
    record.restore();
    sent = record.posts;
  });
  expect(afterCancel).toBe(0);
  expect(beforeConfirm).toBe(0);
  expect(sent).toEqual([{ path: "/missions/msn_1/accept", body: {} }]);
});

/** The mission's conversation: its turns as `useConversation` reads them, from the fixture's own shape — with any other answers the test gives. */
function missionTurns(turns: Record<string, unknown>[], also: Parameters<typeof answer>[0] = {}): void {
  const shown = WIRE["/sessions/ses_1/turns"] as Record<string, unknown>;
  answer({ ...also, "/sessions/ses_msn_1/turns": { status: 200, body: { ...shown, session: { ...(shown.session as object), id: "ses_msn_1", gatewayId: "web:mission", chatId: "msn_1" }, turns } } });
}

const why = (line: string) => `MISSION msn_1 — turn 1\nGoal: fix it\nWhy this turn: ${line}\nChecklist: none yet.`;
const at = (minute: number) => 1_760_000_000_000 + minute * 60_000;
const missionTurn = (n: number, over: Record<string, unknown>) => ({ id: `turn_${n}`, agentId: "nouva", chatId: "msn_1", sessionId: "ses_msn_1", status: "done", prompt: why("continue with the next step."), reply: "", toolCalls: 0, startedAt: at(n), endedAt: at(n) + 1000, durationMs: 1000, steps: [], ...over });

test("its turns are a timeline (0.8.8): a point each, why in words, the same failure in a row once", async () => {
  // msn_2fa88b on the live box: three turns that failed alike were three blocks, and a turn woken by nox's answer read
  // "[System event — not a message from a person. Nobody is waiting on a reply.]".
  const limit = "Claude Code did not start: You've hit your session limit";
  missionTurns([
    missionTurn(1, { status: "failed", error: limit, prompt: why("the mission starts. Write the checklist with `plan` first, then begin.") }),
    missionTurn(2, { status: "failed", error: limit }),
    missionTurn(3, { status: "failed", error: limit }),
    missionTurn(40, { prompt: why("[System event — not a message from a person. Nobody is waiting on a reply.]\n@nouva\nThe answer from nox has arrived, to what you asked at 05:05"), reply: "Nox approved the diff." }),
  ]);
  let points = 0;
  let text = "";
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => host.querySelector("ul.timeline > li") !== null, 2_000, "the timeline");
    points = host.querySelectorAll("ul.timeline > li").length;
    text = host.querySelector("ul.timeline")?.textContent ?? "";
  });
  expect(points).toBe(2);
  expect(text).toContain("Turn 4");
  expect(text).toContain("nox answered");
  expect(text).not.toContain("[System event");
  expect(text).toContain("Turns 1–3");
  expect(text).toContain("failed 3 times");
  expect(text.split(limit).length - 1).toBe(1);
  // The wait before it, where it was long: 37 minutes after the third ended.
  expect(text).toContain("after the turn before");
});

test("each reason says what it means on hovering it — \"the next step\" with an arrow down left the owner asking", async () => {
  missionTurns([missionTurn(1, {}), missionTurn(2, {})]);
  let tips: string[] = [];
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => host.querySelector("ul.timeline > li") !== null, 2_000, "the timeline");
    tips = [...host.querySelectorAll("ul.timeline .tooltip")].map((tip) => tip.getAttribute("data-tip") ?? "");
  });
  expect(tips).toContain("The turn before ended with work left, so the mission went on with its checklist.");
});

test("its result is across the page, above its turns; no question asked is no Questions card", async () => {
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  missionTurns([missionTurn(1, {})], { "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, report: "All three fixes are merged.", answers: [] } } } });
  let order: string[] = [];
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => host.querySelector("ul.timeline") !== null, 2_000, "the timeline");
    order = [...host.querySelectorAll("section h2, section h3")].map((heading) => heading.textContent ?? "");
  });
  expect(order.indexOf("Result")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("Result")).toBeLessThan(order.indexOf("Turns"));
  expect(order).not.toContain("Questions");
});

test("one at work can be told something (0.8.10): the box sends the words, the toast says where they went, and what it was told shows whether it read it", async () => {
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  const told = [
    { id: "tel_1", by: "Gading", at: 1_760_000_000_000, text: "use the second tab", read: 2 },
    { id: "tel_2", by: "Gading", via: "nouva", at: 1_760_000_060_000, text: "PDF, not DOCX" },
  ];
  answer({ "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, status: "running", seen: "working", told } } } });
  let sent: { path: string; body: unknown }[] = [];
  let card = "";
  let toast = "";
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => buttons(host).includes("Tell"), 2_000, "the tell box");
    card = [...host.querySelectorAll("section")].find((section) => section.textContent?.includes("Tell it"))?.textContent ?? "";
    const record = recordPosts({ "/missions/msn_1/tell": { status: 200, body: { mission: { ...shown.mission, told }, said: "Told. It reads this before its next step." } } });
    type(host.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. use the second tab"]')!, "  and the totals  ");
    await enabled(host, "Tell");
    press(host, "Tell");
    await eventually(() => record.posts.length > 0, 2_000, "the tell");
    await eventually(() => document.body.textContent?.includes("It reads this before its next step") === true, 2_000, "the toast");
    toast = document.body.textContent ?? "";
    record.restore();
    sent = record.posts;
  });
  expect(sent).toEqual([{ path: "/missions/msn_1/tell", body: { text: "and the totals" } }]);
  expect(toast).toContain("Told. It reads this before its next step.");
  expect(card).toContain("read in turn 2");
  expect(card).toContain("not read yet");
  expect(card).toContain("Gading via nouva");
});

test("a tell answered in the chat's words and the page's: the toast says the page's, never the chat's command (0.8.23)", async () => {
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  answer({ "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, status: "running", seen: "working", told: [] } } } });
  let toast = "";
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => buttons(host).includes("Tell"), 2_000, "the tell box");
    const record = recordPosts({
      "/missions/msn_1/tell": {
        status: 200,
        body: {
          mission: { ...shown.mission, told: [] },
          said: "Kept for its next turn. It is waiting at its limit: /mission continue msn_1 lets it go on.",
          plain: "Kept for its next turn. It is waiting at its limit: Continue lets it go on.",
        },
      },
    });
    type(host.querySelector<HTMLTextAreaElement>('textarea[placeholder^="e.g. use the second tab"]')!, "and the totals");
    await enabled(host, "Tell");
    press(host, "Tell");
    await eventually(() => document.body.textContent?.includes("Continue lets it go on") === true, 2_000, "the toast");
    toast = document.body.textContent ?? "";
    record.restore();
  });
  expect(toast).toContain("Kept for its next turn. It is waiting at its limit: Continue lets it go on.");
  expect(toast).not.toContain("/mission continue");
});

test("one that ended shows what it was told, and offers no box", async () => {
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  answer({ "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, status: "done", seen: "done", told: [{ id: "tel_1", by: "Gading", at: 1, text: "use the second tab", read: 2 }] } } } });
  let text = "";
  let labels: string[] = [];
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => host.textContent?.includes("What it was told while it worked.") === true, 2_000, "the told card");
    text = host.textContent ?? "";
    labels = buttons(host);
  });
  expect(text).toContain("use the second tab");
  expect(labels).not.toContain("Tell");
});


test("a reviewer's brief naming a long path breaks it, rather than running out of its card", async () => {
  // msn_2edee7 on the live box: "Check the RFC's claims against the code …" ran 140 px past "Done when" (2026-10-31).
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  const review = "Read the revised RFC against the brief at /srv/nouride/.nouride/workspace/private/nix/briefs/v0811-rfc-revision-owner-answers.md.";
  missionTurns([missionTurn(1, {})], { "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, reviewOn: true, review } } } });
  let line: Element | undefined;
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => doneWhen(host) !== undefined, 2_000, "what decides it is done");
    doneWhen(host)!.click();
    await eventually(() => (line = [...host.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Reviewer · "))) !== undefined, 2_000, "the reviewer's line");
  });
  expect(line?.textContent).toBe(`Reviewer · ${review}`);
  expect(line?.className).toContain("[overflow-wrap:anywhere]");
});

test("a mission under review says the reviewer is looking, which pass, and for how long — not only that its checks run", async () => {
  // msn_b97876 on the live box (0.8.10): ten minutes of "Running its checks", and nothing said whether it was stuck.
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  missionTurns([missionTurn(1, {})], { "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, status: "checking", seen: "working" }, reviewing: { pass: 2, of: 3, since: Date.now() - 65_000 } } } });
  let text = "";
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => (text = host.textContent ?? "").includes("The reviewer is looking"), 2_000, "the reviewer's line");
  });
  expect(text).toContain("The reviewer is looking: pass 2 of 3");
  expect(text).toMatch(/Now · review · 1m/);
  expect(text).not.toContain("Running its checks");
});

test("its actions keep one row beside its title from md: Accept, Continue, Stop — Stop wrapped under Accept beside a long title", async () => {
  // A screenshot of msn_b97876 (2026-10-31): the actions shrank to what the title left, and Stop fell to a row
  // of its own. happy-dom lays out nothing, so the classes that keep the row are what is asserted.
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  missionTurns([missionTurn(1, {})], { "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, status: "waiting", waitKind: "accept", seen: "needs_you", startedAt: 1 } } } });
  let row: HTMLElement | null = null;
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => (row = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Stop")?.parentElement ?? null) !== null, 2_000, "the actions");
  });
  const actions = row as HTMLElement | null;
  // Its own buttons — the confirm dialog it holds has one of its own.
  expect([...(actions?.querySelectorAll(":scope > button") ?? [])].map((button) => button.textContent?.trim())).toEqual(["Accept", "Continue", "Stop"]);
  expect(actions?.className).toContain("md:shrink-0");
  expect(actions?.className).toContain("md:flex-nowrap");
});

test("from the top: what it does now and how far it is, its brief across the page, then its checklist over its turns, and beside them its folder, what decides it is done, then the box to tell it", async () => {
  // "Now" and the meters were under the brief, a scroll away. What decides it is done stood beside the brief for a
  // moment, where it read as a second brief: it is beside the work, under the folder.
  missionTurns([missionTurn(1, {})]);
  answer({ "/missions/msn_1": detailOf({}, { brief: "The brief it works from.", briefPath: "/w/private/nova/missions/msn_1/BRIEF.md" }) });
  const seen = { order: [] as string[], brief: "", main: [] as string[], side: [] as string[], phone: {} as Record<string, string | undefined> };
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => host.querySelector("[data-work]") !== null && buttons(host).includes("Read it whole"), 2_000, "the page");
    const titled = (root: Element) => [...root.querySelectorAll("h2, h3")].map((head) => head.textContent ?? "");
    const cardOf = (title: string, root: Element = host) => [...root.querySelectorAll("section")].find((one) => one.querySelector("h2, h3")?.textContent === title);
    const meters = host.querySelector('[aria-label="Progress and limits"]')!;
    const brief = cardOf("Brief")!;
    const work = host.querySelector("[data-work]")!;
    const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    seen.order = [before(meters, brief) ? "meters, then the brief" : "the brief first", before(brief, work) ? "the brief, then the work" : "the work first"];
    // Across the page: the page's own child, sharing its row with nothing.
    seen.brief = brief.parentElement === work.parentElement ? "across the page" : "in a row with something";
    const [main, side] = [...work.children] as [HTMLElement, HTMLElement];
    seen.main = titled(main).filter((title) => ["Checklist", "Turns", "Done when"].includes(title));
    const folder = side.querySelector("[data-folder]")!;
    const done = cardOf("Done when", side)!;
    const tell = side.querySelector("textarea")!;
    seen.side = [side.tagName, before(folder, done) ? "its folder, then what decides it" : "what decides it first", before(done, tell) ? "then the box" : "the box first", titled(side).slice(0, 2).join(", ")];
    // happy-dom lays out nothing, so the classes that order the one column on a phone are what is asserted.
    const order = (el: Element | null | undefined) => el?.className.split(" ").find((name) => name.startsWith("max-lg:order-"));
    seen.phone = { checklist: order(cardOf("Checklist", work)), folder: order(folder.closest("section")), done: order(done.closest("[class*='max-lg:order-']")), tell: order(tell.closest("[class*='max-lg:order-']")), turns: order(cardOf("Turns", work)), main: main.className.includes("max-lg:contents") ? "contents" : "a column" };
  });
  expect(seen.order).toEqual(["meters, then the brief", "the brief, then the work"]);
  expect(seen.brief).toBe("across the page");
  expect(seen.main).toEqual(["Checklist", "Turns"]);
  // Each card of the side column says what it is: the folder was a bare path with no word over it.
  expect(seen.side).toEqual(["ASIDE", "its folder, then what decides it", "then the box", "Folder, Done when"]);
  expect(seen.phone).toEqual({ checklist: "max-lg:order-1", folder: "max-lg:order-2", done: "max-lg:order-3", tell: "max-lg:order-4", turns: "max-lg:order-6", main: "contents" });
});

/** The page's answer for msn_1 with the mission changed — a state the fixture's install does not hold. */
function detailOf(mission: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  return { status: 200, body: { ...shown, mission: { ...shown.mission, ...mission }, ...extra } };
}

test("a draft (0.8.11): its brief shown, and changed before it starts — only what changed is sent", async () => {
  answer({ "/missions/msn_1": detailOf({ status: "waiting", seen: "needs_you", waitKind: "accept", startedAt: null, checks: ["test -s RFC.md"], reviewOn: true, accept: false }, { brief: "## What to read\nThe owner's answers, first." }) });
  let sent: { path: string; body: unknown }[] = [];
  let shown = "";
  let toast = "";
  let there: boolean[] = [];
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => buttons(host).includes("Change the draft"), 2_000, "the draft's card");
    // Nothing of a draft has run: no meters, no checklist, no turns, no box to tell it something, and no "Needs you".
    // As yes or no, not the elements themselves: a failure that prints a whole page's nodes never ends.
    there = ['[aria-label="Progress and limits"]', "[data-work]", '[role="status"].alert'].map((what) => host.querySelector(what) !== null);
    // The brief folded until opened, then read in place.
    openBrief(host);
    await eventually(() => host.textContent?.includes("The owner's answers, first.") === true, 2_000, "the brief, opened");
    shown = host.textContent ?? "";
    press(host, "Change the draft");
    await eventually(() => buttons(host).includes("Save the draft"), 2_000, "the form");
    const checks = [...host.querySelectorAll("textarea")].find((area) => area.value === "test -s RFC.md") as HTMLTextAreaElement;
    type(checks, "test -s RFC.md\nbun run check-paths");
    const accept = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("I accept the result"))!.querySelector("input") as HTMLInputElement;
    accept.click();
    await enabled(host, "Save the draft");
    const record = recordPosts({
      "/missions/msn_1/edit": {
        status: 200,
        body: { mission: {}, changed: ["checks (2)", "folder /srv/work/rfc"], briefFailed: "EACCES: permission denied, open '/srv/work/rfc/BRIEF.md'", plain: "Saved, but its brief could not be written, so it has none for now. Whoever runs the server can see why." },
      },
    });
    press(host, "Save the draft");
    await eventually(() => record.posts.length > 0, 2_000, "the change");
    await eventually(() => document.body.textContent?.includes("its brief could not be written") === true, 2_000, "the toast");
    toast = document.body.textContent ?? "";
    record.restore();
    sent = record.posts;
  });
  expect(shown).toContain("Nothing has run. Change it here, then start it, or delete it.");
  expect(there).toEqual([false, false, false]);
  expect(shown).toContain("drafted");
  // Its badge says Draft, as its card on the board does: a draft is no call on the reader.
  expect(shown).toContain("Draft");
  expect(shown).not.toContain("Needs you");
  expect(shown).not.toContain("started");
  expect(shown).toContain("What to read");
  expect(shown).toContain("The owner's answers, first.");
  expect(sent).toEqual([{ path: "/missions/msn_1/edit", body: { checks: ["test -s RFC.md", "bun run check-paths"], accept: true } }]);
  // The page's words (0.8.23): neither the chat's list, a path in it, nor the server's error.
  expect(toast).toContain("Saved, but its brief could not be written, so it has none for now.");
  expect(toast).not.toContain("/srv/work/rfc");
});

test("a mission at work has no draft form, and its brief is still shown — folded until opened, its file there all along", async () => {
  answer({ "/missions/msn_1": detailOf({}, { brief: "The brief it works from.", briefPath: "/w/private/nova/missions/msn_1/BRIEF.md" }) });
  let folded = "";
  let page = "";
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => buttons(host).includes("Read it whole"), 2_000, "the brief's card");
    folded = host.textContent ?? "";
    openBrief(host);
    await eventually(() => host.textContent?.includes("The brief it works from.") === true, 2_000, "the brief, opened");
    page = host.textContent ?? "";
  });
  expect(folded).toContain("Kept in its folder: each turn starts from it, beside the goal.");
  expect(folded).not.toContain("The brief it works from.");
  expect(page).not.toContain("Change the draft");
});

test("a mission's page: four meters against its limits, the checklist with each step's note, how it is judged done — and only Stop while it works", async () => {
  const seen: { html?: string; buttons?: string[] } = {};
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => host.textContent?.includes("Checklist") === true, 2_000, "the page");
    // How it is judged done is folded to its one line until opened.
    [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) => button.textContent?.startsWith("Done when"))!.click();
    await eventually(() => host.querySelector("[data-done-when]") !== null, 2_000, "what decides it is done, opened");
    seen.html = host.innerHTML;
    seen.buttons = buttons(host);
  });
  for (const words of ["1 of 3", "0 of 50", "0m of 8h", "0 of 50M", "du in sizes.txt — build/ is 41 GB", "test -s report.md", "/srv/nouride/workspace/shared/report"]) {
    expect(seen.html).toContain(words);
  }
  expect(seen.buttons).toContain("Stop");
  expect(seen.buttons!.some((label) => /^(Continue|Accept|Answer)/.test(label))).toBe(false);
});

test("its checklist is folded to the five steps around the one at work, with all of them a press away", async () => {
  const steps = Array.from({ length: 12 }, (_, at) => ({ text: `step ${at + 1}`, state: at < 7 ? "done" : at === 7 ? "active" : "pending" }));
  missionTurns([missionTurn(1, {})]);
  answer({ "/missions/msn_1": detailOf({}, { plan: { steps } }) });
  const seen = { folded: [] as string[], button: "", opened: 0, again: 0 };
  const texts = (host: HTMLElement) => [...host.querySelectorAll("[data-checklist] li")].map((one) => (one.textContent ?? "").replace(/^.*?: /, "").replace(/^\d+\./, "").trim());
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => host.querySelector("[data-checklist]") !== null, 2_000, "the checklist");
    seen.folded = texts(host);
    seen.button = [...host.querySelectorAll("[data-checklist] button")].map((one) => one.textContent ?? "").join();
    press(host.querySelector<HTMLElement>("[data-checklist]")!, "Show all 12 steps");
    await eventually(() => texts(host).length === 12, 2_000, "all twelve");
    seen.opened = texts(host).length;
    press(host.querySelector<HTMLElement>("[data-checklist]")!, "Show less");
    await eventually(() => texts(host).length === 5, 2_000, "folded again");
    seen.again = texts(host).length;
  });
  expect(seen.folded).toEqual(["step 6", "step 7", "step 8", "step 9", "step 10"]);
  expect(seen.button).toBe("Show all 12 steps");
  expect([seen.opened, seen.again]).toEqual([12, 5]);
});

test("a picture its report names among its own result files is drawn in place; any other name is its words, and one on the web still waits for a press", async () => {
  const folder = "/srv/nouride/workspace/shared/report";
  answer({
    "/missions/msn_1": detailOf({
      status: "done",
      seen: "done",
      workdir: folder,
      report: "# What changed\n\n![How a message travels](flow.png)\n\n![The old layout](charts/before%20it.png)\n\n![Not handed back](elsewhere.png)\n\n![From the web](https://example.com/pic.png)",
      files: [`${folder}/notes.md`, `${folder}/flow.png`, `${folder}/charts/before it.png`, `${folder}/drawing.svg`],
    }),
  });
  const seen = { own: [] as (string | null)[][], words: false, web: [] as unknown[] };
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => host.querySelector("img[data-own-picture]") !== null, 2_000, "the report's picture");
    seen.own = [...host.querySelectorAll<HTMLImageElement>("img[data-own-picture]")].map((img) => [img.getAttribute("src"), img.getAttribute("alt")]);
    // A name the result does not hold is no picture: its words, and nothing asked of anywhere.
    seen.words = (host.textContent ?? "").includes("Not handed back") && [...host.querySelectorAll("img")].every((img) => !(img.getAttribute("src") ?? "").includes("elsewhere"));
    seen.web = [buttons(host).filter((label) => label.includes("Show picture")).length, [...host.querySelectorAll("img")].some((img) => (img.getAttribute("src") ?? "").startsWith("https://example.com"))];
  });
  // By its place among the files, the second and the third: the daemon serves nothing by a path.
  expect(seen.own).toEqual([
    ["/api/control/missions/msn_1/files/1", "How a message travels"],
    ["/api/control/missions/msn_1/files/2", "The old layout"],
  ]);
  expect(seen.words).toBe(true);
  expect(seen.web).toEqual([1, false]);
});

/** The Done when card's header, which opens and closes it. */
function doneWhen(host: HTMLElement): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) => button.textContent?.startsWith("Done when"));
}

test("what decides it is done is one line until opened, and open by itself once a check has failed", async () => {
  // Ten commands open at the top of the page pushed the result down it (live).
  const checks = Array.from({ length: 10 }, (_, at) => `test -s part-${at}.md`);
  answer({ "/missions/msn_1": detailOf({ checks, accept: true, lastCheck: null }, { brief: "The brief it works from." }) });
  const seen = { folded: [] as unknown[], opened: [] as unknown[], failed: [] as unknown[] };
  const state = (host: HTMLElement) => [doneWhen(host)?.getAttribute("aria-expanded"), host.querySelector("[data-done-when]") !== null, host.textContent?.includes("test -s part-9.md") === true];
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => doneWhen(host) !== undefined, 2_000, "the card");
    seen.folded = [...state(host), doneWhen(host)!.textContent?.includes("10 checks pass, then you accept.") === true];
    doneWhen(host)!.click();
    await eventually(() => host.querySelector("[data-done-when]") !== null, 2_000, "opened");
    seen.opened = state(host);
  });
  answer({ "/missions/msn_1": detailOf({ checks, lastCheck: "part-3.md is empty" }) });
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => doneWhen(host) !== undefined, 2_000, "the card");
    seen.failed = [...state(host), host.textContent?.includes("part-3.md is empty") === true];
  });
  expect(seen.folded).toEqual(["false", false, false, true]);
  expect(seen.opened).toEqual(["true", true, true]);
  expect(seen.failed).toEqual(["true", true, true, true]);
});

/** The Brief card's header, which opens and closes it. */
function openBrief(host: HTMLElement): void {
  const header = [...host.querySelectorAll("button[aria-expanded]")].find((button) => button.textContent?.startsWith("Brief"));
  if (!header) throw new Error("no Brief card to open");
  (header as HTMLButtonElement).click();
}

test("a draft is deleted from its page at once: asked first with what goes, one request, then the list; it is not stopped on the way", async () => {
  answer({ "/missions/msn_1": detailOf({ status: "waiting", seen: "needs_you", waitKind: "accept", startedAt: null }) });
  const deletes: string[] = [];
  const posts = recordPosts();
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    if (init?.method !== "DELETE") return (spy as typeof fetch)(input as RequestInfo, init);
    const url = new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost");
    deletes.push(url.pathname.replace(/^\/api\/control/, "") + url.search);
    return Promise.resolve(new Response(JSON.stringify({ ok: true, mission: "msn_1", turns: 0 }), { status: 200, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  const seen = { actions: [] as string[], asked: "", landed: "" };
  try {
    await renderPage("/missions/msn_1", async (host, { location }) => {
      await eventually(() => buttons(host).includes("Start it"), 2_000, "the draft's page");
      seen.actions = buttons(host).filter((label) => ["Start it", "Drop it", "Stop", "Delete"].includes(label));
      press(host, "Delete");
      await eventually(() => buttons(host).includes("Delete it"), 2_000, "the ask");
      seen.asked = host.textContent ?? "";
      press(host, "Delete it");
      await eventually(() => location() === "/missions", 2_000, "back on the list");
      seen.landed = location();
    });
  } finally {
    globalThis.fetch = spy;
    posts.restore();
  }
  expect(seen.actions).toEqual(["Start it", "Delete"]);
  expect(seen.asked).toContain("Nothing has run. Its brief and the folder Nouride made for it go with it, and it does not come back.");
  expect(deletes).toEqual(["/missions/msn_1"]);
  expect(posts.posts.filter((post) => post.path.endsWith("/stop"))).toEqual([]);
  expect(seen.landed).toBe("/missions");
});

test("an ended one is deleted from its page (0.8.13): asked first, asked again over work nobody committed, then the list", async () => {
  // Test missions lingered on the live box: a mission went only with its conversation, from the chat list.
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  answer({ "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, status: "stopped", seen: "ended", endedAt: 1_760_000_000_000 } } } });
  const replies = [
    { status: 409, body: { error: "Mission msn_1's folder holds work nobody committed: /w/nouva/msn_1/worktree. Commit it there first.", note: "With force (`--force`, or Delete anyway on its page) that work is lost." } },
    { status: 200, body: { ok: true, mission: "msn_1", turns: 2 } },
  ];
  const deletes: string[] = [];
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    if (init?.method !== "DELETE") return (spy as typeof fetch)(input as RequestInfo, init);
    const url = new URL(String(typeof input === "string" ? input : (input as Request).url), "http://localhost");
    deletes.push(url.pathname.replace(/^\/api\/control/, "") + url.search);
    const reply = replies.shift()!;
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  let secondAsk = "";
  let landed = "";
  try {
    await renderPage("/missions/msn_1", async (host, { location }) => {
      await eventually(() => buttons(host).includes("Delete"), 2_000, "Delete");
      press(host, "Delete");
      await eventually(() => buttons(host).includes("Delete it"), 2_000, "the first ask");
      press(host, "Delete it");
      await eventually(() => buttons(host).includes("Delete anyway"), 2_000, "the second ask");
      secondAsk = host.textContent ?? "";
      press(host, "Delete anyway");
      await eventually(() => location() === "/missions", 2_000, "back on the list");
      landed = location();
    });
  } finally {
    globalThis.fetch = spy;
  }
  expect(deletes).toEqual(["/missions/msn_1", "/missions/msn_1?force=1"]);
  expect(secondAsk).toContain("holds work nobody committed: /w/nouva/msn_1/worktree");
  expect(landed).toBe("/missions");
});

test("asked again over that work in the page's words where the server gives them (0.8.20): no git words, no flag", async () => {
  // "…holds work nobody committed: … Commit it there first." and "`--force`" reached the dialog as the CLI says them.
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  answer({ "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, status: "stopped", seen: "ended", endedAt: 1_760_000_000_000 } } } });
  const plain = "Its folder holds changes that were not kept in its history: 1 file. Deleted anyway, those changes are lost.";
  const replies = [
    {
      status: 409,
      body: {
        error: "Mission msn_1's folder holds work nobody committed: /w/nouva/msn_1/worktree. Commit it there first.",
        note: "With force (`--force`, or Delete anyway on its page) that work is lost.",
        plain,
      },
    },
    { status: 200, body: { ok: true, mission: "msn_1", turns: 2 } },
  ];
  const spy = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    if (init?.method !== "DELETE") return (spy as typeof fetch)(input as RequestInfo, init);
    const reply = replies.shift()!;
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } }));
  }) as typeof fetch;
  let secondAsk = "";
  try {
    await renderPage("/missions/msn_1", async (host, { location }) => {
      await eventually(() => buttons(host).includes("Delete"), 2_000, "Delete");
      press(host, "Delete");
      await eventually(() => buttons(host).includes("Delete it"), 2_000, "the first ask");
      press(host, "Delete it");
      await eventually(() => buttons(host).includes("Delete anyway"), 2_000, "the second ask");
      secondAsk = host.querySelector("dialog[open]")?.textContent ?? host.textContent ?? "";
      press(host, "Delete anyway");
      await eventually(() => location() === "/missions", 2_000, "back on the list");
    });
  } finally {
    globalThis.fetch = spy;
  }
  expect(secondAsk).toContain(plain);
  expect(secondAsk).not.toMatch(/committed|Commit it|--force|Deleted anyway, it is lost/);
});

test("one still working has no Delete — Stop comes first", async () => {
  let shownButtons: string[] = [];
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => buttons(host).includes("Stop"), 2_000, "Stop");
    shownButtons = buttons(host);
  });
  expect(shownButtons).not.toContain("Delete");
});

test("a draft's name is changed in its form: only the name is sent, and no more than a name holds can be typed", async () => {
  answer({ "/missions/msn_1": detailOf({ status: "waiting", seen: "needs_you", waitKind: "accept", startedAt: null, title: "The RFC", checks: [], reviewOn: true, accept: false }) });
  let sent: { path: string; body: unknown }[] = [];
  let most = "";
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => buttons(host).includes("Change the draft"), 2_000, "the draft's card");
    press(host, "Change the draft");
    await eventually(() => buttons(host).includes("Save the draft"), 2_000, "the form");
    const name = [...host.querySelectorAll("input")].find((input) => input.value === "The RFC") as HTMLInputElement;
    most = name.getAttribute("maxlength") ?? "";
    type(name, "  The RFC, revised  ");
    await enabled(host, "Save the draft");
    const record = recordPosts({ "/missions/msn_1/edit": { status: 200, body: { mission: {}, changed: ["title"], plain: "Saved. The chat it began in is told what changed." } } });
    press(host, "Save the draft");
    await eventually(() => record.posts.length > 0, 2_000, "the change");
    record.restore();
    sent = record.posts;
  });
  expect(most).toBe("60");
  expect(sent).toEqual([{ path: "/missions/msn_1/edit", body: { title: "The RFC, revised" } }]);
});

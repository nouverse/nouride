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

test("a long goal: its first sentence is the name, the whole goal under it, folded until opened", async () => {
  const restore = laidOut(true);
  const shown = WIRE["/missions/msn_1"] as { mission: Record<string, unknown> };
  answer({ "/missions/msn_1": { status: 200, body: { ...shown, mission: { ...shown.mission, goal: GOAL } } } });
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
  expect(title).toBe("Automated Nouride test.");
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
    await eventually(() => (line = [...host.querySelectorAll("p")].find((p) => p.textContent?.startsWith("Reviewer · "))) !== undefined, 2_000, "the reviewer's line");
  });
  expect(line?.textContent).toBe(`Reviewer · ${review}`);
  expect(line?.className).toContain("[overflow-wrap:anywhere]");
});

test("a mission under review says the reviewer is looking, which pass, and for how long — not only that its checks run", async () => {
  // msn_b97876 on the live box (0.8.10): ten minutes of "Running its checks", and the owner asked whether it was stuck.
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
  // The owner's screenshot of msn_b97876 (2026-10-31): the actions shrank to what the title left, and Stop fell to a row
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

test("on a phone its Checklist comes before its turns; from lg, beside them (0.8.11)", async () => {
  // "How far is it" was read past every turn below lg. happy-dom lays out nothing, so the classes that order the one
  // column are what is asserted: the side column's cards are the grid's own items there, the Checklist the first.
  missionTurns([missionTurn(1, {})]);
  let checklist: HTMLElement | null = null;
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => (checklist = [...host.querySelectorAll("section")].find((one) => one.querySelector("h2, h3")?.textContent === "Checklist") ?? null) !== null, 2_000, "the Checklist");
  });
  const card = checklist as HTMLElement | null;
  expect(card?.className).toContain("max-lg:order-first");
  expect(card?.parentElement?.tagName).toBe("ASIDE");
  expect(card?.parentElement?.className).toContain("max-lg:contents");
  expect(card?.parentElement?.className).toContain("lg:space-y-5");
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
  await renderPage("/missions/msn_1", async (host) => {
    await eventually(() => buttons(host).includes("Change the draft"), 2_000, "the draft's card");
    // The brief folded until opened (the owner's word), then read in place.
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
  expect(shown).toContain("Nothing has run. Change it here, then start it, or drop it.");
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

/** The Brief card's header, which opens and closes it. */
function openBrief(host: HTMLElement): void {
  const header = [...host.querySelectorAll("button[aria-expanded]")].find((button) => button.textContent?.startsWith("Brief"));
  if (!header) throw new Error("no Brief card to open");
  (header as HTMLButtonElement).click();
}

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

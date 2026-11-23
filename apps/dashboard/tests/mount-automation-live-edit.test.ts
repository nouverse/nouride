/**
 * An agent changes the automation a person has open, from the chat over its page: through the whole app, as a person
 * meets it. The page says what it holds with each message; the agent's change arrives drawn over the steps, with what
 * it adds, changes and removes marked; Apply puts it into the draft, unsaved, with a way back; Discard leaves the draft
 * as it was.
 *
 * Each case is a way it would lose somebody's work or mislead them: a message that leaves without what is on the page,
 * or with what was saved and not what is there now; a change applied by arriving; one saved by being applied; one for
 * another automation drawn here; a change a person discarded gone for good; a page that only reads saying it can be
 * changed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { AutomationChange, AutomationStep } from "@nouride/wire";
import { dropLiveEdit, waitingLiveEdit } from "@/commons/lib/live-edit";
import { answer, dom, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { automation, detail, drawn, editStep, flowDrawn, ok, saveBar, stepCard, STEPS } from "./automation-fixtures.ts";
import { AT_REST, boxIn, card, floatButton, LAST_AGENT_KEY, recordRequests, sendIn } from "./floating-chat-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

afterEach(() => {
  dom.localStorage.removeItem(LAST_AGENT_KEY);
  // The change waiting is the whole browser's: one a test left would be drawn on the next test's page.
  const waiting = waitingLiveEdit();
  if (waiting) dropLiveEdit(waiting.id);
});

const PAGE = "/automations/cron_e";
const [CHECK, , , TELL] = STEPS as [AutomationStep, AutomationStep, AutomationStep, AutomationStep];
/** The agent's version: the second step asks something else, the wait for a person is gone, and a step is added at the end. */
const CHANGED: AutomationStep[] = [CHECK, { id: "find", kind: "agentTurn", message: "Find out why, and how long it was down." }, TELL, { id: "s4", kind: "command", name: "Note it down", argv: ["sh", "-lc", "date >> outages.log"] }];
const change = (over: Partial<AutomationChange> = {}): AutomationChange => ({
  name: "Shop check",
  agentId: "nouva",
  payload: { kind: "steps", steps: CHANGED } as AutomationChange["payload"],
  target: { gatewayId: "telegram:nouva", chatId: "-100200" },
  delivery: { mode: "announce" },
  session: "fresh",
  ...over,
});
const offer = (id: string, value: AutomationChange, target: string | null = "cron_e") => ok({ offer: { id, kind: "automation", target, value, by: "nouva", at: 1_760_000_002_000 } });

/** A turn of Nouva's in the open conversation: the steps written since the reader's last read, and where it has read to. */
const turn = (status: "running" | "done", steps: Record<string, unknown>[], cursor: number, reply = "") =>
  ok({
    jobs: [],
    turn: { id: "turn_9", agentId: "nouva", chatId: "web-1", sessionId: "ses_1", status, prompt: "shorten it", reply, toolCalls: 1, startedAt: 1_760_000_001_000, ...(status === "done" ? { endedAt: 1_760_000_003_000, durationMs: 2_000 } : {}), steps, cursor },
  });
const ASKED = { seq: 1, at: 1_760_000_001_000, kind: "tool", text: "schedule Shop check", callId: "c1", name: "schedule", ms: 0 };
const wrote = (id: string) => ({ seq: 2, at: 1_760_000_002_000, kind: "tool_done", text: "schedule ok · 4ms", callId: "c1", name: "schedule", error: false, outcome: "ok", liveEdit: id, ms: 4 });
const SENT = { "/chat/send": ok({ sessionId: "ses_1", chatId: "web-1", messageId: "msg_9", agentId: "nouva" }) };
const base = (more: Record<string, unknown> = {}) => ({ ...AT_REST, [PAGE]: detail(automation()), ...more });
/** The daemon once the agent's call is done: its step, with the change's id, and the change to fetch by that id. */
const written = (id: string, value: AutomationChange, target: string | null = "cron_e") =>
  base({ "/sessions/ses_1/live?after=1": turn("running", [wrote(id)], 2), "/sessions/ses_1/live": turn("running", [], 2), [`/live-edits/${id}`]: offer(id, value, target) });

const bar = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Change from the chat"]');
const press = (host: HTMLElement, label: string) => ([...bar(host)!.querySelectorAll("button")].find((one) => one.textContent?.trim() === label) as HTMLButtonElement).click();
const tags = (host: HTMLElement) => Object.fromEntries(drawn(host).map((id) => [id, stepCard(host, id).querySelector("[data-tag]")?.textContent ?? ""]));
const sent = (posts: { path: string; body: unknown }[]) => posts.filter((post) => post.path === "/chat/send").map((post) => post.body as { text: string; page?: Record<string, unknown> & { liveEdit?: { kind: string; id: string | null; value: Record<string, unknown> } } });
const saves = (posts: { path: string }[]) => posts.filter((post) => post.path.startsWith("/cron") || post.path.startsWith("/webhooks"));

/** The floating chat opened over the page and a request sent in it: the turn is at work, its call asked and not done. */
async function asked(host: HTMLElement, words = "shorten it", more: Record<string, unknown> = {}): Promise<void> {
  await eventually(() => floatButton(host) !== null, 4_000, "the chat's button");
  floatButton(host)!.click();
  await eventually(() => boxIn(card()) !== null, 3_000, "the conversation in the panel");
  type(boxIn(card())!, words);
  await eventually(() => sendIn(card())?.disabled === false, 2_000, "send enabled");
  answer(base({ ...more, "/sessions/ses_1/live": turn("running", [ASKED], 1) }));
  sendIn(card())!.click();
  await eventually(() => card()?.textContent?.includes("schedule Shop check") === true, 4_000, "the turn at work");
}

describe("what the page says it holds, with each message from the chat over it", () => {
  test("the automation as it is on the page, in the shape a save would make it, with which one it is", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await asked(host);
      });
      const [message] = sent(posted.posts);
      expect(message!.page!.liveEdit).toEqual({
        kind: "automation",
        id: "cron_e",
        value: {
          agentId: "nouva",
          name: "Shop check",
          payload: { kind: "steps", steps: STEPS },
          target: { gatewayId: "telegram:nouva", chatId: "-100200" },
          delivery: { mode: "announce" },
          cron: "0 7 * * *",
          // The zone its pattern is read in, as the page shows it: the server's own where the automation named none.
          tz: "UTC",
          start: "scheduled",
          session: "fresh",
        },
      });
    } finally {
      posted.restore();
    }
  });

  test("with what the person has changed and not saved: the page's own copy, not the one that is saved", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        editStep(host, 2).click();
        await eventually(() => host.querySelector("textarea") !== null, 2_000, "the step's words to change");
        type(host.querySelector("main textarea") as HTMLTextAreaElement, "Find out why, in one line.");
        await eventually(() => saveBar(host) !== null, 2_000, "unsaved changes");
        await asked(host);
      });
      const steps = (sent(posted.posts)[0]!.page!.liveEdit!.value.payload as { steps: { id: string; message?: string }[] }).steps;
      expect(steps.find((step) => step.id === "find")!.message).toBe("Find out why, in one line.");
    } finally {
      posted.restore();
    }
  });

  test("a page that makes a new one says it is one with no id yet; a page that changes nothing says it holds nothing", async () => {
    const proposal = { "/automations/cron_p": detail(automation({ id: "cron_p", enabled: false, proposal: { by: "nouva", at: 1 } })) };
    answer(base(proposal));
    const posted = recordPosts(SENT);
    try {
      await renderPage("/automations/new", async (host) => {
        await eventually(() => host.textContent?.includes("Add the first step") === true, 4_000, "the page that makes one");
        await asked(host, "make me one");
      });
      expect(sent(posted.posts)[0]!.page!.liveEdit).toMatchObject({ kind: "automation", id: null, value: { name: "", payload: { kind: "steps", steps: [] }, start: "scheduled" } });
      // A proposal's page is answered with its card, not edited: nothing there is the person's to change.
      answer(base(proposal));
      await renderPage("/automations/cron_p", async (host) => {
        await flowDrawn(host);
        await asked(host, "what is this?", proposal);
      });
      expect(sent(posted.posts)[1]!.page).toEqual({ path: "/dashboard/automations/cron_p", title: "Automations", subject: "Shop check" });
    } finally {
      posted.restore();
    }
  });
});

describe("a change the agent wrote to it", () => {
  test("is drawn over the steps as it arrives, with what it adds, changes and removes, and nothing is applied or saved by that", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    const seen = { words: "", labels: [] as string[], changedOrder: [] as string[], changedTags: {} as Record<string, string>, edits: -1, asItIs: [] as string[], asItIsTags: {} as Record<string, string>, save: false };
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await asked(host);
        answer(written("edit_1", change()));
        await eventually(() => bar(host) !== null, 4_000, "the change, drawn on the page");
        seen.words = bar(host)!.textContent ?? "";
        seen.labels = [...bar(host)!.querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
        // Shown as it would be, the moment it arrives: it is what the person asked for.
        await eventually(() => drawn(host).includes("s4"), 2_000, "the steps with the change");
        seen.changedOrder = drawn(host);
        seen.changedTags = tags(host);
        seen.edits = host.querySelectorAll('main [aria-label^="Edit step"], main [aria-label^="Add a step"]').length;
        press(host, "As you have it");
        await eventually(() => drawn(host).includes("ok"), 2_000, "the steps as they are");
        seen.asItIs = drawn(host);
        seen.asItIsTags = tags(host);
        seen.save = saveBar(host) !== null;
      });
      expect(seen.words).toContain("Nouva changed this automation");
      expect(seen.words).toContain("Adds step 4. Changes step 2. Removes step 3 of the ones it runs now. Nothing changes until you apply it, and nothing is saved until you save.");
      expect(seen.labels).toEqual(["Apply", "Discard", "As you have it", "With the change"]);
      expect(seen.changedOrder).toEqual(["check", "find", "tell", "s4"]);
      expect(seen.changedTags).toEqual({ check: "", find: "Would change", tell: "", s4: "Suggested" });
      // With the change is only to be read: what is changed is the draft, and that is the other side.
      expect(seen.edits).toBe(0);
      expect(seen.asItIs).toEqual(["check", "find", "ok", "tell"]);
      expect(seen.asItIsTags).toEqual({ check: "", find: "Would change", ok: "Would be removed", tell: "" });
      // Nothing was put into the draft by its arriving, and nothing was sent to be saved.
      expect(seen.save).toBe(false);
      expect(saves(posted.posts)).toEqual([]);
    } finally {
      posted.restore();
    }
  });

  test("Apply puts it into the draft, unsaved, and says so with a way back; Undo is the draft as it was", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    const seen = { applied: "", order: [] as string[], save: false, editable: false, undone: [] as string[], saveAfterUndo: true, barAfterUndo: true };
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await asked(host);
        answer(written("edit_1", change()));
        await eventually(() => bar(host) !== null, 4_000, "the change, drawn on the page");
        press(host, "Apply");
        await eventually(() => bar(host)?.textContent?.includes("You applied") === true, 2_000, "applied, said");
        seen.applied = bar(host)!.textContent ?? "";
        seen.order = drawn(host);
        seen.save = saveBar(host) !== null;
        seen.editable = editStep(host, 2) !== null;
        press(host, "Undo");
        await eventually(() => drawn(host).includes("ok"), 2_000, "the draft as it was");
        seen.undone = drawn(host);
        seen.saveAfterUndo = saveBar(host) !== null;
        seen.barAfterUndo = bar(host) !== null;
      });
      expect(seen.applied).toContain("You applied Nouva's change");
      expect(seen.applied).toContain("It is in this automation now, and not saved yet: save it when you are ready, or take it back.");
      expect(seen.order).toEqual(["check", "find", "tell", "s4"]);
      // In the draft it is the person's own change like any other: the page offers to save it, and its steps are theirs to edit.
      expect(seen.save).toBe(true);
      expect(seen.editable).toBe(true);
      expect(seen.undone).toEqual(["check", "find", "ok", "tell"]);
      expect(seen.saveAfterUndo).toBe(false);
      expect(seen.barAfterUndo).toBe(false);
      expect(saves(posted.posts)).toEqual([]);
    } finally {
      posted.restore();
    }
  });

  test("applied over changes of the person's own, Undo brings those back, not what is saved", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    const seen = { before: "", applied: "", undone: "", save: false };
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        editStep(host, 2).click();
        await eventually(() => host.querySelector("main textarea") !== null, 2_000, "the step's words to change");
        type(host.querySelector("main textarea") as HTMLTextAreaElement, "My own words for it.");
        await eventually(() => saveBar(host) !== null, 2_000, "unsaved changes");
        seen.before = stepCard(host, "find").textContent ?? "";
        await asked(host);
        answer(written("edit_1", change()));
        await eventually(() => bar(host) !== null, 4_000, "the change, drawn on the page");
        press(host, "Apply");
        await eventually(() => bar(host)?.textContent?.includes("You applied") === true, 2_000, "applied");
        seen.applied = stepCard(host, "find").textContent ?? "";
        press(host, "Undo");
        await eventually(() => drawn(host).includes("ok"), 2_000, "the draft as it was");
        seen.undone = stepCard(host, "find").textContent ?? "";
        seen.save = saveBar(host) !== null;
      });
      expect(seen.before).toContain("My own words for it.");
      expect(seen.applied).toContain("Find out why, and how long it was down.");
      expect(seen.undone).toContain("My own words for it.");
      expect(seen.save).toBe(true);
    } finally {
      posted.restore();
    }
  });

  test("the way back goes once the draft is changed again by hand: going back then would take that too", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await asked(host);
        answer(written("edit_1", change()));
        await eventually(() => bar(host) !== null, 4_000, "the change, drawn on the page");
        press(host, "Apply");
        await eventually(() => bar(host)?.textContent?.includes("You applied") === true, 2_000, "applied");
        editStep(host, 2).click();
        await eventually(() => host.querySelector("main textarea") !== null, 2_000, "the step's words to change");
        type(host.querySelector("main textarea") as HTMLTextAreaElement, "Changed again by hand.");
        await eventually(() => bar(host) === null, 2_000, "the way back gone");
        expect(stepCard(host, "find").textContent).toContain("Changed again by hand.");
      });
    } finally {
      posted.restore();
    }
  });

  test("Discard leaves the draft as it was, and the chat has the change still: shown again from there, or said gone", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    const seen = { after: [] as string[], save: true, again: false, gone: "" };
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await asked(host);
        answer(written("edit_1", change()));
        await eventually(() => bar(host) !== null, 4_000, "the change, drawn on the page");
        press(host, "Discard");
        await eventually(() => bar(host) === null, 2_000, "the bar gone");
        seen.after = drawn(host);
        seen.save = saveBar(host) !== null;
        const show = () => [...(card()?.querySelectorAll("button") ?? [])].find((one) => one.textContent?.trim() === "Show the change on the page") as HTMLButtonElement | undefined;
        await eventually(() => show() !== undefined, 3_000, "the change's button in the chat");
        show()!.click();
        await eventually(() => bar(host) !== null, 3_000, "the change, drawn again");
        seen.again = drawn(host).includes("s4");
        press(host, "Discard");
        await eventually(() => bar(host) === null, 2_000, "the bar gone again");
        // A restart forgot it: asked for again, the person is told, and nothing is drawn.
        answer({ ...written("edit_1", change()), "/live-edits/edit_1": { status: 404, body: { error: "no such change", plain: "That change is no longer here. Ask the agent for it again." } } });
        show()!.click();
        await eventually(() => dom.document.body.textContent?.includes("That change is no longer here. Ask for it again.") === true, 3_000, "told it is gone");
        seen.gone = bar(host) === null ? "not drawn" : "drawn";
      });
      expect(seen.after).toEqual(["check", "find", "ok", "tell"]);
      expect(seen.save).toBe(false);
      expect(seen.again).toBe(true);
      expect(seen.gone).toBe("not drawn");
      expect(saves(posted.posts)).toEqual([]);
    } finally {
      posted.restore();
    }
  });

  test("one for another automation is not drawn here: it waits for the page that holds that one", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    const seen = recordRequests();
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await asked(host);
        answer(written("edit_2", change(), "cron_other"));
        await eventually(() => seen.paths.includes("/live-edits/edit_2"), 4_000, "the change fetched");
        const reads = () => seen.paths.filter((path) => path === "/sessions/ses_1/live").length;
        const from = reads();
        await eventually(() => reads() >= from + 2, 6_000, "two more reads of the turn");
        expect(bar(host)).toBeNull();
        expect(drawn(host)).toEqual(["check", "find", "ok", "tell"]);
        expect(waitingLiveEdit()?.target).toBe("cron_other");
      });
    } finally {
      seen.restore();
      posted.restore();
    }
  });

  test("a new start, a new name and a script it brings are said before it is applied, and the script is there to read", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    const scripted: AutomationStep[] = [CHECK, { id: "s2", kind: "command", argv: ["python3"], script: { text: "print('sum the outages')", about: "Sums up the outages" } } as AutomationStep];
    const seen = { words: "", script: false, text: "" };
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await asked(host);
        answer(written("edit_3", change({ name: "Shop check, hourly", starts: { start: "scheduled", trigger: { kind: "every", everyMs: 3_600_000 } }, payload: { kind: "steps", steps: scripted } as AutomationChange["payload"] })));
        await eventually(() => bar(host) !== null, 4_000, "the change, drawn on the page");
        seen.words = bar(host)!.textContent ?? "";
        await eventually(() => drawn(host).includes("s2"), 2_000, "the steps with the change");
        const read = stepCard(host, "s2").querySelector("[data-script-read] button") as HTMLButtonElement | null;
        seen.script = read !== null;
        read?.click();
        await eventually(() => stepCard(host, "s2").querySelector("pre") !== null, 2_000, "the script's text");
        seen.text = stepCard(host, "s2").querySelector("pre")?.textContent ?? "";
      });
      expect(seen.words).toContain('Renames it to "Shop check, hourly".');
      expect(seen.words).toContain("It would start every hour.");
      expect(seen.words).toContain("It brings a script in step 2. Read it before you apply.");
      expect(seen.script).toBe(true);
      expect(seen.text).toBe("print('sum the outages')");
    } finally {
      posted.restore();
    }
  });
});

describe("when and against what a change is drawn", () => {
  test("against the draft as it is when the change arrives, which may have moved since the message was sent", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    const seen = { tags: {} as Record<string, string>, words: "" };
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await asked(host);
        // While the agent works, the person rewrites the last step. The change still says it as it was saved.
        editStep(host, 4).click();
        await eventually(() => host.querySelector("main textarea") !== null, 2_000, "the step's words to change");
        type(host.querySelector("main textarea") as HTMLTextAreaElement, "The shop was down for a while.");
        await eventually(() => saveBar(host) !== null, 2_000, "unsaved changes");
        answer(written("edit_1", change()));
        await eventually(() => bar(host) !== null, 4_000, "the change, drawn on the page");
        seen.words = bar(host)!.textContent ?? "";
        press(host, "As you have it");
        await eventually(() => drawn(host).includes("ok"), 2_000, "the steps as they are");
        seen.tags = tags(host);
      });
      // Applying it would put the saved words back over the person's own: said, and marked on that step.
      expect(seen.tags).toEqual({ check: "", find: "Would change", ok: "Would be removed", tell: "Would change" });
      expect(seen.words).toContain("Adds step 4. Changes steps 2 and 3. Removes step 3 of the ones it runs now.");
    } finally {
      posted.restore();
    }
  });

  test("its last word, where a turn wrote the change twice: the earlier one is one it wrote over", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    const first = { ...wrote("edit_1"), callId: "c1" };
    const second = { ...wrote("edit_2"), seq: 3, callId: "c2" };
    const later: AutomationStep[] = [CHECK, TELL];
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await asked(host);
        answer(
          base({
            "/sessions/ses_1/live?after=1": turn("running", [first, second], 3),
            "/sessions/ses_1/live": turn("running", [], 3),
            "/live-edits/edit_1": offer("edit_1", change()),
            "/live-edits/edit_2": offer("edit_2", change({ payload: { kind: "steps", steps: later } as AutomationChange["payload"] })),
          }),
        );
        await eventually(() => bar(host) !== null, 4_000, "the change, drawn on the page");
        await eventually(() => drawn(host).length === 2, 2_000, "the later change's steps");
        expect(drawn(host)).toEqual(["check", "tell"]);
        expect(waitingLiveEdit()?.id).toBe("edit_2");
      });
    } finally {
      posted.restore();
    }
  });

  test("not for a turn first seen with its change already written: it happened before the chat was looking, and is one press away", async () => {
    // The conversation opens on a turn that ended with the change made: an hour ago, for all the page knows.
    // Its steps are read once, and nothing new is written after: a read past them gets none.
    answer(base({ "/sessions/ses_1/live": turn("running", [ASKED, wrote("edit_1")], 2), "/sessions/ses_1/live?after=2": turn("running", [], 2), "/live-edits/edit_1": offer("edit_1", change()) }));
    const seen = recordRequests();
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        floatButton(host)!.click();
        const show = () => [...(card()?.querySelectorAll("button") ?? [])].find((one) => one.textContent?.trim() === "Show the change on the page") as HTMLButtonElement | undefined;
        await eventually(() => show() !== undefined, 4_000, "the change's button in the chat");
        const reads = () => seen.paths.filter((path) => path === "/sessions/ses_1/live").length;
        const from = reads();
        await eventually(() => reads() >= from + 2, 6_000, "two more reads of the turn");
        expect(bar(host)).toBeNull();
        expect(seen.paths.includes("/live-edits/edit_1")).toBe(false);
        show()!.click();
        await eventually(() => bar(host) !== null, 3_000, "the change, drawn when asked for");
      });
    } finally {
      seen.restore();
    }
  });

  test("one of another kind for a thing with the same id is not this page's", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    const seen = recordRequests();
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        await asked(host);
        answer(base({ "/sessions/ses_1/live?after=1": turn("running", [wrote("edit_5")], 2), "/sessions/ses_1/live": turn("running", [], 2), "/live-edits/edit_5": ok({ offer: { id: "edit_5", kind: "mission", target: "cron_e", value: {}, by: "nouva", at: 1 } }) }));
        await eventually(() => seen.paths.includes("/live-edits/edit_5"), 4_000, "the change fetched");
        const reads = () => seen.paths.filter((path) => path === "/sessions/ses_1/live").length;
        const from = reads();
        await eventually(() => reads() >= from + 2, 6_000, "two more reads of the turn");
        expect(bar(host)).toBeNull();
        // And the page is as it was: read as an automation's, a thing of another shape took the page down with it.
        expect(drawn(host)).toEqual(["check", "find", "ok", "tell"]);
      });
    } finally {
      seen.restore();
      posted.restore();
    }
  });

  test("a page showing a run goes back to the steps for it: a change is to the steps, and is what the person asked for", async () => {
    const ran = { id: "run_1", jobId: "cron_e", startedAt: Date.now() - 60_000, finishedAt: Date.now() - 55_000, status: "success", steps: [] };
    const withRun = { [PAGE]: detail(automation(), [ran as never]) };
    answer(base(withRun));
    const posted = recordPosts(SENT);
    try {
      await renderPage(PAGE, async (host) => {
        await flowDrawn(host);
        const tab = (label: string) => [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((one) => one.textContent === label);
        await eventually(() => tab("Last run") !== undefined, 3_000, "the run's tab");
        tab("Last run")!.click();
        await eventually(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Last run", 2_000, "the run on the page");
        await asked(host, "shorten it", withRun);
        answer({ ...written("edit_1", change()), ...withRun });
        await eventually(() => bar(host) !== null, 4_000, "the change, drawn on the page");
        expect(host.querySelector('main [role="tablist"][aria-label="What to show"] [role="tab"][aria-selected="true"]')?.textContent).toBe("Steps");
        expect(drawn(host)).toEqual(["check", "find", "tell", "s4"]);
      });
    } finally {
      posted.restore();
    }
  });
});

describe("on the page that makes a new one", () => {
  test("the agent's change fills the page's own draft: applied, it is there to name, change and save as the person's", async () => {
    answer(base());
    const posted = recordPosts(SENT);
    const seen = { order: [] as string[], name: "", save: false, at: "", headShown: "", barShown: "", headApplied: "" };
    const head = (host: HTMLElement) => host.querySelector("main header")?.textContent ?? "";
    try {
      await renderPage("/automations/new", async (host, app) => {
        await eventually(() => host.textContent?.includes("Add the first step") === true, 4_000, "the page that makes one");
        await asked(host, "make one that checks the shop");
        answer({ ...written("edit_4", change({ name: "Shop check, made here" }), null), [PAGE]: detail(automation()) });
        await eventually(() => bar(host) !== null, 4_000, "the change, drawn on the page");
        seen.headShown = head(host);
        seen.barShown = bar(host)!.textContent ?? "";
        press(host, "Apply");
        await eventually(() => drawn(host).length === 4, 2_000, "its steps on the page");
        seen.headApplied = head(host);
        seen.order = drawn(host);
        seen.name = (host.querySelector('input[aria-label="Name"]') as HTMLInputElement | null)?.value ?? "";
        seen.save = saveBar(host) !== null;
        seen.at = app.location();
      });
      // While the change waits, the head is the automation as the person has it, all of it: its name, how it starts,
      // and no chat, none being picked. The chat the change names is the bar's to say and the canvas's to show.
      expect(seen.headShown).not.toContain("sends to");
      expect(seen.barShown).toContain("It would report to the chat shown under its steps.");
      expect(seen.headApplied).toContain("sends to Telegram");
      expect(seen.order).toEqual(["check", "find", "tell", "s4"]);
      expect(seen.name).toBe("Shop check, made here");
      expect(seen.save).toBe(true);
      // Still the page that makes one: nothing was made on the server by the agent or by Apply.
      expect(seen.at).toEndWith("/automations/new");
      expect(saves(posted.posts)).toEqual([]);
    } finally {
      posted.restore();
    }
  });
});

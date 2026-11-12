/**
 * The page under the floating chat follows what the agent does there (`commons/hooks/use-page-follows.ts`).
 *
 * A person asks an agent for something on the page they are looking at. The call that makes it says the dashboard page
 * of what it made (`tool_done.page`), and from that alone, with no code in any page: what the page shows is read again
 * when such a call is done and when the turn ends; on a page that makes a new one, the thing the agent made is opened
 * in its place, unless the person has written in the form; and a way to it stands under the agent's answer.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makerOf, pagesMade } from "@/commons/hooks/use-page-follows";
import { answer, dom, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { AT_REST, boxIn, card, floatButton, LAST_AGENT_KEY, recordRequests, sendIn } from "./floating-chat-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

afterEach(() => {
  dom.localStorage.removeItem(LAST_AGENT_KEY);
});

const ok = (body: unknown) => ({ status: 200, body });
/** A turn of Nouva's in the open conversation, at work or ended: the steps written since the reader's last read, and where it has read to. */
const turn = (status: "running" | "done", steps: Record<string, unknown>[], cursor: number, reply = "") =>
  ok({
    jobs: [],
    turn: { id: "turn_9", agentId: "nouva", chatId: "web-1", sessionId: "ses_1", status, prompt: "check the shop every ten minutes", reply, toolCalls: 1, startedAt: 1_760_000_001_000, ...(status === "done" ? { endedAt: 1_760_000_003_000, durationMs: 2_000 } : {}), steps, cursor },
  });
const ASKED = { seq: 1, at: 1_760_000_001_000, kind: "tool", text: "schedule Shop check", callId: "c1", name: "schedule", ms: 0 };
/** The call done, saying the page of the automation it proposed. */
const PROPOSED = { seq: 2, at: 1_760_000_002_000, kind: "tool_done", text: "schedule ok · 4ms", callId: "c1", name: "schedule", error: false, outcome: "ok", page: "/automations/cron_1", ms: 4 };
const SENT = { "/chat/send": ok({ sessionId: "ses_1", chatId: "web-1", messageId: "msg_9", agentId: "nouva" }) };
/** The daemon once the call is done: the step for a reader that has read up to the call, and nothing new after it. */
const DONE = { ...AT_REST, "/sessions/ses_1/live?after=1": turn("running", [PROPOSED], 2), "/sessions/ses_1/live": turn("running", [], 2) };

/** The floating chat opened over the page and a request sent in it: the turn is at work, its call asked and not done. */
async function asked(host: HTMLElement): Promise<void> {
  await eventually(() => floatButton(host) !== null, 4_000, "the chat's button");
  floatButton(host)!.click();
  await eventually(() => boxIn(card()) !== null, 3_000, "the conversation in the panel");
  type(boxIn(card())!, "check the shop every ten minutes");
  await eventually(() => sendIn(card())?.disabled === false, 2_000, "send enabled");
  answer({ ...AT_REST, "/sessions/ses_1/live": turn("running", [ASKED], 1) });
  sendIn(card())!.click();
  // Drawn at work before its call ends: a turn first seen with the call done is not acted on.
  await eventually(() => card()?.textContent?.includes("schedule Shop check") === true, 4_000, "the turn at work");
}
const opens = () => card()?.querySelector('a[href$="/automations/cron_1"]') as HTMLAnchorElement | null;

/**
 * Two more reads of the turn by the chat: whatever a read of it was going to do to the page, it has done. For a check
 * that something did not happen, without a fixed sleep.
 */
async function readTwiceMore(seen: { paths: string[] }): Promise<void> {
  const reads = () => seen.paths.filter((path) => path === "/sessions/ses_1/live").length;
  const from = reads();
  await eventually(() => reads() >= from + 2, 6_000, "two more reads of the turn");
}

describe("on a page that makes a new one", () => {
  test("what the agent made there is opened in the page's place, and the chat stays over it", async () => {
    answer(AT_REST);
    const posted = recordPosts(SENT);
    try {
      await renderPage("/automations/new", async (host, app) => {
        await eventually(() => host.textContent?.includes("Add the first step") === true, 4_000, "the page that makes one");
        await asked(host);
        expect(app.location()).toEndWith("/automations/new");
        answer(DONE);
        await eventually(() => app.location().endsWith("/automations/cron_1"), 4_000, "the automation it made, opened");
        await eventually(() => host.textContent?.includes("Shop health check") === true, 4_000, "its page drawn");
        expect(card()).not.toBeNull();
        // And a way to it under the agent's work, by where the menu puts it.
        expect(opens()?.textContent).toContain("Open in Automations");
      });
    } finally {
      posted.restore();
    }
  });

  test("not over a form the person has written in: the page stays, and the way to it is under the answer", async () => {
    answer(AT_REST);
    const posted = recordPosts(SENT);
    const seen = recordRequests();
    try {
      await renderPage("/automations/new", async (host, app) => {
        await eventually(() => host.querySelector('input[aria-label="Name"]') !== null, 4_000, "the page that makes one");
        type(host.querySelector('input[aria-label="Name"]') as HTMLInputElement, "My own");
        await asked(host);
        answer(DONE);
        await eventually(() => opens() !== null, 4_000, "the way to what it made");
        await readTwiceMore(seen);
        expect(app.location()).toEndWith("/automations/new");
        expect((host.querySelector('input[aria-label="Name"]') as HTMLInputElement).value).toBe("My own");
        expect(opens()!.getAttribute("href")).toBe("/dashboard/automations/cron_1");
      });
    } finally {
      seen.restore();
      posted.restore();
    }
  });

  test("a turn first seen with its call already done opens nothing: it made that before the chat was looking", async () => {
    // The first read has the whole turn so far; the reads after it, from its cursor on, have nothing new.
    answer({ ...AT_REST, "/sessions/ses_1/live?after=0": turn("running", [ASKED, PROPOSED], 2), "/sessions/ses_1/live": turn("running", [], 2) });
    const seen = recordRequests();
    try {
      await renderPage("/automations/new", async (host, app) => {
        await eventually(() => floatButton(host) !== null, 4_000, "the chat's button");
        floatButton(host)!.click();
        await eventually(() => opens() !== null, 4_000, "the turn drawn, with what it made");
        await readTwiceMore(seen);
        expect(app.location()).toEndWith("/automations/new");
      });
    } finally {
      seen.restore();
    }
  });
});

describe("on any other page", () => {
  test("what the page shows is read again when the call that made something is done, and when the turn ends; the page stays", async () => {
    answer(AT_REST);
    const posted = recordPosts(SENT);
    const seen = recordRequests();
    const lists = () => seen.paths.filter((path) => path === "/automations").length;
    try {
      await renderPage("/automations", async (host, app) => {
        await eventually(() => host.querySelector("[data-automation]") !== null, 4_000, "the list");
        await asked(host);
        // Asked and not done: nothing is read again for it.
        const asking = lists();
        await readTwiceMore(seen);
        const before = lists();
        expect(before).toBe(asking);
        answer(DONE);
        await eventually(() => lists() > before, 4_000, "the list read again as the call ends");
        const made = lists();
        answer({ ...AT_REST, "/sessions/ses_1/live": turn("done", [], 2, "Proposed. Turn it on when you are ready.") });
        await eventually(() => lists() > made, 4_000, "and again as the turn ends");
        expect(app.location()).toEndWith("/automations");
      });
    } finally {
      seen.restore();
      posted.restore();
    }
  });
});

describe("on Chats, where the conversation is the page", () => {
  test("nothing is read again for what a call made: no page is under it, and the way to it is under the answer", async () => {
    answer({ ...AT_REST, "/sessions/ses_1/live": turn("running", [ASKED], 1) });
    const seen = recordRequests();
    // What the box says of itself: asked once as the page is drawn, and by no clock of the page's.
    const status = () => seen.paths.filter((path) => path === "/status").length;
    try {
      await renderPage("/chat/ses_1", async (host) => {
        await eventually(() => host.textContent?.includes("schedule Shop check") === true, 4_000, "the turn at work");
        const before = status();
        answer(DONE);
        await eventually(() => host.querySelector('a[href$="/automations/cron_1"]') !== null, 4_000, "the way to what it made");
        await readTwiceMore(seen);
        expect(status()).toBe(before);
      });
    } finally {
      seen.restore();
    }
  });
});

test("which pages a turn's calls made, and the page that makes a new one of each", () => {
  expect(pagesMade({ steps: [ASKED, PROPOSED, { ...PROPOSED, seq: 3, page: "/missions/msn_1" }, { ...PROPOSED, seq: 4, page: undefined }] as never })).toEqual(["/automations/cron_1", "/missions/msn_1"]);
  // A call asked and not done made nothing yet, whatever it carries.
  expect(pagesMade({ steps: [{ ...ASKED, page: "/automations/cron_1" }] as never })).toEqual([]);
  expect(makerOf("/automations/cron_1")).toBe("/automations/new");
  expect(makerOf("/missions/msn_1")).toBe("/missions/new");
});

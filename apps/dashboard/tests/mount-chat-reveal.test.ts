/**
 * An answer that comes whole as its turn ends is written out, as every other answer is (`useTypewriter` in `Turn.tsx`,
 * `splitForDisplay`'s `revealing`). Through the whole app, in the chat that floats over a page.
 *
 * Seen on the live box: an agent on a model that says nothing while its calls run made an automation, the way to it
 * was drawn under its work, and seven seconds later its whole answer was there at once. The daemon had written every
 * word of it within the last 50 ms of the turn. The page stopped writing an answer out the moment its turn was over,
 * and the history, which had every word a moment later, took the turn from the live view.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Revealing } from "@/commons/hooks/use-revealing";
import { answer, dom, recordPosts, renderPage, type, useMountHarness, WIRE } from "./mount-harness.ts";
import { AT_REST, boxIn, card, floatButton, LAST_AGENT_KEY, sendIn } from "./floating-chat-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

afterEach(() => {
  dom.localStorage.removeItem(LAST_AGENT_KEY);
});

const ok = (body: unknown) => ({ status: 200, body });
const ASKED = "check the shop every ten minutes";
const FIRST = "Let me set that up.";
/** What it says once its call is done: long, so there is a while in which some of it is shown and not all. */
const REST = ` ${Array.from({ length: 60 }, (_, at) => `Sentence ${at + 1} of the answer says what the automation does and when it starts.`).join(" ")} The last words of it.`;
const LAST = "The last words of it.";
const record = { id: "turn_9", agentId: "nouva", chatId: "web-1", sessionId: "ses_1", prompt: ASKED, toolCalls: 1, startedAt: 1_760_000_001_000 };
const live = (status: "running" | "done", steps: Record<string, unknown>[], cursor: number, reply: string) =>
  ok({ jobs: [], turn: { ...record, status, reply, ...(status === "done" ? { endedAt: 1_760_000_009_000, durationMs: 8_000 } : {}), steps, cursor } });
const CALL = { seq: 1, at: 1_760_000_001_000, kind: "tool", text: "schedule Shop check", callId: "c1", name: "schedule", ms: 0 };
const CALLED = { seq: 2, at: 1_760_000_002_000, kind: "tool_done", text: "schedule ok · 4ms", callId: "c1", name: "schedule", error: false, outcome: "ok", page: "/automations/cron_1", ms: 4 };
const transcript = WIRE["/sessions/ses_1/turns"] as { turns: Record<string, unknown>[] } & Record<string, unknown>;

/** The daemon the moment the turn is over: the whole answer on the live turn, and in the conversation's history too. */
const OVER = {
  ...AT_REST,
  "/sessions/ses_1/live?after=1": live("done", [CALLED], 2, FIRST + REST),
  "/sessions/ses_1/live": live("done", [], 2, FIRST + REST),
  "/sessions/ses_1/turns": ok({ ...transcript, turns: [...transcript.turns, { ...record, status: "done", reply: FIRST + REST, endedAt: 1_760_000_009_000, durationMs: 8_000, steps: [CALL, CALLED] }] }),
};

const said = () => card()?.textContent ?? "";
/** The answers the history draws: each has its Copy under it, and a live turn has none. */
const finished = () => [...(card()?.querySelectorAll("button") ?? [])].filter((button) => button.textContent?.trim() === "Copy").length;

/** The chat open over a page, a request sent, and the turn at work: its first words said, its call asked and not done. */
async function atWork(host: HTMLElement): Promise<void> {
  await eventually(() => floatButton(host) !== null, 4_000, "the chat's button");
  floatButton(host)!.click();
  await eventually(() => boxIn(card()) !== null, 3_000, "the conversation in the panel");
  type(boxIn(card())!, ASKED);
  await eventually(() => sendIn(card())?.disabled === false, 2_000, "send enabled");
  answer({ ...AT_REST, "/sessions/ses_1/live": live("running", [CALL], 1, FIRST) });
  sendIn(card())!.click();
  await eventually(() => said().includes("schedule Shop check") && said().includes(FIRST), 4_000, "the turn at work, its first words said");
}

describe("an answer that comes whole as its turn ends", () => {
  test("is written out, not drawn all at once: some of it is there before all of it, and then it is the history's", async () => {
    answer(AT_REST);
    const posted = recordPosts({ "/chat/send": ok({ sessionId: "ses_1", chatId: "web-1", messageId: "msg_9", agentId: "nouva" }) });
    try {
      await renderPage("/skills", async (host) => {
        await atWork(host);
        const before = finished();
        expect(said()).not.toContain("Sentence 1 of the answer");

        answer(OVER);
        // Some of it and not yet its end: what a person sees as writing. All at once, this never holds.
        await eventually(() => said().includes("Sentence 1 of the answer") && !said().includes(LAST), 4_000, "the answer part written");
        // The way to what it made is there from the call's end, before the words about it.
        expect(card()?.querySelector('a[href$="/automations/cron_1"]')).not.toBeNull();
        await eventually(() => said().includes(LAST), 6_000, "the whole answer");
        // Written out, it is the history's: drawn once, as a finished answer.
        await eventually(() => finished() === before + 1, 4_000, "the turn drawn from the history");
        expect(said().split(LAST).length - 1).toBe(1);
        expect(said().split("Sentence 30 of the answer").length - 1).toBe(1);
      });
    } finally {
      posted.restore();
    }
  });

  test("an answer that was written out while the turn worked goes to the history as the turn ends: nothing is left to write", async () => {
    answer(AT_REST);
    const posted = recordPosts({ "/chat/send": ok({ sessionId: "ses_1", chatId: "web-1", messageId: "msg_9", agentId: "nouva" }) });
    try {
      await renderPage("/skills", async (host) => {
        await atWork(host);
        const before = finished();
        // It ends with the words it had already said, and no more.
        answer({
          ...OVER,
          "/sessions/ses_1/live?after=1": live("done", [CALLED], 2, FIRST),
          "/sessions/ses_1/live": live("done", [], 2, FIRST),
          "/sessions/ses_1/turns": ok({ ...transcript, turns: [...transcript.turns, { ...record, status: "done", reply: FIRST, endedAt: 1_760_000_009_000, durationMs: 8_000, steps: [CALL, CALLED] }] }),
        });
        await eventually(() => finished() === before + 1, 4_000, "the turn drawn from the history");
        expect(said().split(FIRST).length - 1).toBe(1);
      });
    } finally {
      posted.restore();
    }
  });

  test("a conversation opened on a turn that is already over draws it from the history, whole: nobody watched it being written", async () => {
    answer(OVER);
    await renderPage("/skills", async (host) => {
      await eventually(() => floatButton(host) !== null, 4_000, "the chat's button");
      // Every state the panel is drawn in from here on, by whether the answer is in it and how many finished answers are.
      const drawn: { whole: boolean; finished: number }[] = [];
      const watch = new dom.MutationObserver(() => {
        if (said().includes("Sentence 1 of the answer")) drawn.push({ whole: said().includes(LAST), finished: finished() });
      });
      watch.observe(dom.document.body as never, { childList: true, subtree: true, characterData: true });
      try {
        floatButton(host)!.click();
        await eventually(() => said().includes("Sentence 1 of the answer"), 4_000, "the answer");
        await eventually(() => finished() === 2, 4_000, "both answers the history's");
      } finally {
        watch.disconnect();
      }
      expect(drawn.length).toBeGreaterThan(0);
      // Never some of it, and never as a live turn first: that is a flicker on every conversation opened.
      expect(drawn.filter((state) => !state.whole || state.finished !== 2)).toEqual([]);
    });
  });
});

describe("which turn is held live (`useRevealing`)", () => {
  /** The hook, with each call to it drawn before the next line reads what it holds. */
  async function held(): Promise<{ now: () => Revealing; act: (change: (hook: Revealing) => void) => void; done: () => void }> {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { useRevealing } = await import("@/commons/hooks/use-revealing");
    let hook!: Revealing;
    const Probe = () => {
      hook = useRevealing();
      return null;
    };
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    flushSync(() => root.render(React.createElement(Probe)));
    return { now: () => hook, act: (change) => flushSync(() => change(hook)), done: () => root.unmount() };
  }

  test("a turn seen at work, from the read that finds it over, until its view says its answer is written out", async () => {
    const { now, act, done } = await held();
    try {
      act((hook) => hook.read(null));
      act((hook) => hook.read({ id: "t2", status: "running" }));
      expect(now().turnId).toBeNull();
      act((hook) => hook.read({ id: "t2", status: "done" }));
      expect(now().turnId).toBe("t2");
      // Still behind, and another turn's word is not this one's.
      act((hook) => hook.say("t2", true));
      act((hook) => hook.say("t1", false));
      expect(now().turnId).toBe("t2");
      act((hook) => hook.say("t2", false));
      expect(now().turnId).toBeNull();
    } finally {
      done();
    }
  });

  test("once: the same ended turn, read again every few seconds, is not taken back from the history", async () => {
    const { now, act, done } = await held();
    try {
      act((hook) => hook.read({ id: "t2", status: "running" }));
      act((hook) => hook.read({ id: "t2", status: "done" }));
      act((hook) => hook.say("t2", false));
      act((hook) => hook.read({ id: "t2", status: "done" }));
      act((hook) => hook.read({ id: "t2", status: "done" }));
      expect(now().turnId).toBeNull();
    } finally {
      done();
    }
  });

  test("never a turn first seen when it is over, however it ended, and nothing of the conversation before", async () => {
    const { now, act, done } = await held();
    try {
      for (const status of ["done", "failed", "cancelled", "interrupted"] as const) {
        act((hook) => hook.read({ id: `over-${status}`, status }));
        expect(now().turnId, status).toBeNull();
      }
      // A stopped turn that was watched is held like any other: what it had said is written out.
      act((hook) => hook.read({ id: "t3", status: "running" }));
      act((hook) => hook.read({ id: "t3", status: "cancelled" }));
      expect(now().turnId).toBe("t3");
      // Another conversation: the one held goes, and a turn watched in the last one is not held in this one.
      act((hook) => hook.read({ id: "t4", status: "running" }));
      act((hook) => hook.reset());
      expect(now().turnId).toBeNull();
      act((hook) => hook.read({ id: "t4", status: "done" }));
      expect(now().turnId).toBeNull();
    } finally {
      done();
    }
  });
});

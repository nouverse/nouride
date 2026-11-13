/**
 * In a room, an answer that comes whole as its turn ends is written out, as a one-to-one conversation's is
 * (`useRoomRevealing`, `splitRoomForDisplay`). Through the whole app, on a room's own page.
 *
 * A room's list of turns at work never has an ended one: the turn left it and was in neither list until the history
 * was read again, then there with every word. An agent that says nothing while its calls run was drawn as its work,
 * a blink of nothing, and its whole answer at once.
 */

import { describe, expect, test } from "bun:test";
import type { ChatTurn, LiveTurn } from "@nouride/wire";
import type { RoomRevealing } from "@/commons/hooks/use-revealing";
import { splitRoomForDisplay } from "@/commons/lib/turn-display";
import { answer, dom, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually, sleep } from "./wait.ts";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const NOW = Date.now();
const STATUS = WIRE["/status"] as { agents: Record<string, unknown>[] } & Record<string, unknown>;
const agent = (id: string) => ({ ...STATUS.agents[0], id, displayName: id[0]!.toUpperCase() + id.slice(1), headline: null });
const status = { ...STATUS, orchestrator: "nouva", agents: ["nouva", "nix"].map(agent) };
const room = { gatewayId: "web:dashboard", chatId: "room_1", title: "Harness research", createdAt: NOW - 600_000, members: ["nouva", "nix"].map((agentId) => ({ agentId, addedAt: NOW - 600_000 })) };
const list = { agents: [], rooms: [{ chatId: "room_1", title: "Harness research", members: ["nouva", "nix"], at: NOW - 120_000, working: true, untagged: "nouva" }], groups: [] };
const asked = { id: "m1", gatewayId: "web:dashboard", chatId: "room_1", senderId: "tester", text: "@nix check the shop every ten minutes", at: NOW - 30_000 };

const FIRST = "Let me set that up.";
/** What it says once its call is done: long, so there is a while in which some of it is shown and not all. */
const REST = ` ${Array.from({ length: 60 }, (_, at) => `Sentence ${at + 1} of the answer says what the automation does and when it starts.`).join(" ")} The last words of it.`;
const LAST = "The last words of it.";
const CALL = { seq: 1, at: NOW - 29_000, kind: "tool", text: "schedule Shop check", callId: "c1", name: "schedule", ms: 0 };
const CALLED = { seq: 2, at: NOW - 28_000, kind: "tool_done", text: "schedule ok · 4ms", callId: "c1", name: "schedule", error: false, outcome: "ok", ms: 4 };
const record = { id: "turn_9", agentId: "nix", chatId: "room_1", sessionId: "ses_nix_room", prompt: asked.text, toolCalls: 1, startedAt: NOW - 29_500 };
const atWork = { ...record, status: "running", reply: FIRST, steps: [CALL] };
const over = (reply: string) => ({ ...record, status: "done", reply, endedAt: NOW - 20_000, durationMs: 9_500, steps: [CALL, CALLED] });
const transcript = (turns: unknown[]) => ok({ session: null, room, earlier: [], turns, events: [], messages: [asked] });

const BASE = { "/status": ok(status), "/chat-list": ok(list), "/rooms/room_1": ok({ room }), "/turns/turn_9": { status: 404, body: { error: "no record" } } };
const WORKING = { ...BASE, "/rooms/room_1/live": ok({ turns: [atWork], jobs: [] }), "/rooms/room_1/turns": transcript([]) };
const OVER = (reply: string) => ({ ...BASE, "/rooms/room_1/live": ok({ turns: [], jobs: [] }), "/rooms/room_1/turns": transcript([over(reply)]) });

const said = (host: HTMLElement) => host.querySelector("[data-stream]")?.textContent ?? host.textContent ?? "";
/** The answers the history draws: each has its Copy under it, and a live turn has none. */
const finished = (host: HTMLElement) => [...host.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "Copy").length;

describe("in a room, an answer that comes whole as its turn ends", () => {
  test("is written out: some of it is there before all of it, the turn never gone in between, and then it is the history's, once", async () => {
    answer(WORKING);
    await renderPage("/chat/room/room_1", async (host) => {
      await eventually(() => said(host).includes("schedule Shop check") && said(host).includes(FIRST), 4_000, "the turn at work, its first words said");
      expect(finished(host)).toBe(0);
      // Every state the room is drawn in from here on: whether the turn's first words are in it.
      const drawn: boolean[] = [];
      const watch = new dom.MutationObserver(() => void drawn.push(said(host).includes(FIRST)));
      watch.observe(dom.document.body as never, { childList: true, subtree: true, characterData: true });
      try {
        answer(OVER(FIRST + REST));
        // Some of it and not yet its end: what a person sees as writing. All at once, this never holds.
        await eventually(() => said(host).includes("Sentence 1 of the answer") && !said(host).includes(LAST), 6_000, "the answer part written");
        await eventually(() => said(host).includes(LAST), 6_000, "the whole answer");
        // Written out, it is the history's: drawn once, as a finished answer.
        await eventually(() => finished(host) === 1, 4_000, "the turn drawn from the history");
      } finally {
        watch.disconnect();
      }
      expect(said(host).split(LAST).length - 1).toBe(1);
      expect(said(host).split("Sentence 30 of the answer").length - 1).toBe(1);
      // It left the list of turns at work before the history had it, and was on the page all the while.
      expect(drawn.length).toBeGreaterThan(0);
      expect(drawn.filter((there) => !there)).toEqual([]);
    });
  }, 30_000);

  test("an answer already written out while the turn worked goes to the history as the turn ends: nothing is left to write", async () => {
    answer(WORKING);
    await renderPage("/chat/room/room_1", async (host) => {
      await eventually(() => said(host).includes(FIRST), 4_000, "the turn at work");
      answer(OVER(FIRST));
      await eventually(() => finished(host) === 1, 8_000, "the turn drawn from the history");
      expect(said(host).split(FIRST).length - 1).toBe(1);
    });
  }, 30_000);

  test("a room opened on a turn that is already over draws it from the history, whole: nobody watched it being written", async () => {
    answer(OVER(FIRST + REST));
    await renderPage("/chat/room/room_1", async (host) => {
      const drawn: { whole: boolean; finished: number }[] = [];
      const watch = new dom.MutationObserver(() => {
        if (said(host).includes("Sentence 1 of the answer")) drawn.push({ whole: said(host).includes(LAST), finished: finished(host) });
      });
      watch.observe(dom.document.body as never, { childList: true, subtree: true, characterData: true });
      try {
        await eventually(() => said(host).includes("Sentence 1 of the answer") && finished(host) === 1, 4_000, "the answer, the history's");
      } finally {
        watch.disconnect();
      }
      // Never some of it, and never as a live turn first.
      expect(drawn.filter((state) => !state.whole || state.finished !== 1)).toEqual([]);
    });
  }, 30_000);
});

describe("moving to another room", () => {
  test("a turn at work in the room left is not drawn in the room opened", async () => {
    const other = { ...room, chatId: "room_2", title: "Quiet room" };
    const rooms = [list.rooms[0]!, { chatId: "room_2", title: "Quiet room", members: ["nouva", "nix"], at: NOW - 240_000, working: false, untagged: "nouva" }];
    answer({
      ...WORKING,
      "/chat-list": ok({ ...list, rooms }),
      "/rooms/room_2": ok({ room: other }),
      "/rooms/room_2/live": ok({ turns: [], jobs: [] }),
      "/rooms/room_2/turns": ok({ session: null, room: other, earlier: [], turns: [], events: [], messages: [{ ...asked, id: "m2", chatId: "room_2", text: "nothing happens in here" }] }),
    });
    await renderPage("/chat/room/room_1", async (host) => {
      await eventually(() => said(host).includes(FIRST), 4_000, "the turn at work in the first room");
      const row = [...host.querySelectorAll("a")].find((link) => link.getAttribute("href")?.endsWith("/chat/room/room_2"));
      expect(row).toBeDefined();
      const drawn: boolean[] = [];
      const watch = new dom.MutationObserver(() => {
        if (said(host).includes("nothing happens in here")) drawn.push(said(host).includes(FIRST));
      });
      watch.observe(dom.document.body as never, { childList: true, subtree: true, characterData: true });
      try {
        row!.click();
        await eventually(() => said(host).includes("nothing happens in here"), 4_000, "the second room");
        // Its first read of what is at work there, and a little after: the other room's turn is in neither.
        await sleep(700);
      } finally {
        watch.disconnect();
      }
      expect(said(host)).not.toContain(FIRST);
      expect(drawn.filter(Boolean)).toEqual([]);
    });
  }, 30_000);
});

const turn = (id: string, status: ChatTurn["status"] = "done", reply = `a ${id}`): ChatTurn => ({ id, agentId: "nix", chatId: "room_1", status, prompt: `q ${id}`, reply, toolCalls: 0, startedAt: 1_000, endedAt: 2_000, durationMs: 1_000, steps: [] });
const live = (id: string, reply = "so far"): LiveTurn => ({ ...turn(id, "running", reply), cursor: 0 });
const ids = (turns: { id: string }[]) => turns.map((one) => one.id);

describe("which of a room's turns are drawn live (`splitRoomForDisplay`)", () => {
  test("the turns at work, and every finished one from the history: a running one that leaked into it is not drawn twice", () => {
    const shown = splitRoomForDisplay([turn("t1"), turn("t2", "running"), turn("t5", "running")], [live("t2"), live("t3")], [], new Set(), 5_000);
    expect(ids(shown.history)).toEqual(["t1"]);
    expect(ids(shown.live)).toEqual(["t2", "t3"]);
  });

  test("a held turn the history has only as still running is not the history's yet: it stays as it was last seen", () => {
    const held = [{ turn: live("t2", "Let me"), leftAt: 5_000 }];
    const shown = splitRoomForDisplay([turn("t2", "running", "stale")], [], held, new Set(["t2"]), 5_000);
    expect(shown).toEqual({ history: [], live: [held[0]!.turn] });
  });

  test("a turn that left the list stays as it was last seen until the history has it", () => {
    const held = [{ turn: live("t2", "Let me set that up."), leftAt: 5_000 }];
    // The history as read before it left, and at the very moment: not yet the one that would have it.
    for (const readAt of [4_000, 5_000]) {
      const shown = splitRoomForDisplay([turn("t1")], [], held, new Set(["t2"]), readAt);
      expect(ids(shown.history)).toEqual(["t1"]);
      expect(shown.live).toEqual([held[0]!.turn]);
    }
  });

  test("a history read after it left that does not have it is not waited for: the turn is gone", () => {
    const held = [{ turn: live("t2"), leftAt: 5_000 }];
    expect(splitRoomForDisplay([turn("t1")], [], held, new Set(["t2"]), 5_001)).toEqual({ history: [turn("t1")], live: [] });
  });

  test("once the history has it, it is drawn live as the history has it for as long as its answer is being written out", () => {
    const held = [{ turn: live("t2", "Let me"), leftAt: 5_000 }];
    const recorded = [turn("t1"), turn("t2", "done", "Let me set that up. And the rest of it.")];
    const writing = splitRoomForDisplay(recorded, [], held, new Set(["t2"]), 6_000);
    expect(ids(writing.history)).toEqual(["t1"]);
    expect(writing.live).toEqual([{ ...recorded[1]!, cursor: 0 }]);
    // Written out, or another turn's word alone: the history's.
    for (const revealing of [new Set<string>(), new Set(["t1"])]) {
      const written = splitRoomForDisplay(recorded, [], held, revealing, 6_000);
      expect(ids(written.history)).toEqual(["t1", "t2"]);
      expect(written.live).toEqual([]);
    }
  });

  test("several at once: one at work, one being written out, one waiting for the history, each drawn once", () => {
    const held = [{ turn: live("t2"), leftAt: 5_000 }, { turn: live("t3"), leftAt: 7_000 }];
    const shown = splitRoomForDisplay([turn("t1"), turn("t2")], [live("t4")], held, new Set(["t2", "t3"]), 6_000);
    expect(ids(shown.live)).toEqual(["t4", "t2", "t3"]);
    expect(ids(shown.history)).toEqual(["t1"]);
    // One held that is somehow at work again is the turn at work, once.
    const again = splitRoomForDisplay([], [live("t2")], [{ turn: live("t2", "old"), leftAt: 1 }], new Set(["t2"]), 0);
    expect(again.live).toEqual([live("t2")]);
  });
});

describe("which of a room's ended turns are held (`useRoomRevealing`)", () => {
  /** The hook over a history and a list of turns at work that a test sets, each change drawn before the next line. */
  async function held() {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { useRoomRevealing } = await import("@/commons/hooks/use-revealing");
    const input = { recorded: [] as ChatTurn[], atWork: [] as LiveTurn[], readAt: 0 };
    let hook!: RoomRevealing;
    const Probe = () => {
      hook = useRoomRevealing(input.recorded, input.atWork, input.readAt);
      return null;
    };
    const root = createRoot(dom.document.createElement("div") as unknown as HTMLElement);
    const draw = () => flushSync(() => root.render(React.createElement(Probe)));
    draw();
    return {
      now: () => hook,
      /** The room's poll: the turns at work now. */
      poll: (atWork: LiveTurn[]) => {
        flushSync(() => hook.read(atWork));
        input.atWork = atWork;
        draw();
      },
      /** The history read again, now or at `at`. */
      history: (recorded: ChatTurn[], at = Date.now() + 1) => {
        input.recorded = recorded;
        input.readAt = at;
        draw();
      },
      act: (change: (hook: RoomRevealing) => void) => flushSync(() => change(hook)),
      done: () => root.unmount(),
    };
  }

  test("a turn seen at work and then gone is live until the history has it and its view says its answer is written out", async () => {
    const { now, poll, history, act, done } = await held();
    try {
      poll([live("t2", "Let me")]);
      expect(ids(now().live)).toEqual(["t2"]);
      poll([]);
      // Gone from the list, and still on the page as it was.
      expect(now().live).toEqual([live("t2", "Let me")]);
      history([turn("t2", "done", "Let me set that up.")]);
      expect(now().live).toEqual([{ ...turn("t2", "done", "Let me set that up."), cursor: 0 }]);
      expect(now().history).toEqual([]);
      // Its view, as the turn is found over: its last word of being at work, then that it is behind.
      act((hook) => {
        hook.say("t2", false);
        hook.say("t2", true);
      });
      expect(ids(now().live)).toEqual(["t2"]);
      act((hook) => hook.say("t2", false));
      expect(now().live).toEqual([]);
      expect(ids(now().history)).toEqual(["t2"]);
      // And it stays the history's: its view's word again takes nothing back.
      act((hook) => hook.say("t2", true));
      expect(now().live).toEqual([]);
    } finally {
      done();
    }
  });

  test("two agents' turns end when they end: each is held by its own view's word", async () => {
    const { now, poll, history, act, done } = await held();
    try {
      poll([live("t2"), live("t3")]);
      poll([live("t3")]);
      history([turn("t2")]);
      expect(ids(now().live)).toEqual(["t3", "t2"]);
      act((hook) => hook.say("t3", false));
      expect(ids(now().live)).toEqual(["t3", "t2"]);
      act((hook) => hook.say("t2", false));
      expect(ids(now().live)).toEqual(["t3"]);
      expect(ids(now().history)).toEqual(["t2"]);
    } finally {
      done();
    }
  });

  test("never a turn the room was opened on when it was over, and nothing of the room before", async () => {
    const { now, poll, history, act, done } = await held();
    try {
      // Read as the room opened, long before anything here ends.
      history([turn("t1")], 1);
      poll([]);
      expect(now().live).toEqual([]);
      expect(ids(now().history)).toEqual(["t1"]);
      // Another room: a turn watched in the last one is not held in this one, and one held there is let go.
      poll([live("t2")]);
      act((hook) => hook.reset());
      poll([]);
      expect(now().live).toEqual([]);
      poll([live("t3")]);
      poll([]);
      expect(ids(now().live)).toEqual(["t3"]);
      act((hook) => hook.reset());
      expect(now().live).toEqual([]);
    } finally {
      done();
    }
  });
});

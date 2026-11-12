/**
 * A conversation follows its own end as it grows (`commons/hooks/use-sticky-scroll.ts`), from the draw its content
 * first appears in. Through the whole app, in the chat that floats over a page.
 *
 * What grows is watched by a `ResizeObserver` on the conversation's content. The content is not drawn at first: a
 * conversation still being read draws its loading shape. The hook looked for it once, as it was set up, so in the
 * floating chat, where the conversation is read after the panel is drawn, nothing was ever watched: an answer was
 * written on under the fold, and the way to what the agent made with it. Measured in a browser: 779 px from the end
 * when the answer was done.
 *
 * And only its reader stops it. Every scroll said whether the view was at the end, and that was read as the reader's
 * word. The view's own move to the end is a scroll too, said a frame later: where the content had grown by more than
 * a few lines in that frame, the view was found away from the end it had just gone to, and stopped following. What
 * the reader sends takes them to the end wherever they were reading, and on the Chats page a small button does.
 *
 * A browser's layout is not here, so the observer is the test's: it says what it was given to watch, and the test
 * says when that grew.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { answer, dom, recordPosts, renderPage, type, useMountHarness } from "./mount-harness.ts";
import { AT_REST, boxIn, card, floatButton, LAST_AGENT_KEY, sendIn } from "./floating-chat-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

/** A `ResizeObserver` that keeps what it watches, and says it grew when the test says so. */
class WatchedGrowth {
  static all: WatchedGrowth[] = [];
  readonly watching = new Set<Element>();
  constructor(private readonly grew: () => void) {
    WatchedGrowth.all.push(this);
  }
  observe(element: Element): void {
    this.watching.add(element);
  }
  unobserve(element: Element): void {
    this.watching.delete(element);
  }
  disconnect(): void {
    this.watching.clear();
  }
  /** Whatever watches `element` is told it grew. */
  static grow(element: Element): void {
    for (const one of WatchedGrowth.all) if (one.watching.has(element)) one.grew();
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
let real: unknown;
beforeEach(() => {
  real = globals.ResizeObserver;
  globals.ResizeObserver = WatchedGrowth;
  WatchedGrowth.all = [];
});
afterEach(() => {
  globals.ResizeObserver = real;
  dom.localStorage.removeItem(LAST_AGENT_KEY);
});

/** The box a conversation under `root` scrolls in, and its content: what holds the exchanges, and grows. */
function boxOf(root: ParentNode | null): HTMLElement | null {
  let at = (root?.querySelector("[data-agent]") ?? null) as HTMLElement | null;
  while (at && !at.classList.contains("overflow-y-auto")) at = at.parentElement;
  return at;
}
const contentOf = (box: HTMLElement | null) => [...(box?.children ?? [])].find((child) => child.querySelector("[data-agent]") !== null) as HTMLElement | undefined;
const watching = (element: Element | null | undefined) => element != null && WatchedGrowth.all.some((one) => one.watching.has(element));
/** The box as a browser would have laid it out: this tall inside, this much of it seen, scrolled this far. */
function laidOut(box: HTMLElement, at: { height: number; seen: number; top: number }): void {
  Object.defineProperty(box, "scrollHeight", { value: at.height, configurable: true });
  Object.defineProperty(box, "clientHeight", { value: at.seen, configurable: true });
  box.scrollTop = at.top;
}
/** The scroll a browser says after the view has moved, by a hand or by the page. */
const scrolled = (box: HTMLElement) => box.dispatchEvent(new dom.Event("scroll") as unknown as Event);
/** The reader moves the view to `top`, and the browser says so. */
function reads(box: HTMLElement, at: { height: number; seen: number; top: number }): void {
  laidOut(box, at);
  scrolled(box);
}
const toNewest = (root: ParentNode | null) => (root?.querySelector('button[aria-label="Go to the newest message"]') ?? null) as HTMLButtonElement | null;

/** The floating chat open over a page, its conversation read and drawn, and watched. */
async function floating(host: HTMLElement): Promise<{ box: HTMLElement; content: HTMLElement }> {
  await eventually(() => floatButton(host) !== null, 3_000, "the button");
  floatButton(host)!.click();
  await eventually(() => boxIn(card()) !== null && contentOf(boxOf(card())) !== undefined, 3_000, "the conversation read and drawn");
  // Read after the panel was drawn: its content was not there when the hook was set up, and is watched all the same.
  await eventually(() => watching(contentOf(boxOf(card()))), 2_000, "the content watched");
  return { box: boxOf(card())!, content: contentOf(boxOf(card()))! };
}

describe("the conversation in the floating chat", () => {
  test("is watched from the draw its content appears in, and follows its end as it grows", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      const { box, content } = await floating(host);

      // An answer is written: the content grows, and the view is at its end.
      laidOut(box, { height: 1_200, seen: 400, top: 0 });
      WatchedGrowth.grow(content);
      expect(box.scrollTop).toBe(1_200);

      // The reader scrolls up to read: what grows after that does not take them back.
      reads(box, { height: 1_500, seen: 400, top: 300 });
      laidOut(box, { height: 1_900, seen: 400, top: 300 });
      WatchedGrowth.grow(content);
      expect(box.scrollTop).toBe(300);

      // Down again, and still short of the end: not followed yet.
      reads(box, { height: 1_900, seen: 400, top: 900 });
      WatchedGrowth.grow(content);
      expect(box.scrollTop).toBe(900);

      // At the end, near enough: it is followed again.
      reads(box, { height: 1_900, seen: 400, top: 1_400 });
      laidOut(box, { height: 2_600, seen: 400, top: 1_400 });
      WatchedGrowth.grow(content);
      expect(box.scrollTop).toBe(2_600);
    });
  });

  test("only its reader stops it: the view's own move to the end, said once the content has grown again, is not a reader leaving", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      const { box, content } = await floating(host);
      laidOut(box, { height: 1_200, seen: 400, top: 0 });
      WatchedGrowth.grow(content);
      expect(box.scrollTop).toBe(1_200);

      // The browser says that move a frame later, and by then a whole answer has been written under it: the view is
      // 300 px short of the end, further than "near", and nobody moved it up.
      reads(box, { height: 1_900, seen: 400, top: 1_200 });
      WatchedGrowth.grow(content);
      expect(box.scrollTop).toBe(1_900);

      // What it holds gets shorter (a turn handed to the history): the browser moves the view up, to the new end.
      reads(box, { height: 1_000, seen: 400, top: 600 });
      laidOut(box, { height: 1_500, seen: 400, top: 600 });
      WatchedGrowth.grow(content);
      expect(box.scrollTop).toBe(1_500);
    });
  });

  test("its box is watched too: a strip that takes room from it does not take the newest message out of sight", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      const { box } = await floating(host);
      expect(watching(box)).toBe(true);
      laidOut(box, { height: 1_200, seen: 340, top: 800 });
      WatchedGrowth.grow(box);
      expect(box.scrollTop).toBe(1_200);
    });
  });

  test("what the reader sends takes them to the end, wherever they were reading, and it is followed from there", async () => {
    answer(AT_REST);
    const posted = recordPosts({ "/chat/send": { status: 200, body: { sessionId: "ses_1", chatId: "web-1", messageId: "msg_9", agentId: "nouva" } } });
    try {
      await renderPage("/skills", async (host) => {
        const { box, content } = await floating(host);
        laidOut(box, { height: 3_000, seen: 400, top: 2_600 });
        scrolled(box);
        reads(box, { height: 3_000, seen: 400, top: 500 });
        WatchedGrowth.grow(content);
        expect(box.scrollTop).toBe(500);

        type(boxIn(card())!, "one more thing");
        await eventually(() => sendIn(card())?.disabled === false, 2_000, "send enabled");
        sendIn(card())!.click();
        expect(box.scrollTop).toBe(3_000);
        // Their message is drawn, then the answer: each grows the content, and the view stays with it.
        laidOut(box, { height: 3_300, seen: 400, top: 3_000 });
        WatchedGrowth.grow(content);
        expect(box.scrollTop).toBe(3_300);
      });
      expect(posted.posts.filter((post) => post.path === "/chat/send")).toHaveLength(1);
    } finally {
      posted.restore();
    }
  });

  test("has no button for the way back: it is a few messages tall, and a button would cover them", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      const { box } = await floating(host);
      laidOut(box, { height: 3_000, seen: 400, top: 2_600 });
      scrolled(box);
      reads(box, { height: 3_000, seen: 400, top: 500 });
      // Drawn again after that scroll: something written in the box enables Send, in a draw no earlier than the one
      // the scroll asked for.
      type(boxIn(card())!, "still reading");
      await eventually(() => sendIn(card())?.disabled === false, 2_000, "drawn again");
      expect(toNewest(dom.document.body as unknown as ParentNode)).toBeNull();
    });
  });

  test("put away, nothing of it is watched any more", async () => {
    answer(AT_REST);
    await renderPage("/skills", async (host) => {
      await floating(host);
      floatButton(host)!.click();
      await eventually(() => card() === null, 3_000, "the panel put away");
      // Waited for: what a component sets up it takes down a moment after it is gone from the page, and one run in
      // six read the count in that moment. Counted, not listed: a failure that prints an element prints its page.
      await eventually(() => WatchedGrowth.all.reduce((sum, one) => sum + one.watching.size, 0) === 0, 2_000, "nothing watched any more");
    });
  });
});

describe("the conversation on the Chats page", () => {
  test("offers a small way back to the newest message once its reader has left the end, and pressed, goes there", async () => {
    answer(AT_REST);
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => watching(contentOf(boxOf(host))), 4_000, "the conversation drawn and watched");
      const box = boxOf(host)!;
      // At the end, where it opens: nothing to go back to.
      laidOut(box, { height: 3_000, seen: 600, top: 2_400 });
      scrolled(box);
      expect(toNewest(host)).toBeNull();

      reads(box, { height: 3_000, seen: 600, top: 400 });
      await eventually(() => toNewest(host) !== null, 2_000, "the way back");
      expect(toNewest(host)!.getAttribute("title")).toBe("Newest message");

      toNewest(host)!.click();
      await eventually(() => box.scrollTop === 3_000, 2_000, "the view at the end");
      await eventually(() => toNewest(host) === null, 2_000, "the way back gone");
      // On its way there the view is short of the end and the browser says so: that is not the reader leaving again.
      reads(box, { height: 3_000, seen: 600, top: 1_700 });
      laidOut(box, { height: 3_400, seen: 600, top: 1_700 });
      WatchedGrowth.grow(contentOf(box)!);
      expect(box.scrollTop).toBe(3_400);
      // Drawn again after that scroll, as above.
      type(host.querySelector("textarea") as HTMLTextAreaElement, "thanks");
      await eventually(() => (host.querySelector('button[aria-label="Send message"]') as HTMLButtonElement | null)?.disabled === false, 2_000, "drawn again");
      expect(toNewest(host)).toBeNull();
    });
  });
});

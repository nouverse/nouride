/**
 * A scroll container that follows its own bottom, the way a chat is expected to.
 *
 * Four behaviours, and they are separate on purpose:
 *
 * 1. **Open at the bottom.** A conversation is read newest-first, so arriving at the top of a
 *    three-month transcript is arriving in the wrong place. `resetKey` — the conversation's id — snaps
 *    to the end without asking, because a fresh view has no reading position to preserve.
 * 2. **Follow while it grows.** Steps arrive, an answer is revealed a few characters at a time, an
 *    image finishes loading and pushes everything down. A `useEffect` on some length cannot see most
 *    of that; a `ResizeObserver` on the content sees all of it. The box is watched too: a strip that
 *    appears over the composer takes its height from the box, and the newest message with it.
 * 3. **Stop following the moment somebody scrolls up.** That is the difference between a live view and
 *    an unusable one: if the reader has moved away from the end, nothing here is allowed to drag them
 *    back. Scrolling to the bottom again re-arms it.
 * 4. **Go to the end when asked.** What the reader sends is theirs to see, wherever they were reading
 *    (`toEnd`), and `away` says they are not at the end, for a way back to it.
 *
 * Only the reader stops it. Every scroll said whether the view was at the end, and that was read as the reader's
 * word: the view's own move to the end is a scroll too, said a frame later, and where the content had grown by more
 * than a few lines in that frame (an answer handed over whole, a long conversation still laying itself out) the view
 * was found away from the end it had just gone to, and stopped following. A reader leaves the end by moving up;
 * nothing the page does moves the view up but content getting shorter, which leaves it at the end.
 */

import { useCallback, useEffect, useRef, useState } from "react";

/** How close to the end still counts as "watching". Roughly a line and a half of text. */
const NEAR_BOTTOM_PX = 140;

export interface StickyScroll {
  /** The reader has left the end, and what is newer is below what they see. */
  away: boolean;
  /** To the end now, and following again: `smooth` for a press the reader watches, at once for what they sent. */
  toEnd: (how?: "smooth") => void;
}

export function useStickyScroll<T extends HTMLElement>(options: {
  /** The scrolling element. */
  container: React.RefObject<T | null>;
  /** The element whose height changes — usually the inner list. */
  content: React.RefObject<HTMLElement | null>;
  /** Changing this snaps to the bottom unconditionally. The conversation id. */
  resetKey?: string | undefined;
}): StickyScroll {
  const { container, content, resetKey } = options;
  /** Whether the reader is at the end. Starts true: a new view opens at the bottom. */
  const following = useRef(true);
  const [away, setAway] = useState(false);
  /** What watches the content grow, and the content it watches now. */
  const growth = useRef<ResizeObserver | null>(null);
  const watched = useRef<HTMLElement | null>(null);
  /** Where the view last was, by a scroll or by this hook's own hand: a reader leaves the end by moving up from there. */
  const last = useRef(0);

  useEffect(() => {
    const box = container.current;
    if (!box) return undefined;

    const atBottom = () =>
      box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_BOTTOM_PX;
    last.current = box.scrollTop;

    const onScroll = () => {
      const up = box.scrollTop < last.current - 1;
      last.current = box.scrollTop;
      if (atBottom()) following.current = true;
      else if (up) following.current = false;
      // Away is the reader's leaving, not the view's distance: on its way to the end it is short of it, and not away.
      setAway(!following.current);
    };
    box.addEventListener("scroll", onScroll, { passive: true });

    if (typeof ResizeObserver !== "undefined") {
      growth.current = new ResizeObserver(() => {
        if (!following.current) return;
        box.scrollTop = box.scrollHeight;
        last.current = box.scrollTop;
      });
      growth.current.observe(box);
    }

    return () => {
      box.removeEventListener("scroll", onScroll);
      growth.current?.disconnect();
      growth.current = null;
      watched.current = null;
    };
  }, [container]);

  /**
   * The content is watched from the draw it first appears in, looked for after every draw.
   *
   * It is not there at the first one: a conversation still being read draws its loading shape, and an empty one its
   * greeting. Looked for once, when the hook was set up, it was never found where the conversation was read after the
   * page drew — the chat that floats over a page, opened for the first time — and nothing followed the answer as it
   * was written: it went on under the fold. Watching it from when it appears also lands a conversation just read at
   * its end, since an observer says the size of what it is given at once.
   */
  useEffect(() => {
    const now = content.current;
    if (now === watched.current) return;
    if (watched.current) growth.current?.unobserve(watched.current);
    watched.current = now;
    if (now) growth.current?.observe(now);
  });

  /**
   * A different conversation opens at its newest message.
   *
   * Twice, a frame apart: the first lands before markdown, code blocks and images have laid out, and
   * the height they add afterwards would leave the view short of the end. The observer above catches
   * growth only while `following` is true, and this is what guarantees it starts that way.
   */
  useEffect(() => {
    const box = container.current;
    if (!box) return undefined;
    following.current = true;
    setAway(false);
    const land = () => {
      box.scrollTop = box.scrollHeight;
      last.current = box.scrollTop;
    };
    land();
    const settle = requestAnimationFrame(land);
    return () => cancelAnimationFrame(settle);
  }, [container, resetKey]);

  const toEnd = useCallback(
    (how?: "smooth") => {
      const box = container.current;
      if (!box) return;
      following.current = true;
      setAway(false);
      // Moving there is for a reader who asked to be taken: not for one who asked for less motion, and never for
      // what was just sent, which is at the end before the eye looks for it.
      const smooth = how === "smooth" && typeof matchMedia === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
      // Moved there over a few frames, each scroll of it is further down than the last: none reads as leaving.
      if (smooth && typeof box.scrollTo === "function") return box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
      box.scrollTop = box.scrollHeight;
      last.current = box.scrollTop;
    },
    [container],
  );

  return { away, toEnd };
}

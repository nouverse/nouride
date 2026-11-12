/**
 * A scroll container that follows its own bottom, the way a chat is expected to.
 *
 * Three behaviours, and they are separate on purpose:
 *
 * 1. **Open at the bottom.** A conversation is read newest-first, so arriving at the top of a
 *    three-month transcript is arriving in the wrong place. `resetKey` — the conversation's id — snaps
 *    to the end without asking, because a fresh view has no reading position to preserve.
 * 2. **Follow while it grows.** Steps arrive, an answer is revealed a few characters at a time, an
 *    image finishes loading and pushes everything down. A `useEffect` on some length cannot see most
 *    of that; a `ResizeObserver` on the content sees all of it.
 * 3. **Stop following the moment somebody scrolls up.** That is the difference between a live view and
 *    an unusable one: if the reader has moved away from the end, nothing here is allowed to drag them
 *    back. Scrolling to the bottom again re-arms it.
 */

import { useEffect, useRef } from "react";

/** How close to the end still counts as "watching". Roughly a line and a half of text. */
const NEAR_BOTTOM_PX = 140;

export function useStickyScroll<T extends HTMLElement>(options: {
  /** The scrolling element. */
  container: React.RefObject<T | null>;
  /** The element whose height changes — usually the inner list. */
  content: React.RefObject<HTMLElement | null>;
  /** Changing this snaps to the bottom unconditionally. The conversation id. */
  resetKey?: string | undefined;
}): void {
  const { container, content, resetKey } = options;
  /** Whether the reader is at the end. Starts true: a new view opens at the bottom. */
  const following = useRef(true);
  /** What watches the content grow, and the content it watches now. */
  const growth = useRef<ResizeObserver | null>(null);
  const watched = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const box = container.current;
    if (!box) return undefined;

    const atBottom = () =>
      box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_BOTTOM_PX;

    // A user scroll is the only thing that changes whether we follow. Programmatic scrolls below fire
    // this too, and they always land at the bottom, so they set it to true — which is correct.
    const onScroll = () => {
      following.current = atBottom();
    };
    box.addEventListener("scroll", onScroll, { passive: true });

    if (typeof ResizeObserver !== "undefined") {
      growth.current = new ResizeObserver(() => {
        if (following.current) box.scrollTop = box.scrollHeight;
      });
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
    box.scrollTop = box.scrollHeight;
    const settle = requestAnimationFrame(() => {
      box.scrollTop = box.scrollHeight;
    });
    return () => cancelAnimationFrame(settle);
  }, [container, resetKey]);
}

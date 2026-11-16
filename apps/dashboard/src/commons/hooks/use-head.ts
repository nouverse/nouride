/**
 * The phone's header as the page scrolls (`nextHead`): followed on the element that scrolls the page, and said once for
 * the whole app as `--head` on the document, the header's height while it is there and nothing while it is up. A
 * page's sticky row (`StickyBar`) stops under it by that value, so the header coming back never lies over the row.
 *
 * Only where the header is (`active`: below a laptop's width); back at rest on every new page.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { HEAD_AT_REST, nextHead } from "@/commons/lib/head";

/** Told whenever `--head` changes, for what measures against it (`StickyBar`'s observer). */
export const HEAD_CHANGED = "nouride:head";

export function useHead(scroller: HTMLElement | null, header: RefObject<HTMLElement | null>, { active, page }: { active: boolean; page: string }): boolean {
  const state = useRef(HEAD_AT_REST);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    state.current = HEAD_AT_REST;
    setShown(true);
  }, [page]);

  useEffect(() => {
    if (!active || !scroller) return undefined;
    const read = () => {
      state.current = nextHead(state.current, { y: scroller.scrollTop, maxY: scroller.scrollHeight - scroller.clientHeight });
      setShown(state.current.shown);
    };
    read();
    scroller.addEventListener("scroll", read, { passive: true });
    return () => scroller.removeEventListener("scroll", read);
  }, [active, scroller, page]);

  const up = active && scroller !== null && !shown;
  useEffect(() => {
    const height = active && scroller !== null && !up ? (header.current?.offsetHeight ?? 0) : 0;
    document.documentElement.style.setProperty("--head", `${height}px`);
    window.dispatchEvent(new Event(HEAD_CHANGED));
  }, [active, scroller, up, header, page]);
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty("--head");
    },
    [],
  );
  return !up;
}

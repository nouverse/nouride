/**
 * The phone's tab bar as the page scrolls (`nextFoot`): whether it is there, followed on the element that scrolls
 * the page, and said once for the whole app on the document (`data-foot="away"`), where `main.css` turns it into the
 * one value, `--foot`, that whatever stands over the bar is placed by: the chat's button, the toasts, the bar that
 * saves an automation. Each comes down with the bar and goes back up with it.
 *
 * Only where the bar is (`active`: below a laptop's width); back at rest on every new page.
 */

import { useEffect, useRef, useState } from "react";
import { FOOT_AT_REST, nextFoot } from "@/commons/lib/foot";

export function useFoot(scroller: HTMLElement | null, { active, more, page }: { active: boolean; more: boolean; page: string }): boolean {
  const state = useRef(FOOT_AT_REST);
  const [shown, setShown] = useState(true);
  const moreNow = useRef(more);
  moreNow.current = more;

  useEffect(() => {
    state.current = FOOT_AT_REST;
    setShown(true);
  }, [page]);

  useEffect(() => {
    if (!active || !scroller) return undefined;
    const read = () => {
      state.current = nextFoot(state.current, { y: scroller.scrollTop, maxY: scroller.scrollHeight - scroller.clientHeight, more: moreNow.current });
      setShown(state.current.shown);
    };
    read();
    scroller.addEventListener("scroll", read, { passive: true });
    return () => scroller.removeEventListener("scroll", read);
  }, [active, scroller, page]);

  useEffect(() => {
    if (more) setShown(true);
  }, [more]);

  const away = active && !shown && !more;
  useEffect(() => {
    if (away) document.documentElement.dataset.foot = "away";
    else delete document.documentElement.dataset.foot;
    return () => {
      delete document.documentElement.dataset.foot;
    };
  }, [away]);
  return !away;
}

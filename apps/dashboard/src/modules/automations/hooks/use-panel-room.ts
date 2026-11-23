/**
 * Keeps the panel beside the canvas as tall as the window has room for (`lib/panel-room.ts`), as the page scrolls, the
 * window is resized, or what stands over the canvas changes height. The answer is written on the panel itself as
 * `--panel-room`, which its own classes read: no render for a scroll.
 */

import { useLayoutEffect, type RefObject } from "react";
import { panelRoom } from "../lib/panel-room";

export function usePanelRoom(panel: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = panel.current;
    const row = element?.parentElement;
    if (!element || !row) return undefined;
    const measure = () => {
      const box = element.getBoundingClientRect();
      const chat = document.querySelector("[data-floating-chat-button]")?.getBoundingClientRect();
      const room = panelRoom({ rowTop: row.getBoundingClientRect().top, viewHeight: window.innerHeight, panel: box, chat: chat && chat.width > 0 ? chat : null });
      element.style.setProperty("--panel-room", `${room}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // What stands over the canvas (a banner, the tabs of a run) moves the row without a scroll or a resize.
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (row.parentElement) watch?.observe(row.parentElement);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      watch?.disconnect();
    };
  }, [panel]);
}

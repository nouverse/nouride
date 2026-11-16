/**
 * A page an agent wrote, drawn where it was written: an `html` block of a reply, in a frame inside the chat.
 *
 * The frame's address is the daemon's preview route, which serves the page under a policy of its own
 * (`routes/preview.ts` in the engine): it reaches nothing, reads nothing of the dashboard and cannot move the page
 * around it. The frame is sandboxed here too, so the same holds whatever answers at that address. It is asked for
 * when it comes near the screen, so a long chat does not load every page in it.
 *
 * The dashboard cannot see into the frame, so the page says how tall it is (the route adds the few lines that do) and
 * the frame takes that height, within bounds: a card is as tall as a card, and a long page scrolls inside the frame.
 * A page laid out to fill its window says the frame's own height back, and keeps the one it was first given. What a
 * frame says is a number from somebody else's page: only its own frame's is heard, and held to the bounds. The height
 * a page last said is kept while the dashboard is open, so a block drawn again does not jump.
 * On white whatever the theme, as a page with no colours of its own is in any browser.
 */

import { useEffect, useRef, useState } from "react";

/**
 * The frame's height in pixels before the page has said its own, which is also the window a page that fills its
 * window is given, and the bounds what it says is held to. Choices. On a small screen it is never most of the screen:
 * the chat around it still scrolls.
 */
const HEIGHT = { first: 320, least: 40, most: 640 } as const;

/** The height each page last said, by its address. */
const said = new Map<string, number>();

export function HtmlFrame({ src }: { src: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number>(() => said.get(src) ?? HEIGHT.first);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Its own frame's window, and one there is: a message with no source is nobody's.
      const own = frame.current?.contentWindow;
      if (!own || event.source !== own) return;
      const told = (event.data as { nouridePreviewHeight?: unknown } | null)?.nouridePreviewHeight;
      if (typeof told !== "number" || !Number.isFinite(told)) return;
      const next = Math.min(HEIGHT.most, Math.max(HEIGHT.least, Math.ceil(told)));
      said.set(src, next);
      setHeight(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src]);
  return <iframe ref={frame} src={src} title="A page the agent wrote" sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy" style={{ height }} className="block max-h-[70dvh] w-full border-0 bg-white" />;
}

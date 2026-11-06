/**
 * Whether this tab is being looked at (`document.visibilityState`). A hidden tab holds no event stream — the browser
 * allows six connections to one host over HTTP/1.1, and five chat tabs left open queued every other request behind
 * their streams — and polls only as a slow net.
 */

import { useEffect, useState } from "react";

export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    if (typeof document === "undefined") return;
    const changed = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return visible;
}

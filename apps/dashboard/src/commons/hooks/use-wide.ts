/**
 * Whether the window is a tablet's width or more (768px, Tailwind's `md`): where a panel opens under its button rather
 * than as a sheet from the foot of a phone's screen. Followed as the window is resized or a phone is turned.
 */

import { useEffect, useState } from "react";

const WIDE = "(min-width: 768px)";

function wideNow(): boolean {
  try {
    return window.matchMedia(WIDE).matches;
  } catch {
    return true;
  }
}

export function useWide(): boolean {
  const [wide, setWide] = useState(wideNow);
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia(WIDE);
    } catch {
      return undefined;
    }
    const changed = () => setWide(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return wide;
}

/**
 * Whether the window is a tablet's width or more (768px, Tailwind's `md`): where a panel opens under its button rather
 * than as a sheet from the foot of a phone's screen. And whether it is a laptop's (1024px, `lg`): where the menu stands
 * beside the page rather than in More's sheet over the tab bar. Followed as the window is resized or a phone is turned.
 */

import { useEffect, useState } from "react";

const WIDE = "(min-width: 768px)";
const LAPTOP = "(min-width: 1024px)";

function matchesNow(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return true;
  }
}

function useMedia(media: string): boolean {
  const [matches, setMatches] = useState(() => matchesNow(media));
  useEffect(() => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia(media);
    } catch {
      return undefined;
    }
    const changed = () => setMatches(query.matches);
    changed();
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, [media]);
  return matches;
}

export function useWide(): boolean {
  return useMedia(WIDE);
}

export function useLaptop(): boolean {
  return useMedia(LAPTOP);
}

/**
 * What the Office follows in the browser: the theme on `<html>` as the sidebar sets it, whether motion is wanted, and
 * whether the tab is seen — the last two decide whether anything is drawn twice.
 */

import { useEffect, useState } from "react";
import { DAISY } from "@/commons/lib/theme";

const darkNow = () => typeof document !== "undefined" && document.documentElement.dataset.theme === DAISY.dark;

/** Day or night, as the page is themed now — the sidebar's toggle changes `<html>`, and this follows it. */
export function useOfficeTheme(): "light" | "dark" {
  const [dark, setDark] = useState(darkNow);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setDark(darkNow()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return dark ? "dark" : "light";
}

export function useReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const follow = () => setReduced(media.matches);
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);
  return reduced;
}

export function useVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const follow = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", follow);
    return () => document.removeEventListener("visibilitychange", follow);
  }, []);
  return visible;
}

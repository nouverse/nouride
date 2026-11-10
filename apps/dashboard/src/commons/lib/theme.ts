/**
 * Light and dark: the system's, unless the person chose.
 *
 * daisyUI switches on `data-theme` at the document root, so this is a little state and one attribute. With
 * no choice saved the page follows the operating system, live: a dashboard that opens bright white on a
 * machine set to dark at two in the morning is a small thing that reads as carelessness, and so is one that
 * stays light after the machine has turned dark at sunset.
 *
 * Only the toggle saves. The first visit used to save whatever the system said that day, and every later
 * change of the system's mind was ignored. Choosing the theme the system
 * already gives saves nothing, and the page goes back to following it.
 *
 * `public/theme-boot.js` makes the same decision before the first paint, because this one waits for the
 * bundle. `tests/theme.test.ts` holds the two to the same answer.
 */

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

/**
 * Where a choice is kept. A key of its own: the old `nouride-theme` holds what each first visit saved — the
 * system's answer on that day, not anybody's choice — and reading it would keep everyone pinned to it.
 */
const CHOICE = "nouride-theme-choice";
const PREFERS_LIGHT = "(prefers-color-scheme: light)";

/** daisyUI theme name for each logical mode — the two themes `styles/main.css` defines. */
export const DAISY: Record<Theme, string> = {
  dark: "nouride",
  light: "nouride-light",
};

/**
 * Each theme's ground (`bg-app`: base-200 halfway into base-100), for what the browser draws around the page: its bar,
 * and an installed app's status bar and splash. `index.html`'s two `theme-color` metas and the manifest say the same,
 * and `tests/app-manifest.test.ts` works each out from `main.css`.
 */
export const GROUNDS: Record<Theme, string> = {
  dark: "#1f1d29",
  light: "#f9f7f3",
};

/** The theme the person chose in this browser, or null when they have not. */
function savedChoice(): Theme | null {
  try {
    const saved = localStorage.getItem(CHOICE);
    return saved === "light" || saved === "dark" ? saved : null;
  } catch {
    // Storage can throw in a locked-down browser. Then there is no choice to read, and the system decides.
    return null;
  }
}

/** What the system asks for: light when it says so, dark otherwise — and dark when it cannot be asked. */
function systemTheme(): Theme {
  try {
    return window.matchMedia(PREFERS_LIGHT).matches ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function useTheme(): [Theme, () => void] {
  const [choice, setChoice] = useState<Theme | null>(savedChoice);
  const [system, setSystem] = useState<Theme>(systemTheme);
  const theme = choice ?? system;

  // The system's answer as it changes, and a choice made in another tab, which writes the same key.
  useEffect(() => {
    let media: MediaQueryList | undefined;
    try {
      media = window.matchMedia(PREFERS_LIGHT);
    } catch {
      media = undefined;
    }
    const followSystem = () => setSystem(systemTheme());
    const followOtherTab = (event: StorageEvent) => {
      if (event.key === CHOICE || event.key === null) setChoice(savedChoice());
    };
    media?.addEventListener("change", followSystem);
    window.addEventListener("storage", followOtherTab);
    return () => {
      media?.removeEventListener("change", followSystem);
      window.removeEventListener("storage", followOtherTab);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", DAISY[theme]);
    // The metas follow the system by their `media`; a theme chosen against it would leave an installed app's status bar
    // dark over a cream page. Both say this theme's ground, whichever one the browser reads.
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute("content", GROUNDS[theme]);
  }, [theme]);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const kept = next === system ? null : next;
    setChoice(kept);
    try {
      if (kept) localStorage.setItem(CHOICE, kept);
      else localStorage.removeItem(CHOICE);
    } catch {
      // Then it holds for this page and is not remembered.
    }
  };

  return [theme, toggle];
}

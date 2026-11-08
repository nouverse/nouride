/**
 * The two themes, the theme a page opens on, and what is remembered (dash-dead-theme-css,
 * dashboard-theme-saves-system-choice).
 *
 * `main.css` set eighteen daisyUI 4 variables that daisyUI 5 never reads, so the radii it meant never
 * applied. It also compiled in daisyUI's stock light and dark themes, used for two things only: the
 * custom themes inherited eight variables from them without saying so, and `index.html` booted on
 * stock dark until React picked a theme, which was a dark flash before every light page. Now each
 * theme declares everything daisyUI reads, the stock themes are off, and `public/theme-boot.js` sets
 * the theme before the first paint.
 *
 * And the first visit saved the system's theme as though somebody had chosen it, so every later change of
 * the system's mind was ignored. Now only the toggle saves, and otherwise the page follows the system, live.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { DAISY } from "@/commons/lib/theme";
import { sleep } from "./wait.ts";

const ROOT = join(dirname(import.meta.path), "..");
const css = readFileSync(join(ROOT, "src", "styles", "main.css"), "utf8");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const boot = readFileSync(join(ROOT, "public", "theme-boot.js"), "utf8");

/** Each `@plugin "daisyui/theme" { … }` block: its name, and the variables it declares. */
const themes = [...css.matchAll(/@plugin\s+"daisyui\/theme"\s*\{([\s\S]*?)\n\}/g)].map((m) => ({
  name: /\bname:\s*"([^"]+)"/.exec(m[1]!)?.[1] ?? "",
  variables: [...m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((v) => v[1]!),
}));

/** Every variable a daisyUI 5 theme carries, from the stock light theme of the daisyUI this builds with. */
const daisyThemeVariables = (() => {
  const light = readFileSync(join(dirname(fileURLToPath(import.meta.resolve("daisyui/package.json"))), "theme", "light.css"), "utf8");
  return [...new Set([...light.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!))].sort();
})();

/** The variables each theme carries for the soft look's own rules in `main.css`, beside daisyUI's. */
const OWN = ["--fill-primary", "--fill-secondary", "--fill-success", "--fill-ink", "--shade"];

describe("the themes", () => {
  test("are the two the dashboard switches between", () => {
    expect(themes.map((theme) => theme.name).sort()).toEqual(Object.values(DAISY).sort());
  });

  test("each declares every variable daisyUI reads, so none is borrowed from a stock theme", () => {
    // The fail-open shape: an empty list would make the comparison below pass for anything.
    expect(daisyThemeVariables).toContain("--radius-field");
    expect(daisyThemeVariables.length).toBeGreaterThan(20);
    for (const theme of themes) {
      const daisy = theme.variables.filter((name) => !OWN.includes(name));
      expect({ theme: theme.name, variables: daisy.sort() }).toEqual({ theme: theme.name, variables: daisyThemeVariables });
    }
  });

  test("and the soft look's own, the same in both: the pastel fills, their ink and the shadow's colour", () => {
    // Read by `main.css` alone (the main action, a progress bar, `shadow-soft`): one theme without one would draw that
    // piece in nothing.
    for (const theme of themes) expect({ theme: theme.name, own: theme.variables.filter((name) => OWN.includes(name)).sort() }).toEqual({ theme: theme.name, own: [...OWN].sort() });
    for (const name of OWN) expect(css).toContain(`var(${name})`);
  });

  test("daisyUI's stock themes are not compiled in", () => {
    expect(css).toMatch(/@plugin\s+"daisyui"\s*\{[^}]*\bthemes:\s*false;/);
  });

  test("index.html opens on one of them", () => {
    const opening = /<html[^>]*\bdata-theme="([^"]+)"/.exec(html)?.[1];
    expect(Object.values(DAISY)).toContain(opening ?? "");
  });

  test("the boot script runs before the first paint", () => {
    // In <head>, classic, and from a file: a module or `defer` runs after the page is shown, and the
    // CSP (`script-src 'self'`) refuses an inline script.
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
    const tag = /<script\b[^>]*\bsrc="\/theme-boot\.js"[^>]*>/.exec(head)?.[0];
    expect(tag).toBeDefined();
    expect(tag).not.toMatch(/\b(type="module"|defer|async)\b/);
  });
});

/** Where a choice is kept, and where 0.7.10 kept what every first visit saved. */
const CHOICE = "nouride-theme-choice";
const LEGACY = "nouride-theme";

/** One browser: what its storage holds and whether it throws, and what its system asks for, live. */
interface Browser {
  choice?: string | null;
  legacy?: string | null;
  prefersLight: boolean;
  storageThrows?: boolean;
  noMatchMedia?: boolean;
}

/** A storage that records what is written to it, and can refuse every call as a locked-down browser does. */
function storageFor(browser: Browser) {
  const items = new Map<string, string>();
  if (browser.choice != null) items.set(CHOICE, browser.choice);
  if (browser.legacy != null) items.set(LEGACY, browser.legacy);
  const guard = () => {
    if (browser.storageThrows) throw new Error("SecurityError");
  };
  return {
    items,
    getItem: (key: string) => (guard(), items.get(key) ?? null),
    setItem: (key: string, value: string) => (guard(), void items.set(key, value)),
    removeItem: (key: string) => (guard(), void items.delete(key)),
  };
}

/** The system's colour scheme, with listeners told when it changes — as a MediaQueryList tells them. */
function systemFor(browser: Browser) {
  const listeners = new Set<() => void>();
  const state = { light: browser.prefersLight };
  const query = (text: string) => ({
    get matches() {
      return text === "(prefers-color-scheme: light)" && state.light;
    },
    addEventListener: (_: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => void listeners.delete(listener),
  });
  return {
    matchMedia: browser.noMatchMedia ? undefined : query,
    turn(light: boolean) {
      state.light = light;
      for (const listener of listeners) listener();
    },
    listening: () => listeners.size,
  };
}

/** What `public/theme-boot.js` writes on `<html>`, run as the browser runs it: against its globals. */
function bootScript(browser: Browser): string | undefined {
  const attributes: Record<string, string> = {};
  const documentElement = { setAttribute: (name: string, value: string) => void (attributes[name] = value) };
  new Function("localStorage", "matchMedia", "document", boot)(storageFor(browser), systemFor(browser).matchMedia, { documentElement });
  return attributes["data-theme"];
}

const GLOBALS = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "localStorage"] as const;
let dom: Window;
const before = new Map<string, unknown>();
const tick = () => sleep(10);

beforeAll(() => {
  dom = new Window({ url: "http://localhost/dashboard/" });
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of GLOBALS) {
    if (key in globals) before.set(key, globals[key]);
    globals[key] = (dom as unknown as Record<string, unknown>)[key];
  }
});

afterAll(async () => {
  await sleep(30);
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const key of GLOBALS) {
    if (before.has(key)) globals[key] = before.get(key);
    else delete globals[key];
  }
  await dom.happyDOM.close();
});

/** `useTheme` mounted in this browser: the theme `<html>` wears, the toggle, and the browser's storage and system. */
async function mountTheme(browser: Browser) {
  const storage = storageFor(browser);
  const system = systemFor(browser);
  (globalThis as unknown as Record<string, unknown>).localStorage = storage;
  Object.defineProperty(dom, "matchMedia", { value: system.matchMedia, configurable: true, writable: true });
  dom.document.documentElement.setAttribute("data-theme", "not-yet");

  const { createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useTheme } = await import("@/commons/lib/theme");
  let toggle = () => {};
  const Probe = () => {
    toggle = useTheme()[1];
    return null;
  };
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  root.render(createElement(Probe));
  for (let i = 0; i < 3; i += 1) await tick();

  return {
    storage,
    system,
    wears: () => dom.document.documentElement.getAttribute("data-theme"),
    async press() {
      toggle();
      for (let i = 0; i < 3; i += 1) await tick();
    },
    async turnSystem(light: boolean) {
      system.turn(light);
      for (let i = 0; i < 3; i += 1) await tick();
    },
    unmount() {
      root.unmount();
      host.remove();
    },
  };
}

describe("the theme a page opens on", () => {
  const browsers: Browser[] = [];
  for (const choice of ["light", "dark", null, "solarized"]) {
    for (const prefersLight of [true, false]) {
      browsers.push({ choice, prefersLight }, { choice, prefersLight, storageThrows: true }, { choice, prefersLight, noMatchMedia: true });
      browsers.push({ choice, prefersLight, legacy: prefersLight ? "dark" : "light" });
    }
  }

  test.each(browsers.map((browser) => [JSON.stringify(browser), browser] as const))("the boot script and React agree: %s", async (_, browser) => {
    const page = await mountTheme(browser);
    try {
      expect(page.wears()).toBe(bootScript(browser)!);
    } finally {
      page.unmount();
    }
  });

  test("the choices are the ones that matter", () => {
    // A choice wins, then the system, then dark — said once, so the agreement above is about something.
    expect(bootScript({ choice: "light", prefersLight: false })).toBe("nouride-light");
    expect(bootScript({ choice: "dark", prefersLight: true })).toBe("nouride");
    expect(bootScript({ choice: null, prefersLight: true })).toBe("nouride-light");
    expect(bootScript({ choice: null, prefersLight: true, noMatchMedia: true })).toBe("nouride");
    // Storage that throws hides a choice, not the system: it still decides.
    expect(bootScript({ choice: "dark", prefersLight: true, storageThrows: true })).toBe("nouride-light");
    // What 0.7.10 saved on every first visit was the system's answer that day, not a choice: it is not read.
    expect(bootScript({ legacy: "dark", prefersLight: true })).toBe("nouride-light");
  });
});

describe("what is remembered", () => {
  test("a first visit saves nothing", async () => {
    const page = await mountTheme({ prefersLight: true });
    try {
      expect(page.wears()).toBe("nouride-light");
      expect([...page.storage.items.keys()]).toEqual([]);
    } finally {
      page.unmount();
    }
  });

  test("with nothing chosen, the page follows the system as it changes", async () => {
    const page = await mountTheme({ prefersLight: true });
    try {
      await page.turnSystem(false);
      expect(page.wears()).toBe("nouride");
      await page.turnSystem(true);
      expect(page.wears()).toBe("nouride-light");
      expect([...page.storage.items.keys()]).toEqual([]);
    } finally {
      page.unmount();
    }
    // And stops listening once the page is gone.
    expect(page.system.listening()).toBe(0);
  });

  test("a choice is saved, and the system changing does not move it", async () => {
    const page = await mountTheme({ prefersLight: true });
    try {
      await page.press();
      expect(page.wears()).toBe("nouride");
      expect(page.storage.items.get(CHOICE)).toBe("dark");
      await page.turnSystem(false);
      await page.turnSystem(true);
      expect(page.wears()).toBe("nouride");
    } finally {
      page.unmount();
    }
  });

  test("choosing what the system already gives is no choice: nothing is kept, and the system leads again", async () => {
    const page = await mountTheme({ choice: "dark", prefersLight: true });
    try {
      expect(page.wears()).toBe("nouride");
      await page.press();
      expect(page.wears()).toBe("nouride-light");
      expect(page.storage.items.has(CHOICE)).toBe(false);
      await page.turnSystem(false);
      expect(page.wears()).toBe("nouride");
    } finally {
      page.unmount();
    }
  });

  test("a choice made in another tab is this tab's too", async () => {
    const page = await mountTheme({ prefersLight: false });
    try {
      page.storage.items.set(CHOICE, "light");
      dom.dispatchEvent(Object.assign(new dom.Event("storage"), { key: CHOICE }));
      for (let i = 0; i < 3; i += 1) await tick();
      expect(page.wears()).toBe("nouride-light");
    } finally {
      page.unmount();
    }
  });

  test("a browser that refuses storage still toggles, for as long as the page is open", async () => {
    const page = await mountTheme({ prefersLight: false, storageThrows: true });
    try {
      await page.press();
      expect(page.wears()).toBe("nouride-light");
    } finally {
      page.unmount();
    }
  });
});

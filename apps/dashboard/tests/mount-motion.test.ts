/**
 * Motion where something changes, and only there. A page, a tab's panel or a section that appears fades in as it is
 * drawn: `*:animate-fade` on the element around it, a CSS animation that plays when an element is inserted. So what is
 * checked is what makes it play — the page or the panel is a new element, under a parent that fades its children in —
 * and what keeps it from playing where nothing changed: the tab bar, the header and the sidebar are the same elements
 * after the change, and are not drawn again.
 */

import { describe, expect, test } from "bun:test";
import { dom, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

/** Whether `element` fades in as it is drawn: by its own class, or by its parent's for every child. */
const fadesIn = (element: Element | null | undefined) =>
  Boolean(element && (element.classList.contains("animate-fade") || element.parentElement?.classList.contains("*:animate-fade")));

/** The layout's element around the page — the outermost that fades its children in — and the page in it. */
function page(host: HTMLElement): { holder: Element | null; root: Element | null } {
  const holder = host.querySelector('[class~="*:animate-fade"]');
  return { holder, root: holder?.firstElementChild ?? null };
}

/** The tab bar's button or link that reads `label`, its count after it. */
function tab(host: HTMLElement, label: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>('[role="tab"], main a')].find((el) => el.textContent?.trim().startsWith(label));
  if (!found) throw new Error(`no tab "${label}"`);
  return found;
}

describe("a page", () => {
  test("in each of the layout's frames — a document, one held to the window, one that owns it, one with no chrome — fades in", async () => {
    for (const path of ["/", "/missions", "/logs", "/login"]) {
      await renderPage(path, async (host) => {
        await eventually(() => page(host).root !== null, 4_000, `${path} to draw`);
        expect(fadesIn(page(host).root)).toBe(true);
      });
    }
  });

  test("you go to is drawn anew and fades in, and the sidebar you went from stays as it was", async () => {
    let seen = { anew: false, fades: false, sidebarKept: false };
    await renderPage("/missions", async (host, app) => {
      await eventually(() => host.textContent?.includes("Long work an agent finishes alone") ?? false, 4_000, "Missions to draw");
      const before = page(host).root;
      const sidebar = host.querySelector('nav[aria-label="Menu"]');
      // Helpers is a tab of Work now (0.8.24): a page of the menu's own, as the test means.
      host.querySelector<HTMLElement>('nav[aria-label="Menu"] a[href$="/skills"]')!.click();
      await eventually(() => app.location().endsWith("/skills") && (host.textContent?.includes("Skills") ?? false), 4_000, "Skills to draw");
      const after = page(host).root;
      seen = { anew: after !== before, fades: fadesIn(after), sidebarKept: host.querySelector('nav[aria-label="Menu"]') === sidebar };
    });
    expect(seen).toEqual({ anew: true, fades: true, sidebarKept: true });
  });
});

describe("a tab", () => {
  test("on Missions draws the list it filters anew, and it fades in under a tab bar that stays", async () => {
    let seen = { anew: false, fades: false, barKept: false };
    await renderPage("/missions", async (host) => {
      await eventually(() => host.querySelector('[role="tablist"]') !== null, 4_000, "the tab bar");
      const bar = host.querySelector('[role="tablist"]');
      const list = host.querySelector("main section");
      tab(host, "Working").click();
      await eventually(() => host.querySelector('[aria-selected="true"]')?.textContent?.includes("Working") ?? false, 2_000, "Working to be chosen");
      const next = host.querySelector("main section");
      seen = { anew: next !== null && next !== list, fades: fadesIn(next), barKept: host.querySelector('[role="tablist"]') === bar };
    });
    expect(seen).toEqual({ anew: true, fades: true, barKept: true });
  });

  test("on Logs is a panel of its own, drawn anew and faded in", async () => {
    let seen = { anew: false, fades: false };
    await renderPage("/logs", async (host) => {
      await eventually(() => host.querySelector('[role="tablist"]') !== null, 4_000, "the tab bar");
      const panel = host.querySelector('[role="tablist"]')!.parentElement!.nextElementSibling;
      tab(host, "Audit").click();
      await eventually(() => host.querySelector('[aria-selected="true"]')?.textContent?.includes("Audit") ?? false, 2_000, "Audit to be chosen");
      const next = host.querySelector('[role="tablist"]')!.parentElement!.nextElementSibling;
      seen = { anew: next !== null && next !== panel, fades: fadesIn(next) };
    });
    expect(seen).toEqual({ anew: true, fades: true });
  });

  test("of an agent is its page, drawn anew and faded in under the agent's header, which stays", async () => {
    let seen = { anew: false, fades: false, headerKept: false };
    await renderPage("/agents/nouva", async (host, app) => {
      await eventually(() => host.querySelector("h1") !== null, 4_000, "the agent's header");
      const header = host.querySelector("h1");
      const layout = header!.closest('[class~="*:animate-fade"]')!;
      const before = layout.lastElementChild;
      tab(host, "Skills").click();
      await eventually(() => app.location().endsWith("/skills") && layout.lastElementChild !== before, 4_000, "the Skills tab to draw");
      seen = { anew: true, fades: fadesIn(layout.lastElementChild), headerKept: host.querySelector("h1") === header };
    });
    expect(seen).toEqual({ anew: true, fades: true, headerKept: true });
  });
});

describe("the chat's drawers", () => {
  // History opened under its button on a laptop and as a sheet on a phone, while the notes slid in from the side: two
  // motions for two panels of one conversation. Now both are the one drawer (`Drawer`), from either side, and the phone's
  // sheets rise the way the app's More does.
  const classes = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/);
  const MOTION = ["transition-[translate,visibility]", "duration-200", "ease-out"];

  test("History from the left and the notes from the right: twins, one open at a time, each over a shade, Escape closing", async () => {
    const seen: Record<string, unknown> = {};
    await renderPage("/chat/ses_1", async (host) => {
      const history = () => host.querySelector('[data-drawer="left"]');
      const notes = () => host.querySelector('[data-drawer="right"]');
      const button = () => host.querySelector<HTMLButtonElement>('button[aria-label="Nouva\'s conversations"]');
      const shade = () => host.querySelector('button[aria-label="Close Nouva\'s conversations"]');
      await eventually(() => history() !== null && notes() !== null && button() !== null, 4_000, "the drawers");
      seen.closed = { history: classes(history()), notes: classes(notes()), inert: [history()!.hasAttribute("inert"), notes()!.hasAttribute("inert")], shade: classes(shade()) };
      button()!.focus();
      button()!.click();
      await eventually(() => classes(history()).includes("translate-x-0"), 2_000, "History open");
      seen.open = { history: classes(history()), inert: history()!.hasAttribute("inert"), shade: classes(shade()), notes: classes(notes()), list: history()!.textContent };
      // The notes, from the conversation's menu, close History as they open.
      (host.querySelector('button[aria-label="More for this conversation"]') as HTMLElement).click();
      const item = () => [...host.ownerDocument.body.querySelectorAll("button")].find((one) => one.textContent?.includes("ork notes"));
      await eventually(() => item() !== undefined, 2_000, "the menu");
      item()!.click();
      await eventually(() => classes(notes()).includes("translate-x-0"), 2_000, "the notes open");
      seen.swapped = { history: classes(history()), notes: classes(notes()) };
      host.ownerDocument.dispatchEvent(new (host.ownerDocument.defaultView as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", { key: "Escape" }));
      await eventually(() => classes(notes()).includes("translate-x-full"), 2_000, "Escape to close");
      seen.escaped = true;
    });
    const closed = seen.closed as { history: string[]; notes: string[]; inert: boolean[]; shade: string[] };
    expect(closed.history).toEqual(expect.arrayContaining([...MOTION, "invisible", "-translate-x-full"]));
    expect(closed.notes).toEqual(expect.arrayContaining([...MOTION, "invisible", "translate-x-full"]));
    expect(closed.inert).toEqual([true, true]);
    expect(closed.shade).toEqual(expect.arrayContaining(["invisible", "opacity-0"]));
    // Twins: the same width, from either side.
    const width = closed.history.find((one) => one.startsWith("w-"));
    expect(width).toBeDefined();
    expect(closed.notes).toContain(width!);
    const open = seen.open as { history: string[]; inert: boolean; shade: string[]; notes: string[]; list: string };
    expect(open.history).toEqual(expect.arrayContaining(["visible", "translate-x-0"]));
    expect(open.inert).toBe(false);
    expect(open.shade).toEqual(expect.arrayContaining(["visible", "opacity-100"]));
    expect(open.notes).toContain("translate-x-full");
    expect(open.list).toContain("Nouva's conversations");
    const swapped = seen.swapped as { history: string[]; notes: string[] };
    expect(swapped.history).toContain("-translate-x-full");
    expect(swapped.notes).toContain("translate-x-0");
    expect(seen.escaped).toBe(true);
  });

  test("a phone's sheets rise as the app's More does: the same corners, ground and motion", async () => {
    const { Drawer, SHEET_BOX, DRAWER_MOTION } = await import("@/commons/components/ui/Drawer");
    const React = await import("react");
    const seen: Record<string, string[]> = {};
    await renderPage("/", async (host) => {
      // More: the sidebar drawn as a sheet below a laptop's width.
      const more = [...host.querySelectorAll("div")].find((one) => classes(one).includes("lg:inset-y-0"));
      seen.more = classes(more);
    });
    const holder = dom.document.createElement("div");
    dom.document.body.appendChild(holder as never);
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const root = createRoot(holder as never);
    flushSync(() => root.render(React.createElement(Drawer, { open: true, onClose: () => undefined, side: "bottom", label: "A sheet", children: "in it" })));
    seen.sheet = (dom.document.body.querySelector('[data-drawer="bottom"]')?.getAttribute("class") ?? "").split(/\s+/);
    flushSync(() => root.unmount());
    holder.remove();
    for (const token of [...SHEET_BOX.split(" "), ...DRAWER_MOTION.split(" ")]) {
      expect(seen.more).toContain(token);
      expect(seen.sheet).toContain(token);
    }
  });
});

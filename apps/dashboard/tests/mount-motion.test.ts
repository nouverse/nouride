/**
 * Motion where something changes, and only there. A page, a tab's panel or a section that appears fades in as it is
 * drawn: `*:animate-fade` on the element around it, a CSS animation that plays when an element is inserted. So what is
 * checked is what makes it play — the page or the panel is a new element, under a parent that fades its children in —
 * and what keeps it from playing where nothing changed: the tab bar, the header and the sidebar are the same elements
 * after the change, and are not drawn again.
 */

import { describe, expect, test } from "bun:test";
import { renderPage, useMountHarness } from "./mount-harness.ts";
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
      const sidebar = host.querySelector("nav");
      host.querySelector<HTMLElement>('nav a[href$="/jobs"]')!.click();
      await eventually(() => app.location().endsWith("/jobs") && (host.textContent?.includes("Work an agent left running") ?? false), 4_000, "Background Helpers to draw");
      const after = page(host).root;
      seen = { anew: after !== before, fades: fadesIn(after), sidebarKept: host.querySelector("nav") === sidebar };
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

  test("on System Logs is a panel of its own, drawn anew and faded in", async () => {
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

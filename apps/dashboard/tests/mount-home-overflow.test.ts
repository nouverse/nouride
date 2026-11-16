/**
 * Home's cards keep a long unbroken string inside them. Seen at a desktop's width: a mission waiting for an answer
 * printed its whole goal as the card's title, and a path in it ran past the card's right edge and under the Quick chat card beside it. A grid's column is as wide as its widest word unless its
 * cards may be narrower, and a title that cannot break pushes it. A DOM here has no layout to measure, so the classes
 * that hold it are what is read; the real browser check is in the release's evidence.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";
import { BoxWarnings } from "@/modules/home/components/BoxStatus";
import type { HealthPayload } from "@nouride/wire";

useMountHarness();

const ok = (body: unknown) => ({ status: 200, body });
const GOAL =
  "Nouride v0.8.39, group B (phone fixes): items 13, 14, 15, the tables part of item 16 of apps/dashboard/src/commons/components/approvals/WaitingLink.tsx, and the Home waiting-card overflow bug (WaitingLink title unclamped, long path runs past the card) are built, each as its own conventional commit with tests and sabotage evidence, pushed to releases/v0.8.39. Full instructions are in the brief at the mission folder's BRIEF.md.";
/** Its name: a few words, with one that cannot break. */
const TITLE = "The fixes for apps/dashboard/src/commons/WaitingLink.tsx";
const LONG_NAME = "an-agent-whose-id-is-far-longer-than-a-phone-is-wide-at-all";
const ME = WIRE["/auth/me"] as { user: Record<string, unknown> } & Record<string, unknown>;
const HOME = {
  "/automations/waiting": ok({ waiting: [] }),
  "/status": ok({
    status: "ready",
    gateways: [],
    providers: [],
    uptimeMs: 1000,
    orchestrator: "nix",
    agents: [{ id: "nix", displayName: LONG_NAME, enabled: true, state: "running", provider: "p", model: "m", tools: [], approvals: "careful" }],
  }),
  "/approvals": ok({ pending: [] }),
  "/missions": ok({ missions: [{ id: "m1", agentId: "nix", title: TITLE, goal: GOAL, status: "waiting", seen: "needs_you", waitKind: "input", checklist: null }] }),
  "/knowledge": ok({ collections: [] }),
  "/advisories": ok({ advisories: [{ message: "A secret is handed to every command: /srv/nouride/.nouride/agents/nix/secrets/a-very-long-file-name.json", agents: [], hint: null }] }),
  "/auth/me": ok({ ...ME, user: { ...ME.user, displayName: "Somebodywithaverylongnamethatneverbreaksanywhere" } }),
};

/** The element with this text, its class list. */
const classOf = (host: HTMLElement, selector: string, text: string) =>
  [...host.querySelectorAll<HTMLElement>(selector)].find((element) => element.textContent?.includes(text))?.getAttribute("class") ?? "";

describe("a mission waiting for an answer, on Home and on Work", () => {
  for (const [page, path] of [["Home", "/"], ["Work", "/work"]] as const) {
    test(`${page}: its name, not the goal, broken anywhere and cut at two lines, the goal in its title`, async () => {
      answer(HOME);
      await renderPage(path, async (host) => {
        await eventually(() => host.textContent?.includes("Waiting for your answer") === true, 3_000, page);
        const card = host.querySelector<HTMLAnchorElement>('a[href="/dashboard/missions/m1"]')!;
        const title = card.querySelector("p")!;
        expect(title.textContent).toBe(TITLE);
        expect(title.getAttribute("title")).toBe(GOAL);
        expect(title.className.split(" ")).toEqual(expect.arrayContaining(["[overflow-wrap:anywhere]", "line-clamp-2"]));
        // In the page's own type at reading weight: in the display face, large, a few cards were a screen of bold.
        expect(title.className.split(" ")).toEqual(expect.arrayContaining(["text-[15px]", "font-medium"]));
        expect(title.className).not.toContain("font-display");
        expect(title.className).not.toContain("text-lg");
        // The card itself may be narrower than its longest word, or the grid's column grows to hold it.
        expect(card.className.split(" ")).toContain("min-w-0");
      });
    });
  }

  test("the other waiting cards break and clamp the same way", async () => {
    answer({ ...HOME, "/missions": ok({ missions: [] }) });
    await renderPage("/", async (host) => {
      await eventually(() => host.textContent?.includes("Review them") === true, 3_000, "Home");
      const title = classOf(host, 'a[href="/dashboard/skills"] p', "skill");
      expect(title.split(" ")).toEqual(expect.arrayContaining(["[overflow-wrap:anywhere]", "line-clamp-2"]));
    });
  });
});

describe("the rest of Home", () => {
  test("the grid of cards lets each card be narrower than its longest word", async () => {
    answer(HOME);
    await renderPage("/", async (host) => {
      await eventually(() => host.textContent?.includes("Waiting for your answer") === true, 3_000, "Home");
      const grid = host.querySelector('a[href="/dashboard/missions/m1"]')!.parentElement!;
      expect(grid.className.split(" ")).toEqual(expect.arrayContaining(["grid", "*:min-w-0"]));
    });
  });

  test("an agent's chip breaks a name longer than the card onto another line, whole", async () => {
    answer(HOME);
    await renderPage("/", async (host) => {
      await eventually(() => host.textContent?.includes("Your agents") === true, 3_000, "Home");
      const chip = host.querySelector<HTMLAnchorElement>('a[href="/dashboard/agents/nix"][title]')!;
      expect(chip.getAttribute("title")).toBe(LONG_NAME);
      expect(chip.className.split(" ")).toContain("min-w-0");
      expect(chip.parentElement!.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "max-w-full"]));
      const name = classOf(host, `a[href="/dashboard/agents/nix"] span`, LONG_NAME).split(" ");
      expect(name).toEqual(expect.arrayContaining(["min-w-0", "[overflow-wrap:anywhere]"]));
      expect(name).not.toContain("truncate");
    });
  });

  test("the greeting and a setup note break a long word inside their card", async () => {
    answer(HOME);
    await renderPage("/", async (host) => {
      await eventually(() => host.textContent?.includes("Setup notes") === true, 3_000, "Home");
      [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Setup notes"))!.click();
      await eventually(() => host.textContent?.includes("a-very-long-file-name.json") === true, 3_000, "the note, opened");
      expect(classOf(host, "h1", "Somebodywithaverylongname").split(" ")).toContain("[overflow-wrap:anywhere]");
      expect(classOf(host, "p", "a-very-long-file-name.json").split(" ")).toContain("[overflow-wrap:anywhere]");
    });
  });

  test("the box's warnings break a long word inside their card", () => {
    const html = renderToString(createElement(BoxWarnings, { health: { issues: ["/srv/nouride/.nouride/agents/nix/a-very-long-file-name.json is not readable"] } as unknown as HealthPayload }));
    expect(html).toMatch(/<div class="[^"]*\[overflow-wrap:anywhere\][^"]*"><p[^>]*>Something to look at/);
  });
});

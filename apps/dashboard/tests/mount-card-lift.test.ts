/**
 * A card that is itself what opens something lifts a little under the pointer (`LIFTS`): a mission, a background
 * helper, an agent. Its transform only, eased; one that opens nothing does not lift, so a lift always means "this opens".
 * The reduced-motion rule keeps it still (`reduced-motion.test.ts`).
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const LIFT = "hover:-translate-y-0.5";

/** Every element on the page that lifts, by tag, with whether it eases its transform. */
const lifting = (host: HTMLElement) =>
  [...host.querySelectorAll("main *")]
    .filter((element) => (element.getAttribute("class") ?? "").split(/\s+/).includes(LIFT))
    .map((element) => ({ tag: element.tagName.toLowerCase(), eased: /transition-\[translate,/.test(element.getAttribute("class") ?? "") }));

describe("a card that opens something", () => {
  for (const [page, path, what] of [
    ["Missions", "/missions", 'a[href$="/missions/msn_1"]'],
    ["Helpers", "/jobs", 'a[href*="/jobs/"]'],
    ["Agents", "/agents", "main button.group"],
  ] as const) {
    test(`lifts on ${page}, eased, and only where it opens something`, async () => {
      // The engine's fixture has no background job: one running, as a helper an agent left.
      if (path === "/jobs") {
        const started = Date.now() - 120_000;
        answer({ "/jobs": { status: 200, body: { jobs: [{ id: "job_1", agentId: "nouva", gatewayId: null, chatId: "555", command: "helper: Render the video", kind: "helper", cwd: "/srv/work", status: "running", pid: null, exitCode: null, startedAt: started, endedAt: null, logBytes: 0, logUpdatedAt: started, processAlive: true, brief: null, report: null, turnId: null }] } } });
      }
      let found: { tag: string; eased: boolean }[] = [];
      await renderPage(path, async (host) => {
        await eventually(() => host.querySelector(what) !== null, 4_000, `a card on ${page}`);
        found = lifting(host);
      });
      expect(found.length).toBeGreaterThan(0);
      for (const card of found) {
        expect(["a", "button"]).toContain(card.tag);
        expect(card.eased).toBe(true);
      }
    });
  }

  test("on Home, lifts only the cards that open something: an agent, what waits for you elsewhere (0.8.24)", async () => {
    let found: { tag: string; eased: boolean }[] = [];
    await renderPage("/", async (host) => {
      await eventually(() => host.textContent?.includes("Everything is working") ?? false, 4_000, "Home");
      found = lifting(host);
    });
    // The harness's install has a request to talk to the agents and a skill to review, each a card that opens its page.
    expect(found.length).toBeGreaterThan(0);
    for (const card of found) expect(card).toEqual({ tag: "a", eased: true });
  });

  test("and every card of Settings, each a page", async () => {
    let found: { tag: string; eased: boolean }[] = [];
    await renderPage("/settings", async (host) => {
      await eventually(() => host.textContent?.includes("Models and keys") ?? false, 4_000, "Settings");
      found = lifting(host);
    });
    expect(found.length).toBeGreaterThan(5);
    for (const card of found) expect(card).toEqual({ tag: "a", eased: true });
  });
});

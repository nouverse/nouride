/**
 * A connection that is not up yet says what it waits on, on its row.
 *
 * On a live box a Telegram connection stayed "connecting" for thirty minutes its chat app had asked for, and its row
 * said only "connecting": nothing told that from a connection that would never come back. Mounted in a real DOM with
 * the connections as the daemon answers them.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";
import { waitingSaid } from "@/modules/agents/components/gateway-waiting";
import { markRestartPending, restartPending } from "@/commons/lib/restart";

useMountHarness();

const NOW = 1_795_000_000_000;
const REASON = "Telegram asked this bot to wait 30 minutes before it connects: too many requests in a short time, as after several restarts close together. It connects by itself once the wait is over.";

describe("the line under a connection's name", () => {
  test("says when it connects where the chat app named a time, and why", () => {
    expect(waitingSaid({ enabled: true, status: "connecting", waiting: { reason: REASON, since: NOW - 120_000, until: NOW + 28 * 60_000 } }, NOW)).toBe(`Connects in 28 min. ${REASON}`);
  });

  test("with no time named, or one already past, says since when it has not connected", () => {
    expect(waitingSaid({ enabled: true, status: "connecting", waiting: { reason: "It has not answered yet.", since: NOW - 12 * 60_000 } }, NOW)).toBe("Not connected yet, since 12 min ago. It has not answered yet.");
    expect(waitingSaid({ enabled: true, status: "reconnecting", waiting: { reason: REASON, since: NOW - 40 * 60_000, until: NOW - 60_000 } }, NOW)).toBe(`Not connected yet, since 40 min ago. ${REASON}`);
  });

  test("nothing for a connection that waits on nothing known, is up, or is turned off", () => {
    expect(waitingSaid({ enabled: true, status: "connecting" }, NOW)).toBeNull();
    expect(waitingSaid({ enabled: true, status: "connected", waiting: { reason: REASON, since: NOW } }, NOW)).toBeNull();
    expect(waitingSaid({ enabled: false, status: "connecting", waiting: { reason: REASON, since: NOW } }, NOW)).toBeNull();
    expect(waitingSaid({ enabled: true, status: null, waiting: { reason: REASON, since: NOW } }, NOW)).toBeNull();
  });
});

describe("an agent's connections", () => {
  const connections = (extra: Record<string, unknown>) => ({ editable: true, groupContextDefault: 20, gateways: [{ id: "telegram:nouva", platform: "telegram", name: "nouva", agent: "nouva", enabled: true, hasCredential: true, tokenSecret: "telegram-nouva", ...extra }] });

  // The connection's own card, by its Remove button: the page holds other statuses too. A save that waits for a
  // restart says so in a strip above every page, kept from whichever test saved one, and the first status on the page
  // was that strip in the order the tests run on Linux.
  const card = (host: HTMLElement) => host.querySelector('[aria-label="Remove connection"]')?.closest("section, article, div[class*='card']") ?? null;

  test("one that waits says so in its card, as a status a screen reader is told", async () => {
    markRestartPending("Web search: Free sources");
    answer({ "/gateways": { status: 200, body: connections({ status: "connecting", waiting: { reason: REASON, since: Date.now() - 120_000, until: Date.now() + 28 * 60_000 + 5_000 } }) } });
    await renderPage("/agents/nouva/gateways", async (host) => {
      await eventually(() => card(host)?.querySelector('[role="status"]') != null, 3_000, "the line");
      // In the connection's own card, beside its name and its state.
      expect(card(host)?.textContent).toContain("telegram:nouva");
      expect(card(host)?.querySelector('[role="status"]')?.textContent?.replace(/\s+/g, " ").trim()).toBe(`Connects in 28 min. ${REASON}`);
      // The strip is there, and is not what was read.
      expect([...host.querySelectorAll('[role="status"]')].some((one) => one.textContent?.includes("takes effect after a restart"))).toBe(true);
    });
  });

  test("one that is connected says nothing of a wait", async () => {
    // The strip the test before put up is gone: what one test saved waits for a restart in no other. Left there, it
    // was above the mission's page in the next file on the private runner, which read it as the mission's own word.
    expect(restartPending()).toEqual([]);
    answer({ "/gateways": { status: 200, body: connections({ status: "connected" }) } });
    await renderPage("/agents/nouva/gateways", async (host) => {
      await eventually(() => card(host)?.textContent?.includes("telegram:nouva") === true, 3_000, "the card");
      expect(card(host)?.querySelector('[role="status"]')).toBeNull();
      expect(host.textContent).not.toContain("takes effect after a restart");
      expect(host.textContent).not.toContain("Connects in");
      expect(host.textContent).not.toContain("Not connected yet");
    });
  });
});

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

  test("one that waits says so in its card, as a status a screen reader is told", async () => {
    answer({ "/gateways": { status: 200, body: connections({ status: "connecting", waiting: { reason: REASON, since: Date.now() - 120_000, until: Date.now() + 28 * 60_000 + 5_000 } }) } });
    await renderPage("/agents/nouva/gateways", async (host) => {
      await eventually(() => host.querySelector('[role="status"]') !== null, 3_000, "the line");
      const line = host.querySelector('[role="status"]')!;
      expect(line.textContent?.replace(/\s+/g, " ").trim()).toBe(`Connects in 28 min. ${REASON}`);
      // In the connection's own card, beside its name and its state.
      const card = line.closest("section, article, div[class*='card']");
      expect(card?.textContent).toContain("telegram:nouva");
    });
  });

  test("one that is connected says nothing of a wait", async () => {
    answer({ "/gateways": { status: 200, body: connections({ status: "connected" }) } });
    await renderPage("/agents/nouva/gateways", async (host) => {
      await eventually(() => host.textContent?.includes("telegram:nouva") === true, 3_000, "the card");
      expect(host.querySelector('[role="status"]')).toBeNull();
    });
  });
});

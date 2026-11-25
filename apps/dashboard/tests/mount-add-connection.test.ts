/**
 * What an agent's Connections page offers to add: one connection on each chat app.
 *
 * The page offered Telegram, Discord and WhatsApp to an agent that had all three, as if a second bot on an app were
 * the usual thing. An app the agent already answers on is not offered again, and with all three there is no button.
 * Another agent's connections take nothing away from this one's, and one switched off still holds its app.
 * Mounted in a real DOM with the daemon's answers as it gives them.
 */

import { describe, expect, test } from "bun:test";
import { platformsToAdd } from "../src/modules/agents/components/gateway-platforms.ts";
import { answer, buttons, press, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const connection = (platform: string, name: string, agent: string, extra: Record<string, unknown> = {}) => ({ id: `${platform}:${name}`, platform, name, agent, enabled: true, status: "connected", hasCredential: true, ...extra });
const offered = (mine: { platform: string }[]) => platformsToAdd(mine).map((platform) => platform.label);

function daemon(gateways: ReturnType<typeof connection>[]) {
  answer({
    "/gateways": { status: 200, body: { editable: true, groupContextDefault: 20, gateways } },
    "/gateways/whatsapp%3Anora/pairing": { status: 200, body: { status: "connected", linked: true, qr: null } },
    "/status": { status: 200, body: { agents: [{ id: "nora", displayName: "Nora", access: "pair" }, { id: "nouva", displayName: "Nouva", access: "pair" }] } },
  });
}
/** The menu's own lines once it is open: it is drawn outside the page's own element, over everything. */
const menu = () => [...document.body.querySelectorAll('[role="menu"] button')].map((item) => item.textContent?.trim());

describe("the apps an agent can still be given a connection on", () => {
  test("each app it has none on, in the page's order; an app it has one on is not among them", () => {
    expect(offered([])).toEqual(["Telegram", "Discord", "WhatsApp"]);
    expect(offered([{ platform: "telegram" }])).toEqual(["Discord", "WhatsApp"]);
    expect(offered([{ platform: "whatsapp" }, { platform: "telegram" }])).toEqual(["Discord"]);
    expect(offered([{ platform: "telegram" }, { platform: "discord" }, { platform: "whatsapp" }])).toEqual([]);
    // Two on one app, as a file written by hand may hold: that app is taken once, and nothing else is.
    expect(offered([{ platform: "whatsapp" }, { platform: "whatsapp" }])).toEqual(["Telegram", "Discord"]);
  });
});

describe("the Connections page", () => {
  test("offers only the app the agent has no connection on, whatever another agent has", async () => {
    daemon([connection("telegram", "nora", "nora"), connection("whatsapp", "nora", "nora"), connection("discord", "nouva", "nouva"), connection("telegram", "nouva", "nouva")]);
    let lines: (string | undefined)[] = [];
    await renderPage("/agents/nora/gateways", async (host) => {
      await eventually(() => buttons(host).includes("Add Connection"), 3_000, "the button");
      press(host, "Add Connection");
      await eventually(() => menu().length > 0, 3_000, "the menu");
      lines = menu();
    });
    expect(lines).toEqual(["Discord"]);
  });

  test("has no button to add one once the agent has all three, and still shows each", async () => {
    // One of them switched off: it holds its app all the same, and is switched on again from its own card.
    daemon([connection("telegram", "nora", "nora"), connection("discord", "nora", "nora", { enabled: false, status: null }), connection("whatsapp", "nora", "nora")]);
    let has: string[] = [];
    let cards = 0;
    await renderPage("/agents/nora/gateways", async (host) => {
      await eventually(() => host.querySelectorAll('[aria-label="Remove connection"]').length === 3, 3_000, "the three cards");
      has = buttons(host);
      cards = host.querySelectorAll('[aria-label="Remove connection"]').length;
    });
    expect(has).not.toContain("Add Connection");
    expect(cards).toBe(3);
  });

  test("offers all three to an agent with none", async () => {
    daemon([connection("telegram", "nouva", "nouva")]);
    let lines: (string | undefined)[] = [];
    await renderPage("/agents/nora/gateways", async (host) => {
      await eventually(() => buttons(host).includes("Add Connection"), 3_000, "the button");
      press(host, "Add Connection");
      await eventually(() => menu().length > 0, 3_000, "the menu");
      lines = menu();
    });
    expect(lines).toEqual(["Telegram", "Discord", "WhatsApp"]);
  });

  test("offers nothing while the agent's connections are not known: not all three, as if it had none", async () => {
    answer({ "/gateways": { status: 500, body: { error: "the list could not be read" } }, "/status": { status: 200, body: { agents: [{ id: "nora", displayName: "Nora", access: "pair" }] } } });
    let has: string[] = ["Add Connection"];
    await renderPage("/agents/nora/gateways", async (host) => {
      await eventually(() => host.textContent?.includes("The chat apps this agent answers on") === true, 3_000, "the page");
      has = buttons(host);
    });
    expect(has).not.toContain("Add Connection");
  });
});

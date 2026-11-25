/**
 * An agent's WhatsApp numbers on its Connections page: each one its own card, linked or waiting for its scan.
 *
 * A daemon held one WhatsApp number once. An agent has its own now. The page adds one for an agent
 * (`mount-add-connection.test.ts`), and a file written by hand may hold two, so the page shows each by its own
 * state, asked of the daemon by that connection's id: one linked, one with its code to scan, and never another
 * agent's. A number of an agent that is open to everyone says what that may cost the number.
 * Mounted in a real DOM with the daemon's answers as it gives them.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const number = (name: string, agent: string, extra: Record<string, unknown> = {}) => ({
  id: `whatsapp:${name}`,
  platform: "whatsapp",
  name,
  agent,
  enabled: true,
  status: "connected",
  hasCredential: true,
  encryptionKeySecret: `whatsapp-${name}-key`,
  ...extra,
});

/** The daemon's answers for an agent with two numbers, beside another agent's own number and a Telegram bot. */
function answers(access: "open" | "pair") {
  answer({
    "/gateways": {
      status: 200,
      body: {
        editable: true,
        groupContextDefault: 20,
        gateways: [number("shop", "nora"), number("promo", "nora", { status: "connecting" }), number("home", "nouva"), { id: "telegram:nora", platform: "telegram", name: "nora", agent: "nora", enabled: true, status: "connected", hasCredential: true, tokenSecret: "telegram-nora" }],
      },
    },
    "/gateways/whatsapp%3Ashop/pairing": { status: 200, body: { status: "connected", linked: true, qr: null } },
    "/gateways/whatsapp%3Apromo/pairing": { status: 200, body: { status: "connecting", linked: false, qr: "2@the-promo-number's-code", at: Date.now() } },
    "/status": { status: 200, body: { agents: [{ id: "nora", displayName: "Nora", access }, { id: "nouva", displayName: "Nouva", access: "pair" }] } },
  });
}

/** Each connection's card on the page, by the id it shows. */
const cards = (host: HTMLElement) =>
  [...host.querySelectorAll('[aria-label="Remove connection"]')].map((button) => button.closest("section, article, div[class*='card']") as HTMLElement | null).filter((card): card is HTMLElement => card !== null);
const cardOf = (host: HTMLElement, id: string) => cards(host).find((card) => card.textContent?.includes(id)) ?? null;

describe("an agent with two WhatsApp numbers", () => {
  test("has a card for each, one linked and one waiting for its scan, and none of another agent's", async () => {
    answers("pair");
    await renderPage("/agents/nora/gateways", async (host) => {
      await eventually(() => cardOf(host, "whatsapp:shop")?.textContent?.includes("Device Linked") === true, 3_000, "the linked number's card");
      await eventually(() => /Scan with WhatsApp|Getting the QR code/.test(cardOf(host, "whatsapp:promo")?.textContent ?? ""), 3_000, "the waiting number's card");
      expect(cards(host)).toHaveLength(3);
      expect(["telegram:nora", "whatsapp:promo", "whatsapp:shop", "whatsapp:home"].filter((id) => cardOf(host, id) !== null)).toEqual(["telegram:nora", "whatsapp:promo", "whatsapp:shop"]);
      // Each by its own state: the linked one shows no code, the waiting one is not said to be linked.
      expect(cardOf(host, "whatsapp:shop")?.textContent).not.toMatch(/Scan with WhatsApp|Getting the QR code/);
      expect(cardOf(host, "whatsapp:promo")?.textContent).not.toContain("Device Linked");
      expect(host.textContent).not.toContain("whatsapp:home");
      // Nothing is said of strangers for an agent that is not open.
      expect(host.querySelector("[data-open-number-note]")).toBeNull();
    });
  });

  test("open to everyone: each of its numbers says what that may cost the number, and its Telegram bot does not", async () => {
    answers("open");
    await renderPage("/agents/nora/gateways", async (host) => {
      await eventually(() => host.querySelectorAll("[data-open-number-note]").length === 2, 3_000, "the note on both numbers");
      const said = cardOf(host, "whatsapp:shop")?.querySelector("[data-open-number-note]")?.textContent?.replace(/\s+/g, " ").trim();
      expect(said).toBe(
        "This agent answers anyone who writes to it. WhatsApp may restrict or close a number that answers many people it does not know: Nouride is linked to this number the way WhatsApp Web is, not through the service WhatsApp sells to businesses. A number you can afford to lose is the safer one to use here.",
      );
      expect(cardOf(host, "whatsapp:promo")?.querySelector("[data-open-number-note]")).not.toBeNull();
      expect(cardOf(host, "telegram:nora")?.querySelector("[data-open-number-note]")).toBeNull();
    });
  });
});

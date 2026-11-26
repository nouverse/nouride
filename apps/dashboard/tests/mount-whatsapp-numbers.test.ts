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
import { answer, recordPosts, renderPage, useMountHarness } from "./mount-harness.ts";
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

/** The answers `answers` last gave, to add one to. */
let given: Record<string, { status: number; body: unknown }> = {};
const current = () => given;

/** The daemon's answers for an agent with two numbers, beside another agent's own number and a Telegram bot. */
function answers(access: "open" | "pair") {
  answer(given = {
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
      expect(host.querySelector("[data-whatsapp-risk]")).toBeNull();
    });
  });

  test("open to everyone: each of its numbers says what that may cost the number, and its Telegram bot does not", async () => {
    answers("open");
    await renderPage("/agents/nora/gateways", async (host) => {
      await eventually(() => host.querySelectorAll("[data-whatsapp-risk]").length === 2, 3_000, "the note on both numbers");
      const said = [...(cardOf(host, "whatsapp:shop")?.querySelectorAll("[data-whatsapp-risk] li") ?? [])].map((item) => item.textContent?.replace(/\s+/g, " ").trim());
      expect(said).toEqual([
        "This agent answers anyone. That is the riskiest way to use a WhatsApp number, so start with low daily limits.",
        "Nouride connects to WhatsApp unofficially, the way WhatsApp Web does (through Baileys), not through WhatsApp's official Business API.",
        "WhatsApp may restrict or ban a number it sees acting like a bot: answering many people it doesn't know, sending a lot, or replying to a broadcast. A ban can't be undone from here, and the number's chats may be lost.",
        "Use a number you can afford to lose, not your personal one.",
      ]);
      expect(cardOf(host, "whatsapp:promo")?.querySelector("[data-whatsapp-risk]")).not.toBeNull();
      expect(cardOf(host, "telegram:nora")?.querySelector("[data-whatsapp-risk]")).toBeNull();
    });
  });
});

describe("a number removed", () => {
  const remove = async (stillOnThePhone: boolean) => {
    answers("pair");
    let toast = "";
    await renderPage("/agents/nora/gateways", async (host) => {
      await eventually(() => cardOf(host, "whatsapp:shop") !== null, 3_000, "the shop's card");
      // The removal's own answer, beside the page's, as the daemon gives it.
      answer({
        ...current(),
        "/gateways/whatsapp%3Ashop": { status: 200, body: { ok: true, restartRequired: false, ...(stillOnThePhone ? { stillOnThePhone: true } : {}) } },
      });
      cardOf(host, "whatsapp:shop")!.querySelector<HTMLButtonElement>('[aria-label="Remove connection"]')!.click();
      await eventually(() => [...document.body.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Remove"), 3_000, "the question");
      [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Remove")!.click();
      await eventually(() => document.body.textContent?.includes("Connection whatsapp:shop removed") === true, 3_000, "the toast");
      toast = document.body.textContent ?? "";
    });
    return toast;
  };

  test("whose phone was not told: the person is told where to finish removing it", async () => {
    expect(await remove(true)).toContain("The phone that held this number may still list it under Linked devices: remove it there too.");
  });

  test("logged out from its phone: nothing more to do, and nothing said of it", async () => {
    expect(await remove(false)).not.toContain("Linked devices");
  });
});

describe("a number logged out from its phone", () => {
  test("says so, with no code awaited, and is linked again on the person's word: the daemon asked, and the new code shown", async () => {
    answers("pair");
    answer({ ...current(), "/gateways/whatsapp%3Ashop/pairing": { status: 200, body: { status: "dead", linked: false, loggedOut: true, qr: null } } });
    const posted = recordPosts({ "/gateways/whatsapp%3Ashop/link-again": { status: 200, body: { ok: true, id: "whatsapp:shop", status: "connecting" } } });
    try {
      await renderPage("/agents/nora/gateways", async (host) => {
        await eventually(() => cardOf(host, "whatsapp:shop")?.querySelector("[data-logged-out]") != null, 3_000, "the logged-out note");
        const card = cardOf(host, "whatsapp:shop")!;
        expect(card.textContent).toContain("This number was logged out from its phone");
        // Nothing is waited for: no code comes to a number logged out until it is linked again.
        expect(card.textContent).not.toContain("Getting the QR code");
        // The other number goes on as it was.
        expect(cardOf(host, "whatsapp:promo")?.querySelector("[data-logged-out]")).toBeNull();

        // Its next answer is the new link's: a code to scan.
        answer({ ...current(), "/gateways/whatsapp%3Ashop/pairing": { status: 200, body: { status: "connecting", linked: false, loggedOut: false, qr: "2@a-new-code", at: Date.now() } } });
        [...card.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Link again")!.click();
        await eventually(() => [...document.body.querySelectorAll("dialog button")].some((button) => button.textContent?.trim() === "Link again"), 3_000, "the question");
        expect(posted.posts).toEqual([]);
        [...document.body.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent?.trim() === "Link again")!.click();
        await eventually(() => posted.posts.length === 1, 3_000, "asked of the daemon");
        await eventually(() => /Scan with WhatsApp|Link a Device/.test(cardOf(host, "whatsapp:shop")?.textContent ?? ""), 3_000, "the new code");
        expect(cardOf(host, "whatsapp:shop")?.querySelector("[data-logged-out]")).toBeNull();
      });
      expect(posted.posts).toEqual([{ path: "/gateways/whatsapp%3Ashop/link-again", body: {} }]);
    } finally {
      posted.restore();
    }
  });

  test("asked and not confirmed: nothing is asked of the daemon, and the note stays", async () => {
    answers("pair");
    answer({ ...current(), "/gateways/whatsapp%3Ashop/pairing": { status: 200, body: { status: "dead", linked: false, loggedOut: true, qr: null } } });
    const posted = recordPosts();
    try {
      await renderPage("/agents/nora/gateways", async (host) => {
        await eventually(() => cardOf(host, "whatsapp:shop")?.querySelector("[data-logged-out]") != null, 3_000, "the logged-out note");
        [...cardOf(host, "whatsapp:shop")!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Link again")!.click();
        await eventually(() => [...document.body.querySelectorAll("dialog button")].some((button) => button.textContent?.trim() === "Cancel"), 3_000, "the question");
        [...document.body.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) => button.textContent?.trim() === "Cancel")!.click();
        await eventually(() => ![...document.body.querySelectorAll("dialog[open]")].length, 3_000, "the question closed");
        expect(cardOf(host, "whatsapp:shop")?.querySelector("[data-logged-out]")).not.toBeNull();
      });
      expect(posted.posts).toEqual([]);
    } finally {
      posted.restore();
    }
  });
});

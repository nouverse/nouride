/**
 * A message of files alone, drawn in a conversation: its files, and no bubble of words under them. The daemon keeps a
 * stand-in where such a message's words would be, and the page drew it as what the person wrote.
 */

import { describe, expect, test } from "bun:test";
import type { ChatTurn } from "@nouride/wire";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const RECORDED = WIRE["/sessions/ses_1/turns"] as { turns: ChatTurn[] } & Record<string, unknown>;
const asked = (over: Partial<ChatTurn>): ChatTurn => ({ ...RECORDED.turns[0]!, id: "turn_f", reply: "A quiz about regression.", steps: [], ...over });
const shown = (turn: ChatTurn, session: Record<string, unknown> = {}) =>
  answer({
    "/sessions/ses_1/turns": { status: 200, body: { ...RECORDED, session: { ...(RECORDED.session as Record<string, unknown>), ...session }, turns: [turn] } },
    "/sessions/ses_1/live": { status: 200, body: { turn: null, jobs: [] } },
    "/turns/turn_f": { status: 404, body: { error: "no record" } },
  });
const PICTURE = { name: "quiz.png", mimeType: "image/png", kind: "image", direction: "in" as const };
/** The reader's own bubbles: what they wrote, drawn at the right. */
const bubbles = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>(".items-end .bg-secondary\\/20")].map((bubble) => bubble.textContent ?? "");

describe("a message of files alone in a conversation", () => {
  test("is its files, with no words under them; words that came with files are drawn", async () => {
    shown(asked({ prompt: "(attachment)", attachments: [PICTURE] }));
    const alone = { words: [] as string[], page: "" };
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => (host.textContent ?? "").includes("A quiz about regression."), 3_000, "the answer");
      alone.words = bubbles(host);
      alone.page = host.textContent ?? "";
    });
    expect(alone.words).toEqual([]);
    expect(alone.page).not.toContain("(attachment)");
    // The file itself is there, by its name.
    expect(alone.page).toContain("quiz.png");

    shown(asked({ prompt: "what is this quiz about?", attachments: [PICTURE] }));
    let withWords: string[] = [];
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => (host.textContent ?? "").includes("A quiz about regression."), 3_000, "the answer");
      withWords = bubbles(host);
    });
    expect(withWords).toEqual(["what is this quiz about?"]);
  });

  test("the same of a person's on a chat app, read from the dashboard: their name, their files, and no words they did not write", async () => {
    shown(asked({ prompt: "(attachment)", attachments: [PICTURE], senderName: "Sam" }), { gatewayId: "telegram:nouva", chatId: "814", writable: false });
    let said = "";
    await renderPage("/chat/ses_1", async (host) => {
      await eventually(() => host.querySelector('[data-person="Sam"]') !== null && (host.textContent ?? "").includes("A quiz about regression."), 3_000, "Sam's message and the answer");
      said = host.querySelector('[data-person="Sam"]')?.textContent ?? "";
    });
    expect(said).toContain("quiz.png");
    expect(said).not.toContain("(attachment)");
  });
});

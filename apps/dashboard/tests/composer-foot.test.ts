/**
 * The space under the message box on a phone. Under the box was a row for small words, 16px tall and 8px under it, that
 * is empty on a phone in a one-to-one chat (who answers with no tag is a room's, and "Enter to send" is not drawn on a
 * phone), then the composer's own padding: 36px of nothing at 390px wide, measured in Chrome before the change, where
 * the box's padding alone is 12px. The row is now drawn only where it has words at that width, and the column spaces
 * by gaps, so a row put away takes its gap with it: a `space-y` margin stayed on the box.
 */

import { describe, expect, test } from "bun:test";
import { createElement, createRef } from "react";
import { renderToString } from "react-dom/server";
import { Composer, type ComposerProps } from "@/commons/components/chat/Composer";
import type { Room } from "@nouride/wire";

const menu = { matches: [], active: 0, setActive: () => {}, pick: () => {}, close: () => {}, onTyped: () => {} };
const draw = (extra: Partial<ComposerProps>) =>
  renderToString(
    createElement(Composer, {
      input: "",
      setInput: () => {},
      submit: () => {},
      canSend: false,
      writable: true,
      busy: false,
      textareaRef: createRef<HTMLTextAreaElement>(),
      room: null,
      agentName: "Nova",
      slash: { ...menu, open: false, toggle: () => {} },
      mention: { ...menu, index: 0 },
      attachments: { files: [], add: () => {}, remove: () => {}, uploading: false },
      conversation: { error: null, session: undefined, stop: () => {} } as unknown as ComposerProps["conversation"],
      ...extra,
    }),
  );

/** The row under the box: what holds the keys or the room's words. */
const row = (html: string) => /<div class="([^"]*min-h-4[^"]*)">/.exec(html)?.[1]?.split(" ") ?? null;

describe("under the message box", () => {
  test("its column spaces by gaps, so a row put away leaves no margin on the box", () => {
    const html = draw({});
    expect(html).toMatch(/<div class="max-w-3xl mx-auto flex flex-col gap-2">/);
    expect(html).not.toContain("space-y-2");
  });

  test("a one-to-one chat: the row is put away on a phone and drawn from sm up, for the keys", () => {
    const words = row(draw({}))!;
    expect(words).toEqual(expect.arrayContaining(["hidden", "sm:flex"]));
    expect(words).not.toContain("flex");
  });

  test("a room: the row is drawn at every width, with who answers a message that tags nobody", () => {
    const html = draw({ room: { chatId: "r1", members: ["nova"] } as unknown as Room, untaggedHint: "No tag: Nova answers." });
    expect(row(html)).toContain("flex");
    expect(row(html)).not.toContain("hidden");
    expect(html).toContain("No tag: Nova answers.");
  });

  test("nothing to say at any width: no row at all", () => {
    expect(row(draw({ writable: false }))).toBeNull();
  });
});

/**
 * Enter in the message box (`commons/lib/enter-sends.ts`): with a keyboard it sends and Shift+Enter is a new line;
 * where the pointer is a finger it is a new line, since a phone's keyboard has no Shift to hold with it and the
 * message went out half written.
 */

import { describe, expect, test } from "bun:test";
import type { ComposerProps } from "@/commons/components/chat/Composer";
import { enterSends } from "@/commons/lib/enter-sends";
import { dom, useMountHarness } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

describe("whether Enter sends", () => {
  test("with a keyboard: Enter sends, Shift+Enter and any other key do not", () => {
    expect(enterSends({ key: "Enter", shiftKey: false }, false)).toBe(true);
    expect(enterSends({ key: "Enter", shiftKey: true }, false)).toBe(false);
    expect(enterSends({ key: "a", shiftKey: false }, false)).toBe(false);
  });

  test("where the pointer is a finger: Enter never sends", () => {
    expect(enterSends({ key: "Enter", shiftKey: false }, true)).toBe(false);
    expect(enterSends({ key: "Enter", shiftKey: true }, true)).toBe(false);
  });
});

describe("the message box", () => {
  const menu = { matches: [], active: 0, setActive: () => {}, pick: () => {}, close: () => {}, onTyped: () => {} };

  async function pressEnter(coarse: boolean): Promise<{ sent: number; prevented: boolean }> {
    const was = dom.window.matchMedia;
    (dom.window as unknown as { matchMedia: (query: string) => { matches: boolean } }).matchMedia = (query) => ({ ...was.call(dom.window, query), matches: query === "(pointer: coarse)" ? coarse : false });
    let sent = 0;
    // Brought in here, once the page is there: React reads the document as it loads.
    const { createElement, createRef } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { Composer } = await import("@/commons/components/chat/Composer");
    const host = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.appendChild(host as never);
    const root = createRoot(host);
    root.render(
      createElement(Composer, {
        input: "baris satu",
        setInput: () => {},
        submit: () => void (sent += 1),
        canSend: true,
        writable: true,
        busy: false,
        textareaRef: createRef<HTMLTextAreaElement>(),
        room: null,
        agentName: "Nova",
        slash: { ...menu, open: false, toggle: () => {} },
        mention: { ...menu, index: 0 },
        attachments: { files: [], add: () => {}, remove: () => {}, uploading: false },
        conversation: { error: null, session: undefined, stop: () => {} } as unknown as ComposerProps["conversation"],
      }),
    );
    try {
      await eventually(() => host.querySelector("textarea") !== null, 2_000, "the message box");
      const key = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      host.querySelector("textarea")!.dispatchEvent(key as never);
      return { sent, prevented: key.defaultPrevented };
    } finally {
      root.unmount();
      host.remove();
      (dom.window as unknown as { matchMedia: typeof was }).matchMedia = was;
    }
  }

  test("with a keyboard, Enter sends the message and writes no new line", async () => {
    expect(await pressEnter(false)).toEqual({ sent: 1, prevented: true });
  });

  test("on a phone, Enter is left to the box, which makes it a new line, and nothing is sent", async () => {
    expect(await pressEnter(true)).toEqual({ sent: 0, prevented: false });
  });
});

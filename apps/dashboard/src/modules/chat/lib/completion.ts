/**
 * Arrow, Escape, Tab, Enter — once, for both completion menus.
 *
 * The composer has two: `/` commands and `@` mentions. The keyboard handling for them was written
 * twice, eighty-five lines apart, identical apart from which state it moved and which pick function
 * it called — and they had already drifted in the one place it is visible: the slash menu starts with
 * nothing highlighted so that typing `/status` and pressing Enter still *sends* it, while the mention
 * menu starts on row 0 because `@no` is not an address and there is nothing to protect.
 *
 * That difference is real and stays. It is a parameter (`startAt`), not a second copy of the code.
 *
 * Pure and DOM-free: it takes the key and returns what should happen, so the whole thing is testable
 * without a browser. The component does the moving.
 */

/** Which key was pressed, as much as this needs to know about it. */
export interface CompletionKey {
  key: string;
  shiftKey?: boolean;
}

/**
 * What the composer should do about it.
 *
 * `null` means "not ours" — the key belongs to the textarea, and the caller carries on to its own
 * handling. Everything else is handled here and the caller stops.
 */
export type CompletionAction =
  | { kind: "move"; to: number }
  | { kind: "pick"; index: number }
  | { kind: "dismiss" }
  | null;

/**
 * Where the highlight starts, which is the one thing the two menus disagree about.
 *
 * `-1` — nothing highlighted, so Enter falls through and sends the text as typed. Right for
 * commands, which are meaningful exactly as written.
 *
 * `0` — the first row is live, so Enter completes. Right for mentions, because a half-typed `@no`
 * reaches nobody and every chat app completes it.
 */
export type CompletionStart = -1 | 0;

export function completionKey(input: {
  event: CompletionKey;
  /** How many rows the menu is showing. Zero means it is closed and nothing here applies. */
  count: number;
  /** The currently highlighted row. */
  active: number;
  startAt: CompletionStart;
}): CompletionAction {
  const { event, count, active, startAt } = input;
  if (count === 0) return null;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = active + step;
    // Wrapping, both ways: a list of four reached by holding one arrow should not stop at an end.
    return { kind: "move", to: next < 0 ? count - 1 : next >= count ? 0 : next };
  }

  if (event.key === "Escape") return { kind: "dismiss" };

  // Tab completes the top match — the shell habit, and the reason Tab is not left to the textarea.
  if (event.key === "Tab") return { kind: "pick", index: active >= 0 ? active : 0 };

  if (event.key === "Enter" && !event.shiftKey) {
    /**
     * Enter picks only where the menu says it should.
     *
     * With `startAt: -1` and nothing moved to, this returns `null` and the keystroke goes on to
     * send the message — which is the whole reason the slash menu starts unhighlighted. With
     * `startAt: 0` there is always a row, so Enter always completes.
     */
    if (active < 0 && startAt === -1) return null;
    return { kind: "pick", index: active >= 0 ? active : 0 };
  }

  return null;
}

/**
 * The message box as tall as its text, measured without anything around it moving (`lib/fit-textarea.ts`).
 *
 * Its text's height is read from the box collapsed to one line. For that moment the conversation above it had that
 * much more room and stretched into it; the browser pulled the conversation's scroll position back to fit; and when the
 * box came back at the height it already had, nothing put the conversation at its end again. On a phone, a letter typed
 * on the fourth line of a message left the newest answer three lines under the box, and a new line put it back.
 */

import { describe, expect, test } from "bun:test";
import { fitTextarea } from "@/commons/lib/fit-textarea";

/** A text box in what holds it, as far as fitting reads and writes them: what each was when the text's height was read. */
function composer(options: { text: number; holder?: number; held?: string }) {
  const read: { box: string; holder: string | null }[] = [];
  const holder = options.holder === undefined ? null : { style: { minHeight: options.held ?? "" }, offsetHeight: options.holder };
  const box = {
    parentElement: holder,
    style: { height: "88px" },
    get scrollHeight() {
      read.push({ box: this.style.height, holder: holder ? holder.style.minHeight : null });
      return options.text;
    },
  };
  return { box: box as unknown as HTMLTextAreaElement, holder, read };
}

describe("fitting the message box to its text", () => {
  test("while the text is measured, what holds the box keeps the height it had", () => {
    const { box, holder, read } = composer({ text: 88, holder: 106 });
    fitTextarea(box);
    // Collapsed to read its text, and the row around it as tall as before: the conversation above has no more room.
    expect(read).toEqual([{ box: "auto", holder: "106px" }]);
    expect(box.style.height).toBe("88px");
    expect(holder!.style.minHeight).toBe("");
  });

  test("the box ends as tall as its text, up to seven lines; a height its holder was given is given back", () => {
    const short = composer({ text: 40, holder: 58, held: "58px" });
    fitTextarea(short.box);
    expect(short.box.style.height).toBe("40px");
    expect(short.holder!.style.minHeight).toBe("58px");

    const long = composer({ text: 400, holder: 178 });
    fitTextarea(long.box);
    expect(long.box.style.height).toBe("160px");
  });

  test("a box nothing holds is fitted all the same", () => {
    const { box, read } = composer({ text: 62 });
    fitTextarea(box);
    expect(read).toEqual([{ box: "auto", holder: null }]);
    expect(box.style.height).toBe("62px");
  });
});

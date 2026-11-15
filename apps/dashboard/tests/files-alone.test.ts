/**
 * A message of files alone in the dashboard's chat. Reported with a screenshot: files sent with no words drew a bubble
 * reading "nix:" under them, and half a minute later the page said "Nouride took the message, but no agent started on
 * it" over an answer the agent had already given. The first was the daemon's (the agent's name kept as the words,
 * `tests/pipeline/files-alone.test.ts` in the engine); what is held here is the page's half: a turn of files alone has
 * no words to draw, and it is known as the turn of the message just sent.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatTurn, TurnAttachment } from "@nouride/wire";
import { answersSent, filesWords, wordsOf } from "@/commons/lib/turn-display";

const picture = (direction: TurnAttachment["direction"] = "in"): TurnAttachment => ({ name: "quiz.png", mimeType: "image/png", kind: "image", direction });
const turn = (prompt: string, attachments?: TurnAttachment[]): Pick<ChatTurn, "prompt" | "attachments"> => ({ prompt, ...(attachments ? { attachments } : {}) });

describe("what a person wrote in a message of files alone", () => {
  test("is nothing: the daemon's stand-in for its words is not drawn under the files", () => {
    expect(wordsOf(turn("(attachment)", [picture()]))).toBe("");
    // Words that came with files are the words.
    expect(wordsOf(turn("look at this", [picture()]))).toBe("look at this");
    // With no file to draw, the stand-in is all there is to say a message came: it stays.
    expect(wordsOf(turn("(attachment)"))).toBe("(attachment)");
    // A file the agent sent back is not what the person sent.
    expect(wordsOf(turn("(attachment)", [picture("out")]))).toBe("(attachment)");
  });

  test("the stand-in is the one the daemon writes", () => {
    const daemon = readFileSync(join(import.meta.dir, "../../engine/src/modules/pipeline/turn-state.ts"), "utf8");
    expect(daemon).toContain('prompt: text.trim() || "(attachment)",');
  });
});

describe("the turn of a message just sent", () => {
  test("is known by its words, and for files alone by its having none", () => {
    // Words: the turn that holds them, whatever came with them.
    expect(answersSent(turn("look at this", [picture()]), { text: " look at this ", files: 1 })).toBe(true);
    expect(answersSent(turn("something else"), { text: "look at this", files: 0 })).toBe(false);
    // Files alone: the turn of files alone. It was matched by "3 file(s)", which no turn ever holds.
    expect(answersSent(turn("(attachment)", [picture()]), { text: "", files: 3 })).toBe(true);
    // Not the turn before it, which had words.
    expect(answersSent(turn("an earlier question", [picture()]), { text: "", files: 3 })).toBe(false);
    expect(answersSent(turn("an earlier question"), { text: "", files: 3 })).toBe(false);
    // Nothing was sent: no turn is its turn.
    expect(answersSent(turn("(attachment)", [picture()]), { text: "", files: 0 })).toBe(false);
  });

  test("what stands in for files alone until then says how many, as a person would", () => {
    expect([filesWords(1), filesWords(3)]).toEqual(["1 file", "3 files"]);
  });
});

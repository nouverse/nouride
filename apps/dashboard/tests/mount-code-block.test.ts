/**
 * A block of code in an agent's reply: coloured once the highlighter is here, and copied with a press.
 *
 * It was a grey box with no way to copy it but selecting it by hand. Mounted in a conversation, where a finished
 * answer holds three blocks: one in a language, one in a language nobody knows, and one that names none.
 */

import { describe, expect, test } from "bun:test";
import { answer, renderPage, useMountHarness, WIRE } from "./mount-harness.ts";
import { eventually } from "./wait.ts";

useMountHarness();

const COMMAND = 'for i in $(seq 1 3); do echo "run <$i> & wait"; done';
const REPLY = ["Run this:", "", "```bash", COMMAND, "```", "", "It prints:", "", "```output", "run <1> & wait", "```", "", "```", "const plain = 1;", "```"].join("\n");

async function blocksOf(reply: string, then?: (host: HTMLElement, blocks: () => HTMLElement[]) => Promise<void>) {
  const transcript = WIRE["/sessions/ses_1/turns"] as { turns: Record<string, unknown>[] } & Record<string, unknown>;
  answer({
    "/sessions/ses_1/turns": { status: 200, body: { ...transcript, turns: [{ ...transcript.turns[0], reply }] } },
    "/sessions/ses_1/live": { status: 200, body: { turn: null, jobs: [] } },
  });
  const seen: { label: string; text: string; coloured: string[]; words: Record<string, string>; button: string }[] = [];
  await renderPage("/chat/ses_1", async (host) => {
    const blocks = () => [...host.querySelectorAll<HTMLElement>("pre")].map((pre) => pre.parentElement!);
    await eventually(() => blocks().length === 3, 3_000, "the three blocks");
    await then?.(host, blocks);
    for (const block of blocks()) {
      seen.push({
        label: block.firstElementChild!.querySelector("span")?.textContent ?? "",
        text: block.querySelector("code")!.textContent ?? "",
        coloured: [...block.querySelectorAll("code span")].map((span) => span.className),
        words: Object.fromEntries([...block.querySelectorAll("code span")].map((span) => [span.textContent ?? "", span.className])),
        button: block.querySelector("button")?.textContent?.trim() ?? "",
      });
    }
  });
  return seen;
}

describe("a block of code in a reply", () => {
  test("in a language, its words are coloured once the highlighter is here, and they are still the code", async () => {
    const [bash] = await blocksOf(REPLY, async (_host, blocks) => {
      await eventually(() => blocks()[0]!.querySelectorAll("code span").length > 0, 5_000, "the colours");
    });
    expect(bash!.label).toBe("bash");
    expect(bash!.text).toBe(COMMAND);
    // Each word in the theme's own colour for what it is: a keyword, a command the shell has, a string.
    expect(bash!.words.for).toBe("text-secondary");
    expect(bash!.words.echo).toBe("text-secondary");
    expect(Object.entries(bash!.words).find(([text]) => text.startsWith('"run'))?.[1]).toBe("text-success");
  });

  test("in a language nobody knows, or in none, it is the plain text it was: nothing is guessed", async () => {
    const [, output, bare] = await blocksOf(REPLY, async (_host, blocks) => {
      // The first block's colours have come: the highlighter is here, and has left these two alone.
      await eventually(() => blocks()[0]!.querySelectorAll("code span").length > 0, 5_000, "the colours");
    });
    expect(output).toMatchObject({ label: "output", text: "run <1> & wait", coloured: [] });
    expect(bare).toMatchObject({ label: "", text: "const plain = 1;", coloured: [] });
  });

  test("every block has a button that copies its code as written, and says so", async () => {
    const copied: string[] = [];
    const seen = await blocksOf(REPLY, async (host, blocks) => {
      const view = host.ownerDocument.defaultView as unknown as { isSecureContext: boolean; navigator: { clipboard?: unknown } };
      Object.defineProperty(view, "isSecureContext", { value: true, configurable: true });
      Object.defineProperty(view.navigator, "clipboard", { value: { writeText: async (text: string) => void copied.push(text) }, configurable: true });
      for (const block of blocks()) block.querySelector("button")!.click();
      await eventually(() => blocks().every((block) => block.querySelector("button")!.textContent?.trim() === "Copied"), 2_000, "copied");
    });
    expect(copied).toEqual([COMMAND, "run <1> & wait", "const plain = 1;"]);
    expect(seen.map((block) => block.button)).toEqual(["Copied", "Copied", "Copied"]);
  });

  test("a block still being written is the same box, not coloured yet", async () => {
    const transcript = WIRE["/sessions/ses_1/turns"] as { turns: Record<string, unknown>[] } & Record<string, unknown>;
    // A whole block first, then one whose fence has not closed: the answer as it stands partway through.
    const partway = ["```bash", "echo done", "```", "", "Writing:", "", "```bash", COMMAND].join("\n");
    answer({
      "/sessions/ses_1/turns": { status: 200, body: { ...transcript, turns: [{ ...transcript.turns[0], reply: partway }] } },
      "/sessions/ses_1/live": { status: 200, body: { turn: null, jobs: [] } },
    });
    let box = { label: "", text: "", spans: 0, button: "" };
    await renderPage("/chat/ses_1", async (host) => {
      const blocks = () => [...host.querySelectorAll<HTMLElement>("pre")].map((pre) => pre.parentElement!);
      await eventually(() => blocks().length === 2, 3_000, "both blocks");
      // The whole block's colours have come, so the highlighter is here: the open one is plain because it is open.
      await eventually(() => blocks()[0]!.querySelectorAll("code span").length > 0, 5_000, "the whole block's colours");
      const open = blocks()[1]!;
      box = { label: open.firstElementChild!.querySelector("span")?.textContent ?? "", text: open.querySelector("code")!.textContent ?? "", spans: open.querySelectorAll("code span").length, button: open.querySelector("button")?.textContent?.trim() ?? "" };
    });
    expect(box).toEqual({ label: "bash", text: COMMAND, spans: 0, button: "Copy" });
  });
});

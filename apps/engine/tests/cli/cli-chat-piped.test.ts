/**
 * `nouride chat` driven by a script: each piped line is one message, sent once the one before it is answered.
 *
 * A script's lines arrive together, while its first message is still being answered. Readline handed them to nobody
 * and closed, so the chat sent the first line and ended — a two-message end-to-end run quietly sent one — and a last
 * line with no newline left it waiting for good.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const engine = join(import.meta.dir, "..", "..");

/** `chat` in a fresh process with `script` on its stdin, against a daemon that takes a while over each answer. */
function chatWith(script: string): { sent: string[] | null; opened: string[]; ended: boolean; stdout: string } {
  const body = `
    import { chat } from "@/cli/commands/chat.ts";
    const sent = [];
    const opened = [];
    let push = () => {};
    let seq = 0;
    const row = (turnId, kind, data) => push("id: " + (++seq) + "\\ndata: " + JSON.stringify({ seq, at: Date.now(), turnId, agentId: "a", gatewayId: "web:dashboard", chatId: "x", kind, data }) + "\\n\\n");
    const client = {
      baseUrl: "http://127.0.0.1:0",
      get: async () => ({ agents: [{ id: "a", enabled: true, state: "running" }] }),
      softGet: async () => ({ pending: [] }),
      // The conversation's event stream: what each turn thought, and — the moment that turn's rows land — its end.
      open: async (path) => {
        opened.push(path);
        const encoder = new TextEncoder();
        return new ReadableStream({ start(controller) { push = (text) => controller.enqueue(encoder.encode(text)); } });
      },
      post: async (path, body) => {
        sent.push(body.text);
        const turn = "turn_" + sent.length;
        row(turn, "turn", { phase: "start", prompt: body.text });
        row(turn, "reasoning", { step: 1, text: "thinking about " + body.text });
        await new Promise((r) => setTimeout(r, 150));
        // The end lands after the answer did, as a stream frame can: still drawn above the answer.
        setTimeout(() => row(turn, "turn", { phase: "end", status: "done" }), 50);
        return { replies: ["heard: " + body.text], answered: true };
      },
    };
    await chat(client, ["a"]);
    console.log("SENT " + JSON.stringify(sent));
    console.log("OPENED " + JSON.stringify(opened));
  `;
  const run = spawnSync(process.execPath, ["-e", body], { cwd: engine, input: script, timeout: 10_000, encoding: "utf8" });
  const line = /SENT (\[.*\])$/m.exec(run.stdout)?.[1];
  const opened = /OPENED (\[.*\])$/m.exec(run.stdout)?.[1];
  return { sent: line ? (JSON.parse(line) as string[]) : null, opened: opened ? (JSON.parse(opened) as string[]) : [], ended: run.status === 0 && run.signal === null, stdout: run.stdout };
}

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

describe("nouride chat with a script on stdin", () => {
  // Each runs the CLI to its end: three to four seconds on CI, so each has a timeout of its own, the suite's.
  test("every line is sent, in order, each after the last was answered", () => {
    const run = chatWith("one\ntwo\nthree\n");
    expect(run.ended).toBe(true);
    expect(run.sent).toEqual(["one", "two", "three"]);
  }, 30_000);

  test("a last line with no newline is sent, and the chat still ends", () => {
    const run = chatWith("one\ntwo");
    expect(run.ended).toBe(true);
    expect(run.sent).toEqual(["one", "two"]);
  }, 30_000);

  test("/quit ends it: nothing after it is sent", () => {
    const run = chatWith("one\n/quit\ntwo\n");
    expect(run.ended).toBe(true);
    expect(run.sent).toEqual(["one"]);
  }, 30_000);

  test("the transcript reads as the conversation went: each line, what its turn did, its answer", () => {
    const out = plain(chatWith("one\ntwo\n").stdout);
    // A turn shorter than the feed's one-second tick: what it did is drawn once it is answered, above the answer —
    // not under the next prompt, and not lost.
    const order = ["you › one", "thinking about one", "heard: one", "you › two", "thinking about two", "heard: two"].map((text) =>
      out.indexOf(text),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 30_000);

  test("progress is this conversation's stream — its chat on the dashboard's connection, from now, with the thinking frames", () => {
    const run = chatWith("one\n");
    expect(run.opened).toHaveLength(1);
    const asked = new URL(`http://cli${run.opened[0]}`);
    expect(asked.pathname).toBe("/events/stream");
    expect(Object.fromEntries(asked.searchParams)).toEqual({ chat: expect.stringMatching(/^cli-\d+$/), gateway: "web:dashboard", frames: "1", tail: "1" });
  }, 30_000);
});

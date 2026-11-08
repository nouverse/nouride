/**
 * Each step `nouride chat` draws is one line of the screen. A reasoning row carries the model's own line breaks; drawn
 * as they came, the lines after the first had no mark (0.7.11's end-to-end run: a numbered list's "1." and "2." sat
 * bare between the `│` lines).
 */

import { describe, expect, test } from "bun:test";
import { followChat, type FollowedLine } from "@/cli/chat-follow.ts";
import { eventually } from "../wait.ts";

describe("a step as one line", () => {
  test("a reasoning row with line breaks is drawn as one line", async () => {
    const row = {
      seq: 7, at: 0, turnId: "turn_1", agentId: "e2e", gatewayId: "web:dashboard", chatId: "cli-1",
      kind: "reasoning", data: { step: 1, text: "Plan:\n1. read\n2. answer" },
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`retry: 3000\n\nid: ${row.seq}\ndata: ${JSON.stringify(row)}\n\n`));
      },
    });
    const drawn: FollowedLine[] = [];
    const follower = followChat({
      open: async () => body,
      gatewayId: "web:dashboard",
      chatId: "cli-1",
      draw: (line) => drawn.push(line),
      drawing: () => true,
      notice: () => {},
    });
    await eventually(() => drawn.length > 0, 2_000, "the reasoning row drawn");
    follower.stop();
    expect(drawn[0]).toEqual({ kind: "reasoning", text: "Plan: 1. read 2. answer" });
  });
});

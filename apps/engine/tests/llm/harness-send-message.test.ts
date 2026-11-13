/**
 * `send_message`'s line: how an agent sees the chats it can reach.
 *
 * Found on a live install. The list came back only in the refusal of a `to` that named no chat, and the line said so
 * ("when it names nothing you can reach … the answer lists them"). Agents on two different models then made a
 * recipient up to get it: `to: "list"` with `text: "test"`, in a chat and at the start of a scheduled job's run. Each
 * was a failed step on the person's page, and a message waiting for the chat that would one day carry that name. The
 * list has a call of its own (no `to`), and the line names that one and rules the made-up recipient out.
 */

import { describe, expect, test } from "bun:test";
import { renderTools } from "@/modules/llm/prompt/harness-tools.ts";

const harness = (toolNames: string[]) =>
  renderTools({ ctx: { harness: { maxToolIterations: 8, approvalAvailable: true } }, toolNames, gated: [], free: toolNames } as never).join("\n");

describe("send_message's line", () => {
  test("says the call for the list, and that a made-up `to` is not it", () => {
    const line = harness(["send_message"]).split("\n").find((one) => one.includes("`send_message`")) ?? "";
    expect(line).toContain("With no `to` it lists the chats you can reach and sends nothing: never make up a `to` to see them.");
    expect(line).toContain("For a person with more than one chat, the answer lists theirs.");
    // The words that taught the made-up recipient.
    expect(line).not.toContain("when it names nothing you can reach");
  });

  test("is there only for an agent that holds the tool", () => {
    expect(harness(["read"])).not.toContain("`send_message`");
  });
});

/**
 * Several files sent into a conversation as one set (`send_file` with `paths`): one message to the gateway that says
 * its files belong together, so a platform with albums shows them as one. A single file is the message it always was.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { ToolContext } from "@nouride/shared";
import { FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

const slide = (filename: string, caption?: string) => ({ type: "image" as const, buffer: new Uint8Array([1, 2]), mimeType: "image/png", filename, size: 2, ...(caption ? { caption } : {}) });

describe("files sent into a conversation", () => {
  test("several are one message whose files are one set, in order; one is a message with no such mark", async () => {
    const telegram = new FakeGateway("telegram:main", "telegram");
    bench = await pipelineBench({ turns: [], gateway: telegram });
    const ctx = { agentId: "nouva", gatewayId: telegram.id, chatId: "chat-1", senderId: "op" } as ToolContext;

    const several = await bench.pipeline.sendAttachment(ctx, [slide("s1.png", "Tiga langkah"), slide("s2.png"), slide("s3.png")]);
    expect(several.delivered).toBe(true);
    const one = await bench.pipeline.sendAttachment(ctx, slide("alone.png"));
    expect(one.delivered).toBe(true);

    expect(telegram.sent.map((msg) => ({ files: (msg.attachments ?? []).map((file) => file.filename), together: msg.together, text: msg.text }))).toEqual([
      { files: ["s1.png", "s2.png", "s3.png"], together: true, text: "" },
      { files: ["alone.png"], together: undefined, text: "" },
    ]);
    expect(telegram.sent[0]!.attachments![0]!.caption).toBe("Tiga langkah");
  });
});

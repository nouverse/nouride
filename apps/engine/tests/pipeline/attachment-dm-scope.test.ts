/**
 * #12: a file a person sends one of our bots stays in that bot's conversation.
 *
 * Two agents, each with a Telegram bot of its own — `telegram:agent-a` and `telegram:agent-b` — and one person in a DM
 * with each. On Telegram a DM's chat id is the person's own id, so both conversations have the same chat id, and each
 * bot numbers its DMs itself. The file index matched a lookup on the platform and the chat alone, so agent B was
 * offered, carried into its prompt and could open the photo the person had sent agent A.
 *
 * Driven through the pipeline as a platform drives it — two connections, the real index and attachment store — because
 * the leak was three paths at once: the window of files posted before a message, the message a reply quotes, and
 * `attachment_read`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Gateway, MessageEnvelope, ToolContext } from "@nouride/shared";
import { ChatAttachmentIndex } from "@/modules/attachments/chat-attachments.store.ts";
import { AttachmentStore } from "@/modules/attachments/store.ts";
import { envelope, FakeGateway } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

/** The person: their Telegram id, which is also the chat id of their DM with each of our bots. */
const PERSON = "5550001111";
/** Enough of a PNG for the intake's byte sniff to take it for one. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
/** What the turn says when it carries pictures in from earlier in the conversation (`turn.ts`). */
const CARRIED = "from earlier in this conversation";

async function twoBots() {
  const a = new FakeGateway("telegram:agent-a", "telegram");
  const b = new FakeGateway("telegram:agent-b", "telegram");
  for (const bot of [a, b]) (bot as Gateway).fetchAttachment = async () => PNG;
  bench = await pipelineBench({
    turns: [{ text: "A cat." }, { text: "Which picture?" }, { text: "Still the cat." }],
    agents: ["nouva", "nero"],
    config: {
      gateways: {
        telegram: {
          "agent-a": { enabled: true, token: "t-a", agent: "nouva" },
          "agent-b": { enabled: true, token: "t-b", agent: "nero" },
        },
      },
    },
    gateways: [a, b],
    deps: ({ db, dataDir }) => ({
      attachmentIndex: new ChatAttachmentIndex(db),
      attachments: new AttachmentStore({ rootDir: join(dataDir, "attachments"), maxBytes: 1_000_000 }),
    }),
  });
  const { pipeline, requests } = bench;
  pipeline.setTools(new Map());
  pipeline.attach();

  /** One message from the person, in their DM with one bot. */
  const dm = async (bot: FakeGateway, over: Partial<MessageEnvelope>) => {
    bot.receive(envelope({ gatewayId: bot.id, chatId: PERSON, chatType: "dm", senderId: PERSON, timestamp: Date.now(), ...over }));
    await pipeline.idle();
  };
  /** What `attachment_read` is scoped to in a turn on `bot`'s DM. */
  const ctxOn = (bot: FakeGateway, agentId: string) =>
    ({ agentId, gateway: "telegram", gatewayId: bot.id, chatId: PERSON, chatType: "dm", senderId: PERSON }) as ToolContext;
  return { a, b, pipeline, requests, dm, ctxOn };
}

/** The photo, as the person's message 5 to agent A's bot. */
const photoToA = {
  id: "5",
  text: "lihat ini",
  attachments: [{ type: "image" as const, mimeType: "image/png", filename: "for-agent-a.png", url: "https://files.test/a.png" }],
};

describe("two of our bots in a DM with the same person (#12)", () => {
  test("what the person sent one is not carried into the other's prompt, whatever the other's message points at", async () => {
    const h = await twoBots();
    await h.dm(h.a, photoToA);
    expect(h.requests).toHaveLength(1);
    // Agent A was given its photo.
    expect(JSON.stringify(h.requests[0])).toContain("for-agent-a.png");

    // A moment later, to agent B: a message in the window the photo arrived in, replying to B's own message 5 — the
    // same id the photo had on A's bot.
    await h.dm(h.b, { id: "6", text: "kamu lihat gambarnya?", replyTo: "5" });

    expect(h.requests).toHaveLength(2);
    const toB = JSON.stringify(h.requests[1]);
    expect(toB).not.toContain(CARRIED);
    expect(toB).not.toContain("for-agent-a.png");
  });

  test("the other's attachment_read neither lists it nor opens it by its ref", async () => {
    const h = await twoBots();
    await h.dm(h.a, photoToA);

    const reader = h.pipeline.attachmentReader()!;
    const onA = reader.list(h.ctxOn(h.a, "nouva"), 10);
    expect(onA.map((file) => file.name)).toEqual(["for-agent-a.png"]);
    // Stored by A's intake, so a leak would have handed B the bytes, not only the name.
    expect(onA[0]?.localPath).toBeDefined();

    expect(reader.list(h.ctxOn(h.b, "nero"), 10)).toEqual([]);
    expect(reader.find(h.ctxOn(h.b, "nero"), onA[0]!.ref)).toBeNull();
  });

  test("the same bot's own follow-up still brings the photo in", async () => {
    // The fix narrows a DM to its connection; it must not lose the photo for the conversation it was sent in.
    const h = await twoBots();
    await h.dm(h.a, photoToA);
    await h.dm(h.a, { id: "6", text: "warnanya apa?", replyTo: "5" });

    expect(h.requests).toHaveLength(2);
    expect(JSON.stringify(h.requests[1])).toContain(CARRIED);
  });
});

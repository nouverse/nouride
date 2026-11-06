/**
 * A credential a person sends in chat is taken out as the message arrives (`modules/pipeline/chat-secrets.ts`): a
 * handle in its place in everything the daemon keeps, shows or sends to a model, the value in memory only, and the
 * person told by the daemon. Proved where it matters — the database file and its WAL, the log lines, every request the
 * provider was sent and every message the platform was handed — through the pipeline boot builds.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TransientSecrets } from "@nouride/secrets";
import { addLogSink, type MessageEnvelope } from "@nouride/shared";
import { ChatEventStore } from "@/modules/chat-events/chat-events.store.ts";
import { RoomMessageStore } from "@/modules/chat-events/room-messages.store.ts";
import { ChatSecrets } from "@/modules/pipeline/chat-secrets.ts";
import { secretScope } from "@/modules/tools/held-secrets.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { EDIT_WINDOW_MS } from "@/modules/pipeline/edit-rules.ts";
import { composeQuestion, secretsNote } from "@/modules/pipeline/messages.ts";
import { messagesToTranscript } from "@/modules/turns/transcript.ts";
import { envelope, eventually, FakeGateway, type scriptedOpenAI } from "../helpers.ts";
import { pipelineBench } from "../pipeline-bench.ts";

/** A GitHub token's shape, made here rather than written out — a scanner reads the source too. */
const TOKEN = `ghp_${"Zq9xW2vB7nM4kL8p".repeat(3).slice(0, 36)}`;
const HANDLE = /\$TMP_SECRET_[0-9A-F]{12}/;

const logged: string[] = [];
let logging = false;
addLogSink((entry) => {
  if (logging) logged.push(JSON.stringify(entry));
});

const cleanup: (() => void)[] = [];
afterEach(() => {
  logging = false;
  logged.length = 0;
  for (const fn of cleanup.splice(0).reverse()) fn();
});

async function bench(turns: Parameters<typeof scriptedOpenAI>[0], o: { chatType?: MessageEnvelope["chatType"]; access?: Record<string, unknown> } = {}) {
  const gateway = new FakeGateway("telegram:nouva");
  const held = new TransientSecrets();
  let chatEvents: ChatEventStore | undefined;
  let roomMessages: RoomMessageStore | undefined;
  const made = await pipelineBench({
    turns,
    maxAttempts: 1,
    gateway,
    ...(o.access ? { config: { security: { access: o.access } } } : {}),
    deps: (built) => {
      chatEvents = new ChatEventStore(built.db);
      roomMessages = new RoomMessageStore(built.db);
      return { heldSecrets: held, chatEvents, roomMessages };
    },
  });
  cleanup.push(made.dispose);
  made.pipeline.attach();
  const base = { gatewayId: "telegram:nouva", chatId: "814", chatType: o.chatType ?? "dm", senderId: "u1", senderName: "Gading" } as const;
  const say = (id: string, text: string, over: Partial<MessageEnvelope> = {}) => gateway.receive(envelope({ ...base, id, text, timestamp: Date.now(), ...over }));
  /** Everything this install wrote to disk: the database and its write-ahead log. */
  const disk = () => ["test.db", "test.db-wal"].map((file) => { try { return readFileSync(join(made.dataDir, file), "latin1"); } catch { return ""; } }).join("");
  return {
    ...made,
    gateway,
    held,
    say,
    disk,
    events: () => chatEvents!.forChat("telegram:nouva", "814"),
    room: () => roomMessages!.forChat("telegram:nouva", "814"),
    prompts: () => made.turns.forChat("telegram:nouva", "814").map((turn) => turn.prompt),
    sent: () => JSON.stringify(made.requests.map((request) => request.messages)),
    told: () => gateway.sent.map((message) => message.text),
  };
}

describe("a credential sent in a one-to-one chat", () => {
  test("never reaches the model, the database, a log line or the platform — a handle does, and the person is told", async () => {
    logging = true;
    const b = await bench([{ text: "on it" }]);
    b.say("m1", `deploy pakai token ${TOKEN} ya`);
    await b.pipeline.idle();
    logging = false;

    const handle = b.prompts()[0]?.match(HANDLE)?.[0];
    expect(handle).toBeDefined();
    // The turn's record keeps what the person wrote, the handle in its place, and nothing said to the model about it.
    expect(b.prompts()).toEqual([`deploy pakai token ${handle} ya`]);
    // The model reads the handle, and what it is and how to use it.
    expect(b.sent()).toContain(handle!);
    expect(b.sent()).toContain("took a credential out of the message below");
    // What the box run found the model needs told: the handle is the value in a command, and saving it is the
    // person's call — given "the hour" alone, an agent saved every token it was sent, over one already stored.
    expect(b.sent()).toContain("In an exec command the handle is the credential");
    expect(b.sent()).toContain("only if the person asks you to");
    expect(b.sent()).toContain("a GitHub token");
    // The daemon holds the value for this conversation, and only this one.
    expect(b.held.get(handle!, secretScope({ gatewayId: "telegram:nouva", chatId: "814" }))?.value).toBe(TOKEN);
    expect(b.held.get(handle!, secretScope({ gatewayId: "telegram:nouva", chatId: "999" }))).toBeUndefined();
    // Told, by the daemon: in the chat, and on the dashboard's timeline.
    const notice = b.told().find((text) => text.startsWith("🔒"));
    expect(notice).toContain(handle!);
    expect(notice).toContain("/secret undo");
    expect(b.events().map((event) => [event.kind, event.details?.handles])).toEqual([["secret", [handle]]]);

    // And nowhere it could be read back from.
    expect(b.sent()).not.toContain(TOKEN);
    expect(b.told().join("\n")).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);
    expect(logged.length).toBeGreaterThan(0);
    expect(b.disk()).not.toContain(TOKEN);
    expect(b.disk()).toContain(handle!);
  });

  test("sent again, it is the same handle, and the person is not told twice", async () => {
    const b = await bench([{ text: "ok" }, { text: "ok again" }]);
    b.say("m1", `token: ${TOKEN}`);
    await b.pipeline.idle();
    b.say("m2", `pakai ${TOKEN} lagi`);
    await b.pipeline.idle();

    const [first, second] = b.prompts().map((prompt) => prompt.match(HANDLE)?.[0]);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(b.told().filter((text) => text.startsWith("🔒"))).toHaveLength(1);
    // The model is still told what the handle in the second message is.
    expect(JSON.stringify(b.requests[1]?.messages.at(-1))).toContain("a GitHub token");
  });

  test("a sender the daemon does not let in is not told — and what they sent is not kept either", async () => {
    const b = await bench([{ text: "never" }], { access: { mode: "pair" } });
    b.say("m1", `here is my key ${TOKEN}`, { senderId: "stranger" });
    await b.pipeline.idle();

    expect(b.told().some((text) => text.startsWith("🔒"))).toBe(false);
    expect(b.requests).toHaveLength(0);
    expect(b.disk()).not.toContain(TOKEN);
  });
});

describe("on the dashboard", () => {
  test("a message a credential was taken from is drawn once — the model's note sits in front of the person's words", () => {
    // Found on the box: the note went after the words, so the conversation's stored copy no longer ended with the
    // turn's prompt, the cut missed, and the message showed twice — once with the note to the model in it.
    const handle = "$TMP_SECRET_6474EDF740A0";
    const prompt = `deploy pakai token ${handle} ya`;
    const stored = composeQuestion({ text: prompt, overheard: "", hasAttachments: false, secrets: secretsNote([{ handle, label: "a GitHub token" }]) });
    expect(stored.endsWith(prompt)).toBe(true);
    expect(messagesToTranscript([{ role: "user", content: stored, timestamp: 1 }], { before: 2, prompt })).toEqual([]);
  });
});

describe("in a room", () => {
  test("the room's own record of what was said keeps the handle", async () => {
    const b = await bench([{ text: "ok" }], { chatType: "group" });
    b.say("m1", `@nouva the deploy token is ${TOKEN}`, { mentions: ["nouva"] });
    await b.pipeline.idle();

    const [said] = b.room();
    expect(said?.text).toMatch(HANDLE);
    expect(said?.text).not.toContain(TOKEN);
    expect(b.disk()).not.toContain(TOKEN);
  });
});

describe("what a person quotes, and what they edit", () => {
  test("a credential in the message a reply quotes is taken out of the quote", async () => {
    const b = await bench([{ text: "ok" }]);
    b.say("m2", "pakai yang ini", { quotedText: `token baru: ${TOKEN}`, replyTo: "m1" });
    await b.pipeline.idle();

    expect(b.sent()).not.toContain(TOKEN);
    expect(b.sent()).toMatch(HANDLE);
    expect(b.disk()).not.toContain(TOKEN);
  });

  test("a credential written into an edit is taken out of the edit, and the person is told", async () => {
    const b = await bench([{ text: "ok" }, { text: "ok, with the token" }]);
    b.say("m1", "deploy it");
    await b.pipeline.idle();
    b.gateway.receive(
      envelope({ gatewayId: "telegram:nouva", chatId: "814", chatType: "dm", senderId: "u1", senderName: "Gading", id: "m1:edited", text: `deploy it with ${TOKEN}`, timestamp: Date.now(), edit: { of: "m1", sentAt: Date.now() } }),
    );
    await eventually(() => b.requests.length === 2, 4_000, "the edit answered");
    await b.pipeline.idle();

    expect(b.sent()).not.toContain(TOKEN);
    expect(b.told().some((text) => text.startsWith("🔒"))).toBe(true);
    expect(b.disk()).not.toContain(TOKEN);
  });
});

describe("ChatSecrets", () => {
  const from = (text: string, over: Partial<MessageEnvelope> = {}) => envelope({ gatewayId: "telegram:nouva", chatId: "814", senderId: "u1", text, ...over });

  test("leaves what a bot, the daemon or a put-back message says as it is", () => {
    const secrets = new ChatSecrets(new TransientSecrets());
    for (const message of [from(TOKEN, { senderIsBot: true }), from(TOKEN, { senderId: SYSTEM_SENDER }), from(TOKEN, { asWritten: true })]) {
      expect(secrets.take(message)).toEqual([]);
      expect(message.text).toBe(TOKEN);
    }
  });

  test("`/secret set` keeps what follows the name whatever it looks like — says nothing of it, and is not put back", () => {
    const secrets = new ChatSecrets(new TransientSecrets());
    const message = from("/secret set wifi_kantor rumah123");
    // Nothing to tell: the command's own reply says what happened to the value.
    expect(secrets.take(message)).toEqual([]);
    const handle = message.text.match(/\$TMP_SECRET_[0-9A-F]{12}/)?.[0];
    expect(message.text).toBe(`/secret set wifi_kantor ${handle}`);
    expect(secrets.held.get(handle!, secretScope(message))?.value).toBe("rumah123");
    expect(secrets.putBack(message)).toBeNull();
  });

  test("/secret undo: the message as written, as an edit of itself — its handle let go — and only while an edit is answered", () => {
    let now = 1_000_000;
    const secrets = new ChatSecrets(new TransientSecrets({ now: () => now }), () => now);
    const message = from(`deploy with ${TOKEN}`, { id: "m7", timestamp: now, raw: { original: true } });
    const [taken] = secrets.take(message);
    expect(message.raw).toBeNull();

    const back = secrets.putBack({ gatewayId: "telegram:nouva", chatId: "814", senderId: "u1" });
    expect(back).toMatchObject({ id: "m7:as-written", text: `deploy with ${TOKEN}`, edit: { of: "m7", sentAt: 1_000_000 }, asWritten: true, raw: null });
    expect(back?.secrets).toBeUndefined();
    expect(secrets.held.get(taken!.handle, secretScope(message))).toBeUndefined();
    // Once: there is nothing left to put back.
    expect(secrets.putBack({ gatewayId: "telegram:nouva", chatId: "814", senderId: "u1" })).toBeNull();

    // Past the window an edit is answered in, there is no putting one back.
    secrets.take(from(`again ${TOKEN}`, { id: "m8", timestamp: now }));
    now += EDIT_WINDOW_MS;
    expect(secrets.putBack({ gatewayId: "telegram:nouva", chatId: "814", senderId: "u1" })).toBeNull();
  });

  test("only the person who sent it can put it back, and by handle", () => {
    const secrets = new ChatSecrets(new TransientSecrets());
    const first = secrets.take(from(`one ${TOKEN}`, { id: "a" }))[0]!;
    secrets.take(from(`two ${TOKEN.replace("ghp_Z", "ghp_Y")}`, { id: "b" }));
    expect(secrets.putBack({ gatewayId: "telegram:nouva", chatId: "814", senderId: "someone-else" })).toBeNull();
    expect(secrets.putBack({ gatewayId: "telegram:nouva", chatId: "814", senderId: "u1" }, first.handle)?.id).toBe("a:as-written");
  });
});

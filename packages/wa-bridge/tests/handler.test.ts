/**
 * The engine's commands, carried out against a stand-in for the connection — `src/handler.ts`.
 *
 * Only the shutdown path was ever reached before, through the engine's in-process lifecycle test. Every command is
 * driven here through `handleLine`, the way the host feeds it, with the events read back off `io`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as io from "../src/io.ts";
import { BridgeExit } from "../src/io.ts";
import { Handler, withTimeout, type Link, type Sock } from "../src/handler.ts";
import { BRIDGE_PROTOCOL_VERSION, type BridgeEvent } from "../src/protocol.ts";

const CHAT = "100000000000001@lid";

let events: BridgeEvent[];
let exits: number[];
let detach: () => void;
let dir: string;

beforeEach(() => {
  events = [];
  exits = [];
  detach = io.attach({ write: (line) => events.push(JSON.parse(line) as BridgeEvent), exit: (code) => exits.push(code) });
  dir = mkdtempSync(join(tmpdir(), "wa-handler-"));
});
afterEach(() => {
  detach();
  rmSync(dir, { recursive: true, force: true });
});

/** A connection that records what was asked of it. */
function fakeLink(options: { linked?: boolean; socket?: boolean; fail?: Error } = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const record = (op: string) => async (...args: unknown[]) => {
    calls.push({ op, args });
    if (options.fail) throw options.fail;
    return { key: { id: `sent-${calls.length}` } };
  };
  const sock = {
    sendMessage: record("sendMessage"),
    sendPresenceUpdate: record("sendPresenceUpdate"),
    readMessages: record("readMessages"),
  } as unknown as Sock;
  const link: Link = {
    currentSocket: () => (options.socket === false ? null : sock),
    isLinked: () => options.linked ?? true,
    start: async (sessionDir, key) => void calls.push({ op: "start", args: [sessionDir, key] }),
    stop: () => void calls.push({ op: "stop", args: [] }),
    logout: async () => void calls.push({ op: "logout", args: [] }),
    phoneForLid: () => "628111111111@s.whatsapp.net",
  };
  return { link, calls };
}

const hello = (sessionDir = dir) => JSON.stringify({ type: "hello", version: BRIDGE_PROTOCOL_VERSION, sessionDir });

async function helloed(options?: Parameters<typeof fakeLink>[0]) {
  const fake = fakeLink(options);
  const handler = new Handler(fake.link, { sessionDir: "", sessionKey: "k".repeat(64) });
  await handler.handleLine(hello());
  return { ...fake, handler };
}

describe("hello", () => {
  test("starts the connection with the engine's directory and the key it was configured with", async () => {
    const { link, calls } = fakeLink();
    const handler = new Handler(link, { sessionDir: "/from/env", sessionKey: "" });
    handler.configure({ encryptionKey: "secret-key" });
    await handler.handleLine(hello("/from/engine"));
    expect(calls).toEqual([{ op: "start", args: ["/from/engine", "secret-key"] }]);
  });

  test("the environment's directory when the engine sends none", async () => {
    const { link, calls } = fakeLink();
    await new Handler(link, { sessionDir: "/from/env", sessionKey: "k" }).handleLine(hello(""));
    expect(calls[0]?.args[0]).toBe("/from/env");
  });

  test("another protocol version is refused and the bridge stops", async () => {
    const { link, calls } = fakeLink();
    const line = JSON.stringify({ type: "hello", version: BRIDGE_PROTOCOL_VERSION + 1, sessionDir: dir });
    await expect(new Handler(link, { sessionDir: "", sessionKey: "k" }).handleLine(line)).rejects.toBeInstanceOf(BridgeExit);
    expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("protocol version mismatch") });
    expect(exits).toEqual([1]);
    expect(calls).toEqual([]);
  });

  test("no key: refused rather than writing an unencrypted session", async () => {
    const { link, calls } = fakeLink();
    await expect(new Handler(link, { sessionDir: "", sessionKey: "" }).handleLine(hello())).rejects.toBeInstanceOf(BridgeExit);
    expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("refusing to write an unencrypted session") });
    expect(calls).toEqual([]);
  });

  test("a start that throws is said as disconnected, and the bridge carries on", async () => {
    const { link } = fakeLink();
    link.start = async () => {
      throw new Error("no network");
    };
    await new Handler(link, { sessionDir: "", sessionKey: "k" }).handleLine(hello());
    expect(events).toEqual([{ type: "status", status: "disconnected", reason: "Error: no network" }]);
    expect(exits).toEqual([]);
  });
});

describe("before a hello, and before the link", () => {
  test("a command before hello is refused", async () => {
    const { link, calls } = fakeLink();
    await new Handler(link, { sessionDir: "", sessionKey: "k" }).handleLine(JSON.stringify({ type: "typing", chatId: CHAT }));
    expect(events).toEqual([{ type: "error", message: "no hello received" }]);
    expect(calls).toEqual([]);
  });

  test("a socket that has not signed in says so, with the command's id", async () => {
    const { handler } = await helloed({ linked: false });
    await handler.handleLine(JSON.stringify({ type: "send", id: "c1", chatId: CHAT, text: "hi" }));
    expect(events).toEqual([{ type: "error", id: "c1", message: "not linked yet: this number has not finished signing in to WhatsApp" }]);
  });

  test("no socket at all is a different message", async () => {
    const { handler } = await helloed({ socket: false });
    await handler.handleLine(JSON.stringify({ type: "send", id: "c2", chatId: CHAT, text: "hi" }));
    expect(events.at(-1)).toEqual({ type: "error", id: "c2", message: "not connected to WhatsApp" });
  });

  test("a line that is not JSON is answered, not thrown", async () => {
    const { handler } = await helloed();
    await handler.handleLine("{not json");
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("malformed command") });
    await handler.handleLine("   ");
    expect(events).toHaveLength(1);
  });
});

describe("send", () => {
  test("to the address it arrived on, mentions resolved and cleaned, then the typing bubble cleared and acked", async () => {
    const { handler, calls } = await helloed();
    await handler.handleLine(JSON.stringify({ type: "send", id: "c1", chatId: CHAT, text: "cc @628123456789 ya" }));
    const sends = calls.filter((c) => c.op === "sendMessage");
    expect(sends).toEqual([
      { op: "sendMessage", args: [CHAT, { text: "cc @628123456789 ya", mentions: ["628123456789@s.whatsapp.net"] }] },
    ]);
    expect(calls.find((c) => c.op === "sendPresenceUpdate")?.args).toEqual(["paused", CHAT]);
    expect(events).toEqual([{ type: "ack", id: "c1" }]);
  });

  test("a reply past WhatsApp's limit goes in pieces, in order, with one ack", async () => {
    const { handler, calls } = await helloed();
    const text = `${"a".repeat(4000)}\n\n${"b".repeat(200)}`;
    await handler.handleLine(JSON.stringify({ type: "send", id: "long", chatId: CHAT, text }));
    const texts = calls.filter((c) => c.op === "sendMessage").map((c) => (c.args[1] as { text: string }).text);
    expect(texts).toEqual(["a".repeat(4000), "b".repeat(200)]);
    expect(events).toEqual([{ type: "ack", id: "long" }]);
  });

  test("a send that fails is an error for that command, not an ack", async () => {
    const { handler } = await helloed({ fail: new Error("socket closed") });
    await handler.handleLine(JSON.stringify({ type: "send", id: "c9", chatId: CHAT, text: "hi" }));
    expect(events).toEqual([{ type: "error", id: "c9", message: "Error: socket closed" }]);
  });
});

describe("send_media", () => {
  const file = (name: string) => {
    const path = join(dir, name);
    writeFileSync(path, "bytes");
    return path;
  };
  const sentPayload = async (command: Record<string, unknown>) => {
    const { handler, calls } = await helloed();
    await handler.handleLine(JSON.stringify({ type: "send_media", id: "m1", chatId: CHAT, ...command }));
    expect(events).toEqual([{ type: "ack", id: "m1" }]);
    return calls.find((c) => c.op === "sendMessage")!.args[1] as Record<string, unknown>;
  };

  test("an image with its caption", async () => {
    const payload = await sentPayload({ path: file("a.png"), mimeType: "image/png", caption: "look" });
    expect(Object.keys(payload).sort()).toEqual(["caption", "image"]);
    expect(payload.caption).toBe("look");
  });

  test("a voice note is push-to-talk, and the same audio without `voice` is not", async () => {
    expect(await sentPayload({ path: file("v.ogg"), mimeType: "audio/ogg", voice: true })).toMatchObject({ mimetype: "audio/ogg", ptt: true });
    events.length = 0;
    expect(await sentPayload({ path: file("v.ogg"), mimeType: "audio/ogg" })).not.toHaveProperty("ptt");
  });

  test("anything else is a document named after its file", async () => {
    const payload = await sentPayload({ path: file("report.pdf"), mimeType: "application/pdf", caption: "@628123456789 here" });
    expect(payload).toMatchObject({ mimetype: "application/pdf", fileName: "report.pdf", mentions: ["628123456789@s.whatsapp.net"] });
  });
});

describe("read, typing, logout, shutdown", () => {
  test("read marks the one message, with its group participant", async () => {
    const { handler, calls } = await helloed();
    await handler.handleLine(JSON.stringify({ type: "read", chatId: CHAT, messageId: "M1", participant: "p@lid" }));
    expect(calls.at(-1)).toEqual({ op: "readMessages", args: [[{ remoteJid: CHAT, id: "M1", fromMe: false, participant: "p@lid" }]] });
  });

  test("typing is composing, to the chat", async () => {
    const { handler, calls } = await helloed();
    await handler.handleLine(JSON.stringify({ type: "typing", chatId: CHAT }));
    expect(calls.at(-1)).toEqual({ op: "sendPresenceUpdate", args: ["composing", CHAT] });
  });

  test("logout unlinks and says the session is gone", async () => {
    const { handler, calls } = await helloed();
    await handler.handleLine(JSON.stringify({ type: "logout" }));
    expect(calls.at(-1)?.op).toBe("logout");
    expect(events).toEqual([{ type: "session_expired" }]);
  });

  test("shutdown drops the connection and ends the bridge", async () => {
    const { handler, calls } = await helloed();
    await expect(handler.handleLine(JSON.stringify({ type: "shutdown" }))).rejects.toBeInstanceOf(BridgeExit);
    expect(calls.at(-1)?.op).toBe("stop");
    expect(exits).toEqual([0]);
  });
});

describe("withTimeout", () => {
  test("a send that never settles fails, naming what timed out", async () => {
    await expect(withTimeout(new Promise(() => {}), "sendMessage", 20)).rejects.toThrow("sendMessage timed out after 0.02s");
  });

  test("one that settles is its own answer", async () => {
    expect(await withTimeout(Promise.resolve("ok"), "sendMessage", 1_000)).toBe("ok");
  });
});

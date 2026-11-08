/**
 * The WhatsApp adapter's decisions one by one, against a fake bridge — written for a mutation sweep of
 * the untested areas, where each of these was a line no test noticed going wrong: what a status or an
 * error from the bridge does to the connection, what an outgoing attachment becomes, what a stop or a logout leaves
 * behind, and which refusal walls a chat off.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Attachment, BridgeCommand, BridgeEvent, GatewayEvent, MessageEnvelope, OutboundMessage } from "@nouride/shared";
import { BRIDGE_PROTOCOL_VERSION } from "@nouride/shared";
import { maskedNumber, WhatsAppGateway, type BridgeChannel } from "../src/channels/whatsapp/gateway.ts";
import { eventually } from "./wait.ts";

function fakeChannel(options: { refuse?: (command: BridgeCommand) => boolean } = {}) {
  const written: BridgeCommand[] = [];
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const finish = () => {
    done = true;
    wake?.();
    markClosed();
  };
  const channel: BridgeChannel = {
    writeLine: (line) => {
      const command = JSON.parse(line) as BridgeCommand;
      if (options.refuse?.(command)) throw new Error(`pipe closed (${command.type})`);
      written.push(command);
    },
    async *lines() {
      while (!done || queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
    close: finish,
    closed,
  };
  const pushLine = (line: string) => {
    queue.push(line);
    const fn = wake;
    wake = null;
    fn?.();
  };
  return { channel, written, push: (event: BridgeEvent) => pushLine(JSON.stringify(event)), pushLine, end: finish };
}

interface Inner {
  deliver(msg: OutboundMessage): Promise<string[]>;
  request(build: (id: string) => BridgeCommand): Promise<string>;
  ping(): Promise<boolean>;
  pending: Map<string, unknown>;
}

const READY: BridgeEvent = { type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "628999@s.whatsapp.net" };
const CHAT = "628123@s.whatsapp.net";
/** A message from a person — pushed after another line, its envelope says the line before it has been handled. */
const MESSAGE: BridgeEvent = { type: "message", id: "m1", chatId: CHAT, chatType: "dm", senderId: CHAT, senderName: "A", text: "halo", timestamp: 1 };

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

/** A started gateway on one fake bridge, linked unless told otherwise. */
async function connected(options: { linked?: boolean; refuse?: (command: BridgeCommand) => boolean; channels?: ReturnType<typeof fakeChannel>[] } = {}) {
  const channels = options.channels ?? [];
  const gateway = new WhatsAppGateway({
    id: "whatsapp:main",
    platform: "whatsapp",
    sessionDir: "/tmp/wa-session",
    encryptionKey: "a".repeat(64),
    agentId: "nouva",
    resilience: { reconnectBackoffMs: 3_600_000, reconnectBackoffMaxMs: 3_600_000, healthCheckIntervalMs: 3_600_000 },
    openChannel: () => {
      const fake = fakeChannel(options.refuse ? { refuse: options.refuse } : {});
      channels.push(fake);
      return fake.channel;
    },
  });
  const events: GatewayEvent[] = [];
  const envelopes: MessageEnvelope[] = [];
  gateway.onEvent((event) => events.push(event));
  gateway.onMessage((envelope) => envelopes.push(envelope));
  await gateway.start();
  cleanup.push(() => gateway.stop());
  const fake = channels.at(-1)!;
  if (options.linked !== false) {
    fake.push(READY);
    await eventually(() => gateway.isLinked(), 2_000, "the bridge to link");
  }
  return { gateway, fake, channels, events, envelopes, inner: gateway as unknown as Inner };
}

const statusErrors = (events: GatewayEvent[]) => events.flatMap((e) => (e.type === "status" && e.error ? [e.error] : []));

/** Acknowledge every command the fake was sent that has an id, as they arrive. */
function ackAll(fake: ReturnType<typeof fakeChannel>): () => void {
  const acked = new Set<string>();
  const timer = setInterval(() => {
    for (const command of fake.written) {
      if ("id" in command && !acked.has(command.id)) {
        acked.add(command.id);
        fake.push({ type: "ack", id: command.id });
      }
    }
  }, 1);
  return () => clearInterval(timer);
}

describe("the connection", () => {
  test("before it starts there is no bridge, and the health check says so", async () => {
    const gateway = new WhatsAppGateway({ id: "whatsapp:main", platform: "whatsapp", sessionDir: "/tmp/x", encryptionKey: "a", openChannel: () => fakeChannel().channel });
    expect(await (gateway as unknown as Inner).ping()).toBe(false);
    expect(gateway.progressStyle).toBe("summary");
  });

  test("a bridge that exits is a reconnect, said as such, and what was waiting is failed with why", async () => {
    const { gateway, fake, events, inner } = await connected();
    const waiting = inner.request((id) => ({ type: "send", id, chatId: CHAT, text: "x" }));
    fake.end();
    await expect(waiting).rejects.toThrow("the bridge process exited");
    await eventually(() => gateway.status === "reconnecting", 2_000, "the exit to reconnect");
    expect(statusErrors(events)).toContain("bridge exited");
    expect(inner.pending.size).toBe(0);
  });

  test("the previous bridge closing after a reconnect does not tear down the new one", async () => {
    const channels: ReturnType<typeof fakeChannel>[] = [];
    const { gateway, events } = await connected({ channels });
    await gateway.start();
    // The gateway has seen the old bridge close before we do: its handler on `closed` was attached at the first connect.
    await channels[0]!.channel.closed;
    expect(channels).toHaveLength(2);
    expect(gateway.status).toBe("connected");
    expect(statusErrors(events)).not.toContain("bridge exited");
  });

  test("logging out while it waits to reconnect stops it — it does not come back", async () => {
    const { gateway, fake } = await connected();
    fake.end();
    await eventually(() => gateway.status === "reconnecting", 2_000, "the exit to reconnect");
    expect(await gateway.logoutAndStop()).toEqual({ loggedOut: false, reason: "the bridge was not running" });
    expect(gateway.status).toBe("disconnected");
  });

  test("stopping tells the bridge to shut down, fails what was waiting, and lets go of the bridge", async () => {
    const { gateway, fake, inner } = await connected();
    const waiting = inner.request((id) => ({ type: "send", id, chatId: CHAT, text: "x" }));
    await gateway.stop();
    await expect(waiting).rejects.toThrow("the gateway is shutting down");
    expect(fake.written.at(-1)).toEqual({ type: "shutdown" });
    await gateway.setTyping(CHAT);
    expect(fake.written.at(-1)).toEqual({ type: "shutdown" });
    await expect(inner.deliver({ gatewayId: "whatsapp:main", chatId: CHAT, text: "x" })).rejects.toThrow("the WhatsApp bridge is not connected");
  });

  test("a bridge speaking another protocol version is a reconnect, not a link", async () => {
    const { gateway, fake, events } = await connected({ linked: false });
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION + 1, jid: "x@s.whatsapp.net" });
    await eventually(() => gateway.status === "reconnecting", 2_000, "the mismatch to reconnect");
    expect(gateway.isLinked()).toBe(false);
    expect(statusErrors(events)).toContain("protocol version mismatch");
  });

  test("WhatsApp dropping the connection unlinks and reconnects; the bridge trying again unlinks and is left to it", async () => {
    const { gateway, fake, events, envelopes } = await connected();
    // The bridge's own retry: no longer linked — a send waits for the link — but nothing above restarts it.
    fake.push({ type: "status", status: "connecting" });
    fake.push(MESSAGE);
    await eventually(() => envelopes.length === 1, 2_000, "the message after the status");
    expect(gateway.isLinked()).toBe(false);
    expect(gateway.status).toBe("connected");
    fake.push(READY);
    await eventually(() => gateway.isLinked(), 2_000, "the link back");

    fake.push({ type: "status", status: "disconnected", reason: "stream errored" });
    await eventually(() => gateway.status === "reconnecting", 2_000, "the drop to reconnect");
    expect(gateway.isLinked()).toBe(false);
    expect(statusErrors(events)).toContain("stream errored");
  });

  test("a drop before anything was ever linked is still reconnected", async () => {
    const { gateway, fake } = await connected({ linked: false });
    fake.push({ type: "status", status: "disconnected", reason: "x" });
    await eventually(() => gateway.status === "reconnecting", 2_000, "the drop to reconnect");
  });

  test("an expired session is dead and announced", async () => {
    const { gateway, fake, events } = await connected();
    fake.push({ type: "session_expired" });
    await eventually(() => gateway.status === "dead", 2_000, "the expiry to end it");
    expect(events.some((e) => e.type === "session_expired")).toBe(true);
  });

  test("relinked after expiring, a drop is a reconnect again", async () => {
    const { gateway, fake } = await connected();
    fake.push({ type: "session_expired" });
    fake.push(READY);
    fake.push({ type: "status", status: "disconnected", reason: "x" });
    await eventually(() => gateway.status === "reconnecting", 2_000, "the drop to reconnect");
  });

  test("a fresh bridge after an expiry is not still expired", async () => {
    const channels: ReturnType<typeof fakeChannel>[] = [];
    const { gateway } = await connected({ channels });
    channels.at(-1)!.push({ type: "session_expired" });
    await eventually(() => gateway.status === "dead", 2_000, "the expiry to end it");
    await gateway.start();
    channels.at(-1)!.push({ type: "status", status: "disconnected", reason: "x" });
    await eventually(() => gateway.status === "reconnecting", 2_000, "the new bridge's drop to reconnect");
  });

  test("a line that is not JSON, an ack nobody waits for and an error for nobody leave the read loop running", async () => {
    const { fake, envelopes } = await connected();
    fake.pushLine("not json");
    fake.push({ type: "ack", id: "c999" });
    fake.push({ type: "error", id: "c998", message: "x" });
    fake.push({ type: "message", id: "m1", chatId: CHAT, chatType: "dm", senderId: CHAT, senderName: "", text: "halo", timestamp: 1 });
    await eventually(() => envelopes.length > 0, 2_000, "the message after them");
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.senderName).toBe("unknown");
  });
});

describe("requests and their acks", () => {
  test("two sends in flight have their own ids, and each ack settles only its own", async () => {
    const { fake, inner } = await connected();
    const first = inner.request((id) => ({ type: "send", id, chatId: CHAT, text: "a" }));
    const second = inner.request((id) => ({ type: "send", id, chatId: CHAT, text: "b" }));
    const ids = fake.written.flatMap((c) => ("id" in c ? [c.id] : []));
    expect(new Set(ids).size).toBe(2);
    fake.push({ type: "ack", id: ids[1]! });
    fake.push({ type: "error", id: ids[0]!, message: "not on whatsapp" });
    expect(await second).toBe(ids[1]!);
    await expect(first).rejects.toThrow("not on whatsapp");
    expect(inner.pending.size).toBe(0);
  });

  test("a command the bridge cannot be written is failed at once and forgotten", async () => {
    const { inner } = await connected({ refuse: (command) => command.type === "send" });
    await expect(inner.request((id) => ({ type: "send", id, chatId: CHAT, text: "a" }))).rejects.toThrow("pipe closed (send)");
    expect(inner.pending.size).toBe(0);
  });

  test("a command never acknowledged is failed after the ack timeout and forgotten", async () => {
    const { inner } = await connected();
    const realSetTimeout = globalThis.setTimeout;
    const quick = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
      realSetTimeout(fn, ms === 30_000 ? 0 : ms)) as typeof setTimeout);
    try {
      await expect(inner.request((id) => ({ type: "send", id, chatId: CHAT, text: "a" }))).rejects.toThrow("did not acknowledge within 30000ms");
    } finally {
      quick.mockRestore();
    }
    expect(inner.pending.size).toBe(0);
  });

  test("a send that waits for a link that never comes is failed after the link wait", async () => {
    const { inner } = await connected({ linked: false });
    const realSetTimeout = globalThis.setTimeout;
    const quick = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) =>
      realSetTimeout(fn, ms === 20_000 ? 0 : ms)) as typeof setTimeout);
    let outcome: Promise<unknown>;
    try {
      outcome = inner.deliver({ gatewayId: "whatsapp:main", chatId: CHAT, text: "x" });
      await expect(outcome).rejects.toThrow("the WhatsApp number has not finished linking");
    } finally {
      quick.mockRestore();
    }
    expect((inner as unknown as { linkWaiters: unknown[] }).linkWaiters).toEqual([]);
  });

  test("a bridge that dies as it acknowledges the first of two parts settles the send at once, not at the ack timeout", async () => {
    const { fake, inner } = await connected();
    const sending = inner.deliver({
      gatewayId: "whatsapp:main",
      chatId: CHAT,
      text: "first",
      attachments: [{ type: "file", url: "/tmp/nouride-wa-part-two.txt", mimeType: "text/plain" }],
    });
    await eventually(() => fake.written.some((c) => c.type === "send"), 2_000, "the first part to be sent");
    const first = fake.written.find((c) => c.type === "send") as { id: string };
    fake.push({ type: "ack", id: first.id });
    fake.end();
    const outcome = await Promise.race([
      sending.then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    expect(outcome).toBe("rejected");
  });
});

describe("what goes to the bridge", () => {
  test("a text with nobody to tag carries no mentions field", async () => {
    const { fake, inner } = await connected();
    const stop = ackAll(fake);
    cleanup.push(stop);
    await inner.deliver({ gatewayId: "whatsapp:main", chatId: CHAT, text: "hai", mentions: ["628777@s.whatsapp.net"] });
    expect(fake.written.find((c) => c.type === "send")).toEqual({ type: "send", id: expect.any(String), chatId: CHAT, text: "hai" });
  });

  test("a local file goes as itself; a voice note says so; an unnamed type is octet-stream", async () => {
    const { fake, inner } = await connected();
    const stop = ackAll(fake);
    cleanup.push(stop);
    await inner.deliver({
      gatewayId: "whatsapp:main",
      chatId: CHAT,
      text: "",
      attachments: [
        { type: "voice", url: "/tmp/v.ogg", mimeType: "audio/ogg" },
        { type: "file", url: "/tmp/blob" } as Attachment,
      ],
    });
    const media = fake.written.filter((c) => c.type === "send_media");
    expect(media).toEqual([
      { type: "send_media", id: expect.any(String), chatId: CHAT, path: "/tmp/v.ogg", mimeType: "audio/ogg", voice: true },
      { type: "send_media", id: expect.any(String), chatId: CHAT, path: "/tmp/blob", mimeType: "application/octet-stream" },
    ]);
  });

  test("a remote URL is never handed over as a path — and with no buffer behind it, nothing is sent", async () => {
    const { fake, inner } = await connected();
    const stop = ackAll(fake);
    cleanup.push(stop);
    await inner.deliver({ gatewayId: "whatsapp:main", chatId: CHAT, text: "", attachments: [{ type: "image", url: "HTTPS://example.com/x.jpg", mimeType: "image/jpeg" }, { type: "file", mimeType: "text/plain" }] });
    expect(fake.written.filter((c) => c.type === "send_media")).toEqual([]);
  });

  test("a buffer is written to a temp file named after it, or `file` when it has no name", async () => {
    const { fake, inner } = await connected();
    const stop = ackAll(fake);
    cleanup.push(stop);
    await inner.deliver({ gatewayId: "whatsapp:main", chatId: CHAT, text: "", attachments: [{ type: "file", buffer: new Uint8Array([104, 105]), mimeType: "text/plain" }] });
    const media = fake.written.find((c) => c.type === "send_media") as { path: string };
    cleanup.push(() => rmSync(media.path, { force: true }));
    expect(media.path.endsWith("_file")).toBe(true);
    expect(existsSync(media.path) && readFileSync(media.path, "utf8")).toBe("hi");
  });

  test("a reply of exactly WhatsApp's ceiling goes as one message; one character more as two", async () => {
    for (const [length, parts] of [[65_536, 1], [65_537, 2]] as const) {
      const { fake, inner, gateway } = await connected();
      const stop = ackAll(fake);
      await inner.deliver({ gatewayId: "whatsapp:main", chatId: CHAT, text: "a".repeat(length) });
      stop();
      expect(fake.written.filter((c) => c.type === "send")).toHaveLength(parts);
      await gateway.stop();
    }
  });

  test("typing and read receipts go to the bridge", async () => {
    const { gateway, fake } = await connected();
    await gateway.setTyping(CHAT);
    await gateway.markRead(CHAT, "m1");
    expect(fake.written.slice(-2)).toEqual([
      { type: "typing", chatId: CHAT },
      { type: "read", chatId: CHAT, messageId: "m1" },
    ]);
  });
});

describe("fetching an attachment", () => {
  test("a buffer is itself; no url is nothing; a failed or broken download is null", async () => {
    const { gateway } = await connected();
    const buffer = new Uint8Array([1]);
    expect(await gateway.fetchAttachment({ type: "file", buffer, url: "/nope", mimeType: "text/plain" })).toBe(buffer);
    expect(await gateway.fetchAttachment({ type: "file", mimeType: "text/plain" })).toBeNull();
    expect(await gateway.fetchAttachment({ type: "file", url: "/definitely/not/here.bin", mimeType: "text/plain" })).toBeNull();
    const fetched = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("no", { status: 404 })) as unknown as typeof fetch);
    try {
      expect(await gateway.fetchAttachment({ type: "file", url: "https://example.com/x", mimeType: "text/plain" })).toBeNull();
    } finally {
      fetched.mockRestore();
    }
  });
});

describe("logging out", () => {
  test("with no bridge running, it says so and stops", async () => {
    const gateway = new WhatsAppGateway({ id: "whatsapp:main", platform: "whatsapp", sessionDir: "/tmp/x", encryptionKey: "a", openChannel: () => fakeChannel().channel });
    expect(await gateway.logoutAndStop()).toEqual({ loggedOut: false, reason: "the bridge was not running" });
    expect(gateway.status).toBe("disconnected");
  });

  // Three seconds of grace, waited out: its own timeout, the suite's.
  test("asks the bridge to log out, gives it its grace period, then stops", async () => {
    const { gateway, fake } = await connected();
    const started = Date.now();
    expect(await gateway.logoutAndStop()).toEqual({ loggedOut: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(fake.written.map((c) => c.type)).toEqual(["hello", "logout", "shutdown"]);
    expect(gateway.status).toBe("disconnected");
  }, 30_000);

  test("a logout that cannot be sent still stops, and says why", async () => {
    const { gateway } = await connected({ refuse: (command) => command.type === "logout" });
    expect(await gateway.logoutAndStop()).toEqual({ loggedOut: false, reason: "Error: pipe closed (logout)" });
    expect(gateway.status).toBe("disconnected");
  });
});

describe("refusals and names", () => {
  async function refusal(code: string) {
    const { fake, events } = await connected();
    fake.push({ type: "delivery_refused", chatId: CHAT, messageId: "m1", code });
    await eventually(() => events.some((e) => e.type === "delivery_refused"), 2_000, "the refusal to be said");
    return events.find((e) => e.type === "delivery_refused") as { reason: string; terminal: boolean };
  }

  test("463 is terminal and says what to do", async () => {
    expect(await refusal("463")).toMatchObject({
      terminal: true,
      reason:
        "WhatsApp refused to deliver it: this number is restricted from starting new chats (error 463, missing privacy token). " +
        "Save the bot's number as a contact on the other phone and message it again, or wait out the restriction. " +
        "Do not retry: each attempt counts as another reach-out and makes it worse.",
    });
  });

  test("479 is a stale session, not a wall", async () => {
    expect(await refusal("479")).toMatchObject({ terminal: false, reason: "WhatsApp rejected the stanza (479): usually a stale device session. A relink fixes it." });
  });

  test("any other code is said as itself, and not a wall", async () => {
    expect(await refusal("500")).toMatchObject({ terminal: false, reason: "WhatsApp refused it with code 500." });
  });

  test("a masked number keeps four digits only when there are more than four", () => {
    expect(maskedNumber("1234@s.whatsapp.net")).toBe("…");
    expect(maskedNumber("12345@s.whatsapp.net")).toBe("…2345");
  });
});

describe("what kind an inbound file is", () => {
  test("the bridge's kind when it names one, else the mime type, else a file", async () => {
    const { fake, envelopes } = await connected();
    const cases: [string, string][] = [
      ["image", "application/x"],
      ["video", "application/x"],
      ["audio", "application/x"],
      ["sticker", "image/webp"],
      ["document", "video/mp4"],
      ["document", "audio/ogg"],
      ["document", "application/pdf"],
    ];
    for (const [index, [kind, mimeType]] of cases.entries()) {
      fake.push({ type: "message", id: `m${index}`, chatId: CHAT, chatType: "dm", senderId: CHAT, senderName: "A", text: "", timestamp: 1, media: { kind, mimeType, path: `/tmp/${index}` } } as BridgeEvent);
    }
    await eventually(() => envelopes.length === cases.length, 2_000, "every message");
    expect(envelopes.map((e) => e.attachments![0]!.type)).toEqual(["image", "video", "audio", "image", "video", "audio", "file"]);
  });
});

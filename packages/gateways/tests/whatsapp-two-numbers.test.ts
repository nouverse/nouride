/**
 * Two WhatsApp numbers in one daemon, each its own connection: `channels/whatsapp/gateway.ts`, one adapter for each.
 *
 * A daemon held one number until the bridge kept its state by connection. Each number now has an adapter of its own
 * over a bridge of its own, and what this file holds is that nothing of one is the other's: the code to scan, the
 * link, the messages and the name they arrive under, a logout, a bridge that dies, and what each says of its health.
 * The bridges are stand-ins that speak the protocol, as in `whatsapp.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeCommand, BridgeEvent, MessageEnvelope } from "@nouride/shared";
import { BRIDGE_PROTOCOL_VERSION } from "@nouride/shared";
import { WhatsAppGateway, type BridgeChannel } from "../src/channels/whatsapp/gateway.ts";
import { eventually } from "./wait.ts";

/** A bridge that records what it was told and lets a test push events back. */
function fakeChannel() {
  const written: BridgeCommand[] = [];
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  const end = () => {
    done = true;
    wake?.();
    markClosed();
  };
  const channel: BridgeChannel = {
    writeLine: (line) => written.push(JSON.parse(line) as BridgeCommand),
    async *lines() {
      while (!done || queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    close: end,
    closed,
  };
  return {
    channel,
    written,
    end,
    push: (event: BridgeEvent) => {
      queue.push(JSON.stringify(event));
      const fn = wake;
      wake = null;
      fn?.();
    },
  };
}

const built: WhatsAppGateway[] = [];
afterEach(async () => {
  for (const gateway of built.splice(0)) await gateway.stop();
});

/** One number: its adapter, the bridge it opened, and the messages it handed up. */
async function number(name: string, agentId: string) {
  const fake = fakeChannel();
  const heard: MessageEnvelope[] = [];
  const gateway = new WhatsAppGateway({
    id: `whatsapp:${name}`,
    platform: "whatsapp",
    sessionDir: `/tmp/wa-${name}`,
    encryptionKey: (name === "shop" ? "a" : "b").repeat(64),
    agentId,
    openChannel: () => fake.channel,
  });
  built.push(gateway);
  gateway.onMessage((envelope) => heard.push(envelope));
  await gateway.start();
  await eventually(() => fake.written.some((command) => command.type === "hello"));
  const ping = (gateway as unknown as { ping(): Promise<boolean> }).ping.bind(gateway);
  return { gateway, fake, heard, ping, linkedAs: (jid: string) => fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid }) };
}

const message = (id: string, text: string): Extract<BridgeEvent, { type: "message" }> => ({
  type: "message",
  id,
  chatId: "628111@s.whatsapp.net",
  chatType: "dm",
  senderId: "628111@s.whatsapp.net",
  senderName: "Budi",
  text,
  timestamp: 1_700_000_000_000,
});

describe("each number is opened with what is its own", () => {
  test("its own folder for the login, said to its own bridge", async () => {
    const shop = await number("shop", "nora");
    const home = await number("home", "nouva");
    const hello = (of: typeof shop) => of.fake.written.find((command) => command.type === "hello");
    expect([hello(shop), hello(home)]).toEqual([
      { type: "hello", version: BRIDGE_PROTOCOL_VERSION, sessionDir: "/tmp/wa-shop" },
      { type: "hello", version: BRIDGE_PROTOCOL_VERSION, sessionDir: "/tmp/wa-home" },
    ]);
  });
});

describe("each number is paired by its own code", () => {
  test("one waits for its scan while the other is linked, and neither shows the other's code", async () => {
    const shop = await number("shop", "nora");
    const home = await number("home", "nouva");
    home.linkedAs("62811@s.whatsapp.net");
    shop.fake.push({ type: "qr", qr: "2@the-shop's-code" });
    await eventually(() => home.gateway.isLinked() && shop.gateway.pairingCode() !== null);

    expect({ code: shop.gateway.pairingCode()?.qr, linked: shop.gateway.isLinked() }).toEqual({ code: "2@the-shop's-code", linked: false });
    expect({ code: home.gateway.pairingCode(), linked: home.gateway.isLinked() }).toEqual({ code: null, linked: true });

    // The second is scanned: its code goes, and the first is as it was.
    shop.linkedAs("62822@s.whatsapp.net");
    await eventually(() => shop.gateway.isLinked());
    expect([shop.gateway.pairingCode(), home.gateway.isLinked()]).toEqual([null, true]);
  });
});

describe("a message to a number is that number's", () => {
  test("it comes up under the connection it arrived on, and the other hears nothing", async () => {
    const shop = await number("shop", "nora");
    const home = await number("home", "nouva");
    shop.linkedAs("62822@s.whatsapp.net");
    home.linkedAs("62811@s.whatsapp.net");
    // The same person writes to both numbers, with the same id on each: WhatsApp numbers a chat's messages by sender.
    shop.fake.push(message("m1", "when do you open?"));
    await eventually(() => shop.heard.length === 1);
    expect(home.heard).toEqual([]);
    home.fake.push(message("m1", "are you home?"));
    await eventually(() => home.heard.length === 1);

    expect(shop.heard.map((envelope) => [envelope.gatewayId, envelope.text])).toEqual([["whatsapp:shop", "when do you open?"]]);
    expect(home.heard.map((envelope) => [envelope.gatewayId, envelope.text])).toEqual([["whatsapp:home", "are you home?"]]);
  });

  test("an answer goes out through the number that was written to", async () => {
    const shop = await number("shop", "nora");
    const home = await number("home", "nouva");
    shop.linkedAs("62822@s.whatsapp.net");
    home.linkedAs("62811@s.whatsapp.net");
    await eventually(() => shop.gateway.isLinked() && home.gateway.isLinked());

    const sent = shop.gateway.send({ gatewayId: "whatsapp:shop", chatId: "628111@s.whatsapp.net", text: "nine to five" });
    await eventually(() => shop.fake.written.some((command) => command.type === "send"));
    const command = shop.fake.written.find((one): one is Extract<BridgeCommand, { type: "send" }> => one.type === "send")!;
    shop.fake.push({ type: "ack", id: command.id });
    await sent;
    expect(command).toMatchObject({ chatId: "628111@s.whatsapp.net", text: "nine to five" });
    expect(home.fake.written.filter((one) => one.type === "send")).toEqual([]);
  });
});

describe("the groups each number is in", () => {
  test("each says it is in the groups its own bridge named, and no other's; a one-to-one chat, or before the bridge said, is not known", async () => {
    const shop = await number("shop", "nora");
    const home = await number("home", "nouva");
    expect(shop.gateway.sees("g-shop@g.us")).toBeUndefined();
    shop.fake.push({ type: "groups", ids: ["g-shop@g.us"] });
    home.fake.push({ type: "groups", ids: ["g-family@g.us"] });
    await eventually(() => shop.gateway.sees("g-shop@g.us") === true && home.gateway.sees("g-family@g.us") === true);
    expect({ shop: ["g-shop@g.us", "g-family@g.us"].map((id) => shop.gateway.sees(id)), home: ["g-shop@g.us", "g-family@g.us"].map((id) => home.gateway.sees(id)) }).toEqual({
      shop: [true, false],
      home: [false, true],
    });
    expect(shop.gateway.sees("628111@s.whatsapp.net")).toBeUndefined();
    // Removed from its group: the bridge says the set again, and it is not in it any more.
    shop.fake.push({ type: "groups", ids: [] });
    await eventually(() => shop.gateway.sees("g-shop@g.us") === false);
  });
});

describe("a file a message carried", () => {
  test("is named and held, with what it weighs; fetched from its own number's bridge when asked, read once and removed", async () => {
    const shop = await number("shop", "nora");
    shop.linkedAs("628222@s.whatsapp.net");
    shop.fake.push({ ...message("m-photo", ""), media: { path: "", held: "m-photo-1", mimeType: "image/jpeg", kind: "image", size: 2048 } });
    await eventually(() => shop.heard.length === 1);
    const attachment = shop.heard[0]!.attachments![0]!;
    expect({ url: attachment.url, size: attachment.size }).toEqual({ url: "wa-held:m-photo-1", size: 2048 });
    // Nothing is asked of the bridge until the daemon fetches it.
    expect(shop.fake.written.filter((command) => command.type === "fetch_media")).toEqual([]);

    const saved = join(mkdtempSync(join(tmpdir(), "wa-held-")), "photo.jpg");
    writeFileSync(saved, "a photo's bytes");
    const fetching = shop.gateway.fetchAttachment(attachment);
    await eventually(() => shop.fake.written.some((command) => command.type === "fetch_media"));
    const asked = shop.fake.written.find((command) => command.type === "fetch_media") as { id: string; ref: string };
    expect(asked.ref).toBe("m-photo-1");
    shop.fake.push({ type: "media", id: asked.id, path: saved });
    expect(new TextDecoder().decode((await fetching)!)).toBe("a photo's bytes");
    // The daemon keeps its own copy: the bridge's is gone.
    expect(existsSync(saved)).toBe(false);
  });

  test("one the bridge no longer holds is none to have: null, said in the log", async () => {
    const shop = await number("shop", "nora");
    shop.linkedAs("628222@s.whatsapp.net");
    const fetching = shop.gateway.fetchAttachment({ type: "image", mimeType: "image/jpeg", url: "wa-held:gone" });
    await eventually(() => shop.fake.written.some((command) => command.type === "fetch_media"));
    const asked = shop.fake.written.find((command) => command.type === "fetch_media") as { id: string };
    shop.fake.push({ type: "error", id: asked.id, message: "that file is no longer held: ask the sender to send it again" });
    expect(await fetching).toBeNull();
  });
});

describe("a number removed", () => {
  test("logged out when it is linked; one not linked is not said to be, and its bridge is asked nothing", async () => {
    const shop = await number("shop", "nora");
    expect(await shop.gateway.logoutAndStop()).toEqual({ loggedOut: false, reason: "the number was not linked at the time, so WhatsApp was not told" });
    expect(shop.fake.written.filter((command) => command.type === "logout")).toEqual([]);
  });
});

describe("each number's own addresses", () => {
  test("its phone address once linked, its hidden one once a message says it, each without a device, and none of the other's", async () => {
    const shop = await number("shop", "nora");
    const home = await number("home", "nouva");
    expect([shop.gateway.selfId, shop.gateway.ownsAddress("628222@s.whatsapp.net")]).toEqual([undefined, false]);
    shop.linkedAs("628222:7@s.whatsapp.net");
    home.linkedAs("628111:3@s.whatsapp.net");
    await eventually(() => shop.gateway.selfId !== undefined && home.gateway.selfId !== undefined);
    expect([shop.gateway.selfId, home.gateway.selfId]).toEqual(["628222@s.whatsapp.net", "628111@s.whatsapp.net"]);
    expect(shop.gateway.ownsAddress("77665544@lid")).toBe(false);
    shop.fake.push({ ...message("m-1", "hi"), selfIds: ["628222@s.whatsapp.net", "77665544:7@lid"] });
    await eventually(() => shop.heard.length === 1);
    expect(["628222:9@s.whatsapp.net", "77665544@lid", "628111@s.whatsapp.net"].map((id) => shop.gateway.ownsAddress(id))).toEqual([true, true, false]);
    expect(home.gateway.ownsAddress("77665544@lid")).toBe(false);
  });
});

describe("one number's trouble is its own", () => {
  test("logged out from its phone: it is no longer linked, the other is, and still takes a message", async () => {
    const shop = await number("shop", "nora");
    const home = await number("home", "nouva");
    shop.linkedAs("62822@s.whatsapp.net");
    home.linkedAs("62811@s.whatsapp.net");
    await eventually(() => shop.gateway.isLinked() && home.gateway.isLinked());

    shop.fake.push({ type: "session_expired" });
    await eventually(() => !shop.gateway.isLinked());
    expect({ shop: shop.gateway.isLinked(), home: home.gateway.isLinked(), homeStatus: home.gateway.status }).toEqual({ shop: false, home: true, homeStatus: "connected" });
    expect(shop.gateway.status).not.toBe("connected");

    home.fake.push(message("m2", "still there?"));
    await eventually(() => home.heard.length === 1);
    expect(home.heard[0]?.gatewayId).toBe("whatsapp:home");
  });

  test("one that must be scanned again is not reconnected, and the other still is when its own bridge gives up", async () => {
    const shop = await number("shop", "nora");
    const home = await number("home", "nouva");
    shop.linkedAs("62822@s.whatsapp.net");
    home.linkedAs("62811@s.whatsapp.net");
    await eventually(() => shop.gateway.isLinked() && home.gateway.isLinked());

    // The bridge reports both, for one event.
    shop.fake.push({ type: "session_expired" });
    shop.fake.push({ type: "status", status: "disconnected", reason: "logged out" });
    await eventually(() => !shop.gateway.isLinked());
    expect(shop.gateway.status).not.toBe("reconnecting");

    // The other's bridge loses the network and gives up: that one is the daemon's to bring back.
    home.fake.push({ type: "status", status: "disconnected", reason: "gave up after 8 attempts" });
    await eventually(() => home.gateway.status === "reconnecting");
    expect(shop.gateway.status).not.toBe("reconnecting");
  });

  test("its bridge dies: it says it is unhealthy, the other says it is healthy and stays connected", async () => {
    const shop = await number("shop", "nora");
    const home = await number("home", "nouva");
    shop.linkedAs("62822@s.whatsapp.net");
    home.linkedAs("62811@s.whatsapp.net");
    await eventually(() => shop.gateway.isLinked() && home.gateway.isLinked());
    expect([await shop.ping(), await home.ping()]).toEqual([true, true]);

    shop.fake.end();
    await eventually(() => shop.gateway.status !== "connected");
    expect([await shop.ping(), await home.ping()]).toEqual([false, true]);
    expect({ home: home.gateway.status, linked: home.gateway.isLinked() }).toEqual({ home: "connected", linked: true });
  });

  test("WhatsApp refuses a message of one's: the refusal is that number's to report, and the other's sends go on", async () => {
    const shop = await number("shop", "nora");
    const home = await number("home", "nouva");
    shop.linkedAs("62822@s.whatsapp.net");
    home.linkedAs("62811@s.whatsapp.net");
    await eventually(() => shop.gateway.isLinked() && home.gateway.isLinked());
    const events: string[] = [];
    shop.gateway.onEvent((event) => events.push(`shop:${event.type}`));
    home.gateway.onEvent((event) => events.push(`home:${event.type}`));

    shop.fake.push({ type: "delivery_refused", chatId: "628111@s.whatsapp.net", messageId: "x1", code: "463" });
    await eventually(() => events.length > 0);
    expect(events.every((event) => event.startsWith("shop:"))).toBe(true);

    const sent = home.gateway.send({ gatewayId: "whatsapp:home", chatId: "628111@s.whatsapp.net", text: "hello" });
    await eventually(() => home.fake.written.some((command) => command.type === "send"));
    const command = home.fake.written.find((one): one is Extract<BridgeCommand, { type: "send" }> => one.type === "send")!;
    home.fake.push({ type: "ack", id: command.id });
    expect(await sent).toBeDefined();
  });
});

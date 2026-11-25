/**
 * Two WhatsApp numbers in one daemon, each its own connection: `channels/whatsapp/gateway.ts`, one adapter for each.
 *
 * A daemon held one number until the bridge kept its state by connection. Each number now has an adapter of its own
 * over a bridge of its own, and what this file holds is that nothing of one is the other's: the code to scan, the
 * link, the messages and the name they arrive under, a logout, a bridge that dies, and what each says of its health.
 * The bridges are stand-ins that speak the protocol, as in `whatsapp.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
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

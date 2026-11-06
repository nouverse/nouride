/**
 * The WhatsApp gateway as a protocol client.
 *
 * Every test here runs against a fake channel rather than a real bridge, which is the point: the
 * adapter's whole job is to speak newline-delimited JSON correctly, and that is testable without
 * Baileys, without a phone, and without the bridge's dependencies ever entering this workspace.
 *
 * The cases worth writing down are the ones that cost something when they are wrong: a QR that is
 * logged but not reachable, an ack that never resolves, and our own messages being answered.
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { BridgeCommand, BridgeEvent, MessageEnvelope } from "@nouride/shared";
import { BRIDGE_PROTOCOL_VERSION } from "@nouride/shared";
import { maskedNumber, WhatsAppGateway, type BridgeChannel } from "../src/channels/whatsapp/gateway.ts";
import { sleep } from "./wait.ts";

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

  const push = (event: BridgeEvent) => {
    queue.push(JSON.stringify(event));
    const fn = wake;
    wake = null;
    fn?.();
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
    close: () => {
      done = true;
      wake?.();
      markClosed();
    },
    closed,
  };

  return {
    channel,
    written,
    push,
    end: () => {
      done = true;
      wake?.();
      markClosed();
    },
  };
}

/**
 * Every gateway a test built, stopped after it whatever the test did. One whose bridge a test killed and never stopped
 * went on reconnecting to its dead fake — and logging it — for the rest of the run, long after this file had finished.
 */
const built: WhatsAppGateway[] = [];
afterEach(async () => {
  for (const gateway of built.splice(0)) await gateway.stop();
});

function build() {
  const fake = fakeChannel();
  const gateway = new WhatsAppGateway({
    id: "whatsapp:main",
    platform: "whatsapp",
    sessionDir: "/tmp/wa-session",
    encryptionKey: "a".repeat(64),
    agentId: "nouva",
    openChannel: () => fake.channel,
  });
  built.push(gateway);
  return { gateway, fake };
}

/**
 * A gateway whose transport is a *new* channel each time, so leaks are visible.
 *
 * `build()` reuses one fake, which is convenient and hides the bug this exists for: each open is a
 * connection to the bridge, and a connect that does not close the last one leaves it open.
 */
function buildCounting() {
  const opened: ReturnType<typeof fakeChannel>[] = [];
  const closed: boolean[] = [];

  const gateway = new WhatsAppGateway({
    id: "whatsapp:main",
    platform: "whatsapp",
    sessionDir: "/tmp/wa-session",
    encryptionKey: "a".repeat(64),
    openChannel: () => {
      const fake = fakeChannel();
      const index = opened.length;
      opened.push(fake);
      closed.push(false);
      return {
        ...fake.channel,
        close: () => {
          closed[index] = true;
          fake.channel.close();
        },
      };
    },
  });
  built.push(gateway);

  return { gateway, opened, closed };
}

/** Lets the adapter's read loop drain what the fake pushed. */
const settle = () => sleep(5);

describe("handshake", () => {
  test("says hello with the protocol version and the session directory", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();

    expect(fake.written[0]).toEqual({
      type: "hello",
      version: BRIDGE_PROTOCOL_VERSION,
      sessionDir: "/tmp/wa-session",
    });
    await gateway.stop();
  });

  test("refuses a bridge speaking a different version rather than carrying on", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();

    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION + 1, jid: "1@s.whatsapp.net" });
    await settle();

    // The two protocol files are hand-copied across a licence boundary; a drift must not be treated
    // as a working link.
    expect(gateway.isLinked()).toBe(false);
    await gateway.stop();
  });
});

describe("pairing", () => {
  test("holds the QR so something other than the log can serve it", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();

    expect(gateway.pairingCode()).toBeNull();

    fake.push({ type: "qr", qr: "2@abc/def" });
    await settle();

    // The whole reason this is state and not a log line: the person with the phone is not reading
    // journalctl.
    expect(gateway.pairingCode()?.qr).toBe("2@abc/def");
    await gateway.stop();
  });

  test("clears the QR once linked, so a stale code is never shown as current", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();

    fake.push({ type: "qr", qr: "2@abc/def" });
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "628@s.whatsapp.net" });
    await settle();

    expect(gateway.pairingCode()).toBeNull();
    expect(gateway.isLinked()).toBe(true);
    await gateway.stop();
  });

  test("an expired session drops the link and the code together", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();

    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "628@s.whatsapp.net" });
    fake.push({ type: "qr", qr: "stale" });
    fake.push({ type: "session_expired" });
    await settle();

    expect(gateway.isLinked()).toBe(false);
    expect(gateway.pairingCode()).toBeNull();
    await gateway.stop();
  });
});

describe("health", () => {
  test("an unlinked bridge is healthy — it is waiting for a human, not broken", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();

    // No `ready` yet: the QR is on screen and nobody has scanned it.
    fake.push({ type: "qr", qr: "2@waiting" });
    await settle();

    // `ping` is what the health timer calls, so that is what is asserted — the visible symptom only
    // appears three intervals later, ninety seconds after the code the person is scanning appeared.
    // Reporting unhealthy here tears the gateway down and respawns the bridge, discarding the QR.
    // Found on a live server, not here.
    const ping = (gateway as unknown as { ping(): Promise<boolean> }).ping.bind(gateway);
    expect(await ping()).toBe(true);
    expect(gateway.isLinked()).toBe(false);

    await gateway.stop();
  });

  test("a dead bridge is unhealthy, so the reconnect cycle still runs", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    const ping = (gateway as unknown as { ping(): Promise<boolean> }).ping.bind(gateway);
    expect(await ping()).toBe(true);

    fake.end();
    await settle();

    // The other half of the same rule: "unlinked is fine" must not become "nothing is ever wrong".
    expect(await ping()).toBe(false);
    await gateway.stop();
  });
});

describe("a number that was linked and dropped off", () => {
  const ready = { type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" } as const;
  const internals = (gateway: WhatsAppGateway) =>
    gateway as unknown as { ping(): Promise<boolean>; connect(): Promise<void>; outboundBuffer: unknown[] };

  test("is unhealthy once it has been down too long, so the bridge is restarted — and a new bridge gets its own grace", async () => {
    const { gateway, opened } = buildCounting();
    await gateway.start();
    await settle();
    opened[0]!.push(ready);
    await settle();
    // The internet went: the bridge is trying again, and reachable throughout.
    opened[0]!.push({ type: "status", status: "connecting", reason: "keep alive" });
    await settle();
    const now = Date.now();
    try {
      expect(gateway.isLinked()).toBe(false);
      expect(await internals(gateway).ping()).toBe(true);

      // Live, it said healthy for good while the bridge it had restarted could never connect (2026-10-21).
      setSystemTime(new Date(now + 4 * 60_000));
      expect(await internals(gateway).ping()).toBe(false);

      await internals(gateway).connect();
      await settle();
      expect(opened).toHaveLength(2);
      expect(await internals(gateway).ping()).toBe(true);
    } finally {
      setSystemTime();
    }
    await gateway.stop();
  });

  test("pairing is not that: a number never linked here stays healthy however long the code waits", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "qr", qr: "2@waiting" });
    await settle();
    try {
      setSystemTime(new Date(Date.now() + 60 * 60_000));
      expect(await internals(gateway).ping()).toBe(true);
    } finally {
      setSystemTime();
    }
    await gateway.stop();
  });

  test("a reply that failed while it was down waits for the link, and goes when the number links again", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push(ready);
    await settle();

    const sending = gateway.send({ gatewayId: "whatsapp:main", chatId: "628123@s.whatsapp.net", text: "owed" });
    await settle();
    const first = fake.written.find((cmd) => cmd.type === "send") as { id: string };
    fake.push({ type: "status", status: "connecting", reason: "keep alive" });
    fake.push({ type: "error", id: first.id, message: "not connected to WhatsApp" });
    expect(await sending).toEqual([]);
    await settle();

    // Held, not spent on a flush that would wait for the link and drop it.
    expect(internals(gateway).outboundBuffer).toHaveLength(1);

    fake.push(ready);
    await settle();
    const sends = fake.written.filter((cmd) => cmd.type === "send") as Array<{ id: string; text?: string }>;
    expect(sends).toHaveLength(2);
    expect(sends[1]?.text).toBe("owed");
    fake.push({ type: "ack", id: sends[1]!.id });
    await settle();
    expect(internals(gateway).outboundBuffer).toHaveLength(0);
    await gateway.stop();
  });
});

describe("reconnecting", () => {
  test("opening a second transport closes the first", async () => {
    const { gateway, opened, closed } = buildCounting();

    await gateway.start();
    await settle();
    expect(opened).toHaveLength(1);

    // What `BaseGateway.attemptConnect` does on every retry: `connect()` again, with no `disconnect()`
    // in between. Harmless for a client object, and a leaked process here.
    await (gateway as unknown as { connect(): Promise<void> }).connect();
    await settle();

    expect(opened).toHaveLength(2);
    // The assertion the incident was about: one live bridge, not two. Each leaked one held a WhatsApp
    // session and kept writing the credential files the next one was reading, and enough of them took
    // a 4GB box to load average 204.
    expect(closed[0]).toBe(true);
    expect(closed[1]).toBe(false);

    await gateway.stop();
  });

  test("repeated reconnects leave exactly one transport open", async () => {
    const { gateway, opened, closed } = buildCounting();
    await gateway.start();
    await settle();

    for (let i = 0; i < 5; i += 1) {
      await (gateway as unknown as { connect(): Promise<void> }).connect();
      await settle();
    }

    expect(opened).toHaveLength(6);
    expect(closed.filter((was) => !was)).toHaveLength(1);
    await gateway.stop();
  });

  test("stopping closes the last one too", async () => {
    const { gateway, closed } = buildCounting();
    await gateway.start();
    await settle();
    await gateway.stop();

    expect(closed.every((was) => was)).toBe(true);
  });
});

describe("sending before the number is linked", () => {
  test("waits for the link instead of firing into an unsigned-in socket", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();

    // Connected as far as the base class knows — the bridge process is reachable — but WhatsApp has
    // not accepted the login yet. This is the window right after a QR scan.
    const sending = gateway.send({ gatewayId: "whatsapp:main", chatId: "628123@s.whatsapp.net", text: "halo" });
    await settle();

    // Nothing has gone to the bridge: sending here threw `authState.creds.me.id is undefined` inside
    // Baileys and the reply was dropped, which is how an approved person got silence.
    expect(fake.written.some((cmd) => cmd.type === "send")).toBe(false);

    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    const sent = fake.written.find((cmd) => cmd.type === "send") as { id: string } | undefined;
    expect(sent).toBeDefined();
    fake.push({ type: "ack", id: (sent as { id: string }).id });
    expect(await sending).toHaveLength(1);

    await gateway.stop();
  });

  test("a send waiting on a link that never comes is released when the bridge dies", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();

    const sending = gateway.send({ gatewayId: "whatsapp:main", chatId: "628123@s.whatsapp.net", text: "halo" });
    await settle();
    fake.end();

    // Settles now rather than after the full link timeout. Twenty seconds of waiting on a process
    // that has already exited is twenty seconds of somebody watching an empty chat.
    const settled = await Promise.race([
      sending.then(() => "settled" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 300)),
    ]);
    expect(settled).toBe("settled");
  });
});

describe("an expired session", () => {
  test("does not reconnect into a bridge that can only show a QR", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    // The bridge reports both, for one event.
    fake.push({ type: "session_expired" });
    fake.push({ type: "status", status: "disconnected", reason: "logged out" });
    await settle();

    // `dead`, not `reconnecting`. The disconnect used to overwrite the expiry immediately, and the
    // daemon went back to respawning a bridge that had nothing to offer but a fresh QR.
    expect(gateway.status).not.toBe("reconnecting");
    expect(gateway.isLinked()).toBe(false);

    await gateway.stop();
  });
});

describe("inbound messages", () => {
  async function inbound(event: Extract<BridgeEvent, { type: "message" }>) {
    const { gateway, fake } = build();
    const seen: MessageEnvelope[] = [];
    gateway.onMessage((env) => seen.push(env));

    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    fake.push(event);
    await settle();
    await gateway.stop();
    return seen;
  }

  const BASE = {
    type: "message" as const,
    id: "m1",
    chatId: "628123@s.whatsapp.net",
    chatType: "dm" as const,
    senderId: "628123@s.whatsapp.net",
    senderName: "Gading",
    text: "halo",
    timestamp: 1_700_000_000_000,
  };

  test("normalises a DM into an envelope", async () => {
    const [envelope] = await inbound(BASE);

    expect(envelope?.gateway).toBe("whatsapp");
    expect(envelope?.gatewayId).toBe("whatsapp:main");
    expect(envelope?.chatId).toBe("628123@s.whatsapp.net");
    expect(envelope?.senderId).toBe("628123@s.whatsapp.net");
    expect(envelope?.text).toBe("halo");
  });

  test("a group message keeps the sender distinct from the chat", async () => {
    const [envelope] = await inbound({
      ...BASE,
      chatId: "1234@g.us",
      chatType: "group",
      senderId: "628999@s.whatsapp.net",
    });

    // The distinction the people table depends on: in a group these differ, and collapsing them
    // would give every member one identity.
    expect(envelope?.chatId).toBe("1234@g.us");
    expect(envelope?.senderId).toBe("628999@s.whatsapp.net");
    expect(envelope?.chatType).toBe("group");
  });

  test("a caption-less photo is still a message", async () => {
    const [envelope] = await inbound({
      ...BASE,
      text: "",
      media: { path: "/tmp/wa/x.jpg", mimeType: "image/jpeg", kind: "image" },
    });

    // Dropping it made the bot look like it ignored someone: no reply, no error.
    expect(envelope).toBeDefined();
    expect(envelope?.attachments?.[0]?.type).toBe("image");
    expect(envelope?.attachments?.[0]?.url).toBe("/tmp/wa/x.jpg");
  });

  test("a document carries the name it was sent with", async () => {
    const [envelope] = await inbound({
      ...BASE,
      text: "ini filenya",
      media: { path: "/tmp/wa/x.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "file", caption: "ini filenya", fileName: "Sampel KK 1.1.xlsx" },
    });
    expect(envelope?.attachments?.[0]?.filename).toBe("Sampel KK 1.1.xlsx");
  });

  test("fetchAttachment reads local files downloaded by wa-bridge", async () => {
    const { gateway } = build();
    const testPath = `${process.cwd()}/package.json`;
    const bytes = await gateway.fetchAttachment({ type: "image", url: testPath, mimeType: "image/png" });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect((bytes?.length ?? 0)).toBeGreaterThan(0);
  });

  test("a message with neither text nor media is dropped", async () => {
    expect(await inbound({ ...BASE, text: "   " })).toHaveLength(0);
  });

  test("a person's edit is the edit it is: its own id and time, the message it changes, what that says now (G11)", async () => {
    const [envelope] = await inbound({ ...BASE, id: "EDIT1", text: "halo, maksudnya besok", timestamp: 1_700_000_090_000, edits: "m1" });
    expect(envelope).toMatchObject({ id: "EDIT1", timestamp: 1_700_000_090_000, text: "halo, maksudnya besok", edit: { of: "m1" } });
    // WhatsApp does not say when the message was sent: the engine's own record of it does.
    expect(envelope?.edit?.sentAt).toBeUndefined();
    const [plain] = await inbound(BASE);
    expect(plain?.edit).toBeUndefined();
  });
});

describe("groups", () => {
  async function inbound(event: Extract<BridgeEvent, { type: "message" }>) {
    const { gateway, fake } = build();
    const seen: MessageEnvelope[] = [];
    gateway.onMessage((env) => seen.push(env));
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "628111:5@s.whatsapp.net" });
    fake.push(event);
    await settle();
    await gateway.stop();
    return seen;
  }

  const GROUP = {
    type: "message" as const,
    id: "m1",
    chatId: "1234@g.us",
    chatType: "group" as const,
    senderId: "628999@s.whatsapp.net",
    senderName: "Gading",
    text: "apa pendapatmu?",
    timestamp: 1_700_000_000_000,
    selfIds: ["628111@s.whatsapp.net", "99887766@lid"],
  };

  test("a tag aimed at this number becomes a mention of the agent that owns it", async () => {
    const [envelope] = await inbound({ ...GROUP, mentions: ["628111@s.whatsapp.net"] });

    // WhatsApp has no `@agentname` — it tags a number. Without this translation a group tag is
    // invisible to the router and reads as ordinary chatter.
    expect(envelope?.mentions).toEqual(["nouva"]);
  });

  test("matches when the tag used the LID form of the same account", async () => {
    // The same account is addressed by phone JID in one conversation and by LID in another.
    const [envelope] = await inbound({ ...GROUP, mentions: ["99887766@lid"] });
    expect(envelope?.mentions).toEqual(["nouva"]);
  });

  test("matches across device suffixes", async () => {
    const [envelope] = await inbound({ ...GROUP, mentions: ["628111:9@s.whatsapp.net"] });
    expect(envelope?.mentions).toEqual(["nouva"]);
  });

  test("a tag aimed at somebody else is not a mention of us", async () => {
    const [envelope] = await inbound({ ...GROUP, mentions: ["628777@s.whatsapp.net"] });
    expect(envelope?.mentions).toBeUndefined();
  });

  test("a reply to this number's own message says so, by either of its addresses", async () => {
    // Live (2026-10-21): a reply to Nouva's answer in a group went unanswered until she was tagged. WhatsApp names the
    // quoted message's author — by LID in that group — and this is how the engine hears it was her bot's.
    for (const quotedSender of ["99887766@lid", "628111:3@s.whatsapp.net"]) {
      const [envelope] = await inbound({ ...GROUP, replyTo: "3EB0X", quotedSender, quotedText: "Kak Mira, dari screenshot-nya…" });
      expect(envelope?.repliesToSelf).toBe(true);
      expect(envelope?.mentions).toBeUndefined();
    }
  });

  test("a reply to somebody else's message is not a reply to us", async () => {
    const [envelope] = await inbound({ ...GROUP, replyTo: "3EB0Y", quotedSender: "628999@s.whatsapp.net", quotedText: "x" });
    expect(envelope?.repliesToSelf).toBeUndefined();
  });

  test("the quoted message arrives as context, marked as quoted", async () => {
    const [envelope] = await inbound({
      ...GROUP,
      mentions: ["628111@s.whatsapp.net"],
      quotedText: "deploy jam 3 pagi",
      text: "@bot ini aman?",
    });

    // "@bot ini aman?" means nothing without the message it points at, and in a group that is the
    // usual shape of being asked something. It rides on its own field rather than inside `text`,
    // which is what the engine's command parser and mention router read — prepending it there turned
    // a replied-to `/approve` into ordinary chat. The pipeline marks it with `> ` for the model.
    expect(envelope?.quotedText).toBe("deploy jam 3 pagi");
    expect(envelope?.text).toBe("@bot ini aman?");
    expect(envelope?.text).not.toContain(">");
  });
});

describe("a reply the platform refuses", () => {
  async function refused(code: string) {
    const { gateway, fake } = build();
    const events: unknown[] = [];
    gateway.onEvent((event) => events.push(event));
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    fake.push({
      type: "delivery_refused",
      chatId: "100000000000001@lid",
      messageId: "m1",
      code,
    });
    await settle();
    return { gateway, fake, events };
  }

  test("is announced rather than swallowed", async () => {
    const { gateway, events } = await refused("463");

    // The whole point. Before this the send resolved, the ack came back, and the reply simply never
    // appeared — healthy by every measure the daemon had.
    const event = events.find(
      (e): e is { type: string; code: string; reason: string; terminal: boolean } =>
        (e as { type?: string }).type === "delivery_refused",
    );
    expect(event).toBeDefined();
    expect(event?.code).toBe("463");
    expect(event?.terminal).toBe(true);
    // The message has to say what to do about it, not just that it happened.
    expect(event?.reason).toContain("restricted");

    await gateway.stop();
  });

  test("a terminal refusal stops the next attempt instead of repeating it", async () => {
    const { gateway, fake } = await refused("463");
    const before = fake.written.filter((cmd) => cmd.type === "send").length;

    void gateway.send({ gatewayId: "whatsapp:main", chatId: "100000000000001@lid", text: "another try" }).catch(() => {});
    await settle();

    // Baileys is explicit that retrying "counts as another reach out and worsens the restriction",
    // so a second attempt is not neutral — it is harmful.
    expect(fake.written.filter((cmd) => cmd.type === "send").length).toBe(before);
    await gateway.stop();
  });

  test("a non-terminal refusal does not wall off the chat", async () => {
    const { gateway, fake } = await refused("479");

    // Not awaited: this asserts the attempt *reaches the bridge*, and the fake never acks. Awaiting
    // would wait out the ack timeout for something the test does not care about.
    void gateway.send({ gatewayId: "whatsapp:main", chatId: "100000000000001@lid", text: "retry is fine here" });
    await settle();

    // 479 is a stale session, not a policy block. Refusing forever would turn a transient fault into
    // a permanent one.
    expect(fake.written.some((cmd) => cmd.type === "send")).toBe(true);
    await gateway.stop();
  });

  test("relinking clears the wall, because that is when a restriction may have lifted", async () => {
    const { gateway, fake } = await refused("463");
    const chat = { gatewayId: "whatsapp:main", chatId: "100000000000001@lid" };
    const sends = () => fake.written.filter((cmd) => cmd.type === "send").length;
    const before = sends();

    // Walled: the attempt never reaches the bridge.
    void gateway.send({ ...chat, text: "before relinking" }).catch(() => {});
    await settle();
    expect(sends()).toBe(before);

    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    // Not awaited, as above: the fake never acks, and what matters is that the attempt reaches the bridge.
    void gateway.send({ ...chat, text: "after relinking" }).catch(() => {});
    await settle();
    expect(sends()).toBe(before + 1);
    await gateway.stop();
  });
});

describe("read receipts", () => {
  test("marking read sends the platform command", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    await gateway.markRead("628123@s.whatsapp.net", "m1");
    await settle();

    expect(fake.written).toContainEqual({
      type: "read",
      chatId: "628123@s.whatsapp.net",
      messageId: "m1",
    });
    await gateway.stop();
  });
});

describe("sending", () => {
  test("markdown is converted before it goes over the bridge", async () => {
    // The wiring, which no amount of testing `toWhatsAppText` covers: the adapter sent `msg.text`
    // straight through, so every reply the engine ever produced arrived with its markdown markers
    // intact.
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    void gateway
      .send({
        gatewayId: "whatsapp:main",
        chatId: "628123@s.whatsapp.net",
        text: "**halo** ya\n\n| A | B |\n|---|---|\n| 1 | 2 |",
      })
      .catch(() => {});
    await settle();

    const sent = fake.written.find((cmd) => cmd.type === "send");
    expect(sent).toMatchObject({ text: "*halo* ya\n\n*A · B*\n\n*1*: 2" });
    await gateway.stop();
  });

  test("a reply past WhatsApp's ceiling is split, and only the first part quotes", async () => {
    // This adapter had no chunking at all. WhatsApp's limit is high enough that nothing visibly
    // broke, and the failure when a reply finally reaches it is the whole message being refused.
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    const long = Array.from({ length: 3_000 }, (_, i) => `kalimat nomor ${i} di sini`).join(" ");
    void gateway
      .send({
        gatewayId: "whatsapp:main",
        chatId: "628123@s.whatsapp.net",
        text: long,
        replyTo: "MSG1",
      })
      .catch(() => {});

    // Each part waits for its own ack before the next goes out — the send is sequential, which is
    // what keeps a split answer in order.
    const acked = new Set<string>();
    for (let round = 0; round < 6; round += 1) {
      await settle();
      for (const cmd of fake.written.filter((c) => c.type === "send") as { id: string }[]) {
        if (acked.has(cmd.id)) continue;
        acked.add(cmd.id);
        fake.push({ type: "ack", id: cmd.id });
      }
    }
    await settle();

    const parts = fake.written.filter((cmd) => cmd.type === "send") as { text: string; replyTo?: string }[];
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.text.length).toBeLessThanOrEqual(65_536);
    // Repeating the quote on every part of a long answer is unreadable.
    expect(parts[0]?.replyTo).toBe("MSG1");
    expect(parts.slice(1).every((part) => part.replyTo === undefined)).toBe(true);
    await gateway.stop();
  });

  test("a mention rides only on the part that tags them", async () => {
    // WhatsApp notifies everyone in `mentionedJid` whether or not their tag is in the text, so the
    // whole list on every chunk pings a person once per part of an answer that names them once.
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    void gateway
      .send({
        gatewayId: "whatsapp:main",
        chatId: "628999@g.us",
        text: "halo @628123456789",
        mentions: ["628123456789@s.whatsapp.net", "628000000000@s.whatsapp.net"],
      })
      .catch(() => {});
    await settle();

    const sent = fake.written.find((cmd) => cmd.type === "send") as { mentions?: string[] };
    expect(sent.mentions).toEqual(["628123456789@s.whatsapp.net"]);
    await gateway.stop();
  });

  test("resolves only when the bridge acks", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    const sending = gateway.send({ gatewayId: "whatsapp:main", chatId: "628123@s.whatsapp.net", text: "hai" });

    await settle();
    const sent = fake.written.find((cmd) => cmd.type === "send");
    expect(sent).toMatchObject({ chatId: "628123@s.whatsapp.net", text: "hai" });

    // Unresolved until the ack: a send that resolves on write reports success for a message the
    // bridge may have failed to deliver.
    fake.push({ type: "ack", id: (sent as { id: string }).id });
    expect(await sending).toHaveLength(1);
    await gateway.stop();
  });

  test("a bridge error buffers the message rather than losing it", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    const sending = gateway.send({ gatewayId: "whatsapp:main", chatId: "628123@s.whatsapp.net", text: "hai" });
    await settle();
    const sent = fake.written.find((cmd) => cmd.type === "send") as { id: string };
    fake.push({ type: "error", id: sent.id, message: "not on whatsapp" });

    // No ids, and no throw. `BaseGateway.send` deliberately converts a failed delivery into a
    // buffered one — a send that rejects loses the message, and the caller has nothing useful to do
    // with the exception anyway.
    //
    // The status is deliberately *not* asserted here any more. A failed send no longer condemns the
    // connection on its own: it buffers and probes, and "not on whatsapp" is a per-recipient refusal
    // that says nothing about the bridge. Which way the probe goes is the probe's business, tested in
    // `resilience.test.ts`.
    expect(await sending).toEqual([]);
    await gateway.stop();
  });

  test("a remote URL is not forwarded as a file path", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    const sending = gateway.send({
      gatewayId: "whatsapp:main",
      chatId: "628123@s.whatsapp.net",
      text: "look",
      attachments: [{ type: "image", url: "https://example.com/x.jpg", mimeType: "image/jpeg" }],
    });
    await settle();
    // The text goes first and the attachment only after its ack. Unacknowledged, the attachment was never reached,
    // and this held with the URL check deleted (the mutation sweep found it).
    const text = fake.written.find((cmd) => cmd.type === "send") as { id: string };
    fake.push({ type: "ack", id: text.id });
    expect(await sending).toEqual([text.id]);

    // The bridge opens paths; handing it a URL would either fail or make it fetch from the internet,
    // which is not its job.
    expect(fake.written.some((cmd) => cmd.type === "send_media")).toBe(false);
  });

  test("a buffer attachment without a url is written to temp and sent as send_media", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    const sending = gateway.send({
      gatewayId: "whatsapp:main",
      chatId: "628123@s.whatsapp.net",
      text: "",
      attachments: [
        {
          type: "file",
          buffer: new Uint8Array([104, 101, 108, 108, 111]),
          mimeType: "text/plain",
          filename: "test.txt",
        },
      ],
    });
    await settle();

    const mediaCmd = fake.written.find((cmd) => cmd.type === "send_media");
    expect(mediaCmd).toBeDefined();
    expect(mediaCmd?.type).toBe("send_media");
    if (mediaCmd?.type === "send_media") {
      expect(mediaCmd.mimeType).toBe("text/plain");
      expect(mediaCmd.path).toContain("wa_out_");
      fake.push({ type: "ack", id: mediaCmd.id });
    }
    await sending;
    await gateway.stop();
  });

  test("a send in flight when the bridge dies settles at once instead of hanging", async () => {
    const { gateway, fake } = build();
    await gateway.start();
    await settle();
    fake.push({ type: "ready", version: BRIDGE_PROTOCOL_VERSION, jid: "me@s.whatsapp.net" });
    await settle();

    const sending = gateway.send({ gatewayId: "whatsapp:main", chatId: "628123@s.whatsapp.net", text: "hai" });
    await settle();
    fake.end();

    // The property that matters: it settles now, not in 30 seconds. A pending ack left dangling on a
    // process that has already exited is a turn that looks hung to whoever is waiting for the reply.
    const settled = await Promise.race([
      sending.then(() => "settled" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 200)),
    ]);
    expect(settled).toBe("settled");
  });
});

describe("the linked number in the journal", () => {
  test("keeps the last four digits and nothing else of the JID", () => {
    expect(maskedNumber("6281234567890:12@s.whatsapp.net")).toBe("…7890");
    expect(maskedNumber("6281234567890@s.whatsapp.net")).not.toContain("62812");
  });

  test("says nothing for a JID too short to mask", () => {
    expect(maskedNumber("123@s.whatsapp.net")).toBe("…");
  });
});

/**
 * `BaseGateway` is the state machine every platform adapter inherits: connect, retry with backoff,
 * health-check, buffer what cannot be sent, give up. It is the code that decides whether the daemon
 * survives a platform outage, and it had no tests at all — the bugs it can hold are exactly the ones
 * that only show up during an outage, which is the worst possible time to find them.
 *
 * Real timers, tiny intervals. The alternative is injecting a clock into the base class, which would
 * change production code to suit a test; a 1ms backoff and a polling `eventually` exercise the real
 * `setTimeout`/`setInterval` paths instead, including the ones `stop()` has to clear.
 */

import { describe, expect, test } from "bun:test";
import type {
  GatewayEvent,
  GatewayResilienceConfig,
  GatewayStatus,
  MessageEnvelope,
  OutboundMessage,
} from "@nouride/shared";
import { BaseGateway, PartialDeliveryError, remainingAfter, UndeliverableError } from "../src/commons/resilience.ts";
import { eventually, sleep } from "./wait.ts";

/** Backoff of ~1ms and a 2ms health interval, so a full reconnect cycle fits in a test. */
const FAST: Partial<GatewayResilienceConfig> = {
  maxReconnectAttempts: 3,
  reconnectBackoffMs: 1,
  reconnectBackoffMaxMs: 2,
  reconnectBackoffMultiplier: 1,
  healthCheckIntervalMs: 2,
  // The production window is a minute. Scaled with the rest so a connection that is *meant* to hold
  // can prove it inside a test, while one that dies immediately still does not get credited.
  connectionStableAfterMs: 5,
};

interface FakeOptions {
  resilience?: Partial<GatewayResilienceConfig>;
  /** Answered per attempt: `false` throws out of `connect()`. */
  connectResults?: boolean[];
}

class FakeGateway extends BaseGateway {
  connectCalls = 0;
  disconnectCalls = 0;
  delivered: OutboundMessage[] = [];
  /** Flipped by a test to make every `deliver` throw. */
  deliverFails = false;
  /**
   * Number of deliveries to fail before succeeding again.
   *
   * Distinct from `deliverFails` so a test can describe "this one send is flaky" without racing the
   * probe that follows it — flipping a boolean back mid-flight decides the outcome by timing.
   */
  deliverFailures = 0;
  pingResult: boolean | "throw" = true;
  /** Makes the next `deliver` land its first `|`-separated part and lose the rest — a long reply cut off half-way. */
  partialOnce = false;
  /** Makes `disconnect()` throw, so a test can prove a bad teardown does not block the connect. */
  disconnectThrows = false;
  /** Makes `disconnect()` never finish — discord.js waiting on a `close` that does not come. */
  disconnectHangs = false;
  /** Makes every `deliver` answer what this platform calls final — `refusal` below reads it. */
  refuses = false;
  /** Makes the next `deliver` land its first part, then meet a refusal for the rest. */
  refusedPartway = false;
  /** What `deliverable()` answers — false is a platform reachable and unable to send, like WhatsApp unlinked. */
  canDeliver = true;
  /** Called on a `deliver` before it does anything else — a test's hook into the middle of a flush. */
  beforeDeliver: ((msg: OutboundMessage) => void) | null = null;
  deliverCalls = 0;

  /** Report a dropped connection, the way an adapter's error handler does. */
  drop(reason = "socket closed"): void {
    this.handleDisconnect(reason);
  }

  /** The same, for a failure that cannot be retried until something on the far side expires. */
  dropWithSettle(settleMs: number): void {
    this.handleDisconnect("conflict", settleMs);
  }

  private readonly connectResults: boolean[];

  constructor(options: FakeOptions = {}) {
    super({ id: "telegram:test", platform: "telegram" }, { ...FAST, ...options.resilience });
    this.connectResults = options.connectResults ?? [];
  }

  protected async connect(): Promise<void> {
    const outcome = this.connectResults[this.connectCalls] ?? true;
    this.connectCalls += 1;
    if (!outcome) throw new Error("connect refused");
  }

  protected async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    if (this.disconnectThrows) throw new Error("close refused");
    if (this.disconnectHangs) await new Promise(() => {});
  }

  protected async deliver(msg: OutboundMessage): Promise<string[]> {
    this.deliverCalls += 1;
    this.beforeDeliver?.(msg);
    if (this.refuses) throw new Error("Forbidden: bot was blocked by the user");
    if (this.refusedPartway) {
      this.refusedPartway = false;
      const textParts = msg.text.split("|");
      this.delivered.push({ ...msg, text: textParts[0]! });
      throw new PartialDeliveryError(["id-part"], remainingAfter(msg, { textParts, textIndex: 1 }), new Error("Forbidden: bot was kicked"));
    }
    if (this.partialOnce) {
      this.partialOnce = false;
      const textParts = msg.text.split("|");
      this.delivered.push({ ...msg, text: textParts[0]! });
      throw new PartialDeliveryError(["id-part"], remainingAfter(msg, { textParts, textIndex: 1 }), new Error("the second chunk lost its connection"));
    }
    if (this.deliverFailures > 0) {
      this.deliverFailures -= 1;
      throw new Error("this one request lost its connection");
    }
    if (this.deliverFails) throw new Error("wire is down");
    this.delivered.push(msg);
    return [`id-${this.delivered.length}`];
  }

  protected async ping(): Promise<boolean> {
    if (this.pingResult === "throw") throw new Error("ping exploded");
    return this.pingResult;
  }

  protected override refusal(err: unknown): string | null {
    return err instanceof Error && err.message.startsWith("Forbidden") ? err.message : null;
  }

  protected override deliverable(): boolean {
    return this.canDeliver;
  }

  /** What an adapter does once it can send again. */
  async sendHeld(): Promise<void> {
    await this.flushBuffer();
  }

  /** The two protected hooks a platform adapter calls, exposed so a test can play the platform. */
  dropConnection(reason?: string): void {
    this.handleDisconnect(reason);
  }
  expireSession(): void {
    this.handleSessionExpired();
  }
  deliverInbound(env: MessageEnvelope): void {
    this.emitMessage(env);
  }
}

function outbound(text: string): OutboundMessage {
  return { gatewayId: "telegram:test", chatId: "chat-1", text };
}

function envelope(text: string): MessageEnvelope {
  return {
    id: `msg-${text}`,
    timestamp: 0,
    // Required, and a fixture without it is not the shape the engine receives.
    raw: {},
    gateway: "telegram",
    gatewayId: "telegram:test",
    chatId: "chat-1",
    chatType: "dm",
    senderId: "someone",
    senderName: "Someone",
    text,
  };
}

/** Every status the gateway passed through, in order — the transitions are the contract. */
function trackStatuses(gateway: FakeGateway): GatewayStatus[] {
  const seen: GatewayStatus[] = [];
  gateway.onEvent((event) => {
    if (event.type === "status") seen.push(event.status);
  });
  return seen;
}

describe("connecting", () => {
  test("a clean start reaches connected and reports both transitions", async () => {
    const gateway = new FakeGateway();
    const statuses = trackStatuses(gateway);

    await gateway.start();

    expect(gateway.status).toBe("connected");
    expect(statuses).toEqual(["connecting", "connected"]);
    await gateway.stop();
  });

  test("a failed connect retries and succeeds without the caller knowing", async () => {
    // `start()` resolves as soon as the first attempt fails — the retry is the background loop's
    // job, and an adapter that awaited it would block boot behind a platform outage.
    const gateway = new FakeGateway({ connectResults: [false, false] });

    await gateway.start();
    expect(gateway.status).toBe("reconnecting");

    await eventually(() => gateway.status === "connected", 4_000, "reconnect to succeed");
    expect(gateway.connectCalls).toBe(3);
    await gateway.stop();
  });

  test("a connection that holds gets its retry budget back, so the next outage starts fresh", async () => {
    // Without the reset, a gateway that flapped `maxReconnectAttempts` times over a week would go
    // dead on a blip it had already recovered from — the failures would add up across outages that
    // had nothing to do with each other. Two attempts allowed, two used up in the first outage, and
    // one more failure in the second: it recovers only if the counter went back to zero.
    const gateway = new FakeGateway({
      connectResults: [false, true, false, true],
      resilience: { maxReconnectAttempts: 2 },
    });
    await gateway.start();
    await eventually(() => gateway.status === "connected", 4_000, "first recovery");
    // The budget comes back only once the connection has *held* — see the next test for why.
    await sleep(15);

    gateway.dropConnection("blip");
    await eventually(() => gateway.status === "connected", 4_000, "second recovery");
    expect(gateway.connectCalls).toBe(4);
    await gateway.stop();
  });

  /**
   * The reset used to happen the moment `connect()` resolved, which is not the same as being
   * connected, and Telegram is the adapter where the difference bites: `connect()` returns once
   * `bot.init()` has validated the token, and polling starts afterwards and can fail a third of a
   * second later. Live, two instances were polling one token, so every cycle ran connect → reset to
   * zero → 409 → "reconnecting, attempt 1". Sub-second reconnects against the Telegram API for as
   * long as it lasted: the backoff never left its first step, `maxReconnectAttempts` was unreachable,
   * and the `dead` event that would have alerted the operator never fired.
   *
   * So: a connection that dies before it has held must not be credited, and the gateway must
   * eventually give up and say so.
   */
  test("a connection that dies immediately does not refill the budget, so the loop terminates", async () => {
    const gateway = new FakeGateway({
      // Every `connect()` succeeds — the failure is always *after* it, exactly as a 409 on the first
      // poll behaves. Nothing here would ever stop if the counter reset on connect.
      resilience: { maxReconnectAttempts: 2, connectionStableAfterMs: 10_000 },
    });
    const events: GatewayEvent[] = [];
    gateway.onEvent((event) => events.push(event));

    await gateway.start();
    await eventually(() => gateway.status === "connected", 4_000, "first connect");
    for (let cycle = 0; cycle < 4; cycle += 1) {
      gateway.dropConnection("409 conflict");
      if (gateway.status === "dead") break;
      await eventually(
        () => gateway.status === "connected" || gateway.status === "dead",
        4_000,
        "cycle to settle",
      );
    }

    expect(gateway.status).toBe("dead");
    expect(events.at(-1)).toEqual({ type: "dead", gatewayId: "telegram:test", attempts: 2 });

    // And it really stopped, rather than going quiet for one tick.
    const settled = gateway.connectCalls;
    await sleep(20);
    expect(gateway.connectCalls).toBe(settled);
  });

  test("past max attempts it goes dead and stops trying", async () => {
    const gateway = new FakeGateway({
      connectResults: [false, false, false, false, false, false],
      resilience: { maxReconnectAttempts: 2 },
    });
    const events: GatewayEvent[] = [];
    gateway.onEvent((event) => events.push(event));

    await gateway.start();
    await eventually(() => gateway.status === "dead", 4_000, "gateway to give up");

    expect(events.at(-1)).toEqual({ type: "dead", gatewayId: "telegram:test", attempts: 2 });

    // Nothing is scheduled any more: the call count must not move after the verdict.
    const settled = gateway.connectCalls;
    await sleep(20);
    expect(gateway.connectCalls).toBe(settled);
  });

  test("a duplicate status is not re-emitted", async () => {
    // The dashboard renders these; a reconnect loop emitting "reconnecting" every attempt would be
    // an event storm that says nothing new.
    const gateway = new FakeGateway();
    await gateway.start();
    const statuses = trackStatuses(gateway);

    gateway.dropConnection("one");
    gateway.dropConnection("two");
    expect(statuses.filter((s) => s === "reconnecting")).toHaveLength(1);
    await gateway.stop();
  });
});

describe("the outbound buffer", () => {
  test("a send before the connection is up is held, not lost or thrown", async () => {
    const gateway = new FakeGateway();

    // No ids, because nothing was sent — the caller reads that as "nothing to remember".
    expect(await gateway.send(outbound("early"))).toEqual([]);
    expect(gateway.delivered).toHaveLength(0);

    await gateway.start();
    await eventually(() => gateway.delivered.length === 1, 4_000, "buffer to flush on connect");
    expect(gateway.delivered[0]?.text).toBe("early");
    await gateway.stop();
  });

  test("buffered messages flush in the order they were sent", async () => {
    const gateway = new FakeGateway();
    await gateway.send(outbound("first"));
    await gateway.send(outbound("second"));
    await gateway.send(outbound("third"));

    await gateway.start();
    await eventually(() => gateway.delivered.length === 3, 4_000, "all three to flush");
    expect(gateway.delivered.map((m) => m.text)).toEqual(["first", "second", "third"]);
    await gateway.stop();
  });

  test("past the limit the oldest is dropped, not the newest", async () => {
    // A late reply is worth less than the current one, and an unbounded buffer would flush an hour
    // of stale chat on reconnect.
    const gateway = new FakeGateway();
    for (let i = 0; i < 105; i++) await gateway.send(outbound(`m${i}`));

    await gateway.start();
    await eventually(() => gateway.delivered.length === 100, 4_000, "the capped buffer to flush");
    expect(gateway.delivered[0]?.text).toBe("m5");
    expect(gateway.delivered.at(-1)?.text).toBe("m104");
    await gateway.stop();
  });

  test("a send that fails on a live connection buffers, probes, and does not reconnect", async () => {
    /**
     * A failed send used to reconnect outright, and that inference was a live incident: on Telegram
     * outbound and inbound are separate HTTP requests, so one `sendPhoto` losing its connection said
     * nothing about the poll — and tearing the poll down took inbound out for an hour.
     *
     * Now the connection is asked. It answers, so the failure was the request's own.
     */
    const gateway = new FakeGateway();
    await gateway.start();
    // Exactly one request fails — the shape of a large upload losing its connection while the poll
    // beside it is fine. A boolean flipped back mid-flight would race the probe and decide the
    // outcome by timing instead of by behaviour.
    gateway.deliverFailures = 1;

    expect(await gateway.send(outbound("doomed"))).toEqual([]);

    // The buffered message goes out on the probe's success, not on a reconnect that never happens —
    // a buffer draining only on reconnect would strand it for as long as the connection stayed up.
    await eventually(() => gateway.delivered.some((m) => m.text === "doomed"), 4_000, "the probe to flush it");
    expect(gateway.status).toBe("connected");
    expect(gateway.connectCalls).toBe(1);
    await gateway.stop();
  });

  test("a message that fails part-way buffers only what is left — the part that landed is not sent twice", async () => {
    const gateway = new FakeGateway();
    await gateway.start();
    gateway.partialOnce = true;
    let landed = 0;

    // Delivered, if not all of it: the caller is told so.
    expect(await gateway.send({ ...outbound("one|two|three"), replyTo: "q1", onDelivered: () => (landed += 1) })).toEqual(["id-part"]);

    await eventually(() => gateway.delivered.length === 2, 4_000, "the probe to flush the rest");
    expect(gateway.delivered.map((m) => m.text)).toEqual(["one", "two\n\nthree"]);
    // The rest quotes nothing: only a message's first part replies to what triggered it.
    expect(gateway.delivered[1]!.replyTo).toBeUndefined();
    expect(landed).toBe(1);
    await gateway.stop();
  });

  test("a buffered message says so when it finally lands", async () => {
    const gateway = new FakeGateway();
    let landed = 0;
    // Not connected yet: buffered, so `send` has no ids to give.
    expect(await gateway.send({ ...outbound("later"), onDelivered: () => (landed += 1) })).toEqual([]);
    await gateway.start();
    await eventually(() => landed === 1, 4_000, "the buffer to flush on connect");
    expect(gateway.delivered.map((m) => m.text)).toEqual(["later"]);
    await gateway.stop();
  });

  test("a send that fails on a connection that then fails its probe does reconnect", async () => {
    // The other half: the evidence was real. This is the same conclusion the health timer would have
    // reached, up to a whole interval sooner.
    // The health timer is pushed out of reach on purpose. Left at 2ms it reaches the same conclusion
    // from its own consecutive-failure counter, so the test would pass with the probe deleted — which
    // is what shadowing looks like and why it is worth one line to prevent.
    const gateway = new FakeGateway({ resilience: { healthCheckIntervalMs: 60_000 } });
    await gateway.start();
    gateway.deliverFails = true;
    gateway.pingResult = false;

    expect(await gateway.send(outbound("doomed"))).toEqual([]);

    // What this test is about, and all it asserts: the probe reached the same conclusion the health
    // timer would have, and a reconnect followed. Whether the buffered message survives that reconnect
    // is `flushBuffer`'s business and has its own tests — asserting it here with a 1ms backoff would be
    // a race between the flush and the test clearing the fault.
    await eventually(() => gateway.connectCalls > 1, 4_000, "the probe to condemn the connection");

    gateway.deliverFails = false;
    gateway.pingResult = true;
    await gateway.stop();
  });

  test("a message the platform refuses for good is thrown to its caller — never buffered, never sent again", async () => {
    /**
     * A chat the bot cannot write to answers the same way every time. Buffered, it was sent three more times —
     * resent as plain text, flushed after the probe — and dropped in the log, while a scheduled run recorded its
     * reply as delivered. Thrown, the caller can say it was not.
     */
    const gateway = new FakeGateway();
    await gateway.start();
    gateway.refuses = true;

    const refused = await gateway.send(outbound("to a chat that blocked us")).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(UndeliverableError);
    expect((refused as UndeliverableError).reason).toBe("Forbidden: bot was blocked by the user");

    // Were it buffered, the probe's flush would send it now that the platform takes messages again.
    gateway.refuses = false;
    await sleep(30);
    expect(gateway.delivered).toEqual([]);
    expect(gateway.connectCalls).toBe(1);
    await gateway.stop();
  });

  test("a refusal after a part landed: the caller gets the part, and the rest is not buffered", async () => {
    const gateway = new FakeGateway();
    await gateway.start();
    gateway.refusedPartway = true;

    expect(await gateway.send(outbound("one|two"))).toEqual(["id-part"]);
    await sleep(30);
    expect(gateway.delivered.map((m) => m.text)).toEqual(["one"]);
    await gateway.stop();
  });

  test("a flush waits while the platform cannot take a message, and goes when the adapter says it can", async () => {
    const gateway = new FakeGateway();
    await gateway.start();
    // Reachable and unable to send — a WhatsApp bridge whose number dropped off with the internet.
    gateway.canDeliver = false;
    gateway.deliverFailures = 1;
    await gateway.send(outbound("owed"));

    // A flush now — the probe's, or any other — leaves the message alone rather than spend it on a platform that cannot
    // take it. Live, it was dropped here, a reply a person was owed (2026-10-21).
    await gateway.sendHeld();
    expect(gateway.deliverCalls).toBe(1);
    expect(gateway.delivered).toEqual([]);

    gateway.canDeliver = true;
    await gateway.sendHeld();
    expect(gateway.delivered.map((m) => m.text)).toEqual(["owed"]);
    await gateway.stop();
  });

  test("the platform going away mid-flush keeps the message that failed and the rest, in their order", async () => {
    const gateway = new FakeGateway();
    for (const text of ["one", "two", "three"]) await gateway.send(outbound(text));
    gateway.beforeDeliver = (msg) => {
      if (msg.text !== "two") return;
      gateway.beforeDeliver = null;
      gateway.canDeliver = false;
      throw new Error("the WhatsApp number has not finished linking");
    };

    await gateway.start();
    await eventually(() => gateway.deliverCalls === 2, 4_000, "the flush to reach the second message");
    expect(gateway.delivered.map((m) => m.text)).toEqual(["one"]);

    gateway.canDeliver = true;
    await gateway.sendHeld();
    expect(gateway.delivered.map((m) => m.text)).toEqual(["one", "two", "three"]);
    await gateway.stop();
  });

  test("a buffered message that fails on flush is dropped without taking the rest with it", async () => {
    const gateway = new FakeGateway();
    await gateway.send(outbound("poisoned"));
    gateway.deliverFails = true;

    await gateway.start();
    await eventually(() => gateway.status === "connected", 4_000, "connect despite the bad message");

    // Dropped, and the gateway is still usable — the alternative is a message that fails forever
    // and blocks every send behind it.
    gateway.deliverFails = false;
    await gateway.send(outbound("after"));
    expect(gateway.delivered.map((m) => m.text)).toEqual(["after"]);
    await gateway.stop();
  });
});

describe("health checks", () => {
  test("the timer asks `alive()`, so an adapter that already knows answers without a request (E11)", async () => {
    // Telegram's answers from its last poll; a ping would be a request every thirty seconds at idle for nothing.
    class Knows extends FakeGateway {
      pings = 0;
      protected override async alive(): Promise<boolean> {
        return true;
      }
      protected override async ping(): Promise<boolean> {
        this.pings += 1;
        return false;
      }
    }
    const gateway = new Knows();
    await gateway.start();
    await sleep(20);
    expect({ status: gateway.status, pings: gateway.pings }).toEqual({ status: "connected", pings: 0 });
    await gateway.stop();
  });

  /**
   * What the health check did, read from the statuses it went through rather than the one it is at: with every
   * reconnect refused and the test's backoff at a millisecond, the gateway can be `dead` before a slow runner looks —
   * which is what CI saw on 2026-10-17, and the wrong thing to fail on. Reconnecting first is the behaviour.
   */
  test("three consecutive failed pings are treated as a dropped connection", async () => {
    const gateway = new FakeGateway({ connectResults: [true, false, false, false, false] });
    await gateway.start();
    const statuses = trackStatuses(gateway);
    gateway.pingResult = false;

    await eventually(() => gateway.status !== "connected", 4_000, "the health check to give up");
    expect(statuses[0]).toBe("reconnecting");
    await gateway.stop();
  });

  test("a ping that throws counts as a failure rather than escaping", async () => {
    const gateway = new FakeGateway({ connectResults: [true, false, false, false, false] });
    await gateway.start();
    const statuses = trackStatuses(gateway);
    gateway.pingResult = "throw";

    await eventually(() => gateway.status !== "connected", 4_000, "a throwing ping to be counted");
    expect(statuses[0]).toBe("reconnecting");
    await gateway.stop();
  });

  test("a single failed ping does not tear down a healthy connection", async () => {
    // The threshold is what stops a momentary blip from cycling the whole connection.
    const gateway = new FakeGateway();
    await gateway.start();

    gateway.pingResult = false;
    await sleep(3);
    gateway.pingResult = true;
    await sleep(10);

    expect(gateway.status).toBe("connected");
    await gateway.stop();
  });

  test("health checks stop once the connection is gone", async () => {
    // They run on an interval the reconnect path clears; leaving it armed would ping a socket that
    // no longer exists for as long as the outage lasts.
    const gateway = new FakeGateway({ connectResults: [true, false, false, false, false, false] });
    await gateway.start();
    gateway.pingResult = false;
    await eventually(() => gateway.status === "dead", 4_000, "the gateway to die");

    const settled = gateway.connectCalls;
    await sleep(20);
    expect(gateway.connectCalls).toBe(settled);
  });
});

describe("stopping", () => {
  test("stop() disconnects and reports it", async () => {
    const gateway = new FakeGateway();
    await gateway.start();
    const statuses = trackStatuses(gateway);

    const before = gateway.disconnectCalls;
    await gateway.stop();
    // One more than before: `attemptConnect` also tears down first, so the absolute count is not the
    // interesting number — that this one call happened is.
    expect(gateway.disconnectCalls).toBe(before + 1);
    expect(statuses).toEqual(["disconnected"]);
  });

  test("a disconnect that throws does not break shutdown", async () => {
    // `stop()` runs during drain, where a throw would leave the rest of the sequence unrun.
    const gateway = new FakeGateway();
    gateway.disconnectThrows = true;
    await gateway.start();

    await gateway.stop();
    expect(gateway.status).toBe("disconnected");
  });

  test("nothing reconnects after stop()", async () => {
    const gateway = new FakeGateway({ connectResults: [false, false, false, false] });
    await gateway.start();
    await gateway.stop();

    const settled = gateway.connectCalls;
    await sleep(20);
    expect(gateway.connectCalls).toBe(settled);
    expect(gateway.status).toBe("disconnected");
  });

  test("a platform disconnect after stop() is ignored", async () => {
    // A platform library often fires its close event *because* we closed it. Reacting would start a
    // reconnect loop against a daemon that is shutting down.
    const gateway = new FakeGateway();
    await gateway.start();
    await gateway.stop();

    gateway.dropConnection("library close event");
    expect(gateway.status).toBe("disconnected");
  });
});

describe("events and handlers", () => {
  test("an expired session goes dead and says so — it needs a human, not a retry", async () => {
    const gateway = new FakeGateway();
    const events: GatewayEvent[] = [];
    gateway.onEvent((event) => events.push(event));
    await gateway.start();

    gateway.expireSession();

    expect(gateway.status).toBe("dead");
    expect(events).toContainEqual({ type: "session_expired", gatewayId: "telegram:test" });
    await gateway.stop();
  });

  test("one throwing handler does not stop the others", async () => {
    // Handlers belong to the engine. A gateway that lets one of them break the fan-out turns an
    // engine-side bug into a dead connection.
    const gateway = new FakeGateway();
    const seen: string[] = [];
    gateway.onMessage(() => {
      throw new Error("handler bug");
    });
    gateway.onMessage((env) => seen.push(env.text));

    gateway.deliverInbound(envelope("hello"));
    expect(seen).toEqual(["hello"]);

    const events: GatewayEvent[] = [];
    gateway.onEvent(() => {
      throw new Error("event handler bug");
    });
    gateway.onEvent((event) => events.push(event));

    await gateway.start();
    expect(events.length).toBeGreaterThan(0);
    await gateway.stop();
  });

  /**
   * A press on a button goes to the one handler the engine gave, and its answer comes back for the adapter to carry
   * out — always something to carry out: a platform shows a press pending until it is acknowledged.
   */
  test("a press is answered by the engine's handler; with none, or one that throws, it is still answered", async () => {
    const gateway = new FakeGateway();
    const press = { gatewayId: "telegram:test", chatId: "c", chatType: "dm" as const, messageId: "1", data: "x", senderId: "u", senderName: "U" };
    const answer = (gateway as unknown as { answerPress(p: typeof press): Promise<unknown> }).answerPress.bind(gateway);
    expect(await answer(press)).toEqual({});

    const pressed: string[] = [];
    gateway.onPress(async (p) => (pressed.push(p.data), { notice: "Approved.", settled: "✅ done" }));
    expect(await answer(press)).toEqual({ notice: "Approved.", settled: "✅ done" });
    expect(pressed).toEqual(["x"]);

    gateway.onPress(async () => {
      throw new Error("engine bug");
    });
    expect(await answer(press)).toEqual({ notice: "That did not go through. Answer with the command in the message instead." });
    // No buttons to settle on a gateway that has none.
    expect(await gateway.settleButtons("c", "1", "settled")).toBe(false);
  });
});

/**
 * The reconnect that built a second connection beside the first.
 *
 * `attemptConnect` called `connect()` without ever calling `disconnect()`, so every retry left the
 * previous connection running. On a platform that tolerates two that is a leak; on Telegram, which
 * allows exactly one `getUpdates` per token, it is fatal — the new poll terminates the old one,
 * Telegram answers the old one with 409, that reads as another dropped connection, and the next
 * attempt terminates the poll that just replaced it. One flaky photo upload took inbound down for an
 * hour, with a log blaming an instance that was us.
 */
describe("tearing down before connecting", () => {
  test("every connect is preceded by a disconnect", async () => {
    const gateway = new FakeGateway();
    await gateway.start();

    // Even the first: `disconnect()` is idempotent by contract in every adapter, and a first attempt
    // that skipped it would need `connect()` to know whether it is the first — which is exactly the
    // bookkeeping that went wrong.
    expect(gateway.connectCalls).toBe(1);
    expect(gateway.disconnectCalls).toBe(1);
    await gateway.stop();
  });

  test("a retry tears the failed attempt down before trying again", async () => {
    // The count is the assertion: one teardown per attempt, never fewer.
    const gateway = new FakeGateway({ connectResults: [false, false, true] });
    await gateway.start();

    await eventually(() => gateway.status === "connected", 4_000, "the third attempt to land");
    expect(gateway.connectCalls).toBe(3);
    expect(gateway.disconnectCalls).toBe(3);
    await gateway.stop();
  });

  test("a teardown that throws does not stop the connect it precedes", async () => {
    // Otherwise one bad close leaves the gateway down permanently, for a reason nobody would look for
    // in the connect path.
    const gateway = new FakeGateway();
    gateway.disconnectThrows = true;
    await gateway.start();

    expect(gateway.status).toBe("connected");
    await gateway.stop();
  });

  test("a teardown that never finishes holds the connect, and a stop, only as long as the timeout", async () => {
    // As on the live box: a Discord login timed out, the retry's `destroy()` of that client never returned, and the
    // gateway said "connecting" for good.
    const gateway = new FakeGateway({ connectResults: [false, true], resilience: { teardownTimeoutMs: 20 } });
    gateway.disconnectHangs = true;
    await gateway.start();

    await eventually(() => gateway.status === "connected", 2_000, "the retry to connect past the teardown");
    expect(gateway.connectCalls).toBe(2);
    await gateway.stop();
    expect(gateway.status).toBe("disconnected");
  });
});

/**
 * A failure that cannot be retried quickly, however healthy the network is.
 *
 * Telegram holds a `getUpdates` session open server-side for ~30s after the client goes away, so a
 * reconnect inside that window is answered with a 409 no matter how clean the local teardown was. The
 * backoff starts at one second, so the first attempts were doomed by arithmetic.
 */
describe("a settle floor on the next reconnect", () => {
  test("the floor wins over a shorter backoff", async () => {
    const gateway = new FakeGateway({ resilience: { reconnectBackoffMs: 1, reconnectBackoffMaxMs: 2 } });
    await gateway.start();

    const started = Date.now();
    gateway.dropWithSettle(60);
    await eventually(() => gateway.connectCalls > 1, 2_000, "the delayed reconnect");

    // The backoff would have retried in ~1ms. It waited for the floor instead.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    await gateway.stop();
  });

  test("a failure with no floor is not slowed down", async () => {
    // The floor belongs to one kind of failure. An ordinary dropped socket still retries immediately.
    const gateway = new FakeGateway({ resilience: { reconnectBackoffMs: 1, reconnectBackoffMaxMs: 2 } });
    await gateway.start();

    const started = Date.now();
    gateway.drop();
    await eventually(() => gateway.connectCalls > 1, 2_000, "the immediate reconnect");

    expect(Date.now() - started).toBeLessThan(500);
    await gateway.stop();
  });
});

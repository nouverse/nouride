/**
 * What goes out, at the rate the platform takes it — and a token the platform refuses, given up on at once.
 *
 * A twelve-part answer used to go to Telegram as fast as the API would take it: past its message-a-second limit
 * for a chat, into a 429 that was retried at once and then resent as plain text, into the same limit. And a wrong
 * token was reconnected to ten times over ten minutes before anybody heard about it.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Bot, GrammyError } from "grammy";
import { GatewayAuthError, type GatewayEvent, type GatewayResilienceConfig, type OutboundMessage } from "@nouride/shared";
import { refusedToken } from "../src/channels/discord/gateway.ts";
import { TelegramGateway, retryAfterSeconds } from "../src/channels/telegram/gateway.ts";
import { Pacer, type Clock } from "../src/commons/pace.ts";
import { BaseGateway } from "../src/commons/resilience.ts";
import { eventually } from "./wait.ts";

/**
 * A clock that remembers each sleep. One that `advances` moves forward by it, which is time passing for one sender
 * awaiting in turn; one that does not stands still, which is several senders all asking in the same instant.
 */
function fakeClock(advances = true): Clock & { slept: number[]; t: number } {
  const clock = {
    t: 0,
    slept: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.slept.push(ms);
      if (advances) clock.t += ms;
    },
  };
  return clock;
}

describe("the pacer", () => {
  test("one chat: a message a second — the first at once, the rest a second apart", async () => {
    const clock = fakeClock(false);
    const pacer = new Pacer({ perChat: () => ({ count: 1, perMs: 1_000 }) }, clock);
    await Promise.all([pacer.take("a"), pacer.take("a"), pacer.take("a")]);
    expect(clock.slept).toEqual([1_000, 2_000]);

    // Quiet for a while, and the next goes at once again.
    clock.t += 10_000;
    clock.slept.length = 0;
    await pacer.take("a");
    expect(clock.slept).toEqual([]);
  });

  test("a group's burst, then its pace; and another chat never waits behind this one", async () => {
    const clock = fakeClock();
    const pacer = new Pacer({ perChat: (chat) => (chat.startsWith("-") ? { count: 20, perMs: 60_000 } : { count: 1, perMs: 1_000 }) }, clock);
    for (let n = 0; n < 20; n += 1) await pacer.take("-100");
    expect(clock.slept).toEqual([]);
    await pacer.take("-100");
    expect(clock.slept).toEqual([3_000]);
    clock.slept.length = 0;
    await pacer.take("42");
    expect(clock.slept).toEqual([]);
  });

  test("the bot's own limit holds across chats", async () => {
    const clock = fakeClock(false);
    const pacer = new Pacer({ perChat: () => ({ count: 1, perMs: 1_000 }), perBot: { count: 30, perMs: 1_000 } }, clock);
    await Promise.all(Array.from({ length: 31 }, (_, n) => pacer.take(`chat-${n}`)));
    expect(clock.slept).toEqual([34]);
  });
});

describe("Telegram, sending", () => {
  const sends: { at: number; text: string; html: boolean }[] = [];
  let failures: unknown[] = [];

  function gateway(clock: Clock & { t: number }): TelegramGateway {
    const telegram = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling" });
    const message = async (_chat: string, text: string, options: { parse_mode?: string }) => {
      const failure = failures.shift();
      if (failure) throw failure;
      sends.push({ at: clock.t, text, html: options.parse_mode === "HTML" });
      return { message_id: sends.length };
    };
    (telegram as unknown as { bot: unknown }).bot = { api: { sendMessage: message } };
    (telegram as unknown as { pacer: Pacer }).pacer = new Pacer({ perChat: () => ({ count: 1, perMs: 1_000 }), perBot: { count: 30, perMs: 1_000 } }, clock);
    return telegram;
  }
  const deliver = (telegram: TelegramGateway, msg: OutboundMessage) => (telegram as unknown as { deliver(m: OutboundMessage): Promise<string[]> }).deliver(msg);
  const tooMany = (seconds: number) =>
    new GrammyError("Too Many Requests", { ok: false, error_code: 429, description: `Too Many Requests: retry after ${seconds}`, parameters: { retry_after: seconds } }, "sendMessage", {});

  afterEach(() => {
    sends.length = 0;
    failures = [];
  });

  test("a long answer goes a part a second, not as fast as the API takes it", async () => {
    const clock = fakeClock();
    const long = Array.from({ length: 3 }, (_, n) => `part ${n} ${"x".repeat(4_000)}`).join("\n\n");
    await deliver(gateway(clock), { gatewayId: "telegram:main", chatId: "42", text: long });
    expect(sends.map((send) => send.at)).toEqual([0, 1_000, 2_000]);
  });

  test("a 429 is waited out for as long as Telegram says, and the same message sent — not resent as plain text", async () => {
    const clock = fakeClock();
    failures = [tooMany(3)];
    expect(await deliver(gateway(clock), { gatewayId: "telegram:main", chatId: "42", text: "hello" })).toEqual(["1"]);
    expect(clock.slept).toEqual([3_000]);
    expect(sends).toEqual([{ at: 3_000, text: "hello", html: true }]);
  });

  test("still refused after two waits, it is a failure to send — the plain-text resend is not tried into the limit", async () => {
    const clock = fakeClock();
    failures = [tooMany(1), tooMany(1), tooMany(1)];
    await expect(deliver(gateway(clock), { gatewayId: "telegram:main", chatId: "42", text: "hello" })).rejects.toThrow("Too Many Requests");
    expect(sends).toEqual([]);
    expect(retryAfterSeconds(tooMany(7))).toBe(7);
    expect(retryAfterSeconds(new Error("network"))).toBeNull();
  });

  test("a chat that refuses the bot is refused once — not resent as plain text into the same answer", async () => {
    const clock = fakeClock();
    failures = [new GrammyError("Forbidden", { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, "sendMessage", {})];
    await expect(deliver(gateway(clock), { gatewayId: "telegram:main", chatId: "42", text: "hello" })).rejects.toThrow("blocked");
    // The plain-text resend would have gone through the fake, which has no failure left to give it.
    expect(sends).toEqual([]);
  });

  test("a formatting refusal is still resent as plain text — the message matters more than its marks", async () => {
    const clock = fakeClock();
    failures = [new GrammyError("Bad Request", { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unsupported start tag" }, "sendMessage", {})];
    expect(await deliver(gateway(clock), { gatewayId: "telegram:main", chatId: "42", text: "**hello**" })).toEqual(["1"]);
    expect(sends.map((send) => send.html)).toEqual([false]);
  });

  test("an edit is not paced: the progress line is not held behind the answer", async () => {
    const clock = fakeClock();
    const telegram = gateway(clock);
    (telegram as unknown as { bot: { api: Record<string, unknown> } }).bot.api.editMessageText = async () => ({});
    await deliver(telegram, { gatewayId: "telegram:main", chatId: "42", text: "first" });
    expect(await telegram.editMessage("42", "1", "working…")).toBe(true);
    expect(clock.slept).toEqual([]);
  });
});

describe("a refused token (G8)", () => {
  const FAST: Partial<GatewayResilienceConfig> = { maxReconnectAttempts: 10, reconnectBackoffMs: 1, reconnectBackoffMaxMs: 1, reconnectBackoffMultiplier: 1, healthCheckIntervalMs: 60_000 };

  class Refused extends BaseGateway {
    attempts = 0;
    constructor(private readonly failure: () => Error) {
      super({ id: "telegram:test", platform: "telegram" }, FAST);
    }
    protected async connect(): Promise<void> {
      this.attempts += 1;
      throw this.failure();
    }
    protected async disconnect(): Promise<void> {}
    protected async deliver(): Promise<string[]> {
      return [];
    }
    protected async ping(): Promise<boolean> {
      return true;
    }
  }

  test("is given up on after one more try, and the event says why — not after ten reconnects", async () => {
    const gateway = new Refused(() => new GatewayAuthError("telegram:test", "Telegram refused the bot token: Unauthorized"));
    const events: GatewayEvent[] = [];
    gateway.onEvent((event) => events.push(event));
    await gateway.start();
    await eventually(() => gateway.status === "dead");

    expect(gateway.status).toBe("dead");
    expect(gateway.attempts).toBe(2);
    expect(events.find((event) => event.type === "dead")).toMatchObject({ reason: "auth_failed", detail: expect.stringContaining("refused the bot token") });
    await gateway.stop();
  });

  test("a network failure is still reconnected to, as before", async () => {
    // Its reconnects run on a 1 ms backoff, so a slow runner can find all ten spent before it looks — CI did, on
    // 2026-10-17. What tells a network failure from a refused token is that it is tried again and again, and is never
    // given up on as one.
    const gateway = new Refused(() => new Error("ECONNRESET"));
    const events: GatewayEvent[] = [];
    gateway.onEvent((event) => events.push(event));
    await gateway.start();
    await eventually(() => gateway.attempts >= 4);
    expect(gateway.attempts).toBeGreaterThanOrEqual(4);
    expect(events.flatMap((event) => (event.type === "dead" ? [event.reason ?? "budget"] : []))).not.toContain("auth_failed");
    await gateway.stop();
  });

  test("Telegram's 401 on init, and Discord's refused login, are the token — not the network", async () => {
    const init = spyOn(Bot.prototype, "init").mockImplementation(async () => {
      throw new GrammyError("Unauthorized", { ok: false, error_code: 401, description: "Unauthorized" }, "getMe", {});
    });
    try {
      const telegram = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling" });
      await expect((telegram as unknown as { connect(): Promise<void> }).connect()).rejects.toBeInstanceOf(GatewayAuthError);
    } finally {
      init.mockRestore();
    }
    expect(refusedToken(Object.assign(new Error("An invalid token was provided."), { code: "TokenInvalid" }))).toBe(true);
    expect(refusedToken(Object.assign(new Error("401: Unauthorized"), { status: 401 }))).toBe(true);
    expect(refusedToken(new Error("getaddrinfo ENOTFOUND discord.com"))).toBe(false);
  });
});

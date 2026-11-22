/**
 * A connection that is not up yet says what it waits on.
 *
 * On a live box a Telegram connection stayed "connecting" for thirty minutes to the second after five installs in a
 * row, with nothing in the log and nothing on its row: its client waits out what the platform asks, in silence. Here:
 * the supervisor keeps what an adapter says of a wait, once, until the connect is over, and says by itself that a
 * connect nothing has answered is still waiting; Telegram's and Discord's adapters say what their platforms answered.
 */

import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { Bot, GrammyError } from "grammy";
import { Client } from "discord.js";
import { holdLines, type GatewayResilienceConfig, type LogEntry, type Logger, type OutboundMessage } from "@nouride/shared";
import { ConnectWait } from "../src/commons/connect-wait.ts";
import { BaseGateway } from "../src/commons/resilience.ts";
import { waitWords } from "../src/commons/waits.ts";
import { TelegramGateway } from "../src/channels/telegram/gateway.ts";
import { CutPause, sayingWhyItWaits, StartWait, TELEGRAM_UNREACHABLE, telegramWait } from "../src/channels/telegram/waits.ts";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";
import { discordWait } from "../src/channels/discord/waits.ts";
import { eventually } from "./wait.ts";

const restores: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) await restore();
});

/** A gateway whose connect is in the test's hands: it answers when `answer` is called, with whether it worked. */
class Waiting extends BaseGateway {
  answer: ((worked: boolean) => void) | null = null;
  connects = 0;
  constructor(resilience: Partial<GatewayResilienceConfig> = {}) {
    super({ id: "telegram:nouva", platform: "telegram" }, { healthCheckIntervalMs: 3_600_000, reconnectBackoffMs: 1, reconnectBackoffMaxMs: 2, ...resilience });
  }
  protected connect(): Promise<void> {
    this.connects += 1;
    return new Promise((resolve, reject) => (this.answer = (worked) => (worked ? resolve() : reject(new Error("no")))));
  }
  protected async disconnect(): Promise<void> {}
  protected async deliver(_msg: OutboundMessage): Promise<string[]> {
    return [];
  }
  protected async ping(): Promise<boolean> {
    return true;
  }
  /** As an adapter says it, from what its platform answered. */
  says(reason: string, until?: number): void {
    this.waitingFor(reason, until);
  }
}

function starting(resilience: Partial<GatewayResilienceConfig> = {}) {
  const gateway = new Waiting(resilience);
  // The warn lines so far, each time it is asked: held lines are handed over once, so they are taken and held anew.
  const lines: LogEntry[] = [];
  let release = holdLines();
  const said = () => {
    lines.push(...release());
    release = holdLines();
    return lines.filter((line) => line.message === "waiting to connect").map((line) => line.data);
  };
  restores.push(() => void release(), () => gateway.stop());
  void gateway.start();
  return { gateway, said };
}

describe("what a connection waits on, kept by its supervisor", () => {
  test("said while it connects: kept with when it began and when the platform said to come back, and logged once", async () => {
    const { gateway, said } = starting();
    await eventually(() => gateway.status === "connecting", 2_000, "connecting");
    expect(gateway.waiting).toBeNull();
    const before = Date.now();
    gateway.says("Telegram asked this bot to wait 30 minutes.", before + 1_800_000);
    expect(gateway.waiting).toMatchObject({ reason: "Telegram asked this bot to wait 30 minutes.", until: before + 1_800_000 });
    expect(gateway.waiting!.since).toBeGreaterThanOrEqual(before);
    const since = gateway.waiting!.since;
    // The same answer again a minute on, as a client that retries gets it: nothing new to say, and the wait began when it began.
    const clock = spyOn(Date, "now").mockReturnValue(before + 60_000);
    try {
      gateway.says("Telegram asked this bot to wait 30 minutes.", before + 1_800_000);
    } finally {
      clock.mockRestore();
    }
    expect(gateway.waiting!.since).toBe(since);
    expect(said()).toEqual([{ reason: "Telegram asked this bot to wait 30 minutes.", until: new Date(before + 1_800_000).toISOString() }]);
    // Another reason is another line.
    gateway.says("Telegram could not be reached.");
    expect(gateway.waiting).toMatchObject({ reason: "Telegram could not be reached." });
    expect(gateway.waiting!.until).toBeUndefined();
    expect(said()).toHaveLength(2);
  });

  test("the wait is over with the connect it was said in: up, or failed and trying again", async () => {
    const { gateway } = starting();
    await eventually(() => gateway.answer !== null, 2_000, "the first connect");
    gateway.says("Telegram asked this bot to wait 2 minutes.");
    gateway.answer!(false);
    await eventually(() => gateway.connects === 2 && gateway.status === "connecting", 2_000, "the second connect");
    // Failed, and a connect begun anew: what the first waited on is not this one's.
    expect(gateway.waiting).toBeNull();
    gateway.says("Telegram asked this bot to wait 1 minute.");
    gateway.answer!(true);
    await eventually(() => gateway.status === "connected", 2_000, "connected");
    expect(gateway.waiting).toBeNull();
  });

  test("nothing is kept of a wait said while it is connected, or once it is stopped", async () => {
    const { gateway, said } = starting();
    await eventually(() => gateway.answer !== null, 2_000, "the connect");
    gateway.answer!(true);
    await eventually(() => gateway.status === "connected", 2_000, "connected");
    gateway.says("Telegram asked this bot to wait 5 seconds.");
    expect(gateway.waiting).toBeNull();
    await gateway.stop();
    gateway.says("Telegram asked this bot to wait 5 seconds.");
    expect(gateway.waiting).toBeNull();
    expect(said()).toEqual([]);
  });

});

describe("a connect nothing has answered", () => {
  // The clock is the test's: what is held is when it speaks, to the millisecond, and that it then stays quiet.
  function watched(connecting = { yes: true }) {
    jest.useFakeTimers();
    restores.push(() => void jest.useRealTimers());
    const lines: string[] = [];
    const log = { warn: (message: string, data?: Record<string, unknown>) => void lines.push(`${message} ${JSON.stringify(data)}`), error: () => {}, info: () => {}, debug: () => {} } as unknown as Logger;
    return { wait: new ConnectWait(log, () => connecting.yes), lines, connecting };
  }

  test("says so by itself once it has been long enough, and no sooner", () => {
    const { wait, lines } = watched();
    wait.begin(30_000, () => true);
    jest.advanceTimersByTime(29_999);
    expect(wait.now).toBeNull();
    jest.advanceTimersByTime(1);
    expect(wait.now).toMatchObject({ reason: "It has not answered yet." });
    expect(lines).toEqual(['waiting to connect {"reason":"It has not answered yet."}']);
  });

  test("does not speak over what the adapter said", () => {
    const { wait, lines } = watched();
    wait.begin(30_000, () => true);
    wait.say("Telegram asked this bot to wait 30 minutes.");
    jest.advanceTimersByTime(60_000);
    expect(wait.now).toMatchObject({ reason: "Telegram asked this bot to wait 30 minutes." });
    expect(lines).toHaveLength(1);
  });

  test("says nothing of a connect that was over in time, or that is no longer the one it timed", () => {
    const over = watched();
    over.wait.begin(30_000, () => true);
    jest.advanceTimersByTime(2_000);
    over.wait.end();
    jest.advanceTimersByTime(60_000);
    expect(over.wait.now).toBeNull();
    // Still on its way up, and not the connect this was begun for: reconnecting after it failed.
    const moved = watched();
    moved.wait.begin(30_000, () => false);
    jest.advanceTimersByTime(60_000);
    expect(moved.wait.now).toBeNull();
    expect([...over.lines, ...moved.lines]).toEqual([]);
  });

  test("a connect begun anew starts its own half minute, and forgets what the last waited on", () => {
    const { wait } = watched();
    wait.begin(30_000, () => true);
    wait.say("Telegram asked this bot to wait 2 minutes.");
    jest.advanceTimersByTime(20_000);
    wait.begin(30_000, () => true);
    expect(wait.now).toBeNull();
    jest.advanceTimersByTime(29_999);
    expect(wait.now).toBeNull();
    jest.advanceTimersByTime(1);
    expect(wait.now).toMatchObject({ reason: "It has not answered yet." });
  });

  test("the supervisor gives it the half minute its config names, and ends it with the connect", async () => {
    const { gateway, said } = starting({ slowConnectMs: 25 });
    await eventually(() => gateway.waiting !== null, 2_000, "said to be slow");
    expect(gateway.waiting!.reason).toBe("It has not answered yet.");
    expect(said()).toEqual([{ reason: "It has not answered yet." }]);
    gateway.answer!(true);
    await eventually(() => gateway.status === "connected", 2_000, "connected");
    expect(gateway.waiting).toBeNull();
  });
});

describe("a length of time, as a person says it", () => {
  test("to the unit that matters", () => {
    expect([1, 45, 89, 90, 1800, 3540, 3600, 3900, 7200].map(waitWords)).toEqual(["1 second", "45 seconds", "89 seconds", "2 minutes", "30 minutes", "59 minutes", "1 hour", "1 hour 5 minutes", "2 hours"]);
    expect(waitWords(0)).toBe("1 second");
  });
});

describe("what Telegram's answer makes a connect wait on", () => {
  const NOW = 1_795_000_000_000;

  test("asked to wait: for how long, why, that it comes back by itself, and until when", () => {
    expect(telegramWait({ ok: false, error_code: 429, parameters: { retry_after: 1800 } }, NOW)).toEqual({
      reason: "Telegram asked this bot to wait 30 minutes before it connects: too many requests in a short time, as after several restarts close together. It connects by itself once the wait is over.",
      until: NOW + 1_800_000,
    });
    // No time named: said without one, and nothing invented for it.
    expect(telegramWait({ ok: false, error_code: 429 }, NOW)).toEqual({ reason: "Telegram asked this bot to wait before it connects: too many requests in a short time. It is being tried again." });
  });

  test("an error of Telegram's own is said with its number; a refusal the start gives up at, and a success, are no wait", () => {
    expect(telegramWait({ ok: false, error_code: 502 }, NOW)).toEqual({ reason: "Telegram answered with an error of its own (502). It is being tried again." });
    expect(telegramWait({ ok: false, error_code: 401 }, NOW)).toBeNull();
    expect(telegramWait({ ok: false, error_code: 404 }, NOW)).toBeNull();
    expect(telegramWait({ ok: true }, NOW)).toBeNull();
  });

  test("every call of a bot that is starting passes the watcher: a wait is said, and taken from the library as a StartWait", async () => {
    const said: [string, number | undefined][] = [];
    let isStarting = true;
    const watch = sayingWhyItWaits(() => isStarting, (reason, until) => void said.push([reason, until]), () => NOW);
    const answered = (answer: unknown) => (async () => answer) as never;
    const refusal = { ok: false, error_code: 429, description: "Too Many Requests: retry after 1800", parameters: { retry_after: 1800 } };
    // Asked to wait: said with the time, and thrown with how long, which the library's own retry lets through.
    const asked = await watch(answered(refusal), "getMe", {} as never).catch((err: unknown) => err);
    expect(asked).toBeInstanceOf(StartWait);
    expect((asked as StartWait).waitMs).toBe(1_800_000);
    expect(said).toEqual([[telegramWait(refusal, NOW)!.reason, NOW + 1_800_000]]);
    // An error of its own, and no answer at all: said, and thrown with no time, for the adapter's own backoff.
    const own = await watch(answered({ ok: false, error_code: 502 }), "getMe", {} as never).catch((err: unknown) => err);
    expect([own instanceof StartWait, (own as StartWait).waitMs]).toEqual([true, undefined]);
    const none = await watch((async () => { throw new Error("fetch failed"); }) as never, "getMe", {} as never).catch((err: unknown) => err);
    expect([none instanceof StartWait, (none as StartWait).waitMs, (none as StartWait).reason]).toEqual([true, undefined, TELEGRAM_UNREACHABLE]);
    expect(said.at(-1)).toEqual([TELEGRAM_UNREACHABLE, undefined]);
    // A success, and a refusal the start gives up at, go on to the library as they came.
    const ok = { ok: true, result: {} };
    expect(await watch(answered(ok), "getMe", {} as never)).toBe(ok as never);
    const wrongToken = { ok: false, error_code: 401, description: "Unauthorized" };
    expect(await watch(answered(wrongToken), "getMe", {} as never)).toBe(wrongToken as never);
    expect(said).toHaveLength(3);
    // Once it has started, a slow-down on a send is that send's own matter, said where sends are paced.
    isStarting = false;
    expect(await watch(answered(refusal), "sendMessage", {} as never)).toBe(refusal as never);
    await expect(watch((async () => { throw new Error("fetch failed"); }) as never, "getUpdates", {} as never)).rejects.toThrow("fetch failed");
    expect(said).toHaveLength(3);
  });
});

describe("a Telegram start that has to wait", () => {
  const ME = { id: 1, is_bot: true, first_name: "Nouva", username: "nouva_bot", can_read_all_group_messages: true } as Bot["botInfo"];
  const answered = (answer: unknown) => (async () => answer) as never;

  /** A gateway whose bot answers its start by a plan, through what the adapter installed; its waits are the test's to end. */
  function starts(plan: (unknown | Error)[], resilience: Record<string, number> = {}) {
    const waits: number[] = [];
    let go: (() => void) | null = null;
    let inits = 0;
    const init = spyOn(Bot.prototype, "init").mockImplementation(async function (this: Bot) {
      inits += 1;
      const step = plan[Math.min(inits - 1, plan.length - 1)];
      // Telegram's answer to "who am I", through the newest transformer: the adapter's watcher.
      const watcher = this.api.config.installedTransformers().at(-1)!;
      const result = (await watcher(step instanceof Error ? ((async () => { throw step; }) as never) : answered(step), "getMe", {} as never)) as { ok: boolean; error_code?: number; description?: string };
      if (!result.ok) throw new GrammyError("Call to 'getMe' failed!", result as never, "getMe", {});
      this.botInfo = ME;
    });
    const start = spyOn(Bot.prototype, "start").mockImplementation(() => new Promise<void>(() => {}));
    const stop = spyOn(Bot.prototype, "stop").mockImplementation(async () => {});
    const gateway = new TelegramGateway({ id: "telegram:nouva", platform: "telegram", token: "1:a", mode: "polling", resilience: { healthCheckIntervalMs: 3_600_000, reconnectBackoffMs: 1_000, reconnectBackoffMaxMs: 60_000, ...resilience } });
    // The wait a start is in: how long it was asked to be, and over when the test says.
    (gateway as unknown as { startPause: { wait: (ms: number) => Promise<void>; end: () => void } }).startPause = { wait: (ms) => (waits.push(ms), new Promise((done) => (go = done))), end: () => {} };
    restores.push(() => init.mockRestore(), () => start.mockRestore(), () => stop.mockRestore(), () => gateway.stop());
    return { gateway, waits, inits: () => inits, over: () => (go?.(), (go = null)) };
  }

  test("asked to come back later: its connection says so, it waits as long as Telegram named, asks again, and is up", async () => {
    const { gateway, waits, inits, over } = starts([{ ok: false, error_code: 429, description: "Too Many Requests: retry after 1800", parameters: { retry_after: 1800 } }, { ok: true }]);
    void gateway.start();
    await eventually(() => waits.length === 1, 2_000, "the wait");
    expect(gateway.status).toBe("connecting");
    expect(gateway.waiting!.reason).toStartWith("Telegram asked this bot to wait 30 minutes before it connects");
    expect(gateway.waiting!.until! - gateway.waiting!.since).toBeGreaterThan(1_790_000);
    // The whole of what Telegram named, by this adapter: not the library's retry, which was never reached.
    expect(waits[0]).toBeGreaterThan(1_799_000);
    expect(waits[0]).toBeLessThanOrEqual(1_800_000);
    expect(inits()).toBe(1);
    over();
    await eventually(() => gateway.status === "connected", 2_000, "connected");
    expect(inits()).toBe(2);
    expect(gateway.waiting).toBeNull();
    // Started: the bot is no longer the one being started, and its watcher lets every answer through from here on.
    expect((gateway as unknown as { starting?: Bot }).starting).toBeUndefined();
  });

  test("an error of Telegram's own, then no answer at all: asked again at this connection's pace, a second doubling, not a hundred", async () => {
    const { gateway, waits, inits, over } = starts([{ ok: false, error_code: 502 }, new Error("fetch failed"), { ok: false, error_code: 502 }, { ok: true }]);
    void gateway.start();
    for (const tries of [1, 2, 3]) {
      await eventually(() => waits.length === tries, 2_000, `wait ${tries}`);
      over();
    }
    await eventually(() => gateway.status === "connected", 2_000, "connected");
    expect(inits()).toBe(4);
    // Half to all of one, two and four seconds: the backoff every reconnect has.
    expect(waits.map((ms, index) => ms >= 500 * 2 ** index && ms <= 1_000 * 2 ** index)).toEqual([true, true, true]);
  });

  test("a wrong token is still the token's: no wait, the connection given up as before", async () => {
    const { gateway, waits } = starts([{ ok: false, error_code: 401, description: "Unauthorized" }], { reconnectBackoffMs: 1, reconnectBackoffMaxMs: 2 });
    void gateway.start();
    await eventually(() => gateway.status === "dead", 3_000, "given up");
    expect(waits).toEqual([]);
  });

  test("stopped while it waits: the wait ends at once and nothing is asked again", async () => {
    const waited = starts([{ ok: false, error_code: 429, parameters: { retry_after: 1800 } }, { ok: true }]);
    // The adapter's own wait, not the test's: a real timer that would run half an hour.
    (waited.gateway as unknown as { startPause: CutPause }).startPause = new CutPause();
    let over = false;
    void waited.gateway.start().finally(() => (over = true));
    await eventually(() => waited.gateway.waiting !== null, 2_000, "waiting");
    await waited.gateway.stop();
    // The connect that was waiting is over now, not in half an hour: nothing is left holding a timer.
    await eventually(() => over, 2_000, "the waiting connect to end");
    expect(waited.gateway.status).toBe("disconnected");
    expect(waited.inits()).toBe(1);
    expect(waited.gateway.waiting).toBeNull();
  });
});

describe("what a Discord login waits on", () => {
  test("a limit met while it logs in is said, with how long; one met by a client that was replaced is not this connection's", async () => {
    expect(discordWait(90_000)).toBe("Discord asked this bot to wait 2 minutes before it connects: too many requests in a short time. It connects by itself once the wait is over.");
    const clients: Client[] = [];
    // The first login fails, as one that timed out; the retry's never answers.
    const login = spyOn(Client.prototype, "login").mockImplementation(function (this: Client) {
      clients.push(this);
      return clients.length === 1 ? Promise.reject(new Error("login timed out")) : new Promise<string>(() => {});
    });
    const destroy = spyOn(Client.prototype, "destroy").mockImplementation(async () => {});
    const gateway = new DiscordGateway({ id: "discord:nouva", platform: "discord", token: "t", resilience: { healthCheckIntervalMs: 3_600_000, reconnectBackoffMs: 1, reconnectBackoffMaxMs: 2 } });
    restores.push(() => login.mockRestore(), () => destroy.mockRestore(), () => gateway.stop());
    void gateway.start();
    await eventually(() => clients.length === 2 && gateway.status === "connecting", 3_000, "the second login");
    expect(gateway.waiting).toBeNull();
    // The client the retry replaced is still there, and meets a limit: not this connection's to say.
    clients[0]!.rest.emit("rateLimited", { timeToReset: 5_000, global: true } as never);
    expect(gateway.waiting).toBeNull();
    const before = Date.now();
    clients[1]!.rest.emit("rateLimited", { timeToReset: 90_000, global: true } as never);
    expect(gateway.waiting).toMatchObject({ reason: discordWait(90_000) });
    expect(gateway.waiting!.until!).toBeGreaterThanOrEqual(before + 90_000);
  });
});

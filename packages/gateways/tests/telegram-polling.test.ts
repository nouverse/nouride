/**
 * The Telegram polling loop's failure classification.
 *
 * The adapter itself needs a live connection and is the least unit-testable part of the repo, but the
 * decision that made it unstable is pure: which failures can be retried immediately, and which have to
 * wait for something on Telegram's side to expire. Getting that wrong in either direction is expensive —
 * a fast retry after a conflict is guaranteed to fail, and a slow retry after a dropped socket is dead
 * inbound for no reason.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { Api, Bot, GrammyError } from "grammy";
import { POLL_PROVES_ALIVE_MS, TelegramGateway, isConflict, pollingOptions } from "../src/channels/telegram/gateway.ts";

/**
 * Telling a 409 apart from every other failure.
 *
 * `409 Conflict: terminated by other getUpdates request` is the one Telegram error that cannot be
 * retried quickly: Telegram holds the session open server-side for ~30s after the client goes away, so
 * a fast reconnect is refused however clean the local teardown was. Everything else should retry on the
 * ordinary backoff — a 30-second floor on a dropped socket would be 30 seconds of dead inbound.
 */
describe("isConflict", () => {
  test("a GrammyError carrying 409 is a conflict", () => {
    expect(isConflict(new GrammyError("Call to 'getUpdates' failed!", { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }, "getUpdates", {}))).toBe(true);
  });

  test("other Telegram errors are not", () => {
    // A 400 is a bad request and a 401 is a bad token. Neither is helped by waiting half a minute.
    for (const code of [400, 401, 403, 429, 500]) {
      expect(
        isConflict(new GrammyError("failed", { ok: false, error_code: code, description: "x" }, "getUpdates", {})),
      ).toBe(false);
    }
  });

  test("a wrapped conflict is still a conflict", () => {
    // The polling loop can surface the same failure re-thrown, and `instanceof` does not survive a
    // second copy of the module. The code is still in the text.
    expect(isConflict(new Error("GrammyError: Call to 'getUpdates' failed! (409: Conflict: ...)"))).toBe(true);
  });

  test("a number that is not a status code does not read as one", () => {
    // Matched on the code as a whole word, so an unrelated 4090 or a chat id is not a conflict.
    expect(isConflict(new Error("HttpError: Network request failed after 4090ms"))).toBe(false);
    expect(isConflict(new Error("timeout"))).toBe(false);
    expect(isConflict(undefined)).toBe(false);
  });
});

/**
 * The health check asks Telegram nothing while polls are answering (E11).
 *
 * It sent `getMe` every thirty seconds per bot beside a thirty-second long poll: four requests a minute at idle, two
 * of them to learn what the last poll already said. A poll answers at least every fifty seconds now, and is the proof.
 */
describe("the health check, beside a long poll", () => {
  async function started() {
    const init = spyOn(Bot.prototype, "init").mockImplementation(async function (this: Bot) {
      this.botInfo = { id: 1, is_bot: true, first_name: "Nouva", username: "nouva_bot", can_read_all_group_messages: true } as Bot["botInfo"];
    });
    const start = spyOn(Bot.prototype, "start").mockImplementation(() => new Promise<void>(() => {}));
    const getMe = spyOn(Api.prototype, "getMe").mockImplementation(async () => ({}) as Awaited<ReturnType<Api["getMe"]>>);
    const gateway = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling", resilience: { healthCheckIntervalMs: 3_600_000 } });
    await gateway.start();
    const inner = gateway as unknown as { alive(now?: number): Promise<boolean>; bot: Bot };
    return {
      gateway,
      inner,
      getMe,
      restore: async () => {
        await gateway.stop();
        init.mockRestore();
        start.mockRestore();
        getMe.mockRestore();
      },
    };
  }

  test("a poll that answered is proof, and getMe is not sent", async () => {
    const { inner, getMe, restore } = await started();
    try {
      // A poll comes back empty — what an idle bot's do every fifty seconds — through the transformer the gateway
      // installed on its bot, with Telegram's half answered here rather than over the network.
      const [record] = inner.bot.api.config.installedTransformers();
      const answered = async () => ({ ok: true as const, result: [] });
      await record!(answered as never, "getUpdates", { timeout: 50 } as never, undefined);
      expect(await inner.alive()).toBe(true);
      expect(await inner.alive(Date.now() + POLL_PROVES_ALIVE_MS - 1_000)).toBe(true);
      expect(getMe).not.toHaveBeenCalled();
      // Two windows later with nothing back, it asks.
      expect(await inner.alive(Date.now() + POLL_PROVES_ALIVE_MS + 1_000)).toBe(true);
      expect(getMe).toHaveBeenCalledTimes(1);
    } finally {
      await restore();
    }
  });

  test("a call that is not a poll proves nothing about the poll", async () => {
    const { inner, getMe, restore } = await started();
    try {
      const [record] = inner.bot.api.config.installedTransformers();
      await record!((async () => ({ ok: true as const, result: {} })) as never, "sendMessage", {} as never, undefined);
      await inner.alive();
      expect(getMe).toHaveBeenCalledTimes(1);
    } finally {
      await restore();
    }
  });

  test("a poll gone quiet for two windows is asked about, the way it always was", async () => {
    const { inner, getMe, restore } = await started();
    try {
      // No poll has answered on this connection.
      expect(await inner.alive()).toBe(true);
      expect(getMe).toHaveBeenCalledTimes(1);
    } finally {
      await restore();
    }
  });

  test("polls hold the most Telegram allows, and the request outlasts them", () => {
    expect(pollingOptions().timeout).toBe(50);
    expect(POLL_PROVES_ALIVE_MS).toBe(100_000);
  });
});

describe("what a poll asks Telegram for", () => {
  /**
   * What the adapter handles, and nothing else (G10): messages, a person's edit of one, and a press on a button under
   * ours (G11). Without the list Telegram sent every kind the bot may see — channel posts, member changes — over the
   * card's network, to be dropped.
   */
  test("messages, their edits and presses only — and pending ones are kept, for the inbox to decide", () => {
    expect(pollingOptions()).toMatchObject({ allowed_updates: ["message", "edited_message", "callback_query"], drop_pending_updates: false });
  });

  test("and that is what the poll the gateway starts asks for", async () => {
    const asked: unknown[] = [];
    // Telegram itself is not reached: `init` answers with who the bot is, and `start` with a poll that never ends.
    const init = spyOn(Bot.prototype, "init").mockImplementation(async function (this: Bot) {
      this.botInfo = { id: 1, is_bot: true, first_name: "Nouva", username: "nouva_bot", can_read_all_group_messages: true } as Bot["botInfo"];
    });
    const start = spyOn(Bot.prototype, "start").mockImplementation((options) => {
      asked.push(options);
      return new Promise<void>(() => {});
    });
    const gateway = new TelegramGateway({ id: "telegram:main", platform: "telegram", token: "1:a", mode: "polling", resilience: { healthCheckIntervalMs: 3_600_000 } });
    try {
      await gateway.start();
      expect(asked).toEqual([expect.objectContaining({ allowed_updates: ["message", "edited_message", "callback_query"], drop_pending_updates: false })]);
    } finally {
      await gateway.stop();
      init.mockRestore();
      start.mockRestore();
    }
  });
});

/**
 * A Discord shard's reconnects are in the journal.
 *
 * discord.js brings a shard back by itself, and nothing was logged when it did — so a step in an idle box's memory,
 * with nothing in the journal at that moment, could not be tied to a resume or a new session, nor ruled out
 * (memory-growth-since-0-6). Asserted on `logShardLifecycle`, which `connect` hands its client, with the events emitted
 * on a stand-in under the names and arguments discord.js gives them (`Client`'s own `on` types the listeners).
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Events, type Client } from "discord.js";
import type { LogContext, Logger } from "@nouride/shared";
import { logShardLifecycle } from "../src/channels/discord/gateway.ts";

interface Line {
  level: string;
  message: string;
  context?: LogContext;
}

/** A logger that keeps its lines; `failInfo` makes an info line throw, as a broken sink might. */
function recorder(failInfo = false): { log: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: string) => (message: string, context?: LogContext) => {
    if (failInfo && level === "info") throw new Error("the line could not be written");
    lines.push({ level, message, ...(context ? { context } : {}) });
  };
  const log: Logger = { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => log };
  return { log, lines };
}

function standIn(): EventEmitter & Pick<Client, "on"> {
  return new EventEmitter() as EventEmitter & Pick<Client, "on">;
}

describe("a shard's reconnects", () => {
  test("reconnecting, resumed and a new session are each a line at info", () => {
    const client = standIn();
    const { log, lines } = recorder();
    logShardLifecycle(client, log, () => true);

    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardResume, 0, 12);
    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardReady, 0, new Set(["111", "222"]));

    expect(lines).toEqual([
      { level: "info", message: "shard reconnecting", context: { shard: 0 } },
      { level: "info", message: "shard resumed", context: { shard: 0, replayed_events: 12 } },
      { level: "info", message: "shard reconnecting", context: { shard: 0 } },
      { level: "info", message: "shard ready with a new session", context: { shard: 0, unavailable_guilds: 2 } },
    ]);
  });

  test("a session with every guild available says none are missing", () => {
    // discord.js passes `undefined` rather than an empty set when nothing is unavailable.
    const client = standIn();
    const { log, lines } = recorder();
    logShardLifecycle(client, log, () => true);
    client.emit(Events.ShardReady, 0, undefined);
    expect(lines).toEqual([{ level: "info", message: "shard ready with a new session", context: { shard: 0, unavailable_guilds: 0 } }]);
  });

  test("a replaced client's are not this connection's, and say nothing", () => {
    const client = standIn();
    const { log, lines } = recorder();
    logShardLifecycle(client, log, () => false);
    client.emit(Events.ShardReconnecting, 0);
    client.emit(Events.ShardResume, 0, 3);
    client.emit(Events.ShardReady, 0, undefined);
    expect(lines).toEqual([]);
  });

  test("a line that cannot be written stays in the listener: the socket that emitted it carries on", () => {
    // discord.js emits from its socket, so a throw out of a listener is uncaught — and the daemon stops on one.
    const client = standIn();
    const { log, lines } = recorder(true);
    logShardLifecycle(client, log, () => true);
    expect(() => client.emit(Events.ShardResume, 0, 1)).not.toThrow();
    expect(lines).toEqual([
      { level: "error", message: "could not log a shard resuming", context: expect.objectContaining({ error: "Error: the line could not be written" }) },
    ]);
  });
});

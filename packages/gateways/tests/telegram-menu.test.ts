/**
 * Telegram's command menu takes a name of `[a-z0-9_]` only, and one name it refuses refuses the whole list.
 * `/daemon-restart` is the first command with a hyphen, so the menu would have stopped updating at all.
 */

import { describe, expect, test } from "bun:test";
import { telegramMenu } from "../src/channels/telegram/gateway.ts";

describe("telegramMenu", () => {
  test("spells a hyphenated command the only way Telegram takes it, and leaves the rest alone", () => {
    expect(
      telegramMenu([
        { command: "daemon-restart", description: "Restart the daemon" },
        { command: "memory-pass-now", description: "Run the pass" },
        { command: "status", description: "Model, uptime" },
      ]),
    ).toEqual([
      { command: "daemon_restart", description: "Restart the daemon" },
      // Every hyphen, not the first: one left behind is still a name Telegram refuses, and the whole menu with it.
      { command: "memory_pass_now", description: "Run the pass" },
      { command: "status", description: "Model, uptime" },
    ]);
  });
});

/**
 * `nouride status` says what a connection that is not up yet waits on.
 *
 * "telegram:nouva:connecting" for half an hour reads as hung. Where the connection said why, the reason is a line of
 * its own under the gateways, in `nouride status` and in `nouride gateway`; a connection that said nothing adds none.
 */

import { expect, spyOn, test } from "bun:test";
import type { Client, StatusResponse } from "@nouride/cli-kit";
import { gateway } from "../src/commands/gateway.ts";
import { status } from "../src/commands/status.ts";

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

async function printed(gateways: StatusResponse["gateways"], command: (client: Client) => Promise<void> = status): Promise<string[]> {
  const answer = { status: "ready", uptime: 12, configSource: "/srv/nouride/.nouride/config.toml", agents: [], gateways, queue: { running: 0, waiting: 0 }, pendingApprovals: 0, failures: [] } as unknown as StatusResponse;
  const client = { get: async <T>() => answer as T } as unknown as Client;
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(plain(String(line ?? ""))));
  try {
    await command(client);
  } finally {
    log.mockRestore();
  }
  return lines;
}

test("a connection that waits is named under the gateways, with its reason", async () => {
  const lines = await printed([
    { id: "telegram:nouva", platform: "telegram", status: "connecting", waiting: "Telegram asked this bot to wait 30 minutes before it connects." },
    { id: "discord:nouva", platform: "discord", status: "connected" },
  ]);
  expect(lines).toContain("  gateways telegram:nouva:connecting, discord:nouva:connected");
  expect(lines).toContain("  waiting  telegram:nouva: Telegram asked this bot to wait 30 minutes before it connects.");
});

test("none that waits, no such line", async () => {
  const lines = await printed([{ id: "telegram:nouva", platform: "telegram", status: "connecting" }]);
  // The queue's own line says "0 waiting": the line looked for is the one that begins with the word.
  expect(lines.some((line) => line.trimStart().startsWith("waiting "))).toBe(false);
});

test("`nouride gateway` says it under the connection that waits, and under no other", async () => {
  const lines = await printed(
    [
      { id: "telegram:nouva", platform: "telegram", status: "connecting", waiting: "Telegram asked this bot to wait 30 minutes before it connects." },
      { id: "discord:nouva", platform: "discord", status: "connected" },
    ],
    (client) => gateway(client, []),
  );
  expect(lines).toEqual(["● telegram:nouva telegram · connecting", "  Telegram asked this bot to wait 30 minutes before it connects.", "● discord:nouva discord · connected"]);
});

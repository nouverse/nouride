/**
 * The command menu a Discord bot publishes (`syncCommands`). Discord takes a description of a hundred characters and
 * refuses the whole list over one that is longer: live, a description of 103 kept every command of six bots off the
 * menu, which went on showing the ones published before.
 */

import { expect, test } from "bun:test";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";

function connected() {
  const discord = new DiscordGateway({ id: "discord:nexa", platform: "discord", token: "t" });
  const sent: { name: string; description: string; options: unknown[] }[][] = [];
  (discord as unknown as { client: unknown }).client = { application: { commands: { set: async (list: (typeof sent)[number]) => void sent.push(list) } } };
  return { discord, sent };
}

test("a description longer than Discord takes is cut to it, and the rest of the menu is published as written", async () => {
  const { discord, sent } = connected();
  const long = `${"Who answers here ".repeat(6)}and more`;
  expect(long.length).toBeGreaterThan(100);

  expect(await discord.syncCommands([{ command: "mention", description: long }, { command: "status", description: "Show agent status" }])).toEqual({ synced: 2 });

  const [mention, status] = sent[0]!;
  expect(mention!.description).toHaveLength(100);
  expect(mention!.description).toBe(`${long.slice(0, 99)}…`);
  expect(status!.description).toBe("Show agent status");
});

test("one of exactly a hundred characters is left whole", async () => {
  const { discord, sent } = connected();
  const exact = "x".repeat(100);
  await discord.syncCommands([{ command: "mention", description: exact }]);
  expect(sent[0]![0]!.description).toBe(exact);
});

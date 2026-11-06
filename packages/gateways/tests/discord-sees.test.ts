/**
 * Whether a Discord bot can read a channel (`Gateway.sees`, 0.8.12). Live: in a server channel only Nouva's bot could
 * view, Nouva was told it could tag Nexa, tagged her, and Nexa's bot never received it. Read from the channels Discord
 * sends with each server — whether the bot may view them or not — so nothing is fetched on a turn.
 */

import { expect, test } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import { DiscordGateway } from "../src/channels/discord/gateway.ts";

const ME = { id: "200" };

function withChannels(channels: Record<string, unknown>, user: unknown = ME) {
  const discord = new DiscordGateway({ id: "discord:nexa", platform: "discord", token: "t" });
  (discord as unknown as { client: unknown }).client = { user, channels: { cache: new Map(Object.entries(channels)) } };
  return discord;
}

/** A server channel or thread, with what `permissionsFor` says of this bot. */
const channel = (viewable: boolean | null) => ({
  permissionsFor: (user: unknown) => (user === ME ? (viewable === null ? null : { has: (flag: bigint) => flag === PermissionFlagsBits.ViewChannel && viewable }) : null),
});

test("a channel the bot may view is seen; one it may not is not", () => {
  const discord = withChannels({ general: channel(false), office: channel(true) });
  expect(discord.sees("general")).toBe(false);
  expect(discord.sees("office")).toBe(true);
});

test("nothing is said where nothing can be: a DM, a channel not held, no permissions to read, not connected", () => {
  expect(withChannels({ dm: { type: 1 } }).sees("dm")).toBeUndefined();
  expect(withChannels({}).sees("elsewhere")).toBeUndefined();
  expect(withChannels({ odd: channel(null) }).sees("odd")).toBeUndefined();
  expect(withChannels({ general: channel(true) }, null).sees("general")).toBeUndefined();
});

/**
 * How much of Discord's state a connection keeps in memory.
 *
 * Measured on a live box before this existed: the daemon started at 76MB and climbed to 97MB over
 * twenty minutes — roughly a megabyte a minute until the caches plateaued. discord.js bounds only
 * `MessageManager` (200 per channel) and leaves `UserManager`, `GuildMemberManager`,
 * `PresenceManager` and `ReactionManager` unbounded, with a sweeper that only sweeps threads. With
 * one bot per agent that is six of everything.
 *
 * None of it was read: `message.member?.displayName` and `message.mentions.users` arrive on the
 * gateway payload, and `channel.messages.fetch()` is a REST call by definition. So the defaults here
 * are zero, and the knobs exist for an operator who finds a reason to buy one back.
 *
 * Asserted on `discordCacheSettings`, the function `connect` hands discord.js. These tests used to rebuild the settings
 * in a helper of their own, so the adapter could have asked for anything and every one of them stayed green.
 */

import { describe, expect, test } from "bun:test";
import { Options } from "discord.js";
import { discordCacheSettings } from "../src/channels/discord/gateway.ts";

describe("the defaults discord.js ships", () => {
  test("bound messages and nothing else, which is the problem", () => {
    // Pinned so a discord.js upgrade that changes it shows up here rather than as memory growth
    // nobody attributes to a dependency.
    expect(Options.DefaultMakeCacheSettings).toEqual({ MessageManager: 200 });
  });

  test("sweep only threads, so anything cached by traffic stays", () => {
    expect(Object.keys(Options.DefaultSweeperSettings)).toEqual(["threads"]);
  });
});

describe("what Nouride asks for instead", () => {
  test("everything that grows with traffic is off by default", () => {
    const settings = discordCacheSettings();
    expect(settings.MessageManager).toBe(0);
    expect(settings.UserManager).toBe(0);
    expect(settings.GuildMemberManager.maxSize).toBe(0);
    expect(settings.PresenceManager).toBe(0);
    expect(settings.ReactionManager).toBe(0);
  });

  test("the bot's own member is kept whatever the limit — its permissions are read from it", () => {
    // 0.8.12: with no member cached, `permissionsFor` on a channel said nothing, and whether the bot may view it
    // (`Gateway.sees`) was unknowable — an agent whose bot could not read a room was still offered to be tagged there.
    const keep = discordCacheSettings().GuildMemberManager.keepOverLimit;
    const client = { user: { id: "200" } };
    expect(keep({ id: "200", client })).toBe(true);
    expect(keep({ id: "201", client })).toBe(false);
  });

  test("channels and guilds are left alone", () => {
    // `resolveChannel` reads `client.channels.cache` before falling back to a fetch, and discord.js
    // needs guilds to resolve a channel at all. Both are bounded by how many places the bot was added
    // to rather than by traffic, so neither is worth turning off.
    const settings: Record<string, unknown> = discordCacheSettings();
    expect(settings.ChannelManager).toBeUndefined();
    expect(settings.GuildManager).toBeUndefined();
  });

  test("an operator can buy a cache back", () => {
    const settings = discordCacheSettings({ messages: 50, members: 100 });
    expect(settings.MessageManager).toBe(50);
    expect(settings.GuildMemberManager.maxSize).toBe(100);
    // Untouched knobs stay at the default rather than inheriting the one that was set.
    expect(settings.UserManager).toBe(0);
  });

  test("the settings are accepted by discord.js itself", () => {
    // The one thing worth checking against the library: `cacheWithLimits` throws on a shape it does
    // not recognise, so a manager renamed upstream fails here rather than at the first message.
    expect(() => Options.cacheWithLimits(discordCacheSettings({ messages: 10 }))).not.toThrow();
  });
});

---
title: Discord
description: The intent you have to enable, channel bindings, and the cache setting that costs 20 MB.
---

Discord connects over the Gateway WebSocket.

## Setting it up

1. Create an application and a bot in the [Discord developer portal](https://discord.com/developers/applications).
2. **Enable the Message Content intent** under the Bot tab.
3. Invite the bot to your server with permission to read and send messages.
4. Store the token and add the connection:

   ```bash
   printf '%s' 'MTIz...' | nouride secret set discord-main --stdin
   ```

   ```toml
   [gateways.discord.main]
   enabled = true
   token = "discord-main"
   agent = "nouva"
   ```

5. Restart the daemon.

:::caution[Without the Message Content intent, every message arrives empty]
Which looks exactly like the bot ignoring you. It is the first thing to check.
:::

## Which channels an agent answers in

Set on the **agent**, not on the connection, because a connection is an identity and a binding is a
scope, and one agent may answer on several connections:

```toml
# .nouride/agents/nouva/config.toml
[channels]
"discord:main" = ["123456789012345678"]   # the channel's ID; a thread has its own
```

Turn on Developer Mode in Discord, then right-click a channel → **Copy Channel ID**.

Empty or absent means the agent answers when addressed by name, or always, if the connection names
it as its owner with `agent = "..."`.

## Slash commands

Each time it connects, the daemon registers its commands (`/status`, `/approve`, `/new`, …) as the
bot's own Discord slash commands, so they show in the picker under its name. Discord can take up to
an hour to show a change. Typing the command as a message, `@bot /status`, works too.

## The cache settings, and why they default to zero

```toml
[gateways.discord.main.cache]
messages = 0   # per channel
users    = 0   # global
members  = 0   # per guild
```

discord.js ships these unbounded, bar 200 messages per channel, with a sweeper that only sweeps
threads. With one bot per agent that is one set of caches *per connection*: measured on a live box,
six of them grew the daemon from 76 MB to 97 MB over twenty minutes.

Nothing in the adapter reads them. The message author and the member arrive on the gateway payload,
and fetching a message is a REST call either way, so the cost bought nothing.

Raise one only if something starts needing it. Channels and guilds are always cached and are not
configurable: those are bounded by how many places the bot was added to, rather than by traffic.

## Several Discord bots in one channel

This is the arrangement the multi-agent design is for, and it is where the interesting behaviour
lives, Discord fans every channel message out to every bot in the channel, so six bots means six
copies of one message.

The short version: in a channel with more than one of your bots, **a message has to be addressed**,
and a tag naming somebody else resolves to nobody rather than falling through.

[The full picture →](/en/docs/gateways/overview/#several-bots-in-one-channel)

Two practical consequences:

**A bot can only speak where it was invited.** Each agent answers through its *own* connection, and
nothing in config says which channels a bot is in. A log line reading `an agent's own connection
could not deliver here` means: invite that bot to the channel.

**A tag before a slash command is stripped.** Discord sends `<@self> /approve`, and both the command
parser and the queue's urgency check only recognise text that starts with `/`: so a tagged command
was neither a command nor urgent, and queued behind the very turn waiting to be approved. The adapter
removes leading tags of itself.

## Mentions

The engine never formats a mention itself, the syntax belongs to the platform. Each agent is handed
the exact token to type for every other agent, taken from that agent's own connection, which on
Discord is `<@id>`.

A bot's Discord *application name* is not its agent's id. `@Nero | Infra Agent` is what the portal
says; `nero` is the agent. Both resolve.

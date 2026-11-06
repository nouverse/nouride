---
title: Telegram
description: Creating a bot, group privacy mode, and answering approvals from the chat.
---

Telegram connects over the Bot API with long polling. Webhook mode is not implemented.

## Setting it up

1. Talk to [`@BotFather`](https://t.me/BotFather), send `/newbot`, and copy the token.
2. Store it, the config file holds only the *name* of a secret:

   ```bash
   printf '%s' '123456:ABC-DEF...' | nouride secret set telegram-nouva --stdin
   ```

3. Add the connection:

   ```toml
   [gateways.telegram.nouva]
   enabled = true
   token = "telegram-nouva"
   agent = "nouva"
   ```

4. Restart the daemon, then message the bot.

Or do all of it from the dashboard: **Agents → your agent → Connections**.

![Adding a Telegram connection in the dashboard](/media/gateway-telegram.png)

## Groups: privacy mode

By default, **Telegram delivers almost nothing from a group to your bot.** Not the daemon, Telegram.
With privacy mode on, a bot that is not an admin receives only commands and replies to its own
messages, **not** a message that tags its `@username`. From the chat that looks exactly like the bot
being down. Two ways to change that:

- BotFather → `/setprivacy` → **Disable**, then remove the bot from each group and add it again, or
- make the bot a group admin.

The daemon logs a warning at connect when privacy mode is on. Until one of those is true, the agent
answers only replies and commands in that group, and `group_context_messages` has nothing to work
with.

Telegram also never delivers one bot's messages to another bot, privacy mode or not. Two agents in the
same group see each other's replies because the daemon passes them along itself.

## Approvals

When an agent stops to ask permission, the request arrives in the chat as a message: what it wants to
run, and why it is asking. Answer it from the keyboard:

```
/approve
/approve always
/deny
```

`/approve always` is offered only when the request can become a standing grant. `/approve all`
answers everything waiting in the chat.

[Approvals →](/en/docs/manual/approvals/)

## The command menu

The daemon pushes its slash-command list into Telegram's native menu for each bot every time the
connection comes up, so the people using it do not have to know any of them.

```
/commands
```

Does the same by hand, if the menu ever looks out of date.

The list is generated from the same registry that answers the commands, because a list typed out a
second time is a list that goes stale.

## Reconnection

A dropped connection is tried again ten times, the wait doubling from one second to a minute, and
checked every thirty seconds while it is up. That pacing is the adapter's own; a `[resilience]` table
under the gateway set it until 0.8.0, and one still in `config.toml` is named in a warning and ignored.

A connection that exhausts its attempts is marked dead and raises an alert, if you configured
somewhere for alerts to go. Otherwise it is a line in the log, and you find out when you notice the
agent has gone quiet.

What was sent while the bot was offline is not thrown away: Telegram holds it, and the daemon answers
what is recent once it reconnects. [When the daemon restarts →](/en/docs/gateways/overview/#when-the-daemon-restarts)

```bash
nouride gateway                        # status of every connection
nouride gateway restart telegram:nouva
```

## Several Telegram bots

One connection per agent, each with its own token and its own `@username`:

```toml
[gateways.telegram.nouva]
enabled = true
token = "telegram-nouva"
agent = "nouva"

[gateways.telegram.nox]
enabled = true
token = "telegram-nox"
agent = "nox"
```

In a group holding both, addressing becomes required, a message naming nobody is answered by
nobody, rather than by both. [Why, and what counts as addressing →](/en/docs/gateways/overview/#several-bots-in-one-channel)

## Restricting who can use it

Access is handled by the daemon, not by Telegram. By default a stranger gets a pairing code and waits.

```bash
nouride access
nouride access approve <code>
```

[Who may talk to it →](/en/docs/manual/access/)

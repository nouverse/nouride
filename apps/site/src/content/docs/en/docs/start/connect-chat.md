---
title: Connect a chat app
description: Give an agent its own bot on Telegram, Discord or WhatsApp.
---

Nothing reaches an agent unless a gateway delivers it. A fresh daemon with no bot token is reachable
only from the dashboard and `nouride chat`: which is deliberate, and enough to get going.

When you are ready to reach it from your phone, add a **connection**.

## One bot per agent, not one bot for everything

Every connection is named: `telegram:nouva` is the Telegram connection called `nouva`. That name is
what lets one daemon run a separate identity per agent instead of a single bot that switches
personality.

A connection can name an agent as its owner, and then everything it receives goes to that agent
unless somebody else is addressed by name.

## From the dashboard

This is the shorter path, and the one that does not need you to touch a file.

1. **Agents → your agent → Connections.**
2. **Add Connection**, pick the platform, paste the token.
3. Save, then **restart**: the page offers a **Restart Runtime** button.

The restart is not optional and the dashboard says so: gateway adapters are built at boot, so a saved
connection is not yet a running one. The page shows "not started" rather than "disconnected" for a
connection that has never come up, because those are different problems.

![A connection saved but not started yet, with the Restart Runtime banner above it](/media/gateway-restart.png)

Credentials are **write-only** here. The token field on an existing connection is empty (its placeholder
only says *unchanged*), and empty means *leave it alone*: nothing reads a credential back, so there is
no stored value in the field to accidentally overwrite.

![The Connections tab of an agent](/media/dashboard-agent-connections.png)

## From the config file

The same thing, in `.nouride/config.toml`. Store the token first, the config file holds only the
*name* of a secret:

```bash
# Piped in rather than typed as an argument, so it never lands in your shell history.
printf '%s' '123456:ABC-DEF...' | nouride secret set telegram-nouva --stdin
```

```toml
[gateways.telegram.nouva]
enabled = true
token = "telegram-nouva"     # the NAME of the secret → $TELEGRAM_NOUVA, or the secret store
agent = "nouva"              # this bot is Nouva's
```

Then restart the daemon.

---

## Telegram

1. Talk to [`@BotFather`](https://t.me/BotFather), `/newbot`, and copy the token.
2. Store it and add the connection, as above.
3. Message the bot.

**In a group, a bot with privacy mode on gets almost nothing.** Unless it is an admin, Telegram hands
it only commands and replies to its own messages, not even a message that tags it. Either
`/setprivacy → Disable` in BotFather (then remove the bot from the group and add it again), or make
the bot a group admin.

Approvals arrive in the chat as a message you answer with `/approve` or `/deny`. See
[approvals](/en/docs/manual/approvals/).

![Adding a Telegram connection in the dashboard](/media/gateway-telegram.png)

[Full Telegram page →](/en/docs/gateways/telegram/)

---

## Discord

1. Create an application and a bot in the [Discord developer portal](https://discord.com/developers/applications).
2. **Enable the Message Content intent** under the Bot tab. Without it every message arrives empty,
   which looks like the bot ignoring you.
3. Invite the bot to your server, then store the token and add the connection.

```toml
[gateways.discord.main]
enabled = true
token = "discord-main"
agent = "nouva"
```

Which channels an agent answers in is set on the **agent**, not the connection, see
[the Discord page](/en/docs/gateways/discord/) for why, and for the cache settings that matter when you
run several Discord bots on one daemon.

---

## WhatsApp

WhatsApp has no bot token. You link a device by scanning a QR code from the phone that holds the
number, once.

```toml
[gateways.whatsapp.main]
enabled = true
encryption_key = "wa-encryption-key"   # secret NAME; the value is 64 hex characters
agent = "nouva"
```

The dashboard generates this key for you when you leave its field blank. In the config file, generate
the key and store it before you start:

```bash
openssl rand -hex 32 | nouride secret set wa-encryption-key --stdin
```

What comes back from a scan is a **login**, not a token, so it is stored AES-256-GCM under that key.
A copy of the session directory without the key is useless; a copy *with* it is a working login.
Keep the key, or the next restart asks for a new scan.

Then start the daemon and open the dashboard, the QR appears under the agent's Connections.

![The WhatsApp QR in the dashboard](/media/gateway-whatsapp-qr.png)

The WhatsApp bridge is **compiled into the daemon**. There is no second executable and nothing
extra to install.

[Full WhatsApp page →](/en/docs/gateways/whatsapp/)

---

## Nobody can talk to it yet

By default a stranger who messages one of your bots gets a pairing code and waits, they cannot reach
an agent until you approve them. That includes you: message your bot once, then approve your own code.

```bash
nouride access                  # who is waiting, and who is already in
nouride access approve <code>
```

Or from **Access** in the dashboard, where every agent's requests wait. This is a different queue from tool approvals, and
confusing the two has cost people an hour: an *approval* is an agent stopped mid-turn wanting to run
something; *access* is a person asking to be let in at all.

[Who may talk to it →](/en/docs/manual/access/)

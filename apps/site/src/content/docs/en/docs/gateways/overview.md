---
title: Gateways
description: Named connections, one bot identity per agent, and what happens when six bots share a channel.
---

A gateway is an adapter between a chat platform and the daemon. Every connection is **named**:

```toml
[gateways.<platform>.<name>]
```

`[gateways.telegram.nouva]` is the connection whose id is `telegram:nouva`. That naming is what lets
one daemon run a bot identity per agent, rather than one bot that switches personality.

## The four platforms

| | |
|---|---|
| **[Telegram](/en/docs/gateways/telegram/)** | Bot API, long polling. The daemon's commands show in Telegram's command menu |
| **[Discord](/en/docs/gateways/discord/)** | Gateway WebSocket. Needs the Message Content intent. The daemon's commands are native slash commands |
| **[WhatsApp](/en/docs/gateways/whatsapp/)** | Multi-device, through a bridge that runs inside the daemon |
| **[Terminal chat](/en/docs/gateways/cli-chat/)** | In-process. `nouride chat`, no token needed |

Nothing is defined by default, so a fresh install brings up the dashboard and nothing else, rather
than retry-looping against a platform it has no token for.

## Ownership and routing

```toml
[gateways.telegram.nouva]
enabled = true
token = "telegram-nouva"     # the NAME of a secret
agent = "nouva"              # this bot is Nouva's
```

`agent` makes the connection that agent's own bot: everything it receives goes to them unless somebody
else is addressed by name. Without it, routing falls back to channel bindings in the agent's own
`config.toml`.

Routing order, highest first:

1. **A mention**: this bot's platform tag, or an agent's id or display name in the text
2. **A reply** to a message an agent wrote
3. **The gateway owner**: `agent = "..."`
4. **A channel binding** in an agent's pack
5. **In a DM, the only agent** when just one is running
6. **The orchestrator**

## A saved connection is not a running connection

Adapters are built at boot. Adding or changing a gateway, from the dashboard or the config file,
needs a restart, and the dashboard says so and offers the button. Removing one stops it on the spot.

```bash
nouride gateway                       # connection status
nouride gateway restart <id>
nouride gateway add --platform telegram --name nouva --agent nouva --stdin
nouride gateway rm <id>
```

Renaming is the exception that must be done with the daemon **stopped**, because it rewrites
everything that names the gateway: the config and the database the daemon has open, every agent
pack's `[channels]` and `sender_allowlist`, and the memory vault:

```bash
nouride gateway rename telegram:old telegram:new --apply
```

## When the daemon restarts

Every message is written down the moment it arrives, and every step of a turn as it happens. So an
update, a reboot or a crash costs a delay, not a conversation:

- **A message sent while the daemon was down** is answered once it is back, if it was sent in the
  last 15 minutes. An older one gets a short note that it came in while the daemon was offline,
  rather than a late answer to an old question.
- **A message a platform delivers twice** is answered once.
- **A turn cut off by a restart** keeps everything it did and tells its chat what was done and what
  was cut off. If the daemon is back within 15 minutes, the agent carries on from there by itself,
  once. Back after longer than that, nothing runs by itself: say "continue".
- **A reply written just before a crash** is sent after the restart, if it is under half an hour old.

A planned stop (`systemctl stop`, **Restart Runtime**) asks each running turn to stop at its next
step, close with what it did and say so in its chat, before the gateways go down. A restart or an
update waits until nothing is running: a turn or an approval for ten minutes at most, a background
job until it finishes.

## Several bots in one channel

This is the arrangement a multi-agent daemon is *for*, and it is where all the interesting behaviour
lives. Everything below was found on a live Discord with six agents in one channel.

The one fact the rest follows from:

> **A platform delivers every channel message to every bot in the channel.** Six bots means the
> daemon receives six copies of one message, on six connections, and routes each independently.

Anything that fires *per connection* fires six times. Anything that does not name an agent is true on
all six at once.

### Addressing becomes required

A rule that names no agent, "the owner of this connection answers", "fall back to the orchestrator",
is true six times over. Both of those shipped once, and both produced six replies to a one-word message.

So when more than one enabled connection shares a platform **and the chat is not a DM**, both
fallbacks switch off and a message has to be addressed:

| Signal | Resolves to |
|---|---|
| This bot's own platform tag | that connection's agent |
| An agent id or display name in the text (`nox:`, `@nox`) | that agent |
| A reply to a message an agent wrote | that agent |
| The agent the room named (`/mention <agent>`), for a message that addresses nobody | that agent |
| A channel binding in a pack | that agent |
| **Somebody else's platform tag** | **nobody**: this is the guard that stops the storm |
| Nothing | nobody |

A DM keeps both fallbacks: a private message to Nero's bot is unambiguously Nero's, however many
other bots exist. A platform with one enabled connection keeps them too, that is most installs, and
withholding them there would make a single bot stop answering ordinary messages.

### The orchestrator is the front desk

The "Nothing" row has an answer where the room does not require a mention: the orchestrator
(`[daemon] orchestrator`, the first agent you made) answers a message that addresses nobody, once,
through its own bot. The other bots stay quiet. It is the same agent on every copy of the message, so
the one-turn-per-message claim below lets exactly one through, and its prompt tells it to answer or
hand the message to the agent whose headline fits. Every other row of the table is unchanged, a DM is
unaffected, and a room that requires a mention (`groups_require_mention`, or `/mention required` in
that group) stays quiet for it too.

A group can name another agent for that row, from inside it: `/mention @NovelistBot` (admins), and the
novelist answers every message there that tags nobody, where the orchestrator would have. It ranks
below a tag, a reply and somebody else's tag, and above the connection's owner, a channel binding and
the orchestrator: a person in that room said it of that room. `/mention required` asks for a tag, and
`/mention default` removes the group's own setting. It is stored for the group as the platform knows
it, not for one connection, so every bot in the group reads the same value, and the command is
answered by one bot, once. A Telegram topic is a room of its own.
[Talking to an agent → Groups](/en/docs/manual/chatting/#groups)

### One turn per message

Where the signal is the same on every connection, a name in the text, a reply, all six reach the
same conclusion, and the agent would answer six times. A claim is taken after routing and before any
side effect, keyed by `platform : chat : messageId : agentId`.

Keyed by **agent as well as message** on purpose: two connections that reach *different* conclusions
are not in conflict. One message tagging two bots resolves to two agents, and both should answer.

### One identity, four outputs

An agent says four kinds of thing, its final answer, its live progress line, an approval prompt and
the typing indicator, and each of them goes out through the agent's *own* connection, not the one
the message arrived on.

Before that was true, the visible result was one agent's approval request posted under another's name
and avatar, followed by the wrong bot "typing…" for the whole time, and then `@WrongBot /approve`
looking for a request that was never theirs.

Nothing in config says which channels a bot was invited to, so a send can still fail; the answer path
falls back to the inbound connection rather than going silent. A log line reading `an agent's own
connection could not deliver here` means one thing: **invite that bot to the channel.**

### Mentions are the platform's syntax, not ours

The prompt hands each agent the exact token to type for every other agent, taken from that agent's
own connection. Discord gives `<@id>`, Telegram gives `@username`. The engine never formats a mention
itself.

An agent with no connection of its own falls back to `@<agentId>`, which the text matcher understands.

### A bot is never offered a pairing code

The access gate runs before the bot check and before routing. A code is something a human reads and
forwards; a bot does neither, and on a platform that fans out every message that code becomes a new
unknown sender for *every other connection*. One tag once produced twelve messages.

Bots pass the gate and are judged by "is this one of ours" instead. And in a group a stranger is
paired only by the bot they addressed (tagged, named, or replied to): that bot answers with the code
under their message, and the other bots in the group say nothing and open no request. The gate runs
once per connection, so without this one tag met a wall of codes.

## Alerts

The daemon reports on *itself* through a gateway you nominate, a connection that gave up
reconnecting, a WhatsApp session that needs relinking:

```toml
[alerts]
gateway = "telegram:nouva"
chat_id = "123456789"
```

Without it, a dead gateway is only a line in the log. Boot warns while this is empty.

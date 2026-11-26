---
title: WhatsApp
description: Linking a number, bridge transport modes, and the delivery failure that looks like a bug.
---

WhatsApp works through the multi-device protocol, **inside the daemon, in every edition**. It has no bot token,
you link a device by scanning a QR code from the phone that holds the number, once. Zero external
processes to spawn.

## Setting it up

```bash
# The session is a login, so it is encrypted at rest. Generate the key first.
openssl rand -hex 32 | nouride secret set wa-encryption-key --stdin
```

```toml
[gateways.whatsapp.main]
enabled = true
encryption_key = "wa-encryption-key"   # the secret NAME; the value is 64 hex characters
agent = "nouva"
# session_dir = "..."                 # optional; unset keeps the login in <data_dir>/whatsapp-main
```

From the dashboard there is no key to generate: leave the field blank and it makes one.

Start the daemon and open the dashboard, the QR appears under that agent's **Connections**. Scan it
from the phone: WhatsApp → Linked Devices → Link a Device.

![The WhatsApp QR in the dashboard](/media/gateway-whatsapp-qr.png)

:::caution[Keep the encryption key]
What comes back from a scan is a **login**, not a token. A copy of `session_dir` without the key is
useless; a copy *with* it is a working login. Lose the key and the next restart asks for a new scan.
:::

## A number for each agent

A number belongs to one agent, as a Telegram bot does: a message to it goes to that agent, and people
are let in for that number and no other. To give a second agent its own number, add a second
connection, with its own name, from that agent's **Connections** page or from a terminal. An agent has one
number: a second for an agent that has one is refused, naming the one it has.

```bash
nouride gateway add --platform whatsapp --name shop --agent nora
nouride restart --then "confirm whatsapp:shop connected"
```

```toml
[gateways.whatsapp.main]
enabled = true
encryption_key = "whatsapp-main-key"
agent = "nouva"

[gateways.whatsapp.shop]
enabled = true
encryption_key = "whatsapp-shop-key"   # a key of its own, made for it when added from the dashboard or the command
agent = "nora"
```

After the restart the new number's code is on its agent's Connections page. Scan it from the phone
that holds *that* number. The first number is not asked to scan again, and each card says whether its
number is linked or still waiting.

One number's trouble is its own. A number that is logged out from its phone, or cut off from the
network, stops or reconnects alone; `/health`, `nouride status` and the dashboard name it, and the
other number goes on answering. Nouride sets no limit on how many numbers an install holds: each is
one more connection kept open to WhatsApp.

A number logged out from its phone says so on its card, under its agent's **Connections**, with
**Link again**: its old login is removed and a new code shows there, to scan from the phone that holds
the number. Nouride does not do that by itself, since one logout signal from WhatsApp is not taken as
the end of a link.

In a group that two of your numbers are in, a message that tags one number is that number's agent's
to answer; one that tags nobody is answered once, by the agent that holds the install, not by each
number.

:::caution[What a number risks]
Nouride connects to WhatsApp unofficially, the way WhatsApp Web does (through Baileys, an open-source
library), not through WhatsApp's official Business API. WhatsApp may restrict or ban a number it sees
acting like a bot: answering many people it does not know, sending a lot, or replying to a broadcast. A
ban cannot be undone from Nouride, and the number's chats may be lost. Use a number you can afford to
lose, not your personal one, and see [error 463](#error-463-the-failure-that-reads-like-a-bug) for
what a restriction looks like.

An agent that is [open to everyone](/en/docs/manual/access/#an-agent-open-to-everyone) answers anyone
who writes to its number: the riskiest way to use one. Start it with low daily limits. The dashboard
says all this where you add a number, where you open an agent that has one, and on an open agent's
Access page and number.
:::

## The bridge

```
┌──────────────────────────┐                    ┌─────────────────────────────┐
│      Nouride daemon      │   newline-JSON     │        wa-bridge            │
│  agents · tools · queue  │◄──────────────────►│  Baileys · QR · auth state  │
└──────────────────────────┘                    └─────────────────────────────┘
```

The engine never talks to Baileys, the WhatsApp library, directly. It talks to the bridge over a
newline-delimited JSON protocol, in memory, because the bridge runs inside the daemon. That keeps a WhatsApp problem a WhatsApp problem, and the protocol is small enough to read in
one sitting.

### One transport, a bridge for each number

The bridge is hosted inside the daemon, and every release carries it. There is no second executable
to install and nothing beside the daemon to keep running, so there is no `bridge_transport` to set.
The daemon opens a bridge for each WhatsApp connection in the config: each has its own socket, its own
login and its own reconnect, so one number that is logged out or cut off stops or reconnects alone.
Until 0.8.48 a daemon held one WhatsApp number, and a second needed a second daemon.

**Each number keeps its login in a folder of its own**: `<data_dir>/whatsapp-<name>` for a connection
named `<name>`, unless its table names a `session_dir`. Two connections on one folder are refused at
start, with both names. An install linked before 0.8.48 has its login in `<data_dir>/whatsapp`: the
first start writes that folder into the connection's table as `session_dir`, nothing is moved, and
no new scan is needed. `nouride config check` says so before the start does it.

`bridge_transport = "ws"`, which reached a bridge somewhere else,
went in 0.7.10 (nothing ever served one), and a config naming it is refused at start. So, since 0.8.0, is
`bridge_transport = "stdio"` with its `bridge_command`, which ran the bridge as a second executable.

[Variants and what each costs →](/en/docs/deployment/binaries/)

## Error 463, the failure that reads like a bug

```
error 463: account restricted or missing tctoken for contact
```

WhatsApp is refusing to deliver, because the number is restricted from *starting new chats*.
Established chats already carry a privacy token and keep working, which is why this looks selective.

**Typing indicators still appear**, because presence is not restricted, only delivery to a new chat
is. That combination is not a bug.

A number earns this by looking like spam: brand new, linked and unlinked repeatedly across an
afternoon of testing, then sending automated replies to somebody who has not saved it.

**What may lift it**

1. Save the bot's number as a contact on the other phone, then message it. Being a contact usually
   causes the privacy token to be issued.
2. Wait. The restriction is often temporary.
3. Use a number a human has actually used for a while, rather than a fresh one.

**What must not happen: retrying.** Each attempt counts as another reach-out and worsens the
restriction. The daemon knows this, a terminal refusal walls off that chat so the next message does
not repeat it, and the wall clears on a relink, which is the one moment a restriction may have
lifted.

It is also not silent. The refusal is logged at error in words an operator can act on, and
**alerted through a channel that is by definition not the one that failed**, so set `[alerts]`.

## Groups

**Mentions tag a number, not a name.** The adapter compares the tagged ids against both of the
connection's own addresses, phone JID and LID, normalised across device suffixes.

**Quoted context comes along.** The text of the replied-to message is carried with a `>` prefix,
because "@bot is this safe?" means nothing without the message it points at.

**The sender in a group is the participant.** In a DM the chat *is* the sender; collapsing the two
would give every group member one identity.

## One person, two ids

The same human shows up under two addresses, `…@s.whatsapp.net` and `…@lid`. List both on one
person (People, or their file `people/sam.toml`), or the agent knows them under one and not the other:

```toml
[person]
name = "Sam"
ids  = ["whatsapp:15550001111@s.whatsapp.net", "whatsapp:100000000000002@lid"]
```

`whatsapp:<id>` matches on any of your WhatsApp connections; `whatsapp:main:<id>` only on that one.

## Read receipts

Sent **after** the engine accepts a message, never on arrival. In `pair` mode an unknown sender's
message is dropped, and a read marker on it would tell them they had been seen by something that is
in fact ignoring them.

## When it goes quiet

```bash
nouride logs -f | grep -E "whatsapp|bridge"
```

| Line | Means |
|---|---|
| `whatsapp linked` | signed in; the jid includes the device number |
| `sending to the bridge` | the engine handed a reply over |
| `sent {...}` | Baileys accepted it, **not** that it was delivered |
| `delivery refused` | the server rejected it. Read the code |
| `whatsapp pairing code ready` repeatedly after a link | the session is not persisting, check the encryption key and `session_dir` |
| `unparseable line from the bridge` | something other than protocol JSON reached the channel between the bridge and the adapter |

`sent` and `delivery refused` are the bridge's own lines and go straight to the daemon's stderr, so
look for them in `journalctl -u nouride` or `docker logs` if `nouride logs` does not show them.
`NOURIDE_WA_LOG_LEVEL=debug` turns Baileys' own logging up, on stderr.

## There is no build without WhatsApp

Every edition carries the bridge inside the daemon, so a `config.toml` that names WhatsApp always has
something to connect with.

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
# session_dir = "..."                 # optional; unset keeps the login in <data_dir>/whatsapp
```

From the dashboard there is no key to generate: leave the field blank and it makes one.

Start the daemon and open the dashboard, the QR appears under that agent's **Connections**. Scan it
from the phone: WhatsApp → Linked Devices → Link a Device.

![The WhatsApp QR in the dashboard](/media/gateway-whatsapp-qr.png)

:::caution[Keep the encryption key]
What comes back from a scan is a **login**, not a token. A copy of `session_dir` without the key is
useless; a copy *with* it is a working login. Lose the key and the next restart asks for a new scan.
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

### One transport, one number

The bridge is hosted inside the daemon, and every release carries it. There is no second executable
to install and nothing beside the daemon to keep running, so there is no `bridge_transport` to set.
The bridge keeps its connection state at module scope, so one daemon hosts one WhatsApp connection; a
second number needs a second daemon. `bridge_transport = "ws"`, which reached a bridge somewhere else,
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

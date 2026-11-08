---
title: Who may talk to it
description: Pairing, allowlists, and giving the agents names for the people they talk to.
---

Your bots are on public networks. Anyone who finds the username can send them a message, so who is
allowed to reach an agent is a real setting rather than an afterthought.

## The three postures

`[security.access] mode`, daemon-wide:

| | |
|---|---|
| **`pair`** (default) | An unknown sender is told a short code and dropped. You approve the code and they are remembered, on disk, permanently. |
| **`allowlist`** | Only listed or already approved ids get through. Everyone else is dropped in **silence**: no reply, no error. |
| **`open`** | Anyone. Only sane for a daemon with no chat gateway at all. |

The usual path is to set up with `pair`, then switch to `allowlist` once the people you want are in.
Senders already approved keep talking; everyone else is dropped at the gate.

`open` is not offered as a choice in the dashboard. It is a posture the daemon warns about, so it is
surfaced as a warning when in force rather than presented as an option.

## Approving someone

They message the bot and get a code, and the reply says where it gets approved, because the person
doing the pairing is usually the person who runs the daemon:

![A first message to a Telegram bot, answered with a pairing code and where to approve it](/media/pairing-chat.svg)

In a group the code comes from the bot they tagged, named or replied to, quoted under their message.
The other bots in the group stay quiet and open no request, and a message that addresses no agent
gets nothing.

"Send that code to whoever runs me" is a dead end when you *are* that person and nothing has told
you there is a page for it. So the message names one.

**Home tells you there is one**, and so does the menu: a count beside **Settings**, on every page,
because the code expires (beside **Access** instead, while Settings' own pages are listed). Home's card
says how many are waiting and opens Access, with no buttons. Both appear only when somebody is queued; a
permanent zero is a thing you learn to stop seeing.

That split is deliberate. Home is a glance, and approving a stranger is not undone by looking
away, so the decision is made on a page that shows the whole request rather than a count of them.

**Access** is where you answer it, for every agent at once: one person can ask two bots, and "who did
we block?" has no agent in it. Five tabs, the shape of a request's life:

| Tab | What is on it |
|---|---|
| **Pending** | Every waiting request, with its code and when it runs out. An admin can approve it plainly, approve it *as* somebody (**It's me**, a person already in People, or a new one), deny it or block it |
| **Approved** | Everyone paired, each with Revoke and Block and the person in People the account belongs to, and the ids the config lets in without a code when it names any |
| **Denied** | Who was turned away for now, with how long until they may ask again, and **Reset** |
| **Blocked** | Who is kept out until you **Unblock** them |
| **History** | Every request and every answer, newest first, with who gave it |

A filter narrows all five to one agent, each list has a filter box and scrolls inside its card, and each agent's own **Access** tab counts its senders and
links here, filtered to it. Approving as somebody adds that id to the person, so every agent knows
them by name from the next message. Once approved, they are told so in the chat they used.

![The Access page with one waiting request: its code, It's me, Approve as…, Approve, Deny and Block](/media/dashboard-access-pending.png)

### Deny or block

Two ways to say no, and they are different answers:

- **Deny** is *no, this time*. For a day (`deny_cooldown_ms`) their messages are ignored; after that,
  a message from them is a new request with a new code. **Reset** on the Denied tab ends the wait
  at once, for a "no" given to the wrong code.
- **Block** is *no, until somebody says otherwise*. Ignored until **Unblock**, which lets them ask
  again. It lets nobody in. A block beats an id written in config.toml too.

Neither is said to them: a reply would invite retrying, and confirm the bot is live.

![The Denied tab: two denials counting down to when they may ask again, each with Reset and Block](/media/dashboard-access-denied.png)

Before 0.7.0 Deny was the block: one "no" pressed at a code nobody recognised kept that person out
for good, with nothing on any screen to say so. A denial from before the split is listed as the block
it was, so an upgrade lets nobody back in.

From a terminal:

```bash
nouride access                          # who is waiting, who is in, who is kept out
nouride access approve <code>           # add --me, --as <person key> or --new "<name>"
nouride access deny <gateway:sender>    # no, for a day
nouride access block <gateway:sender>   # no, until unblocked
nouride access revoke <gateway:sender>  # take an approval back
nouride access reset <gateway:sender>   # end a denial's wait now
nouride access unblock <gateway:sender>
nouride access mode pair                # or allowlist
```

Run by an agent, `approve` with `--me`, `--as` or `--new` asks an admin at every approval level, `trusted` too: it
puts whoever sent the code on a person, and linked to an admin, their chat answers as one. So do `people set` and
`people remove` below ([the fixed list](/en/docs/manual/approvals/#the-fixed-list), `people`, from 0.8.9).

A code lasts 15 minutes, long enough to forward, short enough not to linger. There is also a
cooldown on "I do not know you" replies, so a stranger cannot make the daemon answer every message
they send. Denying, blocking or revoking someone also drops the approval level they set for
themselves, so pairing them again starts from the default.

:::caution[This is not the approvals queue]
An **approval** is an agent stopped mid-turn wanting to run a command. **Access** is a person asking
to be let in at all. They live in different places on purpose. The failure that made this explicit:
a bot told someone to approve a pairing code, the dashboard's approval list was empty because that
list is for tool calls, and the fifteen-minute code expired while they looked for it.
:::

## The default, and each agent's own

In the dashboard the pairing mode is one switch, *Accept new senders*, on the **Agents** settings
page. It is the **default**: `[security.access] mode`, which every agent follows.

An agent can decide for itself on its own **Access** page: *Follow the default*, *On* (a stranger gets
a pairing code) or *Off* (only senders already approved). It is `[agent] access = "follow" | "pair" |
"allowlist"` in its `config.toml`, and it covers every connection that agent owns. `open` is not an
option there: a per-agent way round the daemon's own guard, which refuses to start with `open` and an
empty sender allowlist while any agent can run commands, would be a hole in it.

![An agent's Access tab: whether new senders may ask to be let in, and its senders at a glance](/media/dashboard-agent-access.png)

Below them, the tab counts this agent's senders, waiting, approved, and denied or blocked, each a link
to **Access** filtered to it. Both switches are live: the next message is judged by the new setting,
no restart.

## Pre-approving people

To let somebody in before they have ever written, allow them from a terminal (an admin's, as approving
is):

```bash
nouride access allow telegram:nouva:123456789 --name "Sam"
```

They land under **Approved** as if they had paired: Revoke and Block reach them, and History says who
let them in. Pairing is per connection, so somebody on three bots is three lines.

The config can do the same, for an install set up from files rather than from the dashboard:

```toml
[security.access]
mode = "pair"
allowlist = [
  "123456789",                    # bare id
  "telegram:nouva:123456789",     # fully qualified
]
```

It is honoured in every mode and listed under Approved as *Allowed by config* when it names anybody,
but the dashboard cannot revoke it; only a block beats it. Reach for the qualified spelling when one
daemon runs bots on more than one platform: a Telegram id and a Discord snowflake are both numeric,
and a bare id can match on the wrong one.

## Per-agent restriction

The daemon-wide rules decide who may reach the agents at all. One agent can be narrower:

```toml
# .nouride/agents/nouva/config.toml
[security]
sender_allowlist = ["telegram:nouva:123456789"]
```

The same two spellings as the daemon-wide list: qualified by the connection (`telegram:nouva:123456789`),
or the bare id, which matches on every connection the agent owns. Empty narrows nothing: the daemon-wide
rules decide alone.

## Names, not ids

An agent that knows a chat id knows nothing useful. **People** ties an account to a person (a name,
some notes, and a **person key**), and those facts land in the prompt so the agent addresses somebody
properly.

![The People page: one entry per person, with every id they are reachable at (notes blurred)](/media/dashboard-people.png)

```bash
nouride people                                        # who the agents know, and who has no name yet
nouride people set sam --name "Kak Sam"               # somebody by key: added by name, no account yet
nouride people set telegram:123456789 --name "Sam" --note "Alex's sister"   # whoever holds that account
nouride people remove sam                             # by key, or by an account they hold; their memory stays
```

Or the **People** page in the dashboard, or the agent's own `person_record` tool.

**Add somebody by name; attach their accounts when they pair.** On the People page only the name is
needed. The **Person Key** fills itself in from it (`Kak Sam` → `sam`) and can be changed before you
save: lowercase letters and digits, words joined by `-`, and never one somebody else has. It is the
person, and the name of their memory file (`people/sam.md`), so it is fixed once saved. Their accounts
are optional: when they message one of your bots and ask to pair, **Approve as…** on the Access page
lists everybody in People, so their account lands on the person you already added.

Notes are markdown, as long as they need to be. On the People page,
**Notes** on a row opens them to read and edit, the same dialog as in Memory. An admin edits anyone's there.
Through an agent, somebody changes only their own: tell an agent "my birthday is 12 May" and
`person_notes` adds that line to your notes, never to anybody else's, whoever asks. `person_record`
writes only a first line, for somebody nobody has described yet, and what changes over time (work,
plans, tastes) goes to their memory profile instead.

On disk each person is a file of their own (since 0.8.18), `people/<key>.toml` beside `config.toml`, the file's
name their key. A person can send from several accounts, and on WhatsApp in particular the same human shows up under
two (`…@s.whatsapp.net` and `…@lid`); all of them go in `ids`, and none at all is fine. `people/sam.toml`:

```toml
[person]
name  = "Sam"
ids   = ["whatsapp:628123456789@s.whatsapp.net", "whatsapp:100000000000002@lid"]
notes = "Alex's sister. Prefers short answers."
```

A file edited by hand is read at the next start, and the next write from People or an agent patches it rather than
putting back what was there. One that does not load is named in the log and that person left out until it does.
Before 0.8.18 they were `[[people]]` entries in `config.toml`; the first start of 0.8.18 moves them.

Every id is the platform and the account (`telegram:…`, `discord:…`, `whatsapp:…`) and names them on
every bot of yours they talk to. An id written with a connection in the middle (`whatsapp:nouva:…`), as
before 0.7.0, is refused since 0.8.0, naming the id without it. Access is the one place the connection
counts: it is which bot lets somebody in. A bare id is refused, for the same reason as above.

**This survives `/new`.** Facts in a person's file and in an agent's `MEMORY.md` are
permanent; the conversation is not. With memory on, the agents can also learn about each person over
time (**Knowledge & Memory → People**, see [Memory](/en/docs/architecture/memory/)). If an agent keeps forgetting
who somebody is, the fact belongs in one of those places rather than in the chat.

:::note[Empty is a real value]
An account with no name set means nobody has said what to call that person, and the agent then uses
no name at all rather than falling back to a login handle. This is the fix for a real bug: setup used
to ask "what should the agent call you", wrote the answer into a file every agent read for every
conversation, and greeted the second person to message the bot by the first person's name.
:::

## Dashboard accounts are separate

Who may sign in to the dashboard is a different question from who may message a bot. Accounts and
roles live under **Users**, admin-only (multi-user accounts are a Pro edition feature).
Nobody can delete their own account, and the last admin cannot be demoted, because that would lock
the instance out of account management.

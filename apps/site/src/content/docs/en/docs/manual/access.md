---
title: Who may talk to it
description: Pairing, allowlists, and giving the agents names for the people they talk to.
---

Your bots are on public networks. Anyone who finds the username can send them a message, so who is
allowed to reach an agent is a real setting rather than an afterthought.

## The two postures

`[security.access] mode`, daemon-wide:

| | |
|---|---|
| **`pair`** (default) | An unknown sender is told a short code and dropped. You approve the code and they are remembered, on disk, permanently. |
| **`allowlist`** | Only listed or already approved ids get through. Everyone else is dropped in **silence**: no reply, no error. |

The usual path is to set up with `pair`, then switch to `allowlist` once the people you want are in.
Senders already approved keep talking; everyone else is dropped at the gate.

No install lets everyone in. One agent can: a front desk that answers anybody who finds it, with a few
tools of Nouride's own and none of yours. That is [an agent open to everyone](#an-agent-open-to-everyone),
below. Before 0.8.48 there was a third posture, `open`, for the whole install;
[what an upgrade does with it](#an-install-that-was-open) is below too.

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

A filter narrows all five to one agent and a filter box narrows the open tab's list, both in the row of the tabs, which
stays at the top of the window while the list scrolls. Each agent's own **Access** tab counts its senders and
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

An agent can decide for itself on its own **Access** page, under *Who can write to this agent*. It is
one choice of four: *Follow the default*, *Ask first* (someone new gets a pairing code), *Approved only*
(only the people already let in) or *Open to everyone*. The first three are `[agent] access = "follow" |
"pair" | "allowlist"` in its `config.toml`, saved with one press, and they cover every connection that
agent owns. The fourth asks for two numbers before it is saved, and is described next.

![An agent's Access tab: who can write to it, one choice of four, and its senders at a glance](/media/dashboard-agent-access.png)

Below it, the tab counts this agent's senders, waiting, approved, and denied or blocked, each a link
to **Access** filtered to it. The default's switch and an agent's own choice are both live: the next
message is judged by the new setting, no restart.

## An agent open to everyone

Since 0.8.48 one agent can answer anybody who finds it, with no code: a shop's front desk, a help line,
a bot for an event. It is the agent that is open, never the install. Your other agents go on asking
strangers to pair.

On the agent's **Access** page, pick **Open to everyone**, the fourth choice under *Who can write to
this agent*. It says what it means before you take it:

- Anyone who finds it can write to it, and it answers in your name. People may try to talk it into
  saying things you would not, so keep anything private out of its persona files, its notes and what
  you open to everyone.
- Every answer is paid from your model account; the two numbers below are how you keep that in check.
- What people send it is kept on this server, with its chats.
- If it has a WhatsApp number, that number is at risk: see [the caution on the WhatsApp
  page](/en/docs/gateways/whatsapp/#a-number-for-each-agent). The form says it too, and so does the
  Access page while it stays open.

Then it asks for two numbers:

- **Most tokens it may use in a day.** Everything it spends counts, whoever it answered. When the day's
  tokens are used it tells people it is closed until tomorrow, in a sentence you may write yourself, and
  you are told once.
- **Most messages one person may send it in a day.** Past it, that person is told once and left
  unanswered until the next day.

The day is checked before each answer, so answers already begun when it runs out still finish. The
tokens are the model's: a voice note's transcription is not counted in them, and comes only with an
answer the day still has room for.

Neither has a starting value: it answers on your account, and an agent is not opened without numbers
you chose. A day is your own, by the server's time zone, and a restart resets neither count. People you
let in by name are held to neither. Only an admin opens an agent; an operator may close it.

Strangers together take at most half of the answers the server works on at once (`[queue]
max_concurrent_turns`), so you and the people you let in are answered beside them, not after.

### What it can do, and what it knows

While it is open, an agent has four tools and nothing else, whatever its Tools list says:

| | |
|---|---|
| Search and read | the documents you opened to everyone under **Knowledge** (a collection whose readers are *Everyone*) |
| Read a file | that the person sent in the chat |
| Send a file | kept in one of those collections, into the chat it is answering |

A collection for *Everyone* that names no agents is read by every agent you open, so before you take the
answer the form lists the collections this agent would answer strangers from.

No commands, no files of the server, no web, no other agents, no reminders, no memory of its own. Its
Tools tab shows them switched off while it is open, and keeps what was picked for when you close it. It
is told nothing about you, the people you let in, your other agents or the server, and it is told the
same when *you* write to it: a bot that knew more for some senders could be talked into saying it to
others. Nothing a chat tells it is kept, and its conversations are never filed into memory.

What it does know is what you wrote for it: its persona files and its notes. Read them as a stranger
would before you open it. An agent with notes of its own is opened only after you tick that you have,
and an agent made new for the public is the safer choice.

Two agents are never opened, and the card says why: the **main agent**, which looks after the server,
and an agent that works through a **coding CLI**, which brings tools of its own that Nouride cannot
take away. The other way round holds too: an open agent cannot be made the main agent or handed to a
coding CLI until you close it.

### In the chat

Somebody who was let in only because the agent is open has three commands: `/start`, which a chat app
sends when a bot's chat is opened and which the agent answers with a greeting of its own; `/new`; and
`/help`. In a group `/new` is not theirs, since the conversation there is everyone's. Any other command
answers one sentence and does nothing, so nobody can put your bot to sleep or change its model. People
you let in by name keep the commands they have everywhere.

Naming another agent does not reach it: a stranger's message on an open agent's bot is that agent's
alone. And what an open agent says wakes no other agent, whatever it tags.

In a group it answers only when it is tagged, named or replied to, whatever the group's own setting.
Anyone may add a bot to a group of their own, and one that answered every message would spend its day
on talk nobody addressed to it.

### Who wrote

The people who write to an open agent are in none of the Access page's lists: nobody was asked for a
code. They are on the agent's own **Access** tab, under **People who wrote**: who, on which app, what
they first asked and when. **Read** opens the conversation; **Block** keeps that sender out from their
next message. The card above it says what was used of the day.

The list scrolls inside its card, so a busy agent's page stays short. To find someone, type a name, a
number or words from what they first asked, and press **Search** (or Enter): it looks through every
conversation the agent keeps, not only the ones on screen. **Clear** brings everyone back.

Those conversations are kept out of your own list of chats, and go when conversations of their age do
(`retention.session_days`), files included.

From a terminal, `nouride config check` and `nouride doctor` say which agents are open, on which
connections and within which numbers.

### In the file

```toml
# .nouride/agents/nora/config.toml
[agent]
access = "open"

[open]
max_daily_tokens = 200000
max_daily_messages_per_person = 30
closed_reply = "We are closed for today. Please write again tomorrow."   # optional
```

`access = "open"` without both numbers does not load, and names what is missing. Closing an agent sets
`access = "follow"` and leaves `[open]` for the next time.

### An install that was open

Before 0.8.48, `[security.access] mode = "open"` let everyone in on every connection, and the daemon
refused to start with it beside any agent that could run commands. It is gone. The first start of
0.8.48 on such an install:

1. lets in by name everyone an agent there had already answered, on the connection they wrote on;
2. writes `mode = "pair"` into `config.toml`.

So everybody who talks to it goes on talking, and a new sender is given a pairing code. Nobody is
opened by the upgrade: if you want a bot anyone can write to, open that agent as above.
`nouride config check` says so before you upgrade.

## Pre-approving people

To let somebody in before they have ever written, allow them from a terminal (an admin's, as approving
is):

```bash
nouride access allow telegram:nouva:123456789 --name "Sam"
```

They land under **Approved** as if they had paired: Revoke and Block reach them, and History says who
let them in. Pairing is per connection, so somebody on three bots is three lines.

### A whole list of them

Since 0.8.41 a list goes in at once, from a file with one person a line:

```bash
nouride access allow --from contacts.txt --gateway whatsapp:main --dry-run   # counts, and writes nothing
nouride access allow --from contacts.txt --gateway whatsapp:main
```

The same from the dashboard (0.8.42), for an admin: on the Access page's **Approved** tab, **Let in a list**. Choose
the connection they will write on, paste the list or choose its file, and press **Check the list**: it says how many
would be let in and what is left out, and writes nothing. **Let N in** then lets them in, and is offered only for the
list as it was checked.

The file is plain text:

- One person a line: their id first, then a name if you have one, after a comma, a semicolon or a tab.
  Everything after that first mark is the name.
- A spreadsheet saved as CSV works as it is, the id in its first column and the name in its second,
  with or without quotes around a cell.
- An empty line is passed over, and so is a line that starts with `#`.
- A line that is not a sender on that connection, a header row among them, is counted as one that
  could not be read and named in the answer. The rest still goes in.

```text
# WhatsApp: phone numbers with the country code
+62 812-3456-7890, Bu Rina
62 813 0000 0001
6281400000002;Pak Budi
```

```text
# Telegram: account ids or usernames
123456789, Sam
@sam_lee
t.me/budi_santoso
```

```text
# Discord: account ids or usernames
123456789012345678, Sam
sam.lee
```

One file is for one connection: a list for `whatsapp:main` holds numbers, one for a Telegram bot ids
or usernames. What a line holds depends on where the connection is:

| Connection | A line is | Not |
|---|---|---|
| WhatsApp | a phone number with its country code, written however you like (`+62 812-3456-7890`) | a number the local way, from 0: which country it is in is not guessed |
| Telegram | an account's id, or its username (`@sam_lee`, `t.me/sam_lee`) | a phone number: Telegram shows a bot nobody's |
| Discord | an account's id, or its username (`sam.lee`) | an old `name#1234` name, which several accounts can share |

The command says how many are new, how many were in already, how many are blocked and stay out, how
many were said twice, and which lines it could not read. Up to 50,000 lines a run. The whole list is
one line in History. A file the command may not read (on a server it runs as Nouride's own account,
whoever types it) is handed over on standard input: `--from - < contacts.txt`.

A name from the list is shown until that person writes. From then on the Approved tab shows the name
their account carries, as it does for anybody approved.

On WhatsApp a person usually writes to you under a hidden id, not their number. Nouride is told the
number beside it and lets them in by either, so a list of numbers works. On Telegram and Discord
somebody let in by username is known by that username: if they give it up and somebody else takes it,
that somebody is let in. Use ids where that matters.

Once thousands are approved, the Approved tab lists the newest 500 and says how many there are. To
reach one beyond them, type their id or name in the filter and press **Search everyone**; from a
terminal, `nouride access approved --find <id or name>`.

This is how to answer the replies of a contact list without opening an agent to everyone: the people
you wrote to are let in by name, with every tool your agent has, and anybody else still meets a code.
Note that WhatsApp here is not the official Business API: it links a
number as WhatsApp Web does, and WhatsApp can restrict or ban a number that sends in bulk to people
who have not written to it first.

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

![The People page: one entry per person, with every id they are reachable at](/media/dashboard-people.png)

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

What an account sees is its own: its [chats](/en/docs/manual/dashboard/#chat), its
[automations](/en/docs/manual/schedule/#whose-an-automation-is) and its [missions](/en/docs/manual/missions/#watching-it).
An admin sees everyone's, and picks whose on each of those pages.

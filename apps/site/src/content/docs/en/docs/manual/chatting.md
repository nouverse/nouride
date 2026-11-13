---
title: Talking to an agent
description: Slash commands, sessions, groups, restarts, and getting two agents to work together.
---

Wherever you are talking to it, Telegram, Discord, WhatsApp, the dashboard or `nouride chat`: the
message travels the same path. The gateway is the only part that differs.

## Slash commands

Type these instead of a message. They are answered by the daemon, not by the model, so they cost
nothing and always work. They are answered at once, even while a turn is running: a `/stop` or an
`/approve` does not wait behind the turn it is meant to stop or answer.

| | |
|---|---|
| `/help` | List available commands |
| `/status` | The model, uptime and context size |
| `/new` | Start a new conversation |
| `/compact` | Summarise the conversation so far, keeping the recent turns |
| `/reset` | Hard reset: clear the conversation, expire approvals, reload config |
| `/stop` | Stop what this agent is doing, and put it to sleep |
| `/sleep` | Put this agent to sleep: it takes no work until `/wake` |
| `/wake` | Wake this agent (`/start` too) |
| `/mission` | Start long work it carries on alone, or see the missions here: [Missions →](/en/docs/manual/missions/) |
| `/model` | Switch model for this chat |
| `/effort` | How long the model thinks, for this chat; `/effort <level> lock` for every chat and mission |
| `/btw` | Ask something beside the work: the agent answers as itself, does nothing, and keeps it out of the conversation |
| `/agents` | List agents |
| `/prompt` | Show the system prompt this agent is running with (in a DM only: it includes its memory) |
| `/reload` | Reload persona files and config from disk |
| `/approvals` | How much you get asked before tools run (`careful` or `balanced`); follows you, not the chat |
| `/approve` | Approve a pending tool call; add `always` to stop being asked for it, or `all` for everything waiting |
| `/deny` | Deny a pending tool call |
| `/grants` | List standing command permissions, or revoke them: `/grants revoke <id\|all>` |
| `/drafts` | Skills the agent has drafted and wants your call on, `show`, `approve`, `deny` |
| `/secret` | Passwords and keys sent in this chat: what is held, `undo`, `set <name> <value>`, `guard off` ([below](#sending-a-password-or-a-key)) |
| `/mention` | Who answers a message in this group that tags nobody; `<agent>`, `required` or `default` changes it (admins); see [below](#groups) |
| `/daemon-restart` | Restart the whole daemon once nothing is running, or `now`; this chat is told when it is back |
| `/commands` | Sync this list to the platform's own command menu |

`/commands` is worth running once per Telegram bot: it pushes the list into the native menu so the
people using it do not have to know any of this. In the dashboard, typing `/` shows the list.

`/daemon-restart` is for a change that needs a restart, such as an edit to `config.toml`. It waits
until no turn or approval is in progress, ten minutes at most, and until every background job has
finished, however long that takes: its reply names the jobs it is waiting for, and
`/daemon-restart now` stops them and restarts at once. The chat then gets `✓ Restarted, I'm back.`
Only an admin can use it from a chat: someone paired with the bot or on its allowlist, whose person
under **People** is linked to a dashboard account with the admin role. Telegram's menu lists it as
`/daemon_restart`, because Telegram command names cannot contain a hyphen. Both spellings work.

`/effort high` sets how long the model thinks in this chat, from the next message, over the agent's own
`[llm] effort`. An agent its own model answers sends the level with each request. A model that refuses it is asked
again without it, and the answer ends with a line saying so, once; `/effort` alone says it too. A model that takes the
level and ignores it looks the same as one that heeds it, so what Nouride says is what it sent. `/effort default` puts
back the agent's level, which its Model tab sets. Claude Code and Codex set it on their own session:
[External agents →](/en/docs/manual/external-agents/)

A chat's `/model` and `/effort` are kept through a restart, an update included, until `/model default`,
`/effort default`, `/reset` or a rollover drops them; `/new` keeps them.

**On the dashboard, the same two are a button** (from 0.8.35). In the bar over a conversation with one agent, the
button with the model's name opens a panel: pick a model from the list or type its name, and pick an effort. It is the
same choice the commands make, for that conversation only and from your next message, and each reads what the other
set. **Back to the agent's own** undoes it. A model picked before a conversation's first message goes with that
message. An agent a coding CLI answers picks among the models its CLI offers, once the CLI has listed them. Rooms and
chats on a chat app keep the commands.

A chat's level is that chat's alone, and a mission runs in a conversation of its own. `/effort max lock` makes the
level the agent's own instead: written in its config as the Model tab does, for every chat and every mission, and kept
across a restart. `/effort lock` locks the level this chat set, and `/effort unlock` takes the agent's own away. Only an
admin can, someone whose person under **People** is linked to an admin's dashboard account, as for `/daemon-restart`.

`/btw what port was that?` asks a side question, while the agent works or when it does not. The agent answers as
itself, in your language, from the conversation so far and the work it has in progress, on its own model thinking
briefly, within a minute. From there it does nothing: no tools, nothing run or changed. Ask it to do something and it
says, in its own words, that this is better asked in the chat itself, where it can. The answer starts with `btw:` and
is kept out of the conversation: the work goes on as it was, and the next message is answered as if it was never asked.
The dashboard shows it beside the turn. One at a time per chat.

## Sessions, and what `/new` actually clears

A conversation is stored per agent per chat. `/new` starts a fresh one, the agent stops seeing the
earlier messages. Nothing starts one for you unless you set `[rollover] mode` to `daily` or `idle`;
it is off by default.

What survives `/new`:

- **`MEMORY.md`**: the agent's own curated notes.
- **People**: who you are, what you go by, and what the operator wrote about you.
- **Skills**: the shared pool.
- **Memory**, when it is on: the conversation `/new` clears is kept and filed overnight, so what
  mattered in it can come back later. [Memory →](/en/docs/architecture/memory/)

So the fix for "it forgot my sister's name after `/new`" is not to avoid `/new`. It is to have the
fact written down in one of those places, where it is permanent.

## When the conversation gets long

The daemon compacts rather than truncating: it summarises the older part of the conversation and
keeps the recent turns verbatim. That happens automatically, and `/compact` forces it early.

Before that, what a tool printed more than two turns ago leaves the conversation (from 0.8.13): each result becomes a
line saying where its whole text is kept, which the agent opens with `read` when it needs it again. It happens when the
model's cache of the conversation is lost anyway (the agent's prompt, model or tools changed, or the chat was quiet
for an hour), or once there is enough of it to be worth rewriting, so a chat going back and forth keeps its cache.

One long task is held the same way (from 0.8.35). When a single turn has taken so many steps that they fill the
model's context by themselves, the agent sums up its earliest steps and carries on from those notes. Before, such a
turn ended there, with the work unfinished.

`max_context_ratio` decides how much of the model's context window gets filled before that kicks in.
[Configuration reference →](/en/docs/reference/config/)

## Sending a message while it works

In a one-to-one chat you do not have to wait for a turn to finish. Send a message while the agent is
working and the turn reads it at its next step. Never in the middle of one: whatever is running, a
tool or a model call, finishes first, then your message is put in front of the model before its next
call. The agent knows this can happen, so "use the staging database" or "stop there" changes
what it is doing instead of waiting behind it. You are told at once:

> `↪ Got it, I'll read that before my next step.`

A second or two later the agent adds a line of its own, in your language, saying what it will do
with it, like a colleague answering without stopping work:

> On it: once this command finishes I'll switch to the staging database.

That line costs one small model call. It carries the agent's persona, so it sounds like itself, your
notes from People, so it calls you what you like to be called, the latest part of the conversation, so
"that one" in your message means what it means to you, then the request the turn is on, its last few
steps and your message. The turn is shown what it said as a quick guess, and goes by your words where
the guess misread them.

When the turn is quicker than the line, reading your message, answering or ending before the line is
ready, the call is stopped and nothing more is sent: what the turn does with your message is the
answer then. The same when the call fails or takes longer than `steer_reply_timeout_ms` (15 seconds).
While a line is being written, further messages get "Got it" alone.

`[queue] steer_reply = false` keeps "Got it" and drops the line. `steer_reply_model` names a faster
model on the agent's provider for it: a reasoning model can take ten seconds over one sentence.

If the turn is waiting on an approval in that chat, the reply says your message will be read once
the approval is answered, with `/approve` or `/deny` (in a room it leaves the commands to the
approval's own message). A "yes" typed as a message does not answer it.

- **Several messages** sent before the next step are read together, as one. A turn reads five this
  way; after that, a message waits for the turn to finish, and you are told so once:
  `⏳ Nouva is still working on "…": this message waits for it, and is answered next.`
- **A turn already writing its final answer** has no next step. Your message is not lost: it starts
  the next turn the moment this one ends. If the daemon goes down first, the restart answers it; after
  `/stop`, it is treated like any message to a paused agent.
- **Only words are read this way.** A file or a picture waits for the turn, and a slash command is
  answered at once, as always.
- **An agent answered by Claude Code or Codex** (from 0.8.10) is handed your message in the prompt it is
  running, through its CLI. While a command of its runs, the message waits for that command to end, five
  minutes at most, so a test run is not pushed aside; the CLI then stops what it was writing to read it. A
  CLI that cannot take a message mid-prompt reads it once its prompt ends, and "Got it" says so: "I'll read
  that once what I'm running now ends."

What the turn read stays in the conversation. On the dashboard your message appears at once, under
the agent's steps, with "Got it" and the agent's line under it, and the steps mark where the turn
read it: `read a message sent while working: "…"`. In a room your message keeps its own place, and the
agent's card quotes it above the lines that answer it. `[queue] steer = false` turns this off, and a
message sent mid-turn then waits for the turn.

### In a room

The person who started the turn steers it the same way, as long as the message is for the agent: it
names it (`@nouva …`, `nouva: …`) or replies to something it said. Anyone else who addresses a busy
agent gets a short answer instead of silence, once per turn:

> `⏳ Nouva is still working on "migrate the database" (4m so far): ask again once it's done.`

It quotes the request the turn is working on, on one line and with every `@` taken out, so the reply
wakes nobody. It adds when the turn is waiting on an approval, and it never suggests `/stop`, which
pauses the agent in every chat. A message that does not address the agent, people talking among
themselves in a room with one bot, gets nothing, as before.

Another agent handing work to a busy one never steers it either, but its hand-over is kept (0.8.33).
The room is told once:

> `⏳ Nox is still working on "deploy the shop" (4m so far): this message waits for it, and is answered next.`

When the turn ends, the busy agent takes the hand-over as its next turn. A second hand-over from the
same agent meanwhile joins the first, so both are done in one turn. One that has waited longer than a
message may wait in the queue (`queue_timeout_ms`, an hour by default) is left, and the agent it was
for says so in the room.

## Editing a message you sent

On Telegram, Discord and WhatsApp an edit reaches the agent, and where your message is decides what it
does:

- **Not answered yet** (still waiting its turn): the agent answers it as you corrected it, once.
- **Being answered** (the turn is working on it): the edit reaches that turn at its next step, the way
  a message sent while it works does, as your correction. You are told
  `↪ Got your edit, I'll go by it from my next step.`
- **Already answered**: the agent is asked again, told it is an edit and what the message said
  before, so it can say what changes. Only for an edit within fifteen minutes of when you sent the
  message, the same quarter hour after which a message is too old to answer at all: a typo tidied in
  an old message starts nothing.

An edit that changes nothing you can see starts nothing either (Telegram and Discord send a message
again when its link preview loads), and one that now reads as a command is not run: send the command
as a message of its own. In a room an edit is routed like any message: one that now names the agent
reaches it, and one that names nobody only changes what the agents overhear. Edits are words: a
picture swapped in an edit is not sent to the agent again.

The agent's reply to an edit quotes your message. In the dashboard's chat a message answered as edited
carries a small *edited* mark under it, and so does one edited while the turn worked. `nouride turns`
marks the turn `edited`, `nouride turns show` says which message, and `nouride events` ends the line
`(edited)`; the stream carries it as `editOf`.

## Sending a password or a key

Paste a credential into a chat and the daemon takes it out of your message before anything keeps it or
a model reads it. In its place the agent sees a handle, `$TMP_SECRET_` and twelve characters, and the
daemon tells you at once, in the chat and on the dashboard:

> 🔒 Taken out of your message before anything stored or read it: a GitHub token ($TMP_SECRET_3F9A1C2B7D4E).
> The agent can use it in commands for an hour without seeing it.

What it recognises: the formats of the services people use most (model providers, Nougate, GitHub and
GitLab, Telegram and Discord bot tokens, the clouds, Stripe, Midtrans and Xendit, private keys, web tokens,
a password in a URL) and a value you give a key that names a secret: `password: …`, `TOKEN=…`,
`"api_key": "…"`, `kata sandi: …`. A word, a name, a path or a piece of code there stays as you wrote it.
A password written into a sentence with no `:` or `=` is not looked for (the ways of saying it are
endless), so send it as `password: …`, or keep it with `/secret set`. What you quote counts too: a reply
to a message that held one has it taken out of the quote.

The agent uses the handle in a command, `curl -H "Authorization: Bearer $TMP_SECRET_…"`, and the command
finds the value in its environment; whatever the command prints is masked. The value is only in the
daemon's memory (never in the conversation's history, the dashboard, a log line or a request to a model),
and it is gone an hour after you sent it, or when the daemon restarts. To keep it, ask the agent to save
it under a name, or do it yourself with `/secret set`. An agent that keeps one notes what it is for beside it
(0.8.19): the site, the username or email it goes with, what uses it. Those details are not secret, and you can change
them on the dashboard's Secrets page; the value itself is only ever replaced.

A command that prints a credential file or an environment gives the same handles, one per value (see
[credential files](/en/docs/manual/approvals/#secrets-an-agent-may-spend-but-never-read)), so `/secret` may list
`DB_URL in box:/srv/app/.env` beside what you sent.

| | |
|---|---|
| `/secret` | What this chat holds: each handle, what it was, and the minutes it has left |
| `/secret undo` | It was not a secret: your last message goes back as you wrote it, as an edit of itself, within fifteen minutes |
| `/secret set <name> <value>` | Keep a value under a name, for good, and hand it to every command of this chat's agent as `$NAME`; `/secret replace` writes over one that is set. The value is taken out of the command too, whatever it looks like |

Keeping a value under a name is an admin's, as `/daemon-restart` is. The [secret guard](/en/docs/manual/approvals/#the-secret-guard) has no switch since 0.8.0. Your
platform still has the message as you sent it: delete it there if that matters to you; Nouride's copy
never had it.

## When the daemon restarts mid-turn

Every step of a turn is saved as it happens: your message, each reply from the model, each tool
result. If the daemon stops in the middle, for an update, a crash or a power cut, nothing the turn
did is lost, and the agent tells you where it got to:

> ⚠️ I was interrupted by a restart while working on "deploy the site". Done: `read site.toml`,
> `git status`. Cut off: `exec ./deploy.sh` (it may have partly run). Everything I did is kept. If
> I'm back within 15 minutes I'll carry on by myself; after that I'll ask you first.

If the daemon is back within 15 minutes, the agent carries on by itself with everything it had. A
tool that was cut off is marked as such, so the agent checks what it did before repeating anything
that changes something. If the turn was cut off before it did anything, the agent says so and
answers your message once the daemon is back.

It carries on once. A turn that was itself carrying on after a restart is not taken up again, so a
turn that crashes the daemon cannot loop, and a scheduled run is not taken up at all.

Back after longer than 15 minutes, nothing runs by itself: a command run an hour late may no longer
be what you want. The agent asks you instead, once, in the chat the work was in:

> I was cut off 1 hour ago while working on "deploy the site". I have not carried on by myself,
> since it was a while ago. Say "continue" and I will pick it up.

Say "continue" and it picks the work up from what it kept. On Telegram and Discord the question has
a **Continue** button that does the same; in a group, the person who asked for the work or an admin
presses it. After a power cut or a crash nothing could be said at the time, so that question comes
with the list of what was done and what was cut off. It is not asked if you have written in that
chat since, if the work was a scheduled run, or if it was cut off more than two days ago. To stop
the work for good, use `/stop`, not a restart.

Messages are written down the moment they arrive, so nothing sent during a restart is lost either.
One sent in the last 15 minutes is answered once the daemon is back; an older one gets a short note
saying it came in while the daemon was offline, rather than a late answer to yesterday's question. A
message a platform delivers twice is answered once, and a reply interrupted halfway is not sent
twice.

## Groups

Two settings decide how an agent behaves in a room it is not being spoken to directly in:

- **`groups_require_mention`**: off by default. On, an agent ignores unaddressed chatter in groups on
  Telegram, Discord and WhatsApp. DMs still answer everything, and so do the rooms you make in the
  dashboard, which follow their members instead: a message with no tag is answered by the orchestrator
  when it is in the room, or by the room's only agent, and otherwise by nobody.
- **`group_context_messages`**: 20 by default. When an agent *is* addressed, this many recent
  messages come along, so `@nouva ini gimana?` arrives with the exchange it points at.

Chatter still triggers nothing. It is remembered, not answered, and the agent does not bring it up unless
you ask about it.

In a group, every line the agent reads is `Name: …`, the message it was tagged in too. Someone in
`[[people]]` is called by their name there, on every account they write from; anyone else by the name
their platform shows.

Both are daemon-wide, under `[agents]`, because they are about rooms rather than any one agent;
`group_context_messages` is also on the **Agents → Settings** page. A single connection can override
either, and the group-context field on a connection's form says out loud that it is an override.

A group can also answer one question for itself, from inside the group: **a message here that tags
nobody, who answers it?**

- `/mention` says it in one sentence: whether a tag is needed, who answers a message with none, and
  where the setting comes from (this group, the gateway, or the daemon; in a room made in the
  dashboard, the room's own rule above).
- `/mention @NovelistBot` gives the group to that agent: no tag is needed, and it answers every message
  here that tags nobody. The agent can be named by its bot's handle, its id or its name
  (`/mention novelist`), and on Discord by tagging its bot.
- `/mention required`: a tag is needed, and a message that tags nobody is answered by nobody.
- `/mention default` removes the group's own setting, so the gateway and the daemon decide again, or,
  in a dashboard room, its members.

A tag and a reply still win: in a group given to the novelist, `@Alice …` or a reply to something
Alice said is Alice's. The setting decides only a message that names nobody.

On Telegram a topic is a room of its own, so `/mention @NovelistBot` sent inside one topic gives that
topic to the novelist, and the other topics stay as they were.

The group's own setting wins over the connection's and the daemon's, and it is kept across restarts.
It belongs to the group, not to one bot: with several of our bots in the group, each one reads the
same setting, and the command is answered once. Changing it is an admin's, as for `/daemon-restart`;
anyone else is told so and nothing changes. In a DM it does nothing: a DM always gets an answer. The
same choice is on the dashboard's **Groups** page, one list per group, and what either says the other
shows.

`/mention@NovelistBot`, the way Telegram's command menu writes a command for one bot, is answered by
that bot: it says who answers here now, and how to give the group to it.

If the agent a group named is later removed or switched off, the group follows the orchestrator again,
and `/mention` says so.

In a group several of our bots share, a message that names nobody is never answered by every bot: it
is answered once, by the agent the group named, or else by the orchestrator
([Gateways → The orchestrator is the front desk](/en/docs/gateways/overview/#the-orchestrator-is-the-front-desk)).

Until 0.8.34 the words were `/mention on` and `/mention off`. Both are still read: `on` is `required`,
and `off` is no tag needed with nobody named, which the orchestrator answers.

### A group's name

A room is one chat on one platform: a WhatsApp or Telegram group, a Discord channel, a Discord thread
(a room of its own), or a room made in the dashboard. Each keeps its own conversation, its own
`/mention` setting and its own memory.

A room is called what its platform calls it: a WhatsApp group's subject, a Telegram group's title, a
Discord channel as `#name` and a thread by its own name. The agent is told that name, and it is what
`send_message` takes: "send this to Keluarga Besar". **Groups**, beside People in the dashboard, lists
every room the agents talk in, with its agents and who talks there; an admin can rename one there, and
clearing the name gives the platform's back. Two rooms with the same name are not guessed between:
the agent is shown both and picks by address.

A group's file in memory (`groups/<…>.md`) is where what is learned there is kept, not its name.
Renaming that file does not rename the group.

### Threads

In a Discord thread, the agent's first answer there knows the message the thread was started from:
it arrives in front of the question, as `[This thread was started from a message in #channel by Name: …]`.

:::caution
Everything said in a room becomes context for the agents in it, including from senders you have not
paired. If that matters, set `group_context_messages = 0`.
:::

**On Telegram, none of this works until privacy mode is off.** BotFather → `/setprivacy` → Disable,
or make the bot an admin. Otherwise Telegram simply does not deliver the messages.

## Two agents in one room

Agents address each other by tag. Nouva writes `@nox benerin build ini`, Nox sees it and acts. The
dashboard's rooms work the same way: you pick the agents when you make the room, and a tag is how a
message reaches one of them.

**The tag is the handover.** A reply *without* one reaches nobody, which is how an exchange ends
naturally. That soft brake depends on a model choosing not to tag, so there is a hard one too: only a
mention routes a message from an agent, never a channel binding, never the gateway owner, never the
orchestrator, and after `mention_max_hops` handovers (5 by default) the daemon says so in the chat
and stops delivering. A human saying anything resets the count, because the limit exists to bound
*unattended* chatter. Where the chat app has buttons (Telegram, Discord), that line carries
**Continue** (0.8.33): a press delivers the hand-over that was stopped and starts the count again.

Both agents share a working directory (`workspace/shared/`), which is what makes the handover
meaningful: the build Nox was asked to fix is somewhere Nox can actually open.

**Each agent is told what the others are doing (0.8.33).** In a room, the message an agent answers
says which of the other agents are at work there, on which request and for how long, and which are
asleep. So it knows before it tags one that the work will wait. It is also told what else runs on the
box: its own turns in other chats, helpers, missions and background commands with their folder, six
at most and the rest counted. Work somebody else asked for in a private chat is named without its
words, only its kind, its folder and its time. This tells the agent and locks nothing: avoiding a
clash is still the agent's call.

**When handed-over work fails.** If the agent that took the work fails or runs out of time, the line
it leaves carries **Continue** and **Hand to** for up to three other agents of the room (0.8.33).
Continue has the same agent take it up again. Hand to gives another agent what the first was asked.
Anyone who may talk to that agent in the room can press, once, and the line then says who chose what.
Without buttons the line says the same in words: say "continue", or tag another agent.

**When your own request fails in a room.** If the agent had already done part of the work, the line it leaves
says so and carries **Continue** (from 0.8.35), so you do not have to tag it again. You, or an admin, can press
it, once. In a one-to-one chat there is no button: saying "continue" is as short.

**In a one-to-one chat this is not how it works, and it cannot be.** Each bot has its own private
conversation with you, so a tag written in a DM reaches nobody, the other agent's bot never sees the
message. There, an agent hands work over with the `ask_agent` tool instead: the other agent runs
behind the chat with its own skills and permissions, its progress appears labelled `[nox]`, and its
answer comes back to the agent that asked. The one you are talking to stays the only one that speaks.
If the other agent needs more than a minute, the one you are talking to says it is still on it and you
can carry on talking; the answer arrives by itself when it is ready, with what it is about.

Nothing to configure. The prompt tells each agent which of the two applies to the chat it is in, and
`mentions_enabled = false` turns off both. The switch and the hop limit are on **Agents → Settings**.

## Files

Send an agent a file and it is saved for that conversation, and the agent is handed a path to it. A
file sent in one chat cannot be opened from another. Images are looked at if `read_images` is on, by
the agent's own model unless you name a cheaper one in `[media] image_model`. Documents are **not**
sent to a model at all: the agent opens them with `read` or a command, so a PDF costs nothing until
the agent looks at it. Voice notes go to the model only if it can hear them (`read_audio`).

A very large picture, a long screenshot or a photo straight from a camera, is sent to the model as a
smaller copy: no side longer than 2,576 pixels, which is as much as a model reads (0.8.35). Your file
is not changed. Nouride makes the copy with ffmpeg; on a machine without it the picture is left out,
and the agent is told its size and that it was too large, so it can ask you for a smaller one. Before
this, one such picture could end every later turn of its conversation, because the provider refused
the whole request. `[media] max_image_side` sets the number, for a model that reads more.

Agents send files back with `send_file`. It will not send a credential file, or any file holding the
value of one of the agent's secrets, because a file on a chat platform cannot be masked.

## From the terminal

```bash
nouride chat            # the orchestrator
nouride chat nouva      # address one by name
```

Messages go through the running daemon's real `local` gateway, so routing, hooks, the queue, the tool
loop and session persistence all run exactly as they would for a chat platform. Slash commands work.
Approvals appear inline and you answer them with a keypress: `y`, `a` for always, or `n`.

It also works non-interactively, piped stdin is detected, and approvals are printed rather than
prompted for, which is how an end-to-end test talks to the daemon.

[Terminal chat →](/en/docs/gateways/cli-chat/)

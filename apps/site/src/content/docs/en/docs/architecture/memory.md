---
title: Memory
description: "How agents remember: conversations filed each night into Markdown, what is learned about people, who may read what, and how recall works without any extra model."
---

Memory is built to stay small enough for a Raspberry Pi and still behave like an assistant that knows
you. Four ideas carry it:

- **Files are the truth.** Everything remembered is Markdown in one folder. Open it in Obsidian, edit
  it by hand, back it up with `cp`. The SQLite index beside it can be deleted and rebuilt.
- **The work happens at night.** A chat turn only reads memory. Summarizing and learning is one model
  call per conversation, once a night.
- **Who may read a thing is decided in code**, from who was in the conversation it came from. A model
  never decides it.
- **No extra model is required.** Keyword search always works; semantic search is optional.

```
 chats ──► turn log ──► cut ──► episode (raw)  ──► nightly pass ──► episode (summarized)
                                                        │                 │
                                                        ├─► facts ──► people/<key>.md
                                                        └─► proposals ─► shared.md (after approval)

 every turn ◄── recall: profile · the week ahead · follow-ups · recent summaries
 on request ◄── memory_search · memory_read · memory_analyze
```

## The vault

One folder, `[memory] dir` (default `.nouride/memory`):

```
memory/
├── episodes/2026/09/2026-09-25-0459-nouva.md   one conversation
├── days/2026/09/2026-09-25.md                  a day's hub, for navigation
├── people/alex.md                              what is known about a person
├── shared.md                                   what every agent knows
├── agents/  groups/  tags/                     small stubs, so the graph has names; a tag gets one once two conversations share it
├── tags/_tidy/                                 a record of each tag tidy, which Undo reads
└── archive/2026/09/…md.gz                      old transcripts, compressed, unreadable by agents
```

Links live in frontmatter (`day`, `agents`, `people`, `tags`, `related`), so Obsidian's graph shows
people and agents as hubs, episodes around them, and tags joining episodes on one subject. Episodes,
day hubs and archived transcripts are filed by year and month, so no folder grows past a month of
conversations.

An agent's own `MEMORY.md` in its persona pack is separate: its working notes, written by the agent
with `memory_write`, read only by that agent, and never touched by the nightly pass.

Each kind of thing has one home, and an agent is told which:

| What | Where | Written by |
|---|---|---|
| Who somebody is, and what does not change: what to call them, who they are to the household, a birthday, an allergy | Their **notes** in People | You, for anyone. Through an agent, a person changes only their own, a line at a time (`person_notes`) |
| What is learned about them and changes: work, tastes, plans | Their profile, `people/<key>.md` | The nightly pass, and `memory_write` with `about=person` |
| What every agent should know | `shared.md` | The nightly pass, through Proposals |
| How an agent works, and what it is in the middle of | Its own `MEMORY.md` | The agent, with `memory_write` |

## Episodes

An **episode** is one stretch of one chat. A chat is cut into an episode at two moments only: `/new`
or `/reset` in it, and the nightly pass, which cuts every chat active since its last cut. There is no
idle timer. A stretch that crosses midnight is split per day, and one too long for a single model call
is split at turn boundaries.

Episodes are built from the daemon's turn log and the room's message log, not from the conversation's
context, so compaction and `/new` lose nothing. A group chat with several bots is one episode naming
all of them. An episode needs at least one agent turn: people talking among themselves is not memory,
and what they said more than a day before an agent's reply does not open its episode.

Each goes through three states:

| State | What it holds |
|---|---|
| `raw` | Cut, with its transcript. Searchable by its words already. |
| `summarized` | The nightly pass added a summary, up to four tags, an importance from 1 to 5, the people talked about, and up to three related episodes. |
| `compacted` | After `transcript_days` (180; `0` keeps them forever) the transcript leaves the episode. The summary stays forever; with `archive` on, the transcript is kept compressed under `archive/`. |

## The nightly pass

At `pass_at` (01:00 by default) the pass cuts every open chat, then makes one model call per raw
episode, at most `pass_per_night` per agent, direct messages first. The model is shown the redacted
transcript, the participants' facts that this conversation may see, the tags already in use, and a
fixed importance rubric. Its answer is JSON, checked field by field; anything it gets wrong is dropped
with a reason rather than failing the whole episode. An episode that fails `max_attempts` times waits
on the Timeline for a person.

Memory is written in English whatever language was spoken (summaries, facts, notes and tags), so one
keyword finds them across chats. Names and quoted terms stay as said, and transcripts stay as they
were said. Every writer checks it: an answer from the pass that is not English is asked for once
more, and left raw for the next night if it still is not; `memory_write` refuses it; a profile tidy
or a forget that comes back in another language is not kept.

After the call: the episode file is rewritten, facts are applied to profiles, the index is updated,
new summaries are embedded if semantic search is on, old transcripts are compacted, and the day hubs
that changed are redrawn. A profile that has grown past 40 facts or 3,000 characters is tidied
(duplicates merged, what is no longer true removed), three a night.

On a busy machine the night waits (0.8.0). Busy is any of three things: the CPUs more than 70% busy
over the last minute, a thermal zone at or past a trip point where the kernel acts on the heat
(slowing the CPU, or shutting down; a fan's trip points do not count), or the daemon's cgroup waiting
for memory 10% or more of the last minute. While it is, the pass
skips the minute; once it has started, it waits before each conversation and each batch of
embeddings, and looks again every half minute. After two hours of waiting it goes on anyway. The log
says once that it waits, and why, and once that it goes on. A machine without these files (a Mac, for
one) never counts as busy. Run now and `nouride memory pass` never wait.

### Tags

A tag is worth having when many conversations share it: that is what draws a cluster in the graph and
makes a count mean something. So the pass keeps one vocabulary, the same way for every install and
every language:

- **The model is shown the tags in use** in the conversation's audience, most used first, then the
  ones used once in the last 30 days (about 1,000 tokens at most), and the chat's own recent tags.
- **Every tag goes through one gate.** A new spelling folds into a tag in use where the match is
  certain: a plural or separator (`reminders` → `reminder`), a typo one letter off a tag on three or
  more conversations, or a short form an English suffix extends (`blog` → `blogging`). A conversation
  may then coin **one** new tag (three while its audience has fewer than 20 tagged conversations)
  and keeps four tags at most, never none.
- **The morning after**, the dashboard's Knowledge & Memory page lists the tags the night coined, each with the
  known tag the model judged nearest, and **Merge into** it in one click.

What was written before is tidied the same way, on request: **Tidy tags** on the Knowledge & Memory page (or
`nouride memory tags tidy`) previews merges by the same rules, a qualified tag folded into the broad
one beside it (`architecture-review` → `architecture`; offered unticked, since a narrower tag can be a
subject of its own), one-off tags trimmed (a conversation keeps
one, an imported day none), and the four-tag cap. A person ticks what to apply; the model is asked
for merges by meaning only when they tick that too. Applying rewrites only the `tags:` line of each
conversation, keeps the merged names as aliases of the tag kept (so the next night folds them), backs
the vault up first and records the change under `tags/_tidy/`, which is what **Undo** reads. The record
names conversations by id and stubs by tag, and Undo refuses one that names anything else: it is a note
in a vault that is synced and edited by hand, and Undo writes what it names. The graph has **Merge into…** on every tag.

## Facts

A profile is facts under headings. Each line says where it came from and who may read it:

```markdown
## Devices
- Uses a MacBook Air M1 laptop ([[2026-09-29-0739-ren]]) {alex}

## Plans
- Vacation in Lombok (until 2026-10-09) ([[2026-09-29-0739-ren]]) {alex}

## Family
- Mother's birthday (on --10-02) ([[2026-09-29-0739-ren-2]]) {alex}

## Follow-ups
- Pay the electricity bill (on 2026-09-30) ([[2026-09-29-0739-ren-2]]) {alex}
```

- `{…}` is the source conversation's audience: who took part, and the group when it was one. The file
  alone decides who may read the fact, even after the episode is compacted or deleted.
- **Dates are part of the words.** `(until …)`: once the day has passed the fact is not shown or
  found. `(on YYYY-MM-DD)` is one day; `(on --MM-DD)` comes back every year. Both come up in the prompt
  the week before.
- **Follow-ups** are what someone said would be done later or asked to be reminded of. They are listed
  on their own in the prompt, and removed when a later conversation (or the agent, with
  `memory_write`) says they are done.

Whether facts are learned is a choice: `facts` is `off`, `ask` (every change becomes a Proposal) or
`auto` (applied at once), for everyone, and overridden per person on the People tab. Shared knowledge
is read in every chat, so it is only ever proposed, never applied, and only with `propose_shared`.

Every change (by the pass, a tidy-up, an agent, an approved proposal) is recorded with what it
replaced and why, and shown as Recent changes. Each profile keeps its previous versions: one undo away.

## Who sees what

| Where the agent is talking | Conversations it may recall |
|---|---|
| A DM with a person | The ones that person took part in, on any agent: their DMs and their groups |
| A group | That group's own |
| An MCP token for a person | As a DM with them, limited to the agents the token names |

A fact is readable exactly where its source conversation is: in a DM with someone in its `{…}` list,
or in the group it names. What Sam tells an agent in private reaches Sam's DMs and nowhere else; it
never shows up in the family group, and never in someone else's DM. Deleting an episode deletes the
facts it taught.

## Recall

**In every prompt**, already filtered by the rules above, and stable between cuts so it stays in the
cached part of the prompt:

- the profile of each known person in the chat, up to 60 facts a person and 120 in all, so in a big
  group the one speaking is shown in full and the others share the rest;
- `shared.md`;
- what is coming up in the next week, and open follow-ups;
- the latest summaries this chat may see (`prompt_recent`, 3), each saying when it was another agent's;
- conversations cut since the last pass (after `/new`, the one just left), by their first line.

`recall = false` under `[memory]` leaves all of it out, and a `[[people]]` entry's own `recall` overrides that for one
person: on the dashboard, Knowledge & Memory → Settings and each person on the People tab. Off, the nightly pass still learns and
the agents still reach memory through the tools below.

**On request**, through tools:

| Tool | What it does |
|---|---|
| `memory_search` | Search conversations and facts this chat may see. |
| `memory_read` | Open one conversation: its transcript while kept, else its summary. With `related`, also the conversations next to it. |
| `memory_analyze` | Counts, not prose: dates something came up, per day/week/month, top tags or people, activity per agent, importance. No model call. |
| `memory_write` | The agent's own `MEMORY.md`, or (`about=person`) add, correct or drop a fact about the person it is talking to. |

### How search ranks

1. **Filter first** to what this chat may see.
2. **Keywords:** BM25 over a term index of summaries, tags, facts and kept transcripts. A query word of
   four letters or more also matches the words it begins; English plurals are cut back; the roots
   Indonesian affixes hide are indexed beside each word, so `liburan` finds `berlibur`.
3. **Meaning**, if semantic search is on: cosine over int8 vectors of the same items, fused with the
   keyword ranking (RRF). The keyword ranking's first three keep a bonus, so an exact hit (an address,
   a port, a name) is not pushed down by something merely similar.
4. **Score:** relevance 0.5, importance 0.3, recency 0.2.
5. **Two hops** over `related`, either way round, at 0.7 of the score per hop, at most five per result.

Related episodes are chosen by the pass from the last 90 days: those sharing a person and a tag, the
closest three, reordered by how alike the summaries are when semantic search is on.

### Why these two

**Following a thread.** One matter is often several conversations on different days: Monday "the NAS
is full", Wednesday "now it is slow", Friday "I replaced the disk". A search finds one of them; `related`
is how the rest come with it, without the agent guessing other words: the one-hop step does it inside
every search, and `memory_read` with `related` does it on purpose: for "carry on from last time", for
a problem that is back ("how did we fix this before?"), and for a long conversation cut in two at
midnight. It is the idea of Basic Memory's `build_context`, kept to edges the index already holds: no
model, no graph database, and every neighbour through the same rule as any conversation.

**Exact beats similar.** Search by meaning is good at "something like this" and weak at "exactly this".
Asked for "the staging Postgres port 5433" or "192.168.0.54", an embedding can find a conversation about
databases in general closer than the one that says 5433. The bonus on the keyword ranking's first three
places (the idea of QMD's position-aware blending) keeps the exact hit on top. With semantic search
off there is only the keyword ranking, and nothing to protect it from.

Semantic search needs a provider that serves embeddings over the OpenAI API: Ollama on your own
network (`bge-m3`), OpenAI (`text-embedding-3-small`) or Gemini (`gemini-embedding-001`). Vectors are
kept in the index and searched by brute force, which is fine to tens of thousands of conversations on
small hardware. A failed embed falls back to keywords, never to an error.

## In the dashboard

### The Knowledge & Memory page

**Knowledge & Memory** in the sidebar. The line at the top says whether memory is on, when the nightly pass runs
next and whether search by meaning is on; under it, the last tag tidy, with **Undo**.

![The Memory page, on the Agent notes tab](/media/memory-page.png)

| Tab | What it holds |
|---|---|
| **Agent notes** | Each agent's own `MEMORY.md`: what it keeps for itself with `memory_write`. Never changed by the nightly pass. Opens to read or edit; a save over a version the agent changed meanwhile is refused rather than overwriting it. |
| **People** | Everyone with a profile: their facts, where each came from and who may read it, whether facts are learned for them (`off`, `ask`, `auto`), earlier versions of the profile, and **Forget**. **Notes** opens their notes from People, the same text and dialog. |
| **Timeline** | Conversations by day, newest first, with their summary, tags, people and importance, and the ones the pass could not file, to retry. |
| **Shared** | `shared.md`, what every agent knows. |
| **Proposals** | Changes waiting for a person: facts while `facts = "ask"`, and anything for `shared.md`. |
| **Settings** | The nightly pass, the helper model (the pass's model, which also summarizes long conversations) and whether it is working, how many recent summaries each prompt carries, and search by meaning. |

**Tidy tags** and **Graph view** open the two tools described in [Tags](#tags) and below.

### The memory graph

**Graph view** draws what memory holds: every conversation is a dot, joined to what it links to.

![The memory graph](/media/memory-graph.png)

| Dot | What it is | Size |
|---|---|---|
| Conversation | One episode, labelled with the first line of its summary | its importance |
| Person | Someone who took part in it, or was talked about | how many shown conversations link to them |
| Tag | A subject | the same |
| Agent | The agent it was with | the same |

A conversation is joined to its agent, to the people in it (a dashed line when they were only talked
about), to its tags, and to the conversations the nightly pass judged **related**. Those last links,
dot to dot, are the ones search follows when it brings a conversation's neighbours along.

It is built to open quickly on a Pi, and that shapes what you see:

- **The newest 300 conversations** the filters match (150, 600 or 1,000 can be chosen), never the
  whole vault.
- **A tag on only one shown conversation is left out.** It joins nothing to anything, and on a real
  vault three tags in four are like that.
- **Built once per change to memory**, in practice once a night after the pass, however often it is
  opened.
- **Conversations only.** Facts live in profiles, on the People tab.

How to read it: a tag with many dots around it is a subject that keeps coming back; a short chain of
conversations joined directly is one matter over several days; a person or an agent with a cloud
around it is everything they were part of.

How to use it:

- **Filter** by agent, person, tag and time range. Several of one kind match any of them; different
  kinds must all match: "Nouva or Ren, and `#homelab`".
- The legend shows or hides a kind; the search box lights up the dots whose label matches.
- **Click a dot** and its links light up while a panel opens. On a conversation, **Read conversation**
  opens it (summary, tags, people, and the transcript while it is kept) with its related ones listed
  below. On a person, tag or agent, the panel lists the conversations it is in, and **Only this**
  filters the graph down to them.
- **A tag can be merged** from its panel with **Merge into…**: the same merge as **Tidy tags**. The
  vault is backed up first, the old name is kept as an alias so the next night folds it, and the Memory
  page's tidy line can undo it.

![A tag selected, with Merge into…](/media/memory-graph-tag.png)

Drag to move, scroll to zoom; every conversation is labelled once you zoom in. The same links are
written into each file's frontmatter, so Obsidian's graph view draws the same picture from the vault.

## The index

SQLite tables beside the rest of the daemon's state (episodes, their people, tags and related links,
facts with their readers, the keyword index, vectors), all rebuilt from the vault by `nouride memory
reindex`. Files are re-read at boot and before each pass when their modified time or size changed, so an edit
in Obsidian or a sync tool is picked up.

Keyword search is SQLite's own full-text engine, FTS5, built into every release binary. The index keeps
only the words, not a second copy of the text, so on a box with 900 conversations it takes about 4 MB.
Both sides of a search are tokenised the same way, by Nouride: folded to lower case, diacritics removed,
stop words dropped, and Indonesian roots indexed beside the words, so `liburan` finds `berlibur`. Related
conversations are followed both ways and up to two links out. There is no vector extension: comparing a
household's vectors directly takes about 2 ms.

## The knowledge base

Documents a person keeps for reference (an SOP, a manual, a policy) are not memory: they are kept whole in collections
under `.nouride/knowledge/`, never summarized and never turned into facts. Their sections are in the same word index
and the same vectors as memory, so `memory_search` ranks them with conversations and facts, filtered by the same rule:
a collection is searched only where every person in the conversation may be answered from it. RECALL names the
collections an agent may search there, not their documents. The [knowledge base](/en/docs/manual/knowledge/) page says
how to keep them.

## Keeping it safe

- **Backups:** the vault is snapshotted weekly into `data/backups/memory/<stamp>/`, a full tree
  (restore is `cp -r`). Unchanged files are hard-linked to the previous snapshot, so a month of them
  costs about one vault. `daemon.backup_keep` decides how many.
- **Forget a person:** *forget completely* deletes their profile, the conversations they were in and
  proposals about them, and rewrites other summaries without them (checked afterwards for their name);
  *hide their name* replaces it with `[forgotten]` instead. Neither can be undone: the earlier versions
  of every profile lose what their conversations taught, and so does Recent changes. Every chat is cut
  first, so what they said since the last cut goes too. The weekly snapshots above keep it until they
  rotate out, a chat still open with them until `/new`, and the turn log for `session_days`.
- **Secrets never reach memory:** transcripts are redacted before a model sees them, and the pass is
  told never to write credentials, codes or addresses.

## Settings

```toml
[memory]
dir             = "./.nouride/memory"
pass            = false       # the nightly pass; the setup wizard asks
pass_at         = "01:00"
pass_per_night  = 20          # episodes per agent per night
pass_provider   = ""          # empty: each agent's own provider and model
pass_model      = ""
max_attempts    = 3
facts           = "off"       # off | ask | auto; per person on the People tab
propose_shared  = false
prompt_recent   = 3
recall          = true          # what is remembered, in each prompt
transcript_days = 180         # 0 = forever
archive         = true

[memory.semantic]
enabled    = false
provider   = ""               # an OpenAI-compatible profile that embeds, e.g. one pointing at Ollama
model      = ""               # e.g. bge-m3
dimensions = 512
```

`pass_provider` and `pass_model` are the **helper model**. It writes the nightly pass's summaries, and it
also summarizes a conversation that gets too long for its agent to carry whole (compaction), unless
`[llm.context] summary_model` is set, in which case long conversations are summarized with that model, on
each agent's own provider. When the helper model cannot answer (not served, no access, out of quota), each
agent's own model is asked instead. Whether it is working is shown under it, on the **Helper model** card in
Knowledge & Memory → Settings: *Working* when nothing is failing, otherwise what is (summarizing, the nightly pass, or
the model each agent's own stands in for), how many times, how long ago and the provider's last error. A
warning clears once its job works again or its model is no longer the one set, at the latest a day after the
last failure. `nouride doctor` and the Overview's warnings say the same.

A vector is kept under the provider, the model and the size asked of it, so changing any of the three
embeds everything again, a night's share at a time. Until then the old vectors stay where they were: each
is replaced as its conversation or fact is embedded again, so a model that can't be reached, or one you
switch back from, leaves search by meaning as it was.

Nouride can also serve memory to other tools as an MCP server: search and read as a person, and save
a conversation from elsewhere to be filed tonight. See **Integrations** in the dashboard.

![Integrations: Nouride's MCP server, and one key per app](/media/dashboard-integrations.png)

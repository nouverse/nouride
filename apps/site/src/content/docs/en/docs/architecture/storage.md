---
title: State & storage
description: One SQLite file, one directory of Markdown, and what is the source of truth for what.
---

Two kinds of state, kept apart on purpose.

**Markdown is the source of truth for identity.** Personas are meant to be edited by hand and diffed
in git.

**SQLite is the source of truth for everything with a lifecycle.** Sessions, approvals, jobs, the
audit trail, none of which anybody wants to read as a file.

## The directory

```
.nouride/                      one install, one mounted volume
├── config.toml                daemon config
├── people/<key>.toml          one person each (since 0.8.18), with their last versions beside them
├── data/                      the daemon's own state
│   ├── nouride.db             SQLite, 0600: sessions, turns, cron, approvals, audit, usage, memory index
│   ├── nouride.db-wal         WAL mode - concurrent read and write
│   ├── secrets.enc            0600, encrypted (0.8.19), write-only from outside; its key is kept elsewhere
│   ├── secrets.sealed         a copy sealed to the backup password, made again at each change (0.8.19)
│   ├── .control-token         0640 - what the CLI reads to authenticate (group-readable)
│   ├── whatsapp/              Baileys session, AES-256-GCM at rest
│   ├── backups/agents/        dated copies of the persona packs, their skills.toml and mcp.toml too
│   ├── backups/config/        dated copies of config.toml, people/, agents/mcp.toml and secrets.sealed (0.8.18)
│   ├── backups/db/            weekly snapshots of nouride.db, each verified
│   ├── backups/knowledge/     dated copies of the knowledge base's documents (0.8.20)
│   ├── backups/memory/        dated copies of the memory vault, unchanged files hard-linked
│   └── backups/skills/        dated copies of the skill pool (0.8.18)
├── agents/
│   ├── <id>/                  persona packs - git-trackable identity
│   │   ├── IDENTITY.md SOUL.md AGENTS.md MEMORY.md
│   │   └── config.toml  skills.toml
│   └── skills/<name>/SKILL.md the skill pool every agent shares; skills/.history/ what an improvement replaced
├── attachments/<agent>/<chat>/<date>/   what was sent in a chat - its agent reads its own
├── jobs/<agent>/              background command logs - its agent reads its own
├── tool-output/<agent>/<conversation>/   tool results too large for the context
├── credentials/               file-shaped credentials, unreachable by file tools
├── knowledge/<collection id>/ the knowledge base: one folder per collection, the documents as added (0.8.20)
├── memory/                    conversations, profiles and shared knowledge (the memory vault)
├── bin/                       programs installed for every agent, on every command's PATH
├── lib/  opt/                 what those programs need, and the shared Python env (opt/python)
├── home/                      the daemon's HOME: ssh keys, known hosts, CLI logins - every agent's where they share its user
└── workspace/
    ├── shared/                every agent - the working directory
    └── private/<id>/          one agent, unreadable by the others - its HOME where it is its own user
```

What an agent's command is handed a path to sits beside `data/`, never in it (0.8.0): on a Linux install where each
agent's commands run as its own user, no command enters `data/`, and each agent reaches its own job logs, attachments
and long tool output and no other agent's. What an agent installs then lands in its own `~/.local`; `bin/`, `lib/` and
`opt/` are every agent's to run and only the daemon's to change.

There, an agent's HOME is `workspace/private/<id>/`, seeded once from `home/`: its ssh keys and known hosts, its own
installs, its stdio MCP servers' sign-ins, an external agent's CLI sign-ins (`.cli/<cli>/<profile>`) and a mission's
worktree (`missions/<id>/worktree`). Back it up as you back up `home/`. On Docker, macOS or without the helper, every
agent shares the daemon's user and `home/` is their HOME.
[Each agent its own user →](/en/docs/architecture/overview/#each-agent-its-own-user)

Four keys point at four of these, `data_dir`, `agents_dir` and `workspace_dir` under `[daemon]` and
`[memory] dir`, rather than one root, because they differ in backup policy, sensitivity and size.
`workspace_dir` on another disk is a supported arrangement, and the persona pack is deliberately not
a workspace.

Beside `.nouride/` sits the install itself: the `nouride` binary, `dashboard/` and the skills that
ship with it. Every update replaces it, so an agent's command that writes there is refused. On a
binary install it belongs to the service account, which is what lets `nouride update` replace it
without root.

## SQLite, and nothing else

No Postgres, no Redis, no vector database, no external daemon. One file, WAL mode, opened through
Bun's native driver.

The schema lives in numbered, forward-only migrations compiled into the binary; `PRAGMA user_version`
tracks what has been applied. There is no migration step to run, a new binary migrates at boot. Before
it touches an existing database it checks that its own SQLite can hold the schema (3.43 or later, with
FTS5), and snapshots the file. It refuses a database whose applied migrations it does not recognise,
or one a newer build has already migrated, rather than run queries against a schema it is wrong
about. A migration that leaves more than a quarter of the file empty is followed by a `VACUUM`, when
there is the memory to rebuild it.

What is in there: sessions and their turns, the journal of each running turn, the inbox of messages
not yet answered, tool executions, approvals, standing grants, sender access, background jobs, cron
jobs and their runs, skill drafts, usage and cost, the daemon's own log, dashboard accounts and
sign-ins, and the memory index.

SQLite is the database, not a portable subset of SQL: the memory index uses its full-text engine,
FTS5, and queries use recursive CTEs and JSON functions where they help. Every query lives in a
`*.store.ts` file and everything else takes a store, enforced by the lint rules, which also check
that each query binds its values and that its plan searches rather than scans a table.

:::caution[Backups stay on the same disk unless you move them]
The database is snapshotted weekly into `data/backups/db/` (`VACUUM INTO`, each copy
integrity-checked), and at boot unless the newest is under a week old, beside the persona packs
and the memory vault; `daemon.backup_keep` (4) decides how many are kept. The snapshot taken before a
migration, `nouride-<time>-before-<n>.db`, is kept outside that rotation: it is the way back from an
upgrade. By default all of them live on the same disk as the original; `daemon.backup_dir` moves the
scheduled ones to another, such as a USB drive on a box that runs from an SD card. `nouride db backup`
takes one on demand and `nouride db restore <file>` puts one back, with the daemon stopped; `tar` over
`.nouride/` with the daemon stopped is the full copy to put somewhere else.
[Backup →](/en/docs/manual/maintenance/#backup)
:::

## Secrets

Config files hold secret **names**. Values live somewhere else, and are resolved at the moment they
are used:

```
api_key = "nougate"   →   $NOUGATE
                      →   $NOURIDE_SECRET_NOUGATE
                      →   data/secrets.enc
```

Environment wins over the store, so a container platform can always pin a value. The store is what
the dashboard writes to, which is why adding a bot token does not need a redeploy.

This is what makes a `config.toml` safe to commit, print, and render in a browser.

```bash
nouride secret                                 # names and what each is for: values are never printed
printf '%s' "$TOKEN" | nouride secret set telegram-nouva --stdin --field site=telegram.org
nouride secret rm telegram-nouva
```

`--value <v>` exists and the CLI says out loud what it costs: the value ends up in your shell
history. Pipe it instead.

**Encrypted at rest (0.8.19).** `secrets.enc` is the whole store, AES-256-GCM, under a key derived from
`NOURIDE_ENCRYPTION_KEY`. What that is worth is how far the key is from the data, so it is kept outside the install
wherever there is an outside: on Linux, `install.sh` puts it in root's `/etc/nouride/nouride.env`, which systemd reads
before it starts the service, and the `nouride` command hands it to what root runs through it; on a Mac,
`~/.config/nouride/nouride.env`; a container takes it from its environment, or from a file named in
`NOURIDE_ENCRYPTION_KEY_FILE`. A copy of `.nouride/` then carries no key, and cannot open the store. An install that
only updated gets a key the daemon makes, a line in the install's `.env`, which the next `install.sh` moves out as it
is; a container given none keeps one in `.nouride/`. `nouride doctor` says where the key is either way.

The store names its key's fingerprint, so a wrong key is said as one rather than taken for damage, and the daemon
never makes a key over a store that needs another: it refuses to start and names the two ways out, that key, or
`nouride secret restore` with the backup password. The key leaves the daemon's environment once read, so nothing it
runs inherits it. What the encryption does not cover, said plainly: root on the machine, the running daemon (it holds
the values to use them), a whole image of a disk with no TPM, and the blocks an old plain `secrets.json` left on disk.

**What a secret is for (0.8.19).** Each can carry fields of your own naming: the site it belongs to, the username or
email it goes with, what uses it. They are not secret: shown beside the name on the dashboard's Secrets page, by
`nouride secret`, and to agents, which fill them in when they keep one. A text shaped like a key or a password is
refused there. A secret's value is only ever replaced, never shown.

The store goes into a snapshot only sealed (0.8.18): a backup password, set on the dashboard's Secrets page or with
`nouride secret seal --stdin`, and `[daemon] backup_seal` keeps the public half of a key that password derives. Each
config snapshot then holds `secrets.sealed` (X25519 and AES-256-GCM, the key from scrypt), which the daemon can write
and cannot read; `nouride secret unseal` opens it with the password. Since 0.8.19 the copy beside the store,
`data/secrets.sealed`, is made again at each change, and `nouride secret restore --stdin` puts it back under this
install's key: for a lost key, or an install moved without it. Without a backup password, no snapshot holds a secret.

## What ages out, and when

```toml
[retention]
session_days     = 30    # conversations, and the attachments belonging to them
audit_days       = 30    # the audit trail and usage records
job_log_days     = 3     # background command output
tool_output_days = 2     # tool results spilled to disk
scratchpad_days  = 3     # each agent's disposable directory
log_days         = 3     # the daemon's own log table (0 turns it off)
```

Two of these are worth understanding.

**`job_log_days`** cannot be "delete when the job ends", because the agent may still be holding the
path the tool handed it. A log that no job points at any more goes on the same count (0.8.36): the
sweep went by the jobs on record, and a log without one stayed for good.

**`scratchpad_days`** covers `workspace/private/<agent>/.scratchpad/`: the disposable directory an
agent is told to put throwaway artefacts in: a screenshot on its way to being sent, a download on its
way to being converted. A command's `$TMPDIR` points there. Deleting inside it is never on the fixed list,
so an agent can clear up after itself. It is swept on a timer rather than at
the end of the turn, because the next message is usually about the file that was just sent.

"Which skills has nobody read" does not depend on `audit_days`: when each skill was last read is kept
apart from the audit rows that record it (`skill_reads`), for as long as the skill exists.

## Conversation history

A conversation is stored per agent, per chat, per gateway instance. `max_conversation_turns` (200)
caps how much is kept.

When the context gets long the daemon **compacts** rather than truncating: the older part is
summarised once, the summary is kept, and the most recent turns stay verbatim. A conversation may use
`max_context_ratio` (0.8) of the model's window, and compaction starts at `compact_at_ratio` (0.8) of
that, or at `compact_at_tokens` (160k for most models) if that comes first. The exact exchanges that
were compacted away can still be read back with `memory_read`.

`/new` starts a fresh conversation. What survives it: `MEMORY.md`, the People entries,
and the memory vault (the conversation just left is cut into an episode, and learned facts stay in
the profiles).

## Memory

Every conversation becomes an **episode**, a Markdown file in the memory vault; a nightly pass, once
switched on, summarizes it and keeps what it learned about the people in it. The vault is the truth
and its SQLite index, built on FTS5, is rebuilt from it. How it all works (who may read what, what
reaches the prompt, how search ranks) is on its own page: [Memory](/en/docs/architecture/memory/).

A rollover only clears a conversation's context; memory is cut from the turn log, so nothing is lost:

```toml
[rollover]
mode = "none"        # none | daily | idle
```

`daily` clears a conversation that *began* before today's boundary; `idle` clears one nobody has
touched for a while. That is the whole difference between them: a chat kept up all day is still stale
at the next boundary, and one started an hour ago is not idle however old the chat is.

## Health

The daemon checks its own free disk every minute and *alerts* below 1 GB rather than only logging;
`/health` reports degraded once the WAL passes 100 MB. These were `[health]` until 0.8.0; nobody tuned
them, so they are fixed now, and a `[health]` table still in `config.toml` is named in a warning and
ignored. This is the daemon watching itself:
nothing here wakes an agent. A cron job does that, and so does an agent's own background job, when it
finishes or has been quiet for a while.

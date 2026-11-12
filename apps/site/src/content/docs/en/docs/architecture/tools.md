---
title: Tools, sandbox & policy
description: What an agent can reach, what stops it, and where the real boundaries are.
---

Everything an agent *does*, as opposed to says, goes through a tool. Each one is named, typed,
individually gateable, and recorded in the audit log by name.

An [external agent](/en/docs/manual/external-agents/) is the exception for its own work: its coding CLI's files, shell
and web are the CLI's tools, not these. The approval level, the fixed list and `[tools]` do not reach them; its preset
does, and what the CLI asks under it comes to you as an approval. The Nouride tools it is lent while a turn runs are
these, gated and audited as below.

## The built-in tools

| | |
|---|---|
| **Files** | `read` (text, and a PNG, JPEG, GIF or WebP as a picture), `write`, `edit`, `multi_edit`, `glob`, `grep` |
| **Commands** | `exec` (one shot), `session` (a persistent process it can type into), `secret_save` (keep a credential sent in chat under a name, with what it is for, without seeing it) |
| **Web** | `web_search`, `web_fetch` |
| **Memory** | `memory_search`, `memory_read`, `memory_analyze`, `memory_write` |
| **Attachments** | `attachment_read`, `send_file` |
| **Other chats** | `send_message` (post into a chat it knows (a person's one-to-one or a group), and that chat's conversation keeps it; asks first) |
| **People** | `person_record`, `person_notes` |
| **Other agents** | `delegate` (a subagent), `ask_agent` (another persona), `plan` |
| **Skills** | `skill_create`, `skill_improve`, `skill_toggle`, `skill_search`, `skill_install` |
| **MCP** | `mcp_search` (find a server in the official MCP registry, and give the person the link to add it; it cannot add one) |
| **Itself** | `agent_create`, `agent_configure`, `nouride`, `update`, `session_status` |

Which of them one agent gets is `[tools] enabled` in its pack. Anything not listed is not in the
schema at all, the model does not know it exists, which is deliberate: a tool in the schema is a
promise the model will try to keep. A few follow the daemon rather than the list: `ask_agent` when
there is another agent to ask, `attachment_read`, and the agent's MCP tools. `skill_create` brings
`skill_search` and `skill_install` with it, and `send_file` brings `send_message`.

The skill tools are sent to the model as one (0.8.37): a tool called `skill` that names what each does
in a line. The model calls it with an action to read what that action takes, then again with its
arguments. An agent's schemas are sent with every request, and these were about a tenth of them for
tools that are almost never called. Only what the model is sent changes: `[tools] enabled`, a standing
grant, an approval and the audit log name each tool as before, and an agent that holds just one of
them is sent that one as itself.

`web_search` has one exception worth knowing. With no search key at all it falls back to keyless
sources rather than disappearing, because an agent without a search tool does not stop searching: it
writes a scraper and runs it through `exec`. It is withdrawn only when a backend you chose cannot
work, a SearXNG with no address, say, or Exa with no key.

## Where a tool may reach

An agent's file and exec tools resolve paths against its **workspace roots**:

```toml
# .nouride/agents/nouva/config.toml
[workspace]
roots = ["/home/you/projects/thing"]
```

Empty means its own pack, the shared workspace and its private directory: safe, but it cannot touch a
project. Some directories are readable and never writable: the skills it was offered, its own job
logs and spilled tool output, and, for an agent with a shell, its `HOME` and the installed programs
under `.nouride/bin`, `lib` and `opt`. Those last are opened by path only; a search with no path
skips them, since they are mostly caches.

A path outside every root is refused however it is spelled, `..` traversal, symlinks and absolute
paths all resolve first. The refusal names the way that works: an agent with a shell reads such a
file with `exec`. `nouride doctor` reports a declared root that does not exist, because that is the
case where everything else looks green while every path is rejected.

The file tools never write the agent's own `config.toml`, or the daemon's, at any approval level. Its
tools, roots and approvals are yours to change, from the dashboard or the CLI.

`.nouride/workspace/shared/` is where a relative path lands, and it is shared by every agent on
purpose. [Why →](/en/docs/architecture/agents/#where-an-agent-works)

## Credentials an agent can use but never read

The credentials directory is deliberately **not** a workspace root. `read`, `glob` and `grep` cannot
reach it. Only a command can, through `$NOURIDE_CREDENTIALS_DIR`, which the harness block tells the
agent about.

That distinction is the whole point. A credential that reaches the context window is in the
provider's request log, in the session on disk, and in whatever the model says next. A `chmod`
reaches none of those.

```toml
[security]
credentials_dir = ""      # empty = <data_dir>/credentials, created 0700 at boot
```

A command that names a file there, `cat .nouride/data/credentials/token.json`, is a credential path: never an
everyday command, so `careful` asks it once and an `allow-always` can answer for that exact command, and what it
prints is masked at every level. `python3 sync.py`, where the script opens the file itself, is not classified. A
command you wrote may use a credential; the agent pulling one into a conversation has to be asked
about. Since 0.7.17 what those files hold is masked out of every tool's result anyway, a script that
opens one and prints a token included.

**The daemon refuses to start if the credentials directory lands inside any readable root**, so a
placement that would quietly let the model read a key fails at boot rather than at no point at all.

The other half of the same idea is `exec_secrets`: secret names whose values arrive in a child
process as environment variables at the moment the command runs, and never in the prompt. If a
command prints one anyway, every tool result is masked before the model sees it: the value, its
base64 and URL-encoded forms, and its first eight characters, so a print that stops short is caught
too. It reads `[REDACTED:NAME]`.
[Approvals & permissions →](/en/docs/manual/approvals/#secrets-an-agent-may-spend-but-never-read)

## Credential files in a project

Projects carry `.env` files; `HOME` carries `.npmrc`, `.netrc`, cloud CLI logins and ssh keys. `read`
and `grep` show those with their secret values hidden: which keys are set and how the file is laid
out, never the values, so a pattern cannot find a secret one guessed character at a time. A command
still uses them without printing them. Nouride's own secrets, the secret store, the control token and
the credentials directory, are refused outright.

A command meets the same since 0.7.17. One that reads a credential file has its values masked out of
what it prints, so `cat .env` shows what `read` shows; a `git add`, `commit` or `push` that would carry
one is refused at every approval level, naming the file; and one that sends one off this machine
(`scp`, an upload with `curl`, a gist) asks first, under the secret guard. Nouride's own are held
tighter: a command, or a line typed into a session, that names the secret store, a copy of it, or the
control token is refused at every level, and what the store, the control token and the credentials
directory's files hold is masked out of every tool's result, however a command came to print it.

`send_file` will not send a credential file, or any text file holding the value of one of the
agent's own secrets. A file on a chat platform goes as it is, and nothing can mask it there.

## The approval gate

A gated tool call parks the turn and asks a human. Nothing runs while it waits, and a request nobody
answers expires as a **denial** rather than an approval.

The classifier behind it finds what is on the fixed list (a `config.toml` changed, access given, this daemon
stopped or replaced, a secret replaced, a credential leaving, the database, a delete outside the workspace,
infrastructure torn down, a job that runs unasked, a session, a force-push, this machine's system packages changed, a
program installed for every agent, an agent's persona or People changed), and none of them can ever become a standing
grant. The approval level decides which reach a person. It looks *through* privilege escalation, so
`sudo systemctl stop nouride` classifies as this daemon stopped rather than as a `sudo`.

A command that writes into the daemon's own install, the binary or a skill that ships with it, is
refused rather than asked about, with the right way named: `nouride update`, or a copy of the skill
in the pool.

:::caution[The classifier is not a security boundary]
A determined model routes around any classifier. It exists so ordinary work does not surprise you.
What actually holds is the service account, the unit hardening, the workspace roots and the access
gate.
:::

[The full permission model →](/en/docs/manual/approvals/)

## The daemon refuses to start in one configuration

**A gateway enabled, an agent holding `exec`, `[security.access] mode = "open"`, and the sender
allowlist empty.** That combination is a remote shell for anyone who finds the bot, so it is a boot failure
rather than a warning in a log nobody reads.

## Limits on one call

| | Default | |
|---|---|---|
| `tool_timeout_ms` | 30 s | one tool call; `exec` may ask for up to 4 min |
| `tool_max_output_bytes` | 100 MB | output one call may produce; a large one is spilled to disk and only its ends are held |
| `approval_timeout_ms` | 5 min | unanswered requests expire as denials |
| `max_tool_iterations` | 250 | tool calls in a single turn |
| `max_turn_duration_ms` | 1 hour | wall clock on one whole turn |
| `command_timeout_ms` | 10 min | a scheduled `--command` payload |

The two turn budgets are large on purpose, so one turn can carry a long piece of work through the way
a coding agent does. The conversation is compacted as it grows, and `/stop` ends a turn at once. A
tool that does not stop when its turn is stopped, by `/stop` or by the clock, is given five seconds;
then the turn ends without it, and its result says it may still be running in the background.
`max_turn_duration_ms` is separate from the per-request and per-tool timeouts, which each bound a
single step. While a turn runs, other chats do not wait for it, and in a one-to-one chat a message
sent meanwhile is read by the turn at its next step. An agent's pack can set its own budgets with
`[llm] max_tool_iterations` and `max_turn_seconds`.

Kernel ceilings on a single command exist and are **off by default**:

```toml
[security.exec]
max_memory_mb = 0        # prlimit --as; Linux only
max_cpu_seconds = 0
```

They are off because `--as` caps address space rather than resident size, and V8 reserves far more
address space than it uses, at a 1 GB cap, `tsc` aborts while using 250 MB. A cap low enough to
protect a small machine kills every build on it; one high enough to let builds run protects nothing.

Set, they bound a background job as well as a command in the foreground. A service is the exception
for `max_cpu_seconds`: CPU seconds add up for as long as a process runs, so a server would be killed
for running. A job's log is masked against the agent's credentials as it is written, like everything
else a command prints.

What does help on a shared box: commands the agent spawns run at `nice 10`, and the generated systemd
unit carries a soft `MemoryHigh` at 80% of the machine's memory and a private `/tmp` with a size cap,
both written as absolute numbers computed at install time. A clone too big for `/tmp` then fails with
"no space", which an agent can see and report, instead of filling RAM until the daemon is throttled.
Since 0.7.19 the commands also run in a cgroup of their own, capped below that ceiling: the one that
outgrows it is killed, alone, and the daemon keeps answering.

## Installing without root

Agents run as an unprivileged account, so every installer's default for a global install is a
directory they cannot write. Each installer is pointed at `.nouride/` instead, through the settings it
already reads:

- `npm i -g`, `bun add -g`, `pipx install`, `uv tool install`, `go install` and `cargo install` land
  in `.nouride/bin`, with no root and no flags. A release binary goes there with `install -m 755`.
- `pip install` works: agents share one Python environment, `.nouride/opt/python`, which still sees
  the system's own Python packages. It is built when the daemon starts, and rebuilt if the system's
  Python changes.
- Every command, background job, `session` and scheduled command gets the same `PATH`: the bin
  directory, the shared Python env, the system's own directories, and last `~/.local/bin` and
  `~/.cargo/bin`, so nothing there can shadow a system program.
- The shell a command runs in is always the system's. A `bash` put in the bin directory is never the
  one that starts the next command, and the same goes for the `tar` that unpacks an update.
- Where an agent used to improvise, the error comes back with a one-line hint: Python refusing `pip`
  (PEP 668), no `sudo`, a binary for the wrong architecture or C library, no compiler, a program that
  is not installed.
- A system package goes through `nouride pkg install`, where the install allows it, and runs as a
  background job so a long install is not cut off. [System packages →](/en/docs/deployment/system-packages/)
- `nouride doctor` lists what agents installed, and warns about a link into a cache, a broken link,
  or a program that hides a system one such as `git` or `python3`.

All of this applies where `HOME` is the agents' own, `.nouride/home`, as it is under a service and in
the container. `nouride start` on your own machine leaves your npm and pip alone.

## Web access

`web_fetch` blocks private, LAN and loopback addresses by default, and blocks cloud metadata
endpoints unconditionally.

```toml
[security.web]
allow_private_urls = false
```

Turning it on is what lets an agent check a service it just started, `http://localhost:3000/health`
after running a dev server. It is off by default because on a server it turns `web_fetch` into a
reader of every internal service on the box, and the agent takes its instructions from chat.

Set it up on the dashboard's **Web Search** page (under Settings): pick a provider, follow the steps to get its key or server, test it, save. `web_search` has four backends: Brave (a key, a free tier), Exa (a key, a search made for AI agents:
each result comes with a few lines from the page), SearXNG (self-hosted, no key), and a keyless scraping
fallback. Exa is set up like Brave, its key under its own name:

```toml
[security.web]
search_kind = "exa"
search_api_key = "exa_api_key"   # the secret's name; the key itself in Secrets or as EXA_API_KEY
```

Only Brave, the default, falls back to the keyless sources while it has no key. Exa with no key leaves
the agents no web search, and `nouride config check` says so.

On a runtime failure, 429, 5xx, a timeout, the primary falls back rather than losing an agent's search
mid-task. A search service in `fallback_backends` uses its own key, never the primary's: Brave's from
`brave_search_api_key`, Exa's from `exa_api_key`, where the Web Search page keeps them. One whose key is
not set is skipped, and `nouride config check` says so. When the service refuses, the agent is told what
that means: a key it did not accept (401), an account with no credit left (402), or too many searches for
now (429).

The keyless sources are asked all at once, each with its own 6-second deadline, and the search returns
shortly after the first general engine answers: a source that hangs costs a few seconds at most, not
the whole search. Which sources are asked is the model's choice, through `sources`:

| `sources` | asks |
|---|---|
| `web` | DuckDuckGo, Bing (DuckDuckGo Lite when both come back empty) |
| `news` | Google News, in the edition for `lang` |
| `wiki` | Wikipedia in English, plus the Wikipedia in `lang` |
| `forum` | Reddit, through DuckDuckGo's `site:` filter |
| `code` | GitHub, Stack Overflow, npm, MDN, Hacker News |
| `papers` | arXiv |

Without `sources` it asks `web`, `news`, `wiki` and `forum`. `lang` takes any language tag (`en`, `id`,
`ja`, `pt-BR`), and `recent: true` puts headlines first. Results are merged and de-duplicated, general
engines first. An engine that answers a bot with unrelated results instead of refusing (Bing does)
is recognised by none of them mentioning the query, and left out.

Image search rides on the same tool (`kind = "image"`) and returns direct image URLs that `send_file`
can take, which is the whole "find a picture and send it" path with no browser anywhere in it. Only
Brave and SearXNG can do it: Exa returns pages, not pictures. The keyless fallback the keyless fallback scrapes result *pages* and has no image
mode, so it refuses and names both settings rather than handing back page URLs that are not images.

## Rate limiting

```toml
[security.rate_limit]
messages_per_minute = 10          # per sender, per gateway
cooldown_reply = "Please slow down."
```

## Untrusted text is marked as such

These are marked before the model sees them: **MCP tool results and their descriptions**, web pages
and search results, a file or picture somebody sent, and the body of a webhook that triggered a job.
All of it is written by somebody who is not you.

Marking is not gating. A server you would not run a command from is a server you should not connect.

## Interactive commands

`exec` runs with stdin closed, the right default for a one-shot command. The `session` tool opens a
persistent process the agent can type into, so `ssh host`, `kubectl exec -it`, `vim` and a `sudo`
password prompt are reachable.

That needs a real pty, which comes from `script(1)`: `util-linux`'s in the Docker image and on native
Linux, and the one macOS ships on a Mac (since 0.7.20). Where there is no `script`, a session falls
back to pipes and says so: fine for a program that reads stdin, useless for anything that draws a
screen.

Long-running non-interactive work belongs in a background job instead.

## Background jobs and services

`exec` with `background: true` starts work that takes a while and then finishes (a test suite, a
build, a deploy) and returns a job id and a log path at once. The agent's turn ends there and it is
woken with the result. With `keep_working` it carries on instead, with work that does not need the
result, fixing an unrelated file while a build runs, and hears the result after that turn. Obvious
long work, an install, a clone, a build, is backgrounded on its own when the agent did not say.

A **server** never finishes, so it is a **service** instead: `service: true`, or recognised on its own
(a dev server, a static server, `docker compose up` without `-d`, a tunnel). It is a job like the
others (listed in `nouride jobs` and the dashboard, logged, stopped with `nouride jobs kill <id>`),
but the turn goes on, so the agent can check it answers and use it straight away: start a preview and
send its link in the same reply.

A job that has gone quiet for `[jobs] quiet_after_minutes` (5) wakes its agent to say it is still
running, then again at twice the wait each time. Nothing is stopped for being quiet; the person
decides. Running too long is another matter, and the operator's: `[security] job_max_ms`, off by
default, stops a job that is not a service after that long, and its agent is told it did not finish.

A command that starts something with `&` and leaves it running returns when the command does; what is
left running keeps going.

Jobs do not survive a restart, which is why an update waits for them to finish. Services are not
waited for: they run until they are stopped.

## Subagents

`delegate` starts a subagent: no chat history, no slash commands, and half the iteration budget. It
shares the parent's tools and permissions, and up to four run at once. The agent waits for them up to a
minute; one still working then carries on in the background as a job of the agent's, and its result wakes
the agent when it comes, at once with `background: true`
([Helpers in the background](/en/docs/architecture/agents/#helpers-in-the-background)). In a mission that works in a worktree,
`isolated` gives each helper a worktree of the mission's on a branch of its own, `mission/<id>-helper-<n>`, for the
mission to merge; anywhere else it is refused.
[Missions in a repository →](/en/docs/manual/missions/#in-a-repository)

`ask_agent` is the other shape, a different *persona*, with its own skills, tools and permissions,
running behind the conversation. Its progress appears labelled with its name and its answer comes
back to the agent that asked. The agent you are talking to stays the only one that speaks. An ask
waits up to 45 seconds; work that takes longer carries on in the background as a job of the asking
agent's, and its answer wakes that agent when it comes, at once with `background: true`
([Asks that run long](/en/docs/architecture/agents/#asks-that-run-long)). Several agents are asked in one
call (`asks`, up to four): they work at the same time and answer in one result, each under its name.

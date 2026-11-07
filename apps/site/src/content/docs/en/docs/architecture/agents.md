---
title: Agents & persona packs
description: What an agent actually is, a directory of Markdown, and the config file beside it.
---

An agent is a **directory**. Not a process, not a container, not a row in a table.

```
.nouride/agents/nouva/
├── IDENTITY.md      # required: name, headline, emoji, bio
├── SOUL.md          # personality, behaviour rules, tone
├── AGENTS.md        # the other agents: who they are, how to reach them
├── MEMORY.md        # persistent notes, which the agent writes itself
├── config.toml      # model, channel bindings, tools, workspace
├── mcp.toml         # which of the install's MCP servers this one uses, and its own credentials
└── skills.toml      # which pooled skills this one has switched off
```

**`IDENTITY.md` is the only required file.** Everything else has a sensible default, and an agent
with nothing but an identity works.

```bash
mkdir -p .nouride/agents/nouva
printf '# IDENTITY\n- Name: Nouva\n' > .nouride/agents/nouva/IDENTITY.md
```

Packs hot-reload. `/reload` in a chat, `nouride agent reload <id>`, or the dashboard's Files tab, 
no restart.

## What each file is for

**`IDENTITY.md`**: who this is. Name, headline, emoji, a line of biography. Short.

```markdown
# IDENTITY

- **Name:** Nouva
- **Headline:** Code and servers: reads and changes code, runs commands and tests
- **Emoji:** 🛠️
- **Bio:** Works on the Nouverse stack. Answers in the language it was asked in.
```

The other agents see one line of it: the **headline**, one short line of 150 characters at most saying what to bring
this agent. Their prompt's OTHER AGENTS section, and the list `ask_agent` answers a wrong name with, give each peer its
display name and its headline (`nouva: Nouva. Code and servers: reads and changes code, runs commands and tests`) or,
in a pack without one, its first line that is not a heading, a name or an emoji (a `Role:` line, what packs before
0.7.18 say, is not the headline since 0.8.0). A pack that says nothing is listed by its display name alone. So the
headline decides whether another agent asks this one for something: write what it is for, not how it behaves; that is
`SOUL.md`.

It is set when the agent is made (in onboarding, the dashboard's New Agent form, `nouride setup --headline`, or by
`agent_create`) and starts as its preset's when left empty. The Agents list shows it, and its **Settings** tab edits it;
the other agents read a change from their next message.

**`SOUL.md`**: how it behaves. Tone, standing rules, what to do at the edges. This is the file worth
spending time on.

```markdown
# SOUL

You are Nouva. Keep answers short and factual.

- Say plainly when you do not know something.
- Never invent a tool result.
- When a request needs a capability you do not have, say which one is missing.
```

**Who it works with is not a file here.** Family, colleagues, what each person goes by and what they
care about live in **People** (the dashboard page, or `[[people]]` in `config.toml`): every agent
reads a person's notes, and only while that person is the one speaking. Until 0.7.0 that was
`USER.md`, read on every turn whoever was speaking, which greeted a household's second person by the
first one's name. A `USER.md` left in a pack is not read.

**`AGENTS.md`**: the other agents on this daemon, and how to reach them.

An agent does not edit `IDENTITY.md`, `SOUL.md` or `AGENTS.md` itself: they hold its rules and boundaries, and its file
tools refuse them (from 0.8.8). It proposes a change with its `persona` tool, the whole file or one section and a
reason, and an admin sees the diff and approves or denies it, at every approval level, `trusted` too, and a coding CLI
agent the same way. The diff puts each changed line under where it sits: its headings, its label, a table row's header
row (from 0.8.13) and the list item it is in. From 0.8.13 a rule's later lines are shown once under its reworded first
line, rather than each one taken out and put back, so a long rule can be reworded within what an admin is shown at once
(24 lines, 2,400 characters). Approved, the daemon writes it, keeps the version before as `<file>.bak.1`, records it in
the audit log and reloads the agent. The dashboard's **Files** tab stays your own way to change them.

**`MEMORY.md`**: the agent's own notes (how it works, what it is in the middle of), written by its
`memory_write` tool, in English whatever language the chat is in. What it learns about people goes
to the [memory vault](/en/docs/architecture/memory/) instead. **Nothing can rebuild this file.** It
is not in git, and it accumulates. The daemon keeps dated copies under `data/backups/agents/` for
that reason.

## Isolation is by construction

An agent loads only its own directory. What one agent knows about another comes from its own
`AGENTS.md`, from the names its prompt lists, and from what the other agent tells it, never from
reading another agent's files.

There is no permission check making that true. It is true because nothing in the loader looks
anywhere else.

## `config.toml`

Everything omitted falls back to the daemon defaults. The agent's id is its directory name. A key the
pack does not read, a typo or one a release removed, is named in a warning at load (`unknown pack config
key ignored`, and in `nouride config check`) and the agent loads, as the daemon's own config does.

```toml
[agent]
display_name = "Nouva"
emoji = "🛠️"
enabled = true
approvals = "balanced"   # careful | balanced | trusted | per-person (absent: follow each person)
access = "follow"     # follow | pair | allowlist: how strangers on its connections are treated

# `provider` names a [providers.*] profile in the daemon config. That profile owns the endpoint,
# the wire format and the credential, so moving this agent to a different deployment is one word.
[llm]
provider = "nougate-anthropic"
model = "claude-sonnet-4-20250514"
# small_model = "claude-haiku-4-5"   # its small and high tiers; unset, the install's on its provider, else `model`
# high_model = "claude-opus-4-1"
max_tokens = 8192
temperature = 0.7
max_tool_iterations = 40   # optional: this agent's own budgets, instead of the daemon's
max_turn_seconds = 900

# Chats this agent answers in, keyed by GATEWAY INSTANCE id, because two bots on one platform are
# two different audiences. Empty means it answers only when addressed by name, or always, if a
# gateway instance names it as its owner.
[channels]
"discord:main" = ["1234567890123456789"]
"telegram:nouva" = ["-1001234567"]

# Absent `enabled`: reading files and the web, memory, planning, and `nouride` behind approval.
[tools]
enabled = ["read", "web_search", "web_fetch", "memory_read", "memory_write", "person_record", "person_notes", "send_file"]
# or ["*"]: every tool, including ones a later release adds (what setup writes for the first agent)
approval_required = ["exec", "write", "edit"]
blocked = ["rm", "shutdown", "reboot"]   # commands exec refuses outright

# Helpers it may have working in the background at once (absent: the daemon's [delegate], 2). 0 is off.
[delegate]
max_background = 1

# Missions it may have working at once (absent: the daemon's [missions] per_agent, 1). 1 to 4.
[missions]
per_agent = 3

# Directories this agent's file and exec tools may reach, beyond its own pack and the workspace.
# Empty means those only: safe, but it cannot touch a project.
[workspace]
roots = ["/home/you/projects/thing"]
skill_roots = ["/home/you/projects/thing"]

[security]
sender_allowlist = []
ssh_agent = true      # its commands and stdio MCP servers get the daemon's SSH_AUTH_SOCK (off when absent)

[security.exec_secrets]  # secret NAMES whose values reach the commands each is bound to, as variables
pypi_token = ["twine upload"]

# A coding CLI answers this agent in place of its [llm] model: an external agent.
# [external]
# cli = "claude-code"     # claude-code | codex | an [[external_clis]] id from the daemon's config.toml
# profile = "default"     # the account it answers with
# permissions = "risky"   # folder: Free in its folder | risky: Ask when risky | all: Ask for everything
# model = "sonnet"        # as the CLI names it; absent: the CLI's default

# Its cat in the Office. Every part optional; one left out comes from the agent's id.
[look]
fur = "black"
hat = "beanie"
```

`[external]` is read at load: a CLI this install does not know, a profile name that is not lowercase letters, digits
and dashes, or a preset that is not one of the three stops that agent from loading, naming the field.
[External agents →](/en/docs/manual/external-agents/) A `[look]` word that is not one of its part's does the same.
[Office →](/en/docs/manual/office/#a-look-for-each-agent)

### `roots` and `skill_roots` are deliberately different lists

A **root** is somewhere the agent may read and write. A **skill root** is somewhere it accepts
*instructions* from, and those land in the system prompt, the most trusted position in the request.

Auto-loading skills from everything reachable would make a pull request into a prompt-injection
vector. A repository you cloned yesterday should be the first without being the second.

A skill root's skills live in its `.agents/skills/`, and a new one there is picked up on the next
message, no reload. They are read-only to the agent, and a pool or built-in skill of the same name
wins. A skill there may be a link to a folder elsewhere in the same root, a private submodule's for
example, and it loads like the others. A link out of the root is skipped: naming the root trusts that
directory, not wherever its links lead.

### Skills are not configured here

There is one pool at `agents/skills/`, and every agent gets all of it, along with the skills that
ship with Nouride. Exceptions go in `skills.toml` beside the pack:

```toml
[skills]
document-authoring = false
```

Default-on rather than an opt-in list, because a list written today cannot name a skill that arrives
next month. `[skills] off` in the daemon config switches one off for every agent.

A built-in skill sits beside the binary and is replaced by every update, so it is not edited in
place: an agent's command that writes there is refused. To change one, copy it into the pool, where
the copy wins. [Skills →](/en/docs/manual/skills/)

### MCP servers

External tools, installed once and switched on per agent, as skills are. **Configure → Connectors** in the dashboard
is the install's list of servers (the library, `agents/mcp.toml`), and an agent's **Connectors** tab switches each one
on or off for it. A server's tools are discovered on connect and offered as `<server>__<tool>`, because the names come
from the server and cannot be listed in `[tools] enabled` before you have connected once.

```toml
# agents/mcp.toml: the library
[[servers]]
name = "nouva-mcp"
transport = "stdio"
command = "python3"
args = ["/path/to/server.py"]
env = { MEMORY_DIR = "/data/memory" }
env_secrets = { GITHUB_TOKEN = "github_token" }   # variable = the NAME of a secret, never the value

[[servers]]
name = "browser"
transport = "streamable-http"
url = "https://mcp.example.com/mcp"
auth_secret = "example-mcp-token"      # the NAME of a secret, never the value
headers = { "X-Client" = "nouride" }
```

```toml
# agents/nox/mcp.toml, written by the dashboard and `nouride mcp`, one table per server
[servers.browser]
on = true

[servers.nouva-mcp]
on = true
env_secrets = { GITHUB_TOKEN = "nox_github_token" }   # nox's own, in place of the library's
```

A server's credential is the library's (one token, one set of variables, one login) for every agent it is on for,
unless an agent brings its own: its own secrets, or `login = "own"` to log in as somebody else. `per_agent = true` on a
server shares none: each agent brings its own. A pack's own `[[mcp_servers]]` in its `config.toml`, from before 0.7.19,
is refused since 0.8.0: that agent does not load, and the message says to add the server to the library
(`nouride mcp add` or the Connectors page), switched on for that agent, and remove the block.

**Choosing its tools.** Every tool a server offers goes into every request the agent makes: Notion's 65 tools are
about 250 KB of definitions, sent with each one. To give an agent only the tools it uses, open **Tools** on the server's
row in the agent's Connectors tab, tick the ones it needs (each shows what it adds to a request) and **Save**, or from a shell:

```bash
nouride mcp tools notion --agent nox                                   # its tools, what each costs, which nox has
nouride mcp tools notion --agent nox --only notion-search,notion-fetch
nouride mcp tools notion --agent nox --all                             # every tool again
```

That writes `tools = ["notion-search", "notion-fetch"]` into the server's table in `agents/nox/mcp.toml`. Without it the
agent has every tool, as before. A tool left out is not sent to the model, and a call to it is refused, naming the setting. A name the server does not offer (one it renamed, say)
is not an error: the other tools work, and the log and `nouride doctor` say which name is missing.

**Finding one.** The Connectors page's **Explore** searches Nouverse's MCP catalog, a mirror of the
[official MCP registry](https://registry.modelcontextprotocol.io), some forty-five thousand servers, kept up to date and
ranked by Nouverse. Before you type it shows Nouverse's picks; a search puts the publisher's own server first. Each
result says who published it (the namespace the registry made them prove: `com.notion/mcp` is notion.com's), how it
would run here (a remote endpoint, or a package through `npx`, `uvx` or `docker` when that is installed), and what it
asks for; one this machine cannot run says what it lacks ("needs uv", "Docker not usable") and how to get it.
**Add** opens the ordinary form filled in, the version pinned; something only you can give (a token, a
`{slug}` in its URL) is marked, and the form will not save until it is filled. `nouride mcp search [words]` and
`nouride mcp add --from <name> [--agent <id>]` do the same from a shell. An agent can look with `mcp_search`, and answers
with the link that opens Explore on that server: adding one is yours to do.

Nothing of the registry is stored on your machine: a search is sent to `service.nouverse.tech/mcp-catalog` (the words,
nothing else), and what it says about how a server would run here is worked out here. `NOURIDE_MCP_CATALOG_URL` points
the daemon at another copy of the catalog, one on your own network included, or, set empty, turns Explore,
`nouride mcp search` and `mcp_search` off. Adding a server by hand never needs it.

A stdio server that wants a token in its environment gets it through `env_secrets`: each variable names a secret, the
value is read from the secret store when the server starts, and a secret that is not set stops the start, naming the
variable. A value that looks like the token itself is refused at load, and so is a variable `env` sets too. The
server form stores what you type there under a name of its own (`mcp-lib-<server>-<variable>`, or
`mcp-<agent>-<server>-<variable>` for an agent's own); `nouride mcp add --env-secret
GITHUB_TOKEN=github_token` names a secret you set with `nouride secret set <name> --stdin`.

**Logging in.** A remote server with no credential of its own (no `auth_secret`, no `Authorization` header) is tried
with none, and one that answers by asking for a login, as Notion's and Linear's do, shows as **needs login** on its card
and in `nouride mcp`. **Connect** opens the server's login page in a new tab. Once you allow access, the browser comes
back to the dashboard (`/dashboard/oauth/mcp/callback` at `[dashboard] public_url`, or on this machine's loopback
without one) and the server connects. If that page cannot load because the browser is on another machine, paste the
address it ended on into the card. A login is the library's, used by every agent with none of its own, unless the agent has `login = "own"`. From a
shell, `nouride mcp login --server <name>` (with `--agent <id>` for an agent's own) prints the address
to open and asks for the one the browser landed on, which works over SSH. `--client-id` is for a server that
registers no clients itself, GitHub's for one; the client's secret is asked for, never typed on the command line.

The access and refresh tokens go to the secret store as `mcp-oauth-shared-<server>-access` and `-refresh` (or
`mcp-oauth-<agent>-…` for an agent's own), so every result is masked of them. They renew by themselves, and
each new pair is stored in one write before it is used. When the server stops taking the login (it refuses the
refresh), it is back to needs login, you are told once through `[alerts]` with where to log in, and an agent that
calls its tools is told a person has to log in again. A server that only cannot be reached stays an outage. `nouride
mcp logout` deletes the tokens. Logging in is an admin's to do, and an agent that runs `nouride
mcp login` or `logout` is asked about it every time.

All three transports work: `stdio` starts a process here; `streamable-http` and `sse` dial a remote
endpoint (`sse` is the older shape, prefer streamable-http unless the server only speaks sse).

Nouride speaks MCP 2025-06-18, and 2025-03-26 or 2024-11-05 to a server that answers with one of those. A
server that answers anything else is refused, and the log names it and both versions. A server whose tools
change while it runs, and that declared it would say so, has them listed again for the agent's next turn: the
log says what was added and removed, and a turn already running keeps the tools it started with. Arguments
are checked against the tool's schema before a call is sent, required ones and each one's type, and a call
that does not fit goes back to the model with what to fix instead of to the server. A result is held the same way
to the tool's output schema, when it declared one: a result whose data is missing a required field, has one of the
wrong type, or has no data at all reaches the model as an error naming each problem, not as the data, and the log
says it at warn with the server and the tool.

A server's name is its tools' prefix, so each server needs its own, and a name may not hold
`__` or end in `_`: either could give two servers' tools one name. The library is refused at load,
naming the entries, rather than offering whichever server connected last. What a server's tools cost
every request the agent makes is listed by `nouride mcp` and on the agent's Connectors tab; past 16KB it is
said at warn and by `nouride doctor`.

An MCP tool runs **without asking**, exactly like a built-in nobody listed. To gate one, name it in
`approval_required` by its qualified name.

Its results *and its tool descriptions* are marked as untrusted before the model sees them: both are
text written by somebody who is not you. Marking is not gating, a server you would not run a command
from is a server you should not connect.

For `stdio`, the child gets a minimal environment, `PATH`, `HOME`, locale, `TMPDIR`: not the
daemon's whole one, and `SSH_AUTH_SOCK` only when the pack says `ssh_agent = true`. Pass anything else
through `env`. Where each agent runs as its own user, so does its server: its HOME and installs are the agent's, and it
starts in the agent's folder unless its block names a `cwd`, one that user may enter. A server that kept its sign-in
or settings in the daemon's HOME finds them no more, as the agent's user cannot read that folder: sign it in again for
each agent, give it its token through `env_secrets` where it reads one, or copy what it saved into the agent's
folder. On Docker, macOS or without the helper, a stdio server still runs as the daemon's user and reads what the
daemon reads: give a shell or file server only to an agent you would trust with that.
[Each agent its own user →](/en/docs/architecture/overview/#each-agent-its-own-user)

Servers connect at boot and again whenever the pack reloads. A change from the dashboard or `nouride mcp` reloads the
agents it reaches, which connects or closes the server. Nothing restarts; a file edited by hand takes effect on
`/reload` or `nouride agent reload <id>`.

```bash
nouride mcp                                             # the library, the agents each server is on for, their tools
nouride mcp add --name browser --url https://mcp.example.com/mcp --stdin --agent nouva
nouride mcp enable browser --agent nox                  # on for another agent
nouride mcp disable browser --agent nox                 # off for it; the library keeps it
nouride mcp rm browser                                  # out of the library and every agent
nouride mcp login --server notion                       # a remote server that asks for a login, for every agent
nouride mcp logout --server notion
```

## Where an agent works

```
.nouride/workspace/
  shared/           every agent. This is where a relative path resolves
  private/<id>/     one agent, and no other can read it
```

**`shared/` is the working directory**, and that is what makes handover possible. Two agents in one
channel delegate by tagging; with a workspace per agent, the build being handed over sat outside
every directory the second agent was allowed to open, so the sandbox refused it however the path was
spelled. The mention could carry an instruction and never the work, and nothing reported that as a
failure. The second agent simply answered that the file was not there.

Two agents in one group can work at the same time, so writes take a lock per file: `write`, `edit`
and `memory_write` on one path never interleave, and neither loses the other's change.

`private/<id>/` is for drafts and scratch. Anything another agent may need to pick up does not belong
there, and each agent's prompt says exactly that.

**The persona pack is not a workspace.** Work used to land in `agents/<id>/`: observed on a real
run, with an operator's project built next to `IDENTITY.md` in a git-tracked directory. That is why
the two are separate paths, and why `workspace_dir` can point at another disk without moving anything
else.

## Presets, tools and the orchestrator

A new agent from the dashboard starts from a **preset**, which decides its first tools and a few lines
of how it works in `AGENTS.md`, and is not kept afterwards. **New Agent** is an admin's to use, and under
**Answered by** it can pick a coding CLI the box has instead of a model: an
[external agent](/en/docs/manual/external-agents/). Approvals are not part of a preset: every
new agent is written with `[agent] approvals = "balanced"`, so it asks only before what is destructive,
touches the system, infrastructure or credentials, or opens an interactive session, for everyone who
talks to it.

| Preset | Starts with |
|---|---|
| **Pilot** | Every tool. The first agent, from the setup wizard, is always this. |
| **Researcher** | Web search and fetch, reading files, memory. No terminal, writes nothing. |
| **Assistant** | Memory, reminders, web search, sending files. No terminal. |
| **Developer** | Files, the terminal, tests, web fetch for docs. |
| **Custom** | The tools you pick. |

Afterwards its tools are switches on the agent's **Settings** tab (written to `[tools] enabled`), beside
its tool and turn budgets and how many helpers it may run in the background. **Make orchestrator** on
an agent's page sets `daemon.orchestrator`: the agent a message reaches when nothing names another, the front desk of
rooms several of your bots share, listed first everywhere.

## Helpers in the background

An agent can hand a task that will take a while to a **helper** and keep talking to you: `delegate` with
`background: true`. Its turn ends at once with what it started; the helper works on its own, and its
result comes back to the agent as a message when it finishes, which the agent reports in your language.
Two helpers are reported one by one, each as it finishes: the first to finish is not held for the
second.

The agent is told the habit: one helper for a task that takes longer than a few minutes and less than
an hour (research across files or hosts, a long build, a migration rehearsal), so it stays free for you;
two only for two independent pieces; work that may run past an hour is a mission's. Not for a quick
answer, and not for something you are waiting on now.

- **What it hands over is a brief**, in English whatever language you speak: the goal, the context the
  helper cannot know (paths, hosts, what was already tried), the constraints, and what to hand back. A
  brief with no context is refused with what to add.
- **A helper inherits what the agent may do** (its tools, its grants and approvals, its MCP servers, its
  skills), but not who it is: no persona, no memory. It writes no memory, sends nothing to the chat and
  starts no helper of its own; it says what is worth keeping, and the agent decides.
- **How many at once** is `[delegate] max_background`: 2 by default, 0 turns them off, set per agent on
  its **Settings** tab, from the next helper on.
- **Each helper is a job**: in `nouride jobs` and under System Logs → Background work, with its goal, and
  in the chat's strip while it runs. `/stop` in the chat stops the agent's helpers there; `nouride jobs
  kill <id>` stops one.
- **An approval it needs** is asked in your chat, naming it and its goal: "a background task (job_…:
  …) wants to run this". Unanswered, it stops there and says so.
- **On a busy machine it waits before it starts** (0.8.0): the CPUs more than 70% busy over the last
  minute, a thermal zone past its trip point, or the daemon's cgroup short of memory. Its log says
  so. Ten minutes at most, then it starts anyway. A helper the agent waits for while you wait, and the
  agent's replies to you, never wait.
- **A restart** stops it. It is not resumed: the agent is told what it had done, and can start it again.
- **In a mission that works in a worktree**, `delegate` with `isolated` gives each helper a worktree of the
  mission's, on a branch of its own, `mission/<id>-helper-<n>`, so helpers that write do not write over each other;
  the result names the branches for the mission to merge. Anywhere else `isolated` is refused.
  [Missions in a repository →](/en/docs/manual/missions/#in-a-repository)

## Asks that run long

When an agent asks another with `ask_agent` (0.7.19), it waits for the answer for up to a minute, as before.
If the other agent is still working after that (a deploy, an audit), the work carries on in the background
and the agent you are talking to tells you so, and you can keep talking to it. When the answer comes, it
wakes that agent in the same chat, saying what it is the answer to and when it was asked, so it makes sense
even after you moved on. An agent that knows the work is long asks with `background: true` and does not wait
at all.

- **It is a job of the asking agent's**, `ask <agent>: <task>` in `nouride jobs` and under System Logs →
  Background work, and in the chat's strip while it runs. `/stop` in that chat and `nouride jobs kill <id>`
  stop it; `[security] job_max_ms` bounds it; a restart closes it as interrupted, and the agent is told.
- **It shares the helpers' limit**, `[delegate] max_background`. When that is full an ask waits to the end,
  as it always did, and says why it took so long.
- **A failure, the time limit, a stop or a restart** wake the asking agent too, saying which.
- **An approval the other agent needs** after that is still asked in your chat, in its name, saying whose work
  it is.
- Only the agent you talk to moves an ask: a helper's asks, and a scheduled job's, always wait for the answer.

## Work that runs long is nudged, not stopped

At `[agents] nudge_after_minutes` (5) and then at each doubling (10, 20, 40 minutes), long work is reminded
of the time. Nothing is killed; `llm.limits.max_turn_duration_ms` stays the one hard limit. `0` turns it off.

- **A helper, or an agent asked with `ask_agent`,** reads before its next step: it has been on this for N
  minutes, and if it is stuck, or it will take much longer, it should stop and report honestly: what is
  done, what is not, where it is stuck, what it would need.
- **The agent waiting on one in the background** is told in your chat how long it has run and that it was
  asked to report if stuck. It can wait, tell you, or stop it with `nouride jobs kill <id>`.
- **A reply you are waiting on** is asked for a one-line status, and to say so and stop if it is stuck.

## Running agents

```bash
nouride agents                       # list, with state
nouride agent sleep <id>             # takes no work until wake, through a restart too
nouride agent wake  <id>
nouride agent reload <id>            # re-read the pack from disk
nouride agent enable  <id>           # written to config.toml, so it survives a restart
nouride agent disable <id>
nouride agent external <id> <cli> [--profile <name>]   # a coding CLI answers it from now on
nouride agent internal <id>                            # its model answers it again
```

Sleep and wake are runtime state. Enable and disable are written to the config file. The
distinction matters at 2am: putting something to sleep is not the same as deciding it should not come back.
`external` and `internal` set or remove `[external]` in its `config.toml`, and are an admin's to do.

## The harness block

An agent learns its own capabilities from a **harness block** generated fresh into its system prompt
each turn, from live state: which tools it has, whether a human can be asked right now, its
round-trip budget, and the commands a person in this chat can type. An agent with a shell is also
told which programs are already installed, by name, that its `HOME` persists, and which install
commands work on this host.

That is why an agent knows not to promise something it cannot do, and why the answer changes when you
switch a tool off. `/prompt` in a direct message shows the whole thing.

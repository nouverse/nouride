---
title: External agents
description: An agent answered by a coding CLI (Claude Code, Codex or one you add), with a channel, missions and approvals from Nouride, and Nouride's agents in your editor.
---

An **external agent** is a Nouride agent whose turns a coding CLI answers. You talk to it like any agent (in its
Telegram or Discord bot, in a room, on the dashboard, in a mission), and the CLI does the work, on its own model and
its own sign-in. Nouride gives it a channel, approvals, missions, memory and its tools; the CLI keeps what makes it
good at code: its own context, its own prompt, its own tools for files and the shell.

Two are built in: Anthropic's **Claude Code** and OpenAI's **Codex**. Nouride reaches each over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP), through the adapter the
[ACP registry](https://agentclientprotocol.com/registry) lists for it, the same adapters Zed and JetBrains' editors
use:

- [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp), whose authors in the registry are
  Anthropic, Zed Industries and JetBrains;
- [`codex-acp`](https://github.com/agentclientprotocol/codex-acp), by OpenAI, JetBrains and Zed Industries.

Each adapter carries the real CLI, signed in with that CLI's own sign-in, so your Claude or ChatGPT subscription is used
the way its maker supports, not through a workaround: Nouride does not turn it into an API, imitate the CLI, or hand
the sign-in to another program. What a subscription allows is still for its maker's terms to say.

## Installing a CLI

Nouride ships no CLI. Each installs with npm, as its adapter, which carries the CLI itself:

| CLI | Package | The command Nouride starts | Needs |
|---|---|---|---|
| Claude Code | `@agentclientprotocol/claude-agent-acp` | `claude-agent-acp` | Node 22 or later |
| Codex | `@agentclientprotocol/codex-acp` | `codex-acp` | npm |

- **Linux**, installed with `install.sh`: `sudo nouride tools run -- npm i -g @agentclientprotocol/claude-agent-acp`
  (or `@agentclientprotocol/codex-acp`). `nouride tools run` runs the installer as the daemon's user, puts the program
  in `.nouride/bin` and makes it every agent's to run; the `nouride` on `PATH` runs as the service account when root
  runs it. Node and npm come from the system: check `node --version`, as a distribution's own package can be older
  than 22.
- **macOS**: `npm i -g @agentclientprotocol/claude-agent-acp` as yourself, with Node from Homebrew. The daemon runs as
  you, with Homebrew first on its `PATH`.
- **Docker**: the image has no Node; its `node` is Bun's stand-in. Install it with `docker exec nouride nouride pkg
  install nodejs npm` (kept across a recreate, 0.8.15), or build the image with `--build-arg EXTRA_PACKAGES="nodejs npm"`
  (the image's Alpine packages carry Node 24); then install the adapter into the volume, where it outlives a recreate:
  `docker exec -u bun -e NPM_CONFIG_PREFIX=/app/.nouride nouride npm i -g @agentclientprotocol/claude-agent-acp`.

Or ask the orchestrator in chat: it installs either for every agent, on an admin's yes (from 0.8.9, only an admin
answers it, in a one-to-one chat too: the install runs as the daemon's user). The dashboard asks for you (0.8.19):
where a CLI is not on the box, **Models → Coding CLIs** and an external agent's **Brain** tab have a button,
**Ask Nouva to set it up** (your orchestrator's name), which opens the chat over the page with the request written
out, for you to read and send.

`nouride agents scan` lists the CLIs the box has, each with the command Nouride starts and its version. That version
is the adapter's (`claude-agent-acp 0.97.0`), not the CLI's own. Since 0.8.24 each built-in CLI also says where its
version stands against the versions this Nouride was tested with and the newest out, which Nouride asks the npm
registry once a day: up to date, a newer version out, newer than this Nouride was tested with (it runs, with a
warning), or older than it supports. The **Models** page and the agent's **Brain** tab say the same in words, with the
numbers under Details. Each week Nouride's own CI installs each CLI's newest version and checks its handshake with no
sign-in; a version that passes that and a real turn is named tested in the next release.

**Update** there asks the orchestrator, in a message you send, to run `nouride agents update <cli>`. It waits until no
turn runs in that CLI, and starts none in it meanwhile; installs the newest version this Nouride was tested with, as
`nouride tools run` installs; then starts the CLI again and checks its handshake for what Nouride uses: steering, and the
modes its presets set. No prompt is sent for the check. A version that fails it stops only that CLI's agents, saying
why, and the version before is offered back: **Ask … to put it back** on the agent's Brain tab, or
`nouride agents update <cli> <version>`. The CLIs' own updaters stay off.

## Making one

**Agents → New Agent** makes one like any agent (its name, headline and persona), and under **Answered by** offers
the CLIs the box has, then the **account** it answers with. Making an agent is an admin's to do; an operator sees
New Agent disabled. From a terminal, `nouride agent external <id> <cli>` turns an agent that exists into an external
one, and `nouride agent internal <id>` gives it back to its model.

Or ask the orchestrator in chat. It asks what the agent is for and who it is, installs the CLI if the box lacks it (on
your yes), makes the agent, and sends you the link to its Brain tab: the sign-in is yours, there, never in the chat.
Nouride's own model for the agent is the install's default, or the orchestrator's where the install has none.

A small box may not have the room. Measured with a session open and idle, before any work, Claude Code holds about
330 MB and Codex about 190 MB, and working holds more. With less than 512 MiB for the agents' commands, the list says
so and offers none; `nouride agents scan` says the same.

## Signing in

An account is one sign-in of a CLI. **Models → Coding CLIs** lists each CLI's accounts, the agents on each, and
whether they can answer. Agents on one account share its limits, a five-hour window included. Signing in, and saving
an agent's Brain tab, are an admin's to do. The sign-in runs on the box, and the page shows what it prints.

- **Claude Code** signs an account in once, on **Models → Coding CLIs**: **Add an account**, or **Sign in** on one
  already there, runs Claude Code's own `setup-token`. Open the link it prints, sign in with your Claude subscription,
  and paste back the code the page then shows you. Nouride keeps the long-lived token it prints in its secret store,
  never on the page, and every agent on that account answers with it. To sign one agent in on its own instead, **Sign
  in** on its **Brain** tab, or `nouride agents login <id>` in a terminal, signs that agent's own profile.
- **Codex** has no sign-in to share, so each agent on an account signs in once, on its **Brain** tab or with
  `nouride agents login <id>`, in its own folder. It prints a link and a one-time code: open the link, sign in to
  ChatGPT and type the code into OpenAI's page, and the sign-in ends by itself. Device-code sign-in has to be switched
  on first, in your ChatGPT account's security settings.

A CLI you add signs in with its own `login` words. If its browser sign-in ends on a page on the box that does not load
from your machine, paste that page's address back, and Nouride opens it on the box.

## How it runs

One CLI process per agent, started at its first turn and stopped after five quiet minutes; the next message starts it
again. A CLI still running a command it left in the background is not stopped, and an update or a restart waits for
that command as for a background job. Each conversation keeps its own CLI
session, reopened after a restart where the CLI can. Where each agent is
[its own user](/en/docs/architecture/overview/#each-agent-its-own-user), the CLI runs as that user, with the agent's
folder as its HOME.

What the CLI says by itself between turns reaches the chat. Claude Code goes on with no message when a command it
left running in the background ends: it reads the output and says what came of it. That arrives as the agent's own
message, as a background job's result does. If you write first, it comes before the answer to your message. If
Nouride is stopped at once or crashes while such a command runs, the agent says so after the restart.

An external agent's **Brain** tab, in place of the Model tab, holds its CLI, the account it answers with (**In use**;
another is picked with **Use for …**), and what is set in `[external]` in its `config.toml`:

- **Model**: as the CLI names it; the field lists the models the CLI offered once a session has opened. Empty is the
  CLI's default.
- **What it may do without asking**: one of three presets, each the CLI's own mode:

| Preset | `permissions` | Claude Code's mode | Codex's mode |
|---|---|---|---|
| Free in its folder | `folder` | `bypassPermissions` | `agent-full-access` |
| Ask when risky | `risky` | `acceptEdits` | `agent` |
| Ask for everything | `all` | `default` | `read-only` |

*Free in its folder* asks nothing, not before a push, a POST or `ssh` either. It is free only where each agent is its
own user, a Linux service with the `nouride-run` helper, where the operating system keeps the CLI out of everything
that is not its agent's. On Docker, on macOS or without the helper, the CLI is the daemon's user, which reads the
database and the secret store, so there it asks as *Ask when risky* does, whatever the pack says; the Brain tab still
shows the pack's choice. Where what it sends out matters, pick *Ask when risky*. A pack that names no preset gets *Free
in its folder* where each agent is its own user, and *Ask when risky* elsewhere. A changed preset or model reaches a
conversation already going at its next message.

Below them, folded, is Nouride's own model for the agent, with its fallbacks: the one that answers a message the CLI
cannot.

```toml
[external]
cli = "claude-code"
profile = "work"
permissions = "risky"
model = "sonnet"
```

### Its persona, its sign-ins, its skills

Who it is comes from its persona files, on the Files tab like any agent's: `IDENTITY.md`, `SOUL.md`, `AGENTS.md`,
`MEMORY.md` in its pack. When a session opens, Nouride writes them into the CLI's own instruction file, between markers
it keeps: `workspace/private/<id>/CLAUDE.md` for Claude Code, and for Codex the `AGENTS.md` in its profile folder
(below), which Codex reads whatever folder it works in, a mission in your repository too (from 0.8.4; before, a mission
there answered without the agent's persona). Your own lines in either file, above or below the markers, stay as they
are; the `AGENTS.md` there is the CLI's, not the pack's.

A CLI may keep a memory of its own; Claude Code's own prompt tells it to. Nouride and the other agents do not read it,
so the block tells the CLI that what should last goes in `MEMORY.md` with `memory_write`, and what it learns about a
person in that person's facts (from 0.8.10). Each turn's first message also tells it the time in `[daemon] timezone`
and, once a conversation and again when it changes (a scheduled job's too), how to write where its words go: on
Telegram, no tables.

Each account's sign-in and settings are a profile folder, `workspace/private/<id>/.cli/<cli>/<profile>`
(`.cli/codex/default`), which the CLI is pointed at with `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. A Claude Code account
signed in on the Models page is a token in the secret store instead.

Its skills (the ones switched on on its Skills tab) are copied into the `skills` folder of that profile, which the
CLI reads whatever folder it works in, a mission's repository too: when one is switched on or off, and before each
message. A skill you put in that folder yourself stays, and one that needs a Nouride tool the CLI has no way to call is
left out. A CLI you add gets none; its Skills tab says so.

The CLI lists its skills as a conversation starts and keeps that list, so a change reaches a conversation as it starts:
in a chat already going, send `/new` or `/reset`. Either starts the CLI's side over too (a new session, with nothing of
the one before), as a rollover and a delete from the dashboard do.

### Nouride's tools, lent

While a turn runs, and only then, the CLI is lent Nouride's tools over MCP: `ask_agent`, `delegate`, `memory_search`,
`memory_read`, `memory_analyze`, `memory_write`, `person_notes`, `person_record`, `plan`, `notes`, `schedule`,
`mission`, `work`, `send_message`, `send_file`, `agent_configure`, `persona`, `skill_root`, `agent_create`, the skill tools
(`skill_create`, `skill_toggle`, `skill_improve`, `skill_search`, `skill_install`), `mcp_search`, `secret_save` and
`attachment_read`, and the agent's own MCP servers from the library, their credentials staying in Nouride. It gets
only those its agent's tool switches give it, and each call meets the same gate, approval level and audit as a model's.
A call that arrives between turns is refused. Claude Code's claude.ai connectors, the Gmail, Drive and Docs tools a
claude.ai sign-in brings, are switched off: they reached outside the gate.

What each of those does for a CLI that it could not do itself:

- **A skill it makes** goes into the household's pool as any agent's does: checked as a draft is, on for itself, on the
  Skills tab for the other agents to switch on, and copied to its CLI's skills folder. One written straight into that
  folder stays its own, in no other agent's pool.
- **A file sent earlier in the conversation** (before a `/new`, or to another agent in the room) comes back from
  `attachment_read` as a path in its own folder, which its file tools open, a picture as a picture.
- **A credential sent in chat** never reaches the CLI's shell: its process keeps the environment it started with, so the
  handle is empty there, and it is told so. Asked to keep one, it saves it with `secret_save`, and the CLI is started
  again with it at the agent's next turn, once nothing else of the agent is at work, so no other conversation is cut
  off. Its conversations carry on where the CLI keeps them. A turn that comes while another one still works (a
  mission the agent started in the turn that kept the key) waits for that one, up to two minutes, so that it starts
  with the key; past that, or where a command the CLI left running keeps it going, it is told which variables its shell
  does not have yet, rather than asking the person for them again.
- **In a room**, it is told each agent there with the exact text that tags it (on Discord, the bot's id), what each is
  for, and how many hand-offs a chain may run: a tag hands the work over where everyone sees it. In a DM it is told that
  `ask_agent` reaches them and a tag does not. Said once a conversation, and again when the room's agents change.

`nouride`, `update` and `session_status` stay a Nouride agent's: the first two restart the daemon, and the CLI with it,
mid-turn; the third reports the Nouride model's session, none of which is the CLI's.

## What Nouride decides, and what the CLI decides

The CLI's own tools (its files, its shell, its web) are the CLI's. The agent's approval level, the fixed list and
its `[tools]` do not reach them; the preset does, as the CLI's own mode. What the CLI asks under its preset comes to
you as a Nouride approval, in your chat or on the dashboard, and in a mission it is parked like any other. No approval
level answers it for you. **Always** is offered only where the CLI offers an always of its own, and the CLI keeps that
rule, not Nouride.

`/model` in a chat changes only Nouride's own model for that chat, the one that answers when the CLI cannot. The model
the CLI answers with is set on the Brain tab.

`/effort high` sets how long the CLI thinks in that chat, from the next message, over the agent's own effort; the
session is set to it as it runs, so the CLI keeps the conversation. Only a level the CLI offers for the model it is on
is taken, and `/effort` alone says the level now and the ones offered. `/effort default` puts back the agent's effort,
or the CLI's own where the agent sets none. The agent's own is set on its CLI tab, for every chat, or from a chat with
`/effort <level> lock` by an admin.

`/status` says which CLI answers and its model, and that the CLI keeps the conversation's context itself, with its size
as the CLI last reported it. Its tokens are the ones the CLI reported at the end of each prompt, cache included. They
are recorded on the CLI's own account, outside `max_daily_cost_usd` and `max_daily_tokens`: the CLI runs on its own
subscription.

## When it cannot answer

When its CLI cannot answer a message (not signed in, not installed, or it failed), the agent's own model answers that
one, starting with a line that says so, and the CLI answers the next once it can. A message the CLI had begun to answer,
or one you stopped, is not answered again.

Its status says why: the CLI is not installed (and how to install it), not signed in, or failed to start. A CLI
updates often, and a new version can change what Nouride uses: the first time a version starts, however it was
installed, Nouride checks its handshake (steering, the presets' modes; since 0.8.24, in place of a one-line question that
spent a prompt). One that fails stops its agent, saying the version did not pass Nouride's check and which version to go
back to, until you go back or update Nouride. The other agents go on.

An external agent is never the orchestrator: Nouride's approval level, fixed list and tool switches do not reach its
coding CLI's own commands, and the orchestrator is the agent anyone in a room reaches. A save that would make it one is
put back, and a start that finds one named in `[daemon] orchestrator` runs with no orchestrator and says so. It answers in its own channel, in a room when
addressed, and to `ask_agent`. A Nouride agent stays the one a message with no name reaches.

## In a mission

A mission keeps one CLI session from start to end and works in the mission's folder; its checklist is the CLI's plan.
In a git repository, on a box with room, a mission works in a worktree of its own on the branch `mission/<id>`, so two
missions in one repository do not wait for each other, and it ends with that branch. Merging it is the agent's
call, through the approval gate like a push. Helpers it hands work to with `delegate` and `isolated` each get a
worktree of that one, on a branch of their own, for the mission to merge.
[Missions in a repository →](/en/docs/manual/missions/#in-a-repository)

A CLI's mission is held to its hours and tokens, not its turns: it works in one or two long turns of many steps, so its
page and the dashboard count its turns and steps with no limit beside them. Its hours and its tokens stop a turn while
it runs: the CLI is asked to cancel, and the mission waits for you. A CLI says what a prompt spent only when the prompt
ends, so while it runs its tokens are estimated from the size of its context, which the CLI reports after each step;
the count the CLI gives at the end replaces the estimate. A CLI that reports none shows them as unknown. In the `folder` preset
nothing asks before a delete it runs, inside the mission's folder or outside it. Its Linux user's rights are the only
limit, and the mission's page tells it so.

## A CLI of your own

Any CLI that speaks the Agent Client Protocol can be added in the daemon's `config.toml`:

```toml
[[external_clis]]
id = "opencode"
name = "OpenCode"
command = "opencode"
args = ["acp"]
install = "npm i -g opencode-ai"
login = ["auth", "login"]
status = ["auth", "status"]       # exits 0 when signed in; absent: a session it opens says
profile_env = "OPENCODE_HOME"   # absent: its profile is its HOME
modes = { folder = "build", all = "plan" }
```

A secret it needs is bound to its command in `[security.exec_secrets]`; there is no `env` in the row. An `id` a
built-in CLI has (`claude-code`, `codex`) is refused at load. A CLI you add runs as the agent's own user only where
each agent has one, gets no skills, and signs in once per agent: there is no shared account for it.
[Every key →](/en/docs/reference/config/#external_clis)

## Nouride in your editor

The other way round: an agent of yours in Zed, or any editor that speaks ACP. The editor runs
`nouride acp --agent <id>` on the machine the daemon runs on; without `--agent`, the orchestrator answers:

```json
{ "agent_servers": { "Nouride": { "command": "nouride", "args": ["acp", "--agent", "nouva"] } } }
```

The editor's user has to be able to read this install's control token: on a Linux install, be in the `nouride` group,
or give the editor `NOURIDE_URL` and `NOURIDE_TOKEN` in its environment.

The agent works in the daemon as always, with its own tools, approvals and memory; the editor shows its thinking,
each tool call and the answer as they happen, and asks you what the agent's approvals ask. Open the editor in a
folder the agent can reach: one of its `[workspace] roots`.

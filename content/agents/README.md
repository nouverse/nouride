# content/agents/

One directory per agent. Everything here is config-as-code: hand-edited, diffed in
git, hot-reloaded without a restart.

**This directory holds the template, not a running install.** The packs a daemon
actually loads live under `.nouride/agents/`, which is gitignored; `agents_dir` in
`config.toml` is what points at them. The layout below is theirs; `example/` here is
a copy of it to start from.

```
agents/
├── <id>/
│   ├── IDENTITY.md      # required: name, role, emoji, bio
│   ├── SOUL.md          # personality, behaviour rules, tone
│   ├── AGENTS.md        # the other agents: who they are, how to reach them
│   ├── MEMORY.md        # persistent notes, written by the agent itself
│   ├── config.toml      # LLM, channel bindings, tools, MCP servers
│   └── skills.toml      # optional: the pooled skills this agent has switched off
└── skills/<name>/SKILL.md   # the pool: every agent is offered all of it
```

There is no per-agent `skills/` directory and no opt-in list: every skill lives in the pool, and a
pack names only its exceptions in `skills.toml` (`docs/ARCHITECTURE.md` §1.1 says why).

Isolation is by construction: an agent loads only its own directory. What one agent
knows about another comes from its own `AGENTS.md` and from what the other one tells it
when asked, never from reading another agent's files.

The directory name is the agent id. `example/` is a template; copy it, do not edit
it in place.

Secrets never appear in these files. `[llm] provider` names a `[providers.*]` profile in the
daemon's `config.toml`, and the profile names the secret, so an agent pack is safe to commit.

## Family & User Access Setup

Who somebody is (what to call them, who they are to whom, what is worth knowing) lives in **People**
(the dashboard page, or `[[people]]` in the daemon's `config.toml`), not in a pack. Every agent reads a
person's entry, and only while that person is the one speaking. Until 0.7.0 that was `USER.md` in each
pack, read on every turn whoever was speaking, which greeted a household's second person by the first
one's name. It is no longer read. An admin edits anyone's notes on the People page; through an agent,
a person changes only their own (`person_notes`, a line at a time).

1. **People**: one entry per person, every account they write from, and notes in markdown.
   ```toml
   [[people]]
   key   = "sam"
   name  = "Kak Sam"
   ids   = ["whatsapp:628111000001@s.whatsapp.net", "whatsapp:100000000000002@lid", "telegram:5550001111"]
   notes = "Call her Kak Sam. Alex's partner; prefers short answers."
   ```
   The key is the person and their memory file; an account is the platform and the account (it names
   them on every bot of yours they talk to) and may be attached later, when they pair.

2. **Access**: whether they may talk to an agent at all is separate (pairing, or
   `nouride access allow <gateway:sender>` before they have written).

3. **`MEMORY.md`** is the agent's own notes. Ids and contact details do not belong in a pack: it is
   usually a git repository, and an id written there identifies nobody.

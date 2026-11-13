---
title: Skills & learning
description: Your agents write down what they worked out, and you decide what they keep.
---

An agent that solves the same problem twice has learned nothing. Nouride agents keep notes, and by
default you approve what they learn before it counts.

The notes are called **skills**. A skill is a short document: how to do one kind of job, the order the
steps go in, and the things that go wrong. Before an agent starts a job it reads the skills that look
relevant, so a lesson written once is there from then on, on every platform, for every agent that has
the skill switched on.

![The Skills Workshop](/media/dashboard-skills.png)

## One pool, per-agent switches

There is **one** skill pool at `.nouride/agents/skills/`, and every agent is offered all of it. An
agent's exceptions live in `skills.toml` beside its pack:

```toml
[skills]
document-authoring = false     # off for this agent only
```

Default-on rather than an opt-in list, because a list written today cannot name a skill that arrives
next month, every later skill would show up switched off with nothing to say why.

The exception is a skill whose frontmatter names its agents in an `agents:` line. It is off for every
agent not named there until that agent's `skills.toml` turns it on. Skill learning writes that line on
each new skill, naming the agent that learned it, so one agent's lesson does not land in every other
agent's prompt unasked. `nouride skills on <skill> <agent>` gives it to another.

Four ways to flip that switch, all writing the same file: the Skills Workshop, the agent's own
**Skills** tab, the CLI, and the agent itself with `skill_toggle`.

```bash
nouride skills                  # what each agent is offered, and when each skill was last read
nouride skills nouva -v         # one agent, with each skill's description and path
nouride skills --all            # the whole pool: who has each, and what software is missing
nouride skills off document-authoring nouva
nouride skills on  document-authoring nouva
```

A skill comes from one of three places, and the agent's **Skills** tab labels each row:

| | |
|---|---|
| **Built in** | ships with Nouride, in the `skills/` directory beside the binary, and updates with it |
| **Shared** | the pool, what you and the agents write. A pool skill with a built-in's name outranks it |
| **Project** | a `SKILL.md` under `.agents/skills/` in a directory named in that agent's `[workspace] skill_roots`. Read again every turn, so a skill added to the repository counts from the next message. A skill there that is a link to a folder elsewhere in the same directory loads too |

An agent's project folders, its `skill_roots`, are on its **Skills** tab since 0.8.24: each with the skills it brings,
added by its path and removed there by an admin. `nouride agent skill-root add|rm <id> <path>` does the same from a
terminal. The folder is checked first: one the daemon can open, not one that holds the credentials folder, not one the
agent has already. The change is saved as the Files tab saves the agent's `config.toml`, the version before kept, the
agent reloaded. An agent asks for a folder itself with its `skill_root` tool: an admin approves or denies it in the
chat, at every approval level, `trusted` too, because a project's skills become instructions the agent follows.

`[skills] off` in the daemon config is the other axis: names nobody loads, whatever their own
`skills.toml` says. That is a removal rather than a preference, and it exists mainly for the
built-ins, which cannot be deleted. **Switch off for every agent** on a Workshop row writes it.

## Built in

These ship with Nouride and update with it. A skill added to, removed from or edited in the built-in folder or the
pool reaches every agent within a minute, without a restart (from 0.8.13).

- **document-reading**: what is inside a PDF, Word, Excel, PowerPoint, EPUB or scanned document. A
  helper script names a file's real type, lists its sheets, headings or pages, pulls any part out to a
  file, and answers questions over a large sheet with SQL. Needs `python3`.
- **document-authoring**: a typeset PDF made with LaTeX, such as a paper, a report, a thesis, a letter
  or a CV; and changes to an existing Excel workbook through a helper that edits a copy, never the
  original, and refuses a workbook it would damage.
- **nouride**: operating the daemon itself. Upgrading it, restarting it, adding a connection or a
  provider, finding out why one is down, and adding an agent from a chat (a Nouride model or a coding CLI),
  asked one thing at a time.
- **network-reach**: finding and reaching other devices on your network or through Tailscale, with a
  setup guide for Windows, macOS, Android, cameras, a NAS and more when something has to be switched
  on at the device.
- **share-preview**: a public trycloudflare.com link to something an agent built, with no account and
  no port opened.
- **mockup-design**: a mockup of a screen, a page or an app, written as HTML and drawn in a real
  browser at a desktop's and a phone's width, measured and looked at before it is sent. It asks first
  how you want it: a link to open, pictures, pictures inside a phone and a laptop, or the HTML file. It
  has no look of its own: the colours and fonts are yours, your brand's, or chosen for the request.
- **carousel**: a set of pictures to swipe through on Instagram, LinkedIn or TikTok. It asks first where
  it is posted, which decides the shape, and sends you the words slide by slide for a yes before it
  draws anything. Every slide is in one HTML file, drawn at the platform's exact size, measured for a
  phone and looked at before it is sent, as one album in order or as a PDF. It has no look of its own
  either.
- **motion-graphics**: a video made from code with Remotion. It checks first whether this machine can
  render it, and renders on another of your devices through network-reach when it cannot. It asks where
  the video is watched, which decides its shape (a screen, a full phone screen for Reels or TikTok, a
  feed post), and for a feed it puts the hook first, one idea a scene, its words on screen long enough to
  read, and an end card. Each round is measured as well as looked at: small text, text where a phone's
  app draws over a vertical video, and text too pale to read.
- **browser-automation**: a real browser driven with Playwright to log in, click through and fill in
  sites. It asks before anything that cannot be undone, and turns a flow that works into a script that
  runs again on its own.
- **nouclip**: summaries of a video or a YouTube link from its timed transcript, and short vertical
  clips with word-by-word subtitles, using the video's own captions before transcribing anything.
- **coding-agents**: coding work handed to a coding agent CLI such as OpenCode, Claude Code, Codex,
  Gemini CLI or pi. The agent installs it without root, signs it in on the provider it already uses or
  with a subscription token, runs it in its own worktree, follows up in the same session, and checks
  the diff and the tests before it reports.

To change one, copy it into the pool under the same name and edit the copy, which then wins. Editing
the shipped file is wasted work: the next upgrade replaces it, and an agent that tries is refused.

An [external agent](/en/docs/manual/external-agents/)'s skills, the ones switched on for it, are copied into its
CLI's own skills folder, for Claude Code and Codex; one that needs a Nouride tool the CLI cannot call is left out. A
CLI you add gets none. Since 0.8.9 that includes the project skills from its `skill_roots`, copied again before each
turn, so a skill added to the repository reaches the CLI at its next message wherever it works.

## Where skills come from

Four ways in.

**Someone else wrote it.** Skills written to the open [Agent Skills](https://agentskills.io) format can
be installed from a hub: the **Explore** tab on the Skills page, `nouride skills search` /
`nouride skills install`, or an agent asking with `skill_search` / `skill_install`.

| Source | Install with |
|---|---|
| GitHub | `owner/repo`, `owner/repo/path/to/skill`, or a github.com URL. Installs every skill in it |
| [skills.sh](https://skills.sh) | `skills.sh:owner/repo/skill` |
| [ClawHub](https://clawhub.ai) | `clawhub:slug`. Its security scan is shown, and a *malicious* verdict is refused |
| A site's `/.well-known/skills/` | `well-known:https://site` |

Installing fetches the skill, pins it (a commit, or a version), and adjusts it to Nouride: YAML
frontmatter is flattened, `allowed-tools` becomes `needs_tools` (`Bash` → `exec`, `Read` → `read`…),
and `requires` is filled in from what its scripts are written in. Binary files and unsafe paths are
left out. Then it waits on **Pending** like any draft, with where it came from and what was changed
beside it. Nothing is in an agent's prompt, and no script has run, until you approve it. An approved
skill keeps a `source:` line saying where it came from. Set the secret `github_token` if GitHub's
limit of 60 requests an hour gets in the way.

**You write one.** Add a directory holding a `SKILL.md` to `agents/skills/`, or ask an agent to save a
procedure: it writes what you dictate with `skill_create`, straight into the pool, on for that agent.
It gets the checks a draft gets, so a procedure that names an address, an account or a past session
is sent back to be rewritten. That tool is approval-gated like `write`, so whether you are asked first
follows your [approval level](/en/docs/manual/approvals/).

**An agent fixes one it is using.** An agent that finds a skill wrong or incomplete mid-task proposes
the fix with `skill_improve`. Nothing changes until you approve it: the fix arrives as a draft.

**The agent learns it on its own.** That is **skill learning**, and it is the rest of this page.

## What makes it look up

Nothing runs on an ordinary turn, that would be slow and expensive. The pass is a short model call to
decide, and one more to write the draft when there is something to write, and it runs only after a
turn where something actually happened:

- **You asked for it.** "Save this as a skill."
- **Something broke and then worked.** Three tool failures in one turn, then a success. The failures
  are what make it worth writing down.
- **The conversation got long in effort.** Eight model round-trips. A turn counts for one, plus one
  for every round of tool use, plus one more if your reply arrived within three minutes of the agent's
  last word, which is how "you were steering" gets counted without reading a word of what you said.
- **It got something new working**: a tool this agent had never used successfully before.

These are all about the *shape* of what happened, not its meaning. Nothing has been judged yet. The
numbers are the daemon's own, not settings.

The daemon deliberately does not try to judge it either. An earlier version matched phrases like
"still broken", which fails silently for anyone whose wording nobody anticipated. Counting is dumb,
free and language-agnostic; the judgement belongs to the model. That is the agent's own model, unless
`[skills.learning] model` names a cheaper one.

## What it decides

The agent reads the conversation back and asks one question: **should the skill library change
because of this?**

What it looks for is a procedure. Three places keep what an agent learns, and only one of them is a
skill:

| | |
|---|---|
| **Work notes** | One task while it runs: its plan, where it stands, what it found. They go with the task. |
| **Memory** | Facts about people and about this environment: which host runs what, its addresses, accounts and paths. |
| **Skills** | A procedure for a *kind* of task: the steps an agent follows the next time it does work like this, on another task and perhaps another machine. |

The test is whether an agent doing a different task of the same kind would follow these steps. This
task's files, its numbers and the fix for what broke today belong in its notes or in memory. An
incident earns a skill one line, as the step that prevents it next time.

Four possible answers, first one that fits:

| | |
|---|---|
| **Update** | A skill already covers this. Add the missing step or the pitfall to it. |
| **Attach** | A skill covers it, but what was learned is bulky, a long command, a config that worked, an error and its cause. Put it in a file beside the skill instead of swelling the skill. |
| **Create** | Nothing covers this kind of work. Propose a new skill, and say which existing one came closest, and why it should not just absorb this. |
| **Skip** | There is genuinely nothing here. |

Skip is real, and it should be rare after a long session. If you spent an afternoon getting a camera
connected and it now works, the *camera* is a one-off but the *procedure* is not.

**A new kind of work is noted before it is written.** One conversation does not show that the work
comes back. So the first time, a create is held as a **candidate**: a name and a "Use when" line, with
no body and no second model call. The skill is written when another conversation turns out to be the
same kind of work, or at once when somebody asks for a skill in words. A candidate that does not come
back within 30 days lapses.

## How much runs without you

`[skills.learning] mode`, or the **Self-Improving Skill** panel at the top of the Skills page, which applies
from the next message. `ask` is the default.

![The Self-Improving Skill panel: how much runs without you, the model, and the weekly review](/media/skills-learning.png)

**`ask`: propose, and wait for me.** A draft is a proposal, not a change. Pending drafts pin to the
top of the Skills page. Each shows what the agent wants to add, why, and, for an update, a
line-by-line diff against the file on disk, because an improvement is usually one added pitfall in a
sixty-line body and asking somebody to spot it by eye is asking them to approve without reading. A new
draft is also announced in the chat it came from, unless `[skills.learning] notify_chat` is off.

**`off`: nothing is examined.** Drafts already waiting stay exactly where they are, still yours to
decide. The weekly review does not run on its own either.

**`auto`: let it keep what it learns.** The agent approves its own drafts as it writes them and tells
you afterwards in the chat it was working in. Worth knowing before you pick it: a skill is read on
every matching turn by every agent that has it on, so a bad one is wrong repeatedly and quietly rather
than once and visibly. A new skill starts on only for the agent that learned it, which keeps a bad one
to one agent until somebody turns it on elsewhere. What you have afterwards is the audit log, the row
records the daemon as the approver, and `nouride skills off <skill> <agent>` to take one back out. It
covers the loop's own drafts only: a hub install, a `skill_improve` fix and every proposal from the
weekly review still wait for you.

Anything unrecognised in that setting is read as `ask`, never as `auto`: a bad value should cost an
approval, not grant autonomy.

Before 0.7.27 the table was `[rsi]`, and the modes were `require_approval` (now `ask`) and
`always_allow` (now `auto`). Since 0.8.0 an `[rsi]` table in `config.toml` stops the daemon from starting,
naming `[skills.learning]`.

## Working through the queue

```bash
nouride skills drafts            # what is waiting on you
nouride skills draft <id>        # one draft in full, with the turn it came from
nouride skills approve <id>      # into the pool
nouride skills deny <id>         # discarded, transcript and all
```

`approve` and `deny` also take the skill's name. Or `/drafts` in a chat, where `/drafts approve` on its
own approves everything waiting, or the Skills Workshop, whose tabs are one workflow:

| Tab | Shows |
|---|---|
| **Live** | the pool: what the agents are actually carrying. Opened first when nothing waits on you |
| **Pending** | the queue, plus what was recently decided. Opened first when something waits on you |
| **Explore** | skills on the hubs, opening on ClawHub's most downloaded. Installing one puts it on Pending |

Each draft row opens into the whole `SKILL.md`, editable in place, plus the scrubbed transcript of
the turn it came from, or, for an install, where it came from and what was adjusted. Both are on the
row rather than behind a navigation, because the decision is "do I want this in my agents' prompts"
and the evidence for it is the turn.

**A draft is not an approval.** It blocks nothing and it never expires. That is why it lives in the
Workshop and not in the approvals queue, putting them together would give one of them the wrong
lifecycle.

## The weekly review

Learning adds, and a library that only grows ends up with bodies that have turned into incident logs,
two skills on one subject, and skills nobody reads. So once a week, while the mode is not `off`, the
daemon reads the whole library and proposes three kinds of change:

| | |
|---|---|
| **Tighten** | A body over 12,000 characters, or one that names a machine's address or an account, or tells a session. The rewrite has to come back shorter, or without what was found, or it is dropped. |
| **Merge** | Skills that cover one subject, found by one model call over the names and descriptions. One is rewritten to hold them all; the others are archived when you approve it. |
| **Archive** | A skill nobody has read in 45 days, and older than that. No model call. Every read is kept for as long as the skill, so a skill counts as unread only once it has been watched that long. It moves to `skills/.archive/`, and moving it back undoes it. |

Only skills an agent wrote are touched. A skill a person wrote and the built-ins never are. Every
proposal is a draft that waits for you in every mode, `auto` included: rewriting or moving something
your agents rely on is a decision, not a lesson. On **Pending** these drafts are marked **weekly
review**, and a row says what approving it moves: **archives**, or **merges** with the names it takes
in.

`nouride skills review`, or **Review now** in the Self-Improving Skill panel, runs it at once. The panel
says when the last review ran and what it proposed.

## Two things an agent may never do

Whichever mode you pick:

- **Change a skill a person wrote.** A skill you added by hand has no agent named in an `author:`
  line, and neither the loop nor the weekly review ever proposes a change to it. An agent that finds
  one wrong says so in its reply instead, and the edit stays yours. The built-ins are off limits the
  same way.
- **Delete a skill.** Only a person removes one. The weekly review can propose archiving a skill an
  agent wrote, and nothing moves until you approve it.

## The guardrails

**It will not flood you.** Twenty waiting drafts is the ceiling. Once reached, the loop stops
proposing until you clear some. A new draft for a skill that already has one waiting replaces it and
carries the earlier lesson along, so the queue holds one decision rather than several that would
overwrite each other.

**Credentials are removed.** Tokens, keys and passwords are stripped out of a conversation before the
agent reads it back, and again before anything is written to disk.

**Drafts are checked in code.** The prompts ask for all of this, and asking was not enough. A draft is
refused before it reaches you when its body names a machine's address, a hardware (MAC) address or an
email account, or tells a session ("in this session", "the user said") instead of writing the
procedure. It is refused when its description reads as an edit note ("Update…", "Document…") rather
than saying when to use the skill, and when a new skill's body is over 8,000 characters. A revision
may grow a body to 12,000 characters; a body already past that may not grow. A refusal is
logged and recorded in the audit log.

**Skills are written in English**, whatever language you were speaking. One library, one language, so
any agent can read any skill.

**It waits between looks.** A minute between two passes for the same agent, near enough to off: what
should throttle reflection is work done, and the trigger already counts that. Asking for a skill in
words ignores both the wait and the ceiling; a person asking is not noise.

## What a good skill looks like

Named for the *class* of job, not today's instance. `deployment-docker`, not
`fix-the-build-on-tuesday`. If the name only makes sense today, it is the wrong name, and the agent
is told to reach for updating an existing skill before inventing a new one, because two skills
covering one subject is worse than either alone: the agent loads one, the lesson is in the other, and
neither gets trusted.

A procedure, not a history. An improvement goes into the step it changes and merges with the pitfalls
already listed, rather than being added at the end, and dated incidents come out. Facts about this
environment stay out too: the skill says `<host>` or "the Docker host", and memory keeps which machine
that is.

Each skill declares what it needs, programs that must be installed, tools the agent must be allowed
to use. `nouride doctor` reports both gaps, per host and per agent, because the alternative is a
skill that loads fine and dies on step four with `dot: command not found`, halfway through a task,
with an approval already spent.

## Skills cost something

Every skill costs a line in the system prompt of *every* agent that has it on, on *every* turn,
whether or not it is ever read. `nouride doctor` lists the skills with no read on record for exactly
that reason. It reports them as fine rather than as a
fault: an unread skill is a bill worth knowing about, not a bug. For a skill an agent wrote, the
weekly review goes one step further and proposes archiving it after 45 days unread.

---
title: The dashboard
description: A tour of the web interface, what each page is for, and the queues people confuse.
---

The dashboard is a React app the daemon serves from beside itself, on the same port as everything
else:

```
@@DASHBOARD_URL@@
```

It is the operator's interface for anything an **agent** owns. It is not a lesser copy of the CLI:
the setup wizard and `nouride setup` run the same code, and the Skills page writes the same file
`nouride skills on|off` does.

![Dashboard overview](/media/dashboard-overview.png)

## The map

The menu is in the order its pages are opened: **Home, Chats, Work and Agents** every day, **Skills**, **Connectors**
and **Memory** now and then, and everything you set up once behind **Settings**.

```
Home                what needs you · what is moving · Quick chat · your agents · the box · today's AI use
Chats               one agent, or a room of several, with each step live as it works
Work
  Waiting for you   tool calls an agent waits on, and missions waiting for your answer
  Missions          long work agents finish alone: what needs you, what runs, what ended; Limits
  Helpers           helpers, commands and asked agents an agent left running: each one's steps, Stop
  Schedule          every job: create, edit, run now; filter by active / paused / failing
  Webhooks          endpoints that run a job when called, rather than on a clock
Agents
  Agents            the list, New Agent (admin), and daemon-wide Settings
    └ <agent>
        Files           IDENTITY.md, SOUL.md, AGENTS.md, MEMORY.md, config.toml
        Model           which provider profile and model this agent runs on
        Brain           an external agent's, in place of Model: its CLI, account, preset and model,
                        and Nouride's own model for it
        Connections     the bots and numbers it answers on
        Access          whether it takes new senders, how much it asks before it acts, its senders' count
        Skills          every skill in the pool, and which of them this agent carries
        Connectors      the install's MCP servers this agent uses
        Settings        its tool and turn budgets, quiet jobs, and which tools it has
        Look            its cat in the Office
  Office            the agents' statuses as a small office of cats

Skills              the Skills Workshop: Live · Pending · Explore
Connectors          the install's MCP servers: Installed · Explore, a switch per agent
Memory
  Knowledge & Memory   Knowledge · Agent notes · People · Timeline · Shared · Proposals · Settings, and a graph
  People            names and notes for the humans they talk to
  Groups            the rooms they talk in: each one's name, its agents, who talks there

Settings
  Models and keys
    Models          Model providers: endpoint, wire format, credential;       (admin)
                    Coding CLIs: each CLI's accounts and their sign-ins
    Secrets         the credentials, what each is for, the backup password    (admin)
    LLM Gateway     the in-process Nougate: accounts, keys, usage (Router)    (admin)
  Reaching out
    Integrations    other AI apps reaching memory, one key per app            (admin)
    Web Search      where agents search: free sources, Brave, SearXNG, own    (admin)
  People and sign-in
    Access          who may talk to the agents: Pending · Approved · Denied · Blocked · History
    Users           accounts and roles (Pro editions)                         (admin)
    My Account      username, name, password
  This box
    My Box          the appliance itself (a paired Box only)                  (admin)
    Logs            Daemon · Audit · Schedule · Helpers
    Update          the version running, the newest release, installing it

Documentation       this site, in a new tab
```

Work, Agents and Memory each hold several pages, shown as tabs across the top of each of them. Every tab keeps its own
address, so a link to one still opens it. Work opens on **Waiting for you**, and the count beside Work in the menu is
what waits there.

**Settings** is a page of cards in four groups, each card with a line on what its page is for, and a search box that
finds one by its name or that line. **Restart** and **Documentation** sit at its foot. In the sidebar, Settings' own
pages are listed under it only while you are on Settings or one of them.

Admin-only pages are **absent** from the menu and from Settings for anyone who cannot use them, rather than present
and refusing.

At the foot of the sidebar, **Your box** says whether the box is running well and which version it runs, with a button
when a newer version is out. The card itself opens Settings.

The browser tab's title counts everything waiting for you, `(2) Nouride`, so a tab left in the background still tells
you.

**On a phone**, a tab bar along the bottom holds Home, Chats, Work and Agents, with Work's count on it, and **More**,
which slides the rest of the menu up as a sheet.

**The look** is a soft cream by day and a violet grey by night. It follows your device until you choose with the sun or
moon button beside your name. The Nouride cat greets you on Home and keeps you company on an empty page.

**Update** is a card on Settings rather than a menu entry. The version under the logo shows a dot when a newer release
exists, and the badge at the top of Home or the button on **Your box** opens the page. Check, download and install are
three steps, because only the last one restarts the daemon, and it waits until nothing is running.
[Updating →](/en/docs/deployment/updating/)

**Restart**, beside the update badge at the top of Home, restarts the daemon for a change that needs one. It asks
first, waits until nothing is running, offers **Restart now** while it waits, and says when the daemon is back. Only an
admin or an operator sees it, there and at the foot of Settings.

## Home

Home opens with a greeting and one line on what is going on: how many agents are awake, how many missions are moving,
how many things need you. In the greeting's corner the box says whether everything is working, its version and how
long it has been up, beside the update badge and **Restart**; anything to look at is a card right under it. Then, in
this order:

- **What needs you.** A tool call an agent waits on is answered right there: **Allow once**, **Deny**, and **Always
  allow** where it is offered. A mission waiting for an answer, a request to talk to the agents, a skill to review, a
  fact the nightly pass wants to keep or change, or a document an agent saved for a collection is a card that opens
  its page. Facts and documents are shown to whoever may decide them: an admin or an operator.
- **What is moving.** Each mission at work, with how far along its checklist is.
- **Quick chat**, on a laptop: a line to an agent, the orchestrator first and marked as such, and the chat opens with
  the answer. On a phone a **+ Chat** button floats above the tab bar instead.
- **Your agents.** The Office, small, and beside it each agent as a chip: its cat, its name, a crown on the
  orchestrator and a dot for what it is doing. A chip opens the agent; the picture opens the Office.
- Then today's AI use, folded to one line, and setup notes when the last start found something.

When nothing waits and nothing moves, a sleeping cat says *Nothing is waiting for you*.

## An agent is the module

This is the one structural decision worth explaining. Everything about one agent, its files, its
model, its bots, who may reach it, what it carries, is under that agent, not spread across four
top-level pages joined by hand.

It also closes off a failure. A connection is created from an agent's own page, so the form has
nothing to ask about ownership and the dashboard cannot make a gateway that belongs to nobody. One
written into `config.toml` by hand without an owner is flagged at the top of the Agents page.

![The agents list](/media/dashboard-agents.png)

### Model versus Models

A real distinction, not a naming accident. A **profile** is infrastructure, an endpoint, a wire
format, a credential, defined once under *Models* and shared. A **model** is one agent's choice
within it, under that agent's *Model* tab. Keeping them apart is what lets one agent move to a
different deployment without touching the others.

The *Model* tab also sets how long the agent's model thinks (**Effort**), asked for in each of its requests in every
chat; a chat's `/effort` sets its own over it, and an admin's `/effort <level> lock` in a chat sets this one.

An [external agent](/en/docs/manual/external-agents/) has a **Brain** tab in place of *Model*: the coding CLI that
answers it, the account, the preset and the CLI's model, with Nouride's own model for it folded below. Its accounts
are under *Models → Coding CLIs*.

![An agent's Model tab](/media/dashboard-agent-model.png)

### Files

The persona pack, edited in the browser. A Markdown file opens in its preview, with **Edit** beside it, and both
are one height that scrolls inside, so switching between them does not move the page.

![An agent's Files tab](/media/dashboard-agent-files.png)

The preview builds React elements and there is no raw HTML rendering anywhere in the app. An agent
can write its own `MEMORY.md` and create its own skills; rendering that as HTML would turn "the model
emitted a script tag" into a script running in an admin's browser, same origin, with a session
cookie.

The `config.toml` here is the agent's own. The daemon's is the last card of **Agents → Settings**.

### Settings, for every agent

**Agents → Settings** holds what applies to every agent: whether new senders may ask to be let in,
group context, credential paths, mentions between agents, the daily spend cap, tool and turn budgets,
how long conversations are kept, and the daemon's `config.toml` for anything without a form. An
agent's own *Settings* tab holds only what that agent overrides.

![Agents → Settings: who may ask to be let in, and how much of a group an agent follows](/media/dashboard-agents-settings.png)

## What waits on you, and where

Four things wait on a person, and each has its own place. Confusing the first two once cost an
operator an hour, and the wording is chosen so it cannot happen again.

| | Where | What it means |
|---|---|---|
| **Approvals** | Home, Work → *Waiting for you*, and under the conversation in Chats, only when non-empty | An agent has stopped mid-turn wanting to run something |
| **Pairing requests** | **Settings → Access** → *Pending*, with a count beside Settings in the menu | A person is asking to be let in at all |
| **Skill drafts** | Skills Workshop → *Pending*, with a count beside Skills in the menu | An agent has *proposed* a skill, or you fetched one from a hub |
| **Memory proposals** | Home, and Knowledge & Memory → *Proposals*, with a count beside Memory in the menu | The nightly pass wants a change a person should decide on |
| **Documents to add** | Home, and the collection's card under Knowledge & Memory → *Knowledge*, with a count beside Memory | An agent saved a document for a collection, and it waits for you to add or decline it |

An approval is a turn stopped mid-flight with a timer on it. A draft or a proposal is a suggestion
about work that already finished: it blocks nothing and waits for you. Putting them in one queue
would give one of them the wrong lifecycle.

### What Home says about the others

Approvals are answered on Home, first among what needs you, and on Work's *Waiting for you*, because the agent is
blocked and the answer is the whole point of showing it. A queue nobody can find is a turn that times out.

Pairing requests and skill drafts are only *announced* there, one card each, saying how many are
waiting and opening where they are answered:

> 2 people ask to talk to your agents. **See who is asking →**
> A new skill waits for your review. **Review them →**

Both appear only when the queue is not empty, and neither carries an approve button. Letting a
stranger in, or publishing a skill an agent wrote, is not a decision to make from a page you are
skimming, so the count is here and the request is read where it is decided. A mission waiting for an
answer is a card too, opening the mission. Memory proposals show as a count on the *Proposals* tab.

![An approval card](/media/dashboard-approvals.png)

## Links from a chat

Asked about a mission, a scheduled job or an approval, an agent gives you the link to its page here, and a mission's
*started*, *needs you* and *done* notices carry one. Links are built from `[dashboard] public_url`, the address the
dashboard is reached at from outside. Without it there are none: a `localhost` address opens nothing on a phone.

- **In a direct chat**, a link goes to a person who holds a dashboard account: an id `web:<account>` in their People
  entry. Anyone else gets the same answer, report and files, without the link.
- **In a group**, the link is written whoever is there. Someone without an account who opens it sees the login page and
  nothing more.
- **Opened signed out**, a link goes to the login page, and once you sign in, on to the page it named.
- **No preview card.** A message that holds a link is sent with its preview off, so the chat shows no card of the login
  page.
- **One job on Schedule.** The link for a job an agent proposed, `/schedule?job=<id>`, opens the page with that job's
  card marked and its runs open.

## Skills is top-level *and* a tab

Both are load-bearing. A skill is not owned by an agent, there is one pool and every agent is
offered all of it, so "who has this, and does this box have the `dot` it needs?" has no agent to
live under. That is the Workshop. The agent tab answers the other direction: what does *this* one
carry.

Two views of one switch, which is why the Workshop's rows carry a badge per agent rather than five
links away. *Explore* installs a skill someone else wrote; it lands on *Pending* like any draft.

![The Skills Workshop](/media/dashboard-skills.png)

A row expands to its `SKILL.md` in place, fetched only when opened. Deciding whether an agent should
carry something and reading what it says belong on one screen.

[Skills & learning →](/en/docs/manual/skills/)

## Knowledge & Memory

What the agents know and remember, for operators only. **Knowledge** holds the documents you keep for them, in
collections: who may be answered from each, files dropped on it or written there, what waits for an admin's yes, a
search over them, and each document's related ones ([Knowledge base →](/en/docs/manual/knowledge/)). The other tabs are
memory: each agent's own notes, what is known about each person (with the documents about them), every conversation on a
timeline, what every agent knows, and the changes waiting on you.
**Tidy tags** and the tags card above the tabs keep the tag vocabulary small, and **Graph view**
(`/memories/graph`) shows the same memory as a shape: conversations joined to the people, tags and
agents in them, and with **Documents** switched on, the collections, their documents, the links between them and the
documents close in meaning.

[Memory →](/en/docs/architecture/memory/)

## Things the UI will always do

Not style preferences, each one is a bug that was written, or one the code's shape now prevents.

**Destructive actions ask, and say what will happen.** Which item, how many agents it affects, and
that nothing undoes it. The button carries the verb, "Delete", never "OK".

**Credentials are write-only.** A token field on an existing connection is empty, and empty means
*leave it alone*, never *clear it*. Nothing reads a credential back, so the field never holds a stored
value for someone to select and overwrite; its placeholder only says *unchanged*.

**A saved gateway is not a running gateway.** Adapters are built at boot, so a saved connection that
has not started yet says a restart is required and offers the button.

**It says which state is which.** A connection that exists but never started shows as "not started",
not "disconnected", labelling it as disconnected sends somebody to debug a network problem that does
not exist.

**Nobody can lock the instance out.** Nobody can delete their own account, and the last admin cannot
be demoted, so there is always someone left to manage accounts.

## Chat

Talk to one agent, or make a **room** with several: pick the agents first, then tag the one you mean
(`@nox`), because in a room a tag is the only way a message reaches a particular agent. Each turn's
steps open live as the agent works, with how long each took and the model's reasoning, and stay
readable afterwards. It is the fastest way to see *why* an answer took the shape it did.

![Dashboard chat with live turn steps](/media/dashboard-chat.png)

The turn lives on the daemon, not in the browser, so a reload or a second tab picks up a turn still
running, and the conversation list marks which conversations are working, wherever they started.
Approvals wait under the conversation, background jobs show while they run, and typing `/` lists
the slash commands. `/stop` and `/approve` act at once rather than waiting behind the turn they are
meant to stop or answer. In a one-to-one chat, **Send** stays next to **Stop** while the agent works:
what you send then is read by the running turn at its next step.

Above the box you type in, the agent's plan for the conversation shows while it works: how many steps
are done and the one in hand, with the whole list a press away. Missions started from the conversation
sit beside it, each with its progress or what it needs from you, and open their own page. The agent
keeps the plan; the line only reads it, and goes once the plan is finished.
[Talking to an agent →](/en/docs/manual/chatting/)

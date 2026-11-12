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

![Home: what needs you, what is moving and Quick chat](/media/dashboard-overview.png)

## The map

The menu is in the order its pages are opened: **Home, Chats, Work and Agents** every day, **Skills**, **Connectors**
and **Memory** now and then, and everything you set up once behind **Settings**.

```
Home                what needs you · what is moving · Quick chat · your agents · the box · today's AI use
Chats               your agents and rooms in one list, and the groups they are in on chat apps
Work
  Waiting for you   tool calls an agent waits on, missions waiting for your answer, and steps of an
                    automation waiting for your yes
  Automations       everything that runs on its own, on a schedule, when a webhook is called or by hand:
                    make one, change its steps, run it now, see how each run went
  Missions          long work agents finish alone: what needs you, what runs, what ended; Limits
  Helpers           helpers, commands and asked agents an agent left running: each one's steps, Stop
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
    LLM Gateway     the in-process Nougate: on or off, accounts, usage        (admin)
    Models          Model providers: endpoint, wire format, credential;       (admin)
                    Coding CLIs: each CLI's accounts and their sign-ins;
                    Model tiers (a button): the three tiers, each helper's
    Secrets         the credentials, what each is for, the backup password    (admin)
  Reaching out
    Integrations    other AI apps reaching memory, one key per app            (admin)
    Web Search      where agents search: free sources, Brave, Exa, SearXNG, own (admin)
  People and sign-in
    Access          who may talk to the agents: Pending · Approved · Denied · Blocked · History
    Users           accounts and roles (Pro editions)                         (admin)
    My Account      username, name, password
  This box
    My Box          the appliance itself (a paired Box only)                  (admin)
    Logs            Daemon · Audit · Schedule · Helpers
    Update          the version running, the newest release, installing it
```

Work, Agents and Memory each hold several pages, shown as tabs across the top of each of them. Every tab keeps its own
address, so a link to one still opens it. Work opens on **Waiting for you**, and the count beside Work in the menu is
what waits there.

**Settings** is a page of cards in four groups, each card with a line on what its page is for, and a search box that
finds one by its name or that line. **Restart**, **Documentation** and **Community** (Nouride's Discord server) sit at its foot. In the sidebar, Settings' own
pages are listed under it only while you are on Settings or one of them.

Admin-only pages are **absent** from the menu and from Settings for anyone who cannot use them, rather than present
and refusing.

At the foot of the sidebar, **Your box** says whether the box is running well and which version it runs, with a button
when a newer version is out. The card itself opens Settings.

The browser tab's title counts everything waiting for you, `(2) Nouride`, so a tab left in the background still tells
you.

**On a phone**, a tab bar along the bottom holds Home, Chats, Work and Agents, with Work's count on it, and **More**,
which slides the rest of the menu up as a sheet.

**On your phone's home screen**, the dashboard opens like an app: the Nouride cat as its icon, Chats first, in a window
of its own. Open the dashboard at its `https://` address. Chrome or Edge offers **Install** (in the address bar, or in
the browser's menu as **Add to Home screen**). On an iPhone, open it in Safari, press **Share**, then **Add to Home
Screen**. The app keeps its own sign-in, so you sign in once inside it. After the box updates, it opens on the new
version, as the browser does.

**On Chats** the menu folds to its icons, so the list of chats and the conversation fit side by side. **Expand**, at
the foot of the folded menu, gives it back, and the browser remembers which way you left it. Every other page keeps the
whole menu, and a phone keeps its tab bar.

**The look** is a soft cream by day and a violet grey by night. It follows your device until you choose with the sun or
moon button beside your name. The Nouride cat greets you on Home, keeps you company on an empty page, and sits beside the title of pages such as
Automations and Secrets. While a page loads you see its outline, grey shapes where its content will be.

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
  allow** where it is offered. A step of an automation that waits for your yes is answered there too: **Continue**
  or **Stop**. A mission waiting for an answer, a request to talk to the agents, a skill to review, a
  fact the nightly pass wants to keep or change, or a document an agent saved for a collection is a card that opens
  its page. Facts and documents are shown to whoever may decide them: an admin or an operator.
- **What is moving.** Each mission at work, with how far along its checklist is.
- **Quick chat**, on a laptop: a line to an agent, the orchestrator first and marked as such, and the chat opens with
  the answer. On a phone the chat button that floats over every page stands in its place, above the tab bar.
- **Your agents.** The Office, small, and beside it each agent as a chip: its cat, its name, a crown on the
  orchestrator and a dot for what it is doing. A chip opens the agent; the picture opens the Office.
- Then today's AI use, folded to one line, and setup notes when the last start found something.

When nothing waits and nothing moves, the cat says *Nothing is waiting for you*: asleep, with a coffee, or leaning on
its scooter, a different picture each time you open Home. While a mission is moving, it rides beside the list.

## A chat on every page

On every page but Chats, a round button with an agent's face stands in the corner of the window; on a phone it stands
above the tab bar. Press it and a small chat opens over the page: a card in the corner on a laptop or a tablet, a
sheet from the foot of the screen on a phone. The page stays where it is, so you can look at it while you ask. Press
the button again, press Escape or use the panel's minimize button to put it away: that ends nothing, and an agent at
work goes on. What you had written and not sent is
still in the box when you open it again.

- **Which agent.** The first time it opens on your orchestrator, and after that on the agent you last used there. On
  an agent's own pages it opens on that agent. Press the agent's name at the top of the panel to pick another.
- **The same conversation as on Chats.** For each agent the panel shows your newest one-to-one conversation with it,
  the one its row on Chats opens, and starts one when there is none. What you send in the panel is on Chats and the
  other way round, with the agent's steps, its files, the approvals it waits on and **Stop**, as on Chats. The arrows
  at the top of the panel open the same conversation on the Chats page. Rooms and groups stay on Chats.
- **A new conversation.** The speech bubble with a plus, at the top of the panel, starts a new conversation with the
  agent the panel is on. Your first message begins it, and the panel stays on it. If you close the panel without
  writing anything, it opens on your newest conversation again.
- **The page follows the agent.** When the agent makes or changes something that has a page of its own, such as an
  automation it proposes or a mission it starts, the page under the chat reads its data again by itself, and once
  more when the agent has finished answering. A button under the answer, **Open in Automations** for an automation,
  takes you to what it made. On the page that makes a new automation, what the agent made for you opens in its
  place, its steps drawn; if you had already written in the form, the page stays and the button is the way.
- **The agent knows which page you have open.** Each message from the panel tells the agent the page it was written
  from: what the page is called, its address, and what it is about where it is about one thing, such as a mission or
  an agent. So "what is this one waiting for?" asked on a mission's page is about that mission. A message written on
  the Chats page names no page.
- **It can take you to another page.** In a conversation from the panel the agent is also told the dashboard's pages,
  so "take me to the memory graph" is answered with a link. Press it and that page opens under the chat, which stays
  open; on a phone the chat is put away so you see the page. A link to anywhere else opens in a new tab, as before.

The button is there for whoever may chat (an admin or an operator). While the panel is closed it asks the server for
nothing.

## Ask your orchestrator, from any page

Most pages carry a button in their header, **Ask** and your orchestrator's name: *Ask Nouva to create an agent* on
Agents, *to make an automation* on Automations, *to change it* on one automation's page, *to add a model* on Models,
and so on.
It opens the chat over the page you are on, with your orchestrator, and puts a request for that page in the box, with
a gap (…) for what you want. You stay on the page. Finish the request and send it: nothing is sent until you do, and
the agent still asks before anything risky. If you had already written something in the box, the request is added
under it. The button is there for whoever may chat (an admin or an operator), and only once an orchestrator is set.
On a phone it says **Ask Nouva**.

## Automations

**Work → Automations** is one list of everything that runs on its own: what starts at a time, what starts when a
webhook is called, and what you start by hand. What an automation is, and what each kind of step does, is on
[Automations](/en/docs/manual/schedule/). This is the page itself.

**The list.** Each automation is a card: its name, what starts it in words (*every day at 07:00*), its steps as a row
of small tiles (the first six, then how many more), the agent that runs it, how its last run went, when it runs next,
and a switch to pause it. An automation with one step says that step in a line, so an old reminder reads as what it
does. A search box looks in the names, the agents and what the steps say, and one dropdown, **Starts**, narrows the
list to **Scheduled**, **Webhooks** or **Manual**. An automation an agent proposed carries **Turn on** and
**Discard**. **New automation** opens an empty page to fill in, or ask an agent for one in a chat.

**One automation's page** has its name at the top (press it to rename), **Ask Nouva to change it**, the switch,
**Run now**, and **Delete** in the menu beside them. Under it:

- **Start**: when it runs, said back to you in words as you set it. A webhook shows its address with a button to copy
  it, an example of how to call it, **Send a test**, and **New address** for when the old one got out.
- **Steps**: cards in the order they run, joined by a line. Press a card to change it where it is. Press the plus
  between two cards to add a step there and pick what it does. Drag a card by its handle to move it, or use **Move
  up** and **Move down** in the card's menu, where **Duplicate** and **Delete** are too. A deleted step comes back
  with **Undo** for a few seconds.
- **Where a run goes next**: under each card, small labels say where the run goes once the step is done, if it
  failed, and if it had nothing to say. On a laptop a step that jumps ahead is joined to the step it lands on by a
  curved line, and pointing at the label lights that line up. A run only goes forward, so when moving or deleting a
  step would leave a jump pointing back, the page sets it to the usual way and says so on the card. The last
  step has no such labels and nothing to choose: the run ends after it, and its card says how that end is counted.
- **Who and where**: the agent, the chat that hears how each run went, and what it remembers between runs.

Nothing is saved as you type. Once something changed, a bar at the foot of the page offers **Save** and **Discard
changes**, and says what is still missing. If the server refuses a step, that step's card is marked with the reason
in everyday words.

**Runs.** Switch from **Steps** to **Last run** and the same cards show how the run went: which steps are done and
how long each took, which failed and why, and which the run never reached. A run that is still going is drawn as it
moves. A step that waits for you has **Continue** and **Stop** on its card, for whoever may change automations, and a
step that started a mission links to it. **Recent runs** lists the last twenty, and pressing one draws that run over
the steps.

**A change an agent suggests** waits at the top of the page as **Suggested**, with what it adds, changes and removes,
and **Accept** and **Discard**. **Current** and **Suggested** switch the cards between the two, with the changed
steps marked.

Schedule and Webhooks used to be two pages. They are this one page now, and their old addresses still open it.

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

Several things wait on a person, and each has its own place. Confusing the first two once cost an
operator an hour, and the wording is chosen so it cannot happen again.

| | Where | What it means |
|---|---|---|
| **Approvals** | Home, Work → *Waiting for you*, and under the conversation in Chats, only when non-empty | An agent has stopped mid-turn wanting to run something |
| **Pairing requests** | **Settings → Access** → *Pending*, with a count beside Settings in the menu | A person is asking to be let in at all |
| **Skill drafts** | Skills Workshop → *Pending*, with a count beside Skills in the menu | An agent has *proposed* a skill, or you fetched one from a hub |
| **Memory proposals** | Home, and Knowledge & Memory → *Proposals*, with a count beside Memory in the menu | The nightly pass wants a change a person should decide on |
| **Documents to add** | Home, and the collection's card under Knowledge & Memory → *Knowledge*, with a count beside Memory | An agent saved a document for a collection, and it waits for you to add or decline it |
| **A step waiting for your yes** | Home, Work → *Waiting for you*, and the automation's own page, with **Continue** and **Stop** | A run of an automation has reached a step that asks a person before it goes on |

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
answer is a card too, opening the mission. A step of an automation that waits for your yes is answered right there,
with **Continue** and **Stop**, and its card opens the automation. Memory proposals show as a count on the
*Proposals* tab.

![An approval card](/media/dashboard-approvals.png)

## Links from a chat

Asked about a mission, an automation or an approval, an agent gives you the link to its page here, and a mission's
*started*, *needs you* and *done* notices carry one. Links are built from `[dashboard] public_url`, the address the
dashboard is reached at from outside. Without it there are none: a `localhost` address opens nothing on a phone.

- **In a direct chat**, a link goes to a person who holds a dashboard account: an id `web:<account>` in their People
  entry. Anyone else gets the same answer, report and files, without the link.
- **In a group**, the link is written whoever is there. Someone without an account who opens it sees the login page and
  nothing more.
- **Opened signed out**, a link goes to the login page, and once you sign in, on to the page it named.
- **No preview card.** A message that holds a link is sent with its preview off, so the chat shows no card of the login
  page.
- **One automation.** The link for an automation an agent proposed opens that automation's own page,
  `/automations/<id>`. A link from before Automations was one page, `/schedule?job=<id>`, lands on the same page, and
  the old Schedule and Webhooks addresses open the Automations list.

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

**Every account is someone in People.** Making an account asks **Who is this?**: someone already in People who has no
account yet, or someone new, named after the account. Accounts made before this are each given a person of their own
when Nouride starts; none is matched to a person by name, so link it to the right one on Users if it is someone you
already had.

## Chat

**Chats** is one list beside the conversation you have open. On a phone the list comes first, and a conversation
opens over the whole screen with an arrow back to the list.

The list has two halves, switched at its top:

- **Chats** is everything you can talk to from the dashboard. Your orchestrator is always first. Then come the agents
  and rooms you talked to, the latest first, each with its cat, the last thing said and when. **Working** shows while an
  agent works, with how many helpers it has at work, and a dot marks a reply you have not read yet. Agents you have not
  talked to yet wait at the end, under **Not talked to yet**.
- **Groups** is the groups your agents are in on Telegram, Discord and WhatsApp, one line per group even when several of
  your agents' bots sit in it, each with its app's name in that app's colour (WhatsApp green, Telegram blue, Discord
  indigo), and the rooms you made in the dashboard. A chip per app narrows the list to it, **Dashboard** to your rooms,
  and anything quiet for two weeks or more is folded into one line at the end. A dot on **Groups** says a group heard
  something since you last looked.

The **+** at the top starts a chat with an agent or makes a room, and the search finds a chat by its name or its last
message.

**Your chats are yours.** Each account sees its own: its conversations with each agent here, its private chats with the
agents on Telegram, Discord and WhatsApp (by the person it is under People), the groups that person spoke in, and the
rooms it made or spoke in. Two accounts talking to the same agent each have their own conversation. An operator or a
viewer never sees anyone else's: not in the list, not by its link. An admin picks whose chats in the dropdown beside the
search, in the list and in History: **Mine** (where it starts), **Everyone**, which lists every conversation set apart by
person, then what scheduled jobs said on their own, then the private chats of people not yet under People, one person
(type part of their name to find them), or **Not known**. Your own name is not in the list: **Mine** is
yours already (0.8.33). A scheduled job's conversation and a
mission's are not held by person yet: everyone sees them as before.

**A conversation opens on its newest message** and stays there as an answer is written. Scroll up to read and it
stays where you put it; a small arrow at the foot of the conversation takes you back to the newest message. Sending a
message takes you there too, wherever you were reading. The chat that floats over other pages does the same, without
the arrow.

**An agent's chat** opens its latest conversation, to carry on where you left off. **History**, in its header, lists
only that agent's conversations: the ones in the dashboard, and its private chats on chat apps, each saying where it is
from. **New chat** starts a fresh one. To delete a conversation, use the menu (**…**) on its row in History, or the
chat's own menu while it is open; you are asked first, and nothing undoes it.

**A room** is one conversation with several agents. Pick the agents when you make it, then tag the one you mean
(`@nox`): a tag is how a message reaches a particular agent. The room's header shows its members as the tags you type,
and says who answers a message with no tag, if anyone does: the orchestrator when it is in the room, or the room's only
agent. The setting that makes chat-app groups wait for a tag does not apply here; `/mention on` in the room does. **Add
agent** brings another one in; the room's menu renames it, takes an agent out, or deletes it.

**Anything from a chat app is read-only here.** A group, or a private chat with an agent on Telegram, Discord or
WhatsApp, says its app's name and **Read-only**, and where you would type there is a note: it is answered on its own
app. The people there are on the left, each under their name (the one under People, else the name their app shows), and
a group shows what people said even when no agent answered. **Pin to Chats** keeps a group you read often in Chats, in
this browser.

![Chats: the list beside a conversation, an answer with its steps open](/media/dashboard-chat.png)

While an agent works, its steps fold into one line: what it is doing now, how many steps it has taken and for how long.
Press the line to open the newest steps, with how long each took and the model's reasoning; the earlier ones are one
more press away. Press the line again to fold them. Once the turn is done the steps stay readable under the answer. It
is the fastest way to see *why* an answer took the shape it did.

The turn lives on Nouride, not in the browser, so a reload or a second tab picks up a turn still running. Approvals wait
under the conversation, background jobs show while they run, and typing `/` lists the slash commands. `/stop` and
`/approve` act at once rather than waiting behind the turn they are meant to stop or answer. In a one-to-one chat,
**Send** stays next to **Stop** while the agent works: what you send then is read by the running turn at its next step.

Above the box you type in, the agent's plan for the conversation shows while it works: how many steps
are done and the one in hand, with the whole list a press away. Missions started from the conversation
sit beside it, each with its progress or what it needs from you, and open their own page. The agent
keeps the plan; the line only reads it, and goes once the plan is finished.
[Talking to an agent →](/en/docs/manual/chatting/)

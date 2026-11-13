# The Dashboard

React 19 + Vite + TanStack Router + TailwindCSS/daisyUI, served by the engine at `/dashboard/`
(TD-009). It is the operator's second interface after the CLI, and the *first* one for anything an
agent owns.

This file is the map and the reasoning. The invariants that apply to the code are in
[CONTRIBUTING.md](./CONTRIBUTING.md); the API it speaks to is `apps/engine/src/modules/web/control/`.
What each screen does for a user is `SPEC.md` §11.

---

## 1. The shape, and why

```
Chat              talk to any agent, or open a room with several
Missions          long work an agent finishes alone: what needs you, what runs, each one's page (0.8.0)

Overview          what is waiting on you · today's tokens and spend · the Office, small
Office            the agents' statuses as a small office of cats; a cat's card to wake, sleep or restyle it (0.8.1)
Automations       everything that runs on its own, whatever starts it (a schedule, a webhook, by hand):
                  the list, and a page for each with its start, its steps as a flow and its runs (0.8.34)
System Logs       the daemon's log, the audit trail, job runs, background commands

Agents            the list, and New Agent — answered by a model, or by a coding CLI on this box
  ├ Agent Settings  daemon-wide: who may pair, group context, exec policy, mentions, spend cap,
  │                 budgets, retention, and config.toml itself
  └ <agent-id>
      Files           SOUL.md, IDENTITY.md, config.toml… with a markdown preview
      Model           which provider profile and model this agent runs on
      Brain           in Model's place for an external agent: its coding CLI, account and sign-in,
                      preset, the CLI's model, and the model Nouride's own work for it runs on
      Connections     the bots and numbers it answers on
      Access          whether it takes new senders, what it asks before acting, its senders' count
      Skills          every skill in the pool, and which of them this agent carries
      MCP             which of the install's MCP servers it uses
      Settings        what one turn may spend, its tools
      Look            its cat in the Office, part by part, as it will be

Skills            the Workshop: the pool, who has each skill, drafts, skills on public hubs
MCP               the install's MCP servers: Installed · Explore, a switch per agent on each
Memory            agent notes · people · timeline · shared · proposals · settings — and the graph
People            who is who across platforms ([[people]])
Groups            the rooms the agents talk in: each group, channel, thread and dashboard room
Access            who may talk to the agents: pending · approved · denied · blocked · history
Models            Model providers: endpoint, wire format, credential · Coding CLIs: each CLI,
                  its accounts and the agents on each, a shared account's sign-in
LLM Gateway       the in-process Nougate's console — only on an edition that carries it
Secrets           the secret store — names and where each resolves from, never values

Integrations      other tools using this install's memory and personas, over MCP
Web Search        which search service the agents reach

My account        username, name, password
Users             accounts and roles
My Box            the paired Box — only on one
Documentation     a link out to the docs site
```

The sidebar heads the blocks above Interact, Monitor, Configure (Agents to Secrets), Connect, Account and Learn, so
the Office is **Monitor → Office**.
Models, LLM Gateway, Secrets, Integrations, Web Search, Users and My Box are an admin's, and absent
from the sidebar for anyone else (§3). `/update` — which version this is, and taking a newer one — hangs off the
version shown in the sidebar.

**An agent is the module.** This is the one structural decision worth defending. The first rebuild
gave the dashboard a sidebar and left Gateways and Access as top-level pages, and that was still
wrong: one agent's settings were spread across four places, so answering *how is this agent set up*
meant visiting all four and joining the results by hand.

**Access is top-level again — for the people, not the settings.** What one agent does with a stranger
(follow the default, pair, refuse) and how much it asks before acting stay on its own Access tab. The
*people* moved out, because none of the questions about them has an agent in it: one person can ask two
bots, a spammer can tag six, and "who did we block, and who let them in?" is one search across all of
them. Per agent, the requests waited three clicks behind a name you had to guess while a fifteen-minute
code ran out. The tab counts its own senders and links to the page filtered to it.

Moving them under the agent also made a failure mode unrepresentable. A connection is created from
an agent's own page, so the form has nothing to ask about ownership — and there is no longer any way
to produce a gateway that belongs to nobody, which used to silently drop every group message.

**Model vs Models** is a real distinction, not a naming accident. A *profile* is infrastructure — an
endpoint, a wire format, a credential — defined once and shared. A *model* is one agent's choice
within it. Keeping them apart is what lets one agent move to a different deployment without touching
the others. Coding CLIs keep the same split (0.8.1): an account is listed once, on Models → Coding CLIs, with the
agents on it, and an external agent's Brain tab picks its CLI and account.

**Skills is top-level *and* a tab, and both are load-bearing.** A skill is not owned by an agent —
there is one pool in `agents/skills/` and every agent is offered all of it — so the question "who has
this, and does this box have the `dot` it needs" has no agent to live under. That is the Workshop. The
agent tab answers the other direction, "what does *this* one carry", and writes the same file:
`agents/<id>/skills.toml`. Two views of one switch, which is why the Workshop's rows carry a badge per
agent rather than a link away to five pages.

The Workshop is also where a skill gets read before it is handed out. A row expands to its `SKILL.md`
in place, fetched only when opened — deciding whether an agent should carry something and reading what
it says belong on one screen, and a pool of thirty bodies preloaded would make the first render carry
everything nobody asked for.

**Memory and People are top-level for the same reason Skills is.** What is remembered about a person is
shared by every agent that talks to them, so it has no agent to live under. Memory holds what the agents
remember — each agent's own notes, the people's profiles, the timeline of conversations with the nightly
pass on top, shared knowledge, the proposals waiting on a person, and the pass's settings — and its graph
draws the conversations, and the people, agents and tags they link, from the index. The tag tools live there
too: a card that appears only when there is something to act on — the tags last night's pass coined,
each with **Merge into** the tag it is nearest; what the rules can tidy; **Undo** for a week after a
tidy — and **Tidy tags** in the page header, which opens the same review at any time. People is the
`[[people]]` mapping that tells an agent who is speaking: one entry per person, added by name with a
Person Key made from it, and their accounts attached then or when they pair.

**Automations is one page, and daemon-wide.** A scheduled job, a webhook and a job started by hand are the same
thing with a different start, so they are one list (`modules/automations`) with one dropdown for the start, where
Schedule and Webhooks were two pages. It stays daemon-wide even though every job has an `agentId`, because you
usually want to see everything that runs on its own at once. One automation's page is its start, its steps as cards
in the order they run, and who runs it and where it reports. A run is drawn over those same cards (done, failed,
waiting, never reached), so the picture a person edits is the picture a run is read on, and a suggested change is
the same cards again with what it adds and changes marked. A job that does one thing is drawn as one step and stays
saved as one thing until it needs to be a list. Nothing is saved as it is typed: the page keeps a draft and one bar
saves it, because a list of steps half saved is a job that runs half of what was meant. `/schedule` and `/webhooks`
redirect to the list, and `/schedule?job=<id>` to that job's page.

**Chat is the first entry, and it is a client of the daemon, not of the browser.** A turn belongs to
the daemon's turn records, so reloading the page, opening a second tab or coming back an hour later
shows the same turn — its steps, their durations, the answer as it is written. A room is a chat with
several agents in it, each with its own conversation. The composer keeps **Send** beside **Stop**
while an agent works: a room always did, and a one-to-one chat now does too, because what is sent
then is read by the running turn at its next step (`SPEC.md` §10.1, steering). It appears at once,
from the turn's record: your message under the steps, then "↪ Got it" and the agent's line under it.
In a room the message keeps its own bubble where it was said, and the card quotes it above the lines.

**The floating chat is that same conversation, over every other page.** A person looking at a mission, a job or a
log line wants to ask about it without leaving it, and a button that went to Chats took the page away. So every page
but Chats has a round button with an agent's face, and it opens a panel over the page: a card in the corner from a
tablet's width up, a sheet on a phone (`commons/components/floating-chat`). The panel draws the Chats page's own
conversation component for one agent, picked in its bar: the person's newest one-to-one conversation with it, the one
its row on Chats opens, so there is one transcript and one live turn whichever place it is read from. Two things are
the panel's own. A new conversation's id is kept in the panel, where the Chats page puts it in the address, because
the page under the panel must not move. And each message says which page was open (`OpenPage`: the address, the
page's title, and its subject where the page says one with `usePageSubject`), which the daemon puts on that message as
one line, never in the prompt. Once in a conversation, on the first message that names a page, the daemon also says
the dashboard's pages by name and path (`web/dashboard-pages.ts`, held to the menu by a contract test), so the agent
can answer with a link; a link to a page of this dashboard, in any markdown the dashboard draws, opens it in place
(`lib/page-link.ts`, `Linked` in `Markdown.tsx`), and any other path stays words. It opens on the agent the page
belongs to, else the one last used there, else the orchestrator. Closed, it draws no conversation, so it holds no event stream and asks for nothing: a browser has six
connections to give. The pages' "Ask Nouva to" buttons open it with their request in the box, unsent.

---

## 2. Queues that are not the same queue

Confusing these once cost an operator an hour, and the words are chosen so it cannot happen again.

| | Where | What it means |
|---|---|---|
| **Approvals** | Overview, top, only when non-empty | An agent has stopped mid-turn wanting to run something |
| **Access** | The Access page; counted beside it in the sidebar, and on Overview | A person is asking to be let in at all |
| **Skill drafts** | Skills Workshop, Pending; counted on Overview | An agent has *proposed* a skill, or the weekly review a change to the library, and wants your call. Blocks nothing, and never expires |
| **Memory proposals** | Memory, Proposals | The nightly pass wants a change it may not make alone — shared knowledge, or any fact while `facts = "ask"` |
| **A step waiting for a yes** | Work, Waiting for you; Home; the automation's own page | A run of an automation reached a step that asks a person. Continue or Stop; no answer in the step's time ends the run there |

Overview counts the pairing requests and the drafts and links to them, but answers neither: it is a
page you skim, and the decision belongs on the page that shows the whole request.

**A draft is not an approval**, and the panel is deliberately somewhere else because of it. An
approval is a turn stopped mid-flight with a timer on it; a draft is a suggestion about a turn that
finished twenty minutes ago. Putting them in one queue would give one of them the wrong lifecycle —
either drafts that expire overnight, or approvals that wait forever. So drafts live in the Workshop,
where the pool they would join is on the same screen, and the copy says out loud that nothing there
expires.

A draft that **improves** an existing skill is marked as such and opens into a line diff against the
file on disk — an improvement is usually one added pitfall in a sixty-line body, and asking somebody
to spot it by eye is asking them to approve without reading. Support files it proposes are listed
beside it, each expandable.

A draft from the weekly review says **weekly review** where others say why the agent looked, and its
badge says what approving it moves rather than only what it writes: **archives** for a skill that
leaves the pool with nothing written, **merges *x, y* into** for a rewrite whose approval archives the
skills it absorbed. A move of something several agents rely on must not look like one more
improvement.

Each draft row opens into the whole `SKILL.md`, editable in place, plus the scrubbed transcript of the
turn it came from. Both are on the row rather than behind a navigation, because the decision is
"do I want this in my agents' prompts" and the evidence for it is the turn.

**Three tabs, one page.** A pool skill and a draft are not the same kind of thing — one is in the
prompts right now, the other has no effect at all — so they cannot share a row shape without one of
them lying. But they are one *workflow*: you judge a draft by what is already in the pool.

| Tab | Shows |
|---|---|
| **Live** | the pool: what the agents are actually carrying — opened first when nothing waits on you |
| **Pending** | the queue, plus what was recently decided, for working through it — opened first when something waits |
| **Explore** | opens on ClawHub's most downloaded skills (kept an hour); skills on skills.sh, ClawHub, well-known indexes or a GitHub repository; installing one makes it a pending draft, adjusted to Nouride's frontmatter, with nothing run |

**The Self-Improving Skill panel lives on this page too**, collapsed above the tabs: `[skills.learning]` as
three controls. The mode is a radio group of three — *Off*, *Propose, and wait for me* (`ask`, the
default), *Let it keep what it learns* (`auto`) — because the middle one is the interesting one and the
question operators differ on is whether what the pass finds needs a person. Then the model for the
pass, and a toggle for announcing a new draft in its chat. All of it is live (the loop reads the config
object per turn, so saving applies to the next message and the form says so). It is here and not in a
settings section elsewhere because the only way to know whether learning is set right is to look at
the queue it produced: a setting on a different page from its effect is one nobody revisits.

There are no dials for when the pass looks. Until 0.7.27 the panel carried five — the failure
threshold, the rounds of work, the quick-reply window, the quiet period and the pending ceiling — and
the right answer for every one of them was to leave it alone, so they are the daemon's own now.

The panel's last line is the **weekly review**: when it last ran and what it proposed ("2 to tighten,
1 to archive", or "nothing to change"), and a **Review now** button that runs it at once — the same as
`nouride skills review`. What it proposes lands on Pending, and the toast says so; it never writes to
the pool itself, in any mode.

The failure Access came from: the bot told someone to approve a pairing code, the dashboard's approval
list was empty because that list is for *tool calls*, and the fifteen-minute code expired while they
looked for it.

Approvals are first on the page and hidden when empty because an agent is *waiting* — a queue nobody
can find is a turn that times out.

One **switch**, not a mode picker: *Accept new senders*. On is `pair` — a stranger gets a code and
waits. Off is `allowlist` — a stranger is dropped before anything is queued, while everyone already
paired keeps talking. That is the shape of the actual question ("can strangers still reach my bots?"),
and it is live: the next inbound message is judged by the new setting, with no restart. `open` is not
one of the two positions — it is a posture the daemon warns about, so it is surfaced as a warning when
it is in force rather than offered as a choice.

It sits on **Agent Settings** (`/agents/settings`, linked from the Agents list), not on any one agent's
Access page. `[security.access] mode` is daemon-wide: a switch inside Nouva's card would look scoped to
Nouva and silently change what every other bot answers, which is how you lock six bots out at once. The
per-agent Access tab says what that agent does — follow the default, or its own on or off — and links to
where the default is changed. The requests themselves are answered on the **Access** page, every
agent's at once: Pending, Approved, Denied (for a day, with Reset), Blocked (until Unblock), and History
from the audit log — each list in a scrolling card with a filter box, as the Skills lists are. Every
approved account names its person in People, or says "not in People": one person is usually several
accounts, and that is what a monitor of this list wants to see. The config's own ids are listed under
Approved as *Allowed by config* only when it names any, each named by People where it can be — a bare
list read as "anybody may talk to my bot" when it was the operator's own accounts — and a block beats
them.

**Group context sits beside it, for the same reason.** `[agents] group_context_messages` — how far
back an agent reads a group it was not addressed in — is one number for the whole daemon, so it is one
control on the same page. It is a number and not a switch because there are two questions behind it
and they are different: *should* agents follow the room, and *how far back*. Zero answers the first,
and the copy says so rather than leaving zero as a boundary value nobody guesses. Live, like the
pairing switch: the next inbound message is judged by the new value.

A single connection can override it on that agent's **Connections** page, and that field is labelled
as the override — it names the daemon value it is replacing and where to change it. The general rule
is that whichever scope the config has is the scope the primary control gets, and a narrower field has
to say out loud that it is narrower.

---

## 3. Rules the UI has to keep

These are not style preferences. Each is a bug that was written, or one the shape of the code
prevents.

**Destructive actions ask, through `useConfirm()` and not `window.confirm`.** The native call is
unstyled, cannot name the consequence in more than a line, cannot tell a destructive answer from a
routine one, and is blocked outright by some browsers outside a user gesture. `useConfirm()` hands
back a promise so the decision stays where it is written — `if (await ask({…})) remove.mutate(x)` —
rather than making every caller invent an `open` / `pendingItem` / `onYes` triple, the third of which
is what deletes the wrong row after the dialog has closed.

Say what will happen, not "are you sure": which item, how many agents it affects, and that nothing
undoes it. The button carries the verb — "Delete", never "OK".

**Never render agent-authored text as HTML.** An agent can write its own `SOUL.md` and create its own
skills, so the markdown preview in the Files tab builds React elements and there is no
`dangerouslySetInnerHTML` anywhere in the app. Adding one turns "the model emitted a script tag" into
a script running in an admin's browser, same origin, with a session cookie.

**Credentials are write-only.** A token field is empty on an existing connection and empty means
*leave it alone*, never *clear it*. Nothing reads a credential back — the API does not return one, so
the UI cannot show a masked placeholder that people select and overwrite.

**A saved gateway is not a running gateway.** Adapters are built at boot, so every gateway mutation
reports `restartRequired` and the page says so with a restart button. The signal is derived — an
enabled connection with no live status — rather than remembered in a flag that would survive a reload
it should not.

**Say which state is which.** A connection that exists but has never started is `null` status, shown
as "not started", not "disconnected". Labelling it as disconnected sends someone to debug a network
problem that does not exist.

**Roles are hidden, not refused.** Admin-only pages are absent from the sidebar for anyone who cannot
use them, and a person cannot change their own role or delete their own account — demoting the last
admin from their own browser locks the instance out of account management.

**A phone is a screen of its own, not a narrow desktop** (0.8.12, from the owner's iPhone). A field's text
is 16px there, or iOS zooms the page onto it and leaves it zoomed; the viewport keeps its own zoom.
Nothing is under 12px on a phone and copy is never smaller there than on a desktop — `main.css` lifts the
small sizes, so write `text-sm` for copy rather than `text-xs sm:text-sm`. Every page ends `PAGE_BOTTOM`
above the browser's toolbar and the home indicator (`viewport-fit=cover`). Below `lg` a page scrolls as one
document: a list held to the window scrolls inside its card only from a laptop up. A grid that sets columns
at a breakpoint sets `grid-cols-1` for a phone, or its one track grows to its widest unbreakable line. A row
of columns — a log line, a table, a step beside its outcome — becomes a block there, its long part the
whole width. `tests/phone-type.test.ts` and `tests/phone-layout.test.ts` hold the rules that can be read
from the source.

**Empty is a real value.** An account with no name set means nobody has said what to call them. The
agent then uses no name at all, rather than falling back to the login handle. This is the fix for a
real bug: setup used to ask "what should the agent call you", wrote the answer into a file every
agent read for every conversation, and greeted the second person to message the bot by the first
person's name.

---

## 4. The first-login password

A screen of its own (`/welcome`), and it does **not** ask for the current password.

`must_change_password` means the account is still on the credential the daemon printed at first boot
— which the person typed one screen ago to get in. Asking for it again proves nothing the session
already proved, and frames a *set* as a *change*: the old value was handed to them, not chosen.

The exemption is narrow and closes behind itself. `setPassword` clears the flag, so every subsequent
change requires the current password like any other, because from then on it guards a secret the
person actually picked.

---

## 5. Working on it

```sh
bun run dev                    # the engine, restarting on change
bun run dev:dashboard          # the dashboard on Vite, /api proxied to the engine on $PORT (18254)
bun run build:dashboard
cd apps/dashboard && bun x tsc --noEmit --skipLibCheck
```

`VITE_BACKEND_URL` points the dev server's proxy at an engine somewhere else.

Routes are file-based and the tree is **generated** — `src/routeTree.gen.ts` is written by
`@tanstack/router-plugin` during `vite build` or `vite dev`, and from the same options by
`apps/dashboard/scripts/routes.ts`, which lint:deadcode, lint:types and the mount test run first. So a fresh checkout
needs no build before the hook, and a new route file typechecks without one.

Nested routes use flat dotted names: `agents.$agentId.access.tsx` is `/agents/:agentId/access`.
`agents.tsx` is the layout that renders `<Outlet/>`; `agents.index.tsx` is the list.

`bun run build:binary` runs the dashboard build first, so the compiled daemon always ships the
current UI. There is no separate step to forget.

The dashboard imports no workspace package but `ui-*` ones — `@nouride/ui-graph` draws the Memory
graph — and `@nouride/wire`, the types of what the control API sends and takes, by `import type` alone. It
reaches the daemon over HTTP only (`ARCHITECTURE.md` §3).

### Where things live

| | |
|---|---|
| `src/routes/` | one file per route; layouts render `<Outlet/>` |
| `src/modules/<domain>/` | the pages themselves — `skills/workshop.page.tsx` is the Skills Workshop, with `skills/drafts.panel.tsx` in it |
| `src/commons/components/layout/RootLayout.tsx` | the sidebar: its groups, and which entries are admin-only |
| `src/commons/components/ui/ui.tsx` | `Card`, `Field`, `PageHeader`, `EmptyState`, `StatusDot`, `ErrorNote` |
| `src/commons/components/ui/confirm.tsx` | `useConfirm()` — the one "are you sure?", promise-shaped |
| `src/commons/components/ui/SearchSelect.tsx` | pick one of a list: a button that opens it. A long list gets a field to narrow it (whose chats, on Chats); a short one takes the keys itself (a list's filters) |
| `src/commons/components/ui/ReorderList.tsx` | a list put in order by dragging a row's handle, by the arrow keys on it, or by buttons; the rows slide to their new places |
| `src/commons/components/ui/FlowLinks.tsx` | the curved lines between the cards of a flow, drawn over it from marks the cards carry |
| `src/commons/components/ui/InlineTitle.tsx` | a page's title, edited where it is |
| `src/commons/components/jobs/` | what more than one page draws of a job: `StepCard` (one step of a flow), `WaitingStepCard` (a step that waits for a person, on Work and Home), `ProposalBar`, `Allowances`, `ChatPicker` |
| `src/commons/components/chat/` | the conversation and its parts (`Conversation`, `Composer`, `Turn`), drawn by the Chats page and by the floating chat |
| `src/commons/components/floating-chat/` | the chat over every page: its button and card or sheet (`FloatingChat`), what is in it (`FloatingPanel`), the page a message says (`page-open.ts`) |
| `src/commons/lib/page-link.ts` | `pageInDashboard(href)`: whether a link an agent wrote names a page of this dashboard, read as a browser reads it; `Markdown` opens such a link in place |
| `src/commons/hooks/use-page-subject.ts` | `usePageSubject("…")`: a page says the one thing it is about, for an agent asked from the floating chat |
| `src/commons/hooks/use-sticky-scroll.ts` | a conversation at its end: opens there, follows what grows (its content, watched from the draw it appears in, and its box), stops only when its reader scrolls up, goes there for what they send; `away` and `toEnd` for `ToNewest`, the Chats page's arrow back |
| `src/modules/chat/components/ChatChoice.tsx` | the model and effort a one-to-one conversation is answered with, picked in its bar: what `/model` and `/effort` do, with no message. The daemon keeps a begun conversation's pick, the page a new one's until its first message takes it; the model field is the Model tab's `Combobox`, which says a row was picked (`onPick`) apart from text being typed |
| `src/commons/hooks/use-revealing.ts` | an ended turn held as live while its answer is still being written out: an answer that came whole at the turn's end is written out, not taken by the history with every word at once (`splitForDisplay`, `useTypewriter` in `Turn.tsx`); in a room too, whose list of turns at work never has an ended one, so a turn seen there and then gone is held as it was last seen until the history has it (`useRoomRevealing`, `splitRoomForDisplay`) |
| `src/commons/hooks/use-page-follows.ts` | the page under the floating chat follows the agent: read again when a call made something with a page (`tool_done.page`) and when the turn ends; on a page that makes a new one, what the agent made is opened in its place |
| `src/commons/lib/unsaved.ts` | `useUnsaved(holds)`: a page says it holds something written and not saved, so nothing takes the person off it by itself |
| `src/commons/components/ui/Markdown.tsx` | the deliberately small, HTML-free renderer |
| `src/commons/lib/api.ts` and `api.*.ts` | every control-API call, typed by `@nouride/wire`; cookie auth, same-origin |
| `src/commons/lib/session.ts` | the single description of who may be where, and the redirects |

`session.ts` holds the redirect decision in one place on purpose. Spread across five components it
becomes five subtly different descriptions, and the one that is wrong is always the one guarding
something.

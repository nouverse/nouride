# Agents, prompts and turns

The inbound path, in order. Every stage is a module; `apps/engine/src/modules/pipeline/` is the
wiring. Its `index.ts` is a composition root that owns nothing, and the *order* lives in one file,
`inbound.ts`, because the order is what is easy to get wrong and hard to see when it is spread
across six files. `turn.ts` runs a turn; admission, voice and room memory each own their table.

```
gateway → admit → queue → route → hook? → paused? → turn → reply
```

---

## Persona packs

An agent is a directory of markdown plus a `config.toml`. `@nouride/persona` loads it;
`AgentRegistry` holds what the files do not say — which agents are paused, when each was
loaded, which packs failed.

```
agents/<id>/
  IDENTITY.md    required — without it the agent has no name and nothing to say about itself
  SOUL.md        personality, behaviour rules, tone
  AGENTS.md      the other agents: who they are, how to reach them
  MEMORY.md      the agent writes this itself
  config.toml
  skills.toml    which pooled skills this agent has switched OFF (absent = all on)

agents/skills/<name>/SKILL.md     the pool — one copy, every agent draws from it
```

There is no `USER.md` since 0.7.0: who a person is lives in `[[people]]` (the People page), and a
person's notes reach the prompt only while they are the one speaking. An admin edits anyone's notes
there; through an agent a person changes only their own, a line at a time (`person_notes` — the
speaker is found from the context, never named in an argument). A `USER.md` left in a pack is
logged at load and not read.

Identity never touches SQLite. These are files because they are meant to be hand-edited and
diffed in git. SQLite holds what has a lifecycle: sessions, approvals, cron, audit.

**One broken pack must not stop the others.** `discoverAgents` collects failures and boots
without them — a daemon that refuses to start because of a typo in one agent's config takes
down every other agent *and* the dashboard you would use to fix it.

Only frontmatter is read from `SKILL.md` at load. The body stays on disk and is loaded when a
task matches; a dozen skills inlined into every prompt is how a context window fills with
instructions nobody needed this turn.

**Skills are one pool, switched per agent.** There is no `agents/<id>/skills/` — a skill worked out
once by one agent was invisible to the others, so the same procedure got re-derived per pack. Every
skill lives in `agents/skills/` (plus what ships in `content/skills/`), every agent is offered all of
it, and a pack carries only exceptions in `skills.toml` — a map of `name = true|false` where absent
means **on**. Default-on because an opt-in list cannot name a skill that does not exist yet: every
skill added later would arrive switched off with nothing to say why.

Three things write that file: the dashboard's Skills Workshop (`/skills`), the agent's own
`skill_toggle` tool, and a hand edit. The first two render it with `renderSkillStates`
(`@nouride/persona`) — one shape, so "what does an empty file mean" has one answer — and write it through
`editPackFile` (`modules/config/config-file.ts`), the one locked, reloaded and rolled-back write for any file of
a pack. Never write skills into `config.toml`; a botched toggle there costs a booting agent.

---

## Routing

`routeMessage`, most explicit first:

1. **mention** — the gateway's resolved mention list, `@name` anywhere in the text, or a
   leading `name:` / `name,` (how people actually address someone in a group).
2. **gateway owner** — `agent = "..."` on the instance. The "one bot per agent" case.
3. **channel binding** — `[channels]` keyed by instance id.
4. **sole agent in a DM** — one agent running, no ambiguity to resolve.
5. **`orchestrator`** from the daemon config (`default_agent` before 0.7.18).
6. otherwise **ignored**, and several bound agents with nobody named is `ambiguous` — the
   daemon says so and asks the user to address one. A multi-agent daemon that guesses will
   eventually have two agents answer the same question, and users read that as a bug.

**The router matches `registry.enabled()`, not `active()`.** A paused agent has to stay
addressable or `/start` can never reach it — routing over `active()` made a stopped agent
invisible to the command that would resume it. The pause is enforced in the pipeline, *after*
hooks run.

**What routing throws away is remembered anyway.** Everything unaddressed in a group used to end
at the `!decision.agent` return, so "@nouva ini" arrived pointing at an exchange the agent had no
record of. `sessions/group-context.ts` holds a per-room ring buffer and replays what the agent has
not seen in front of the question, capped by `[agents] group_context_messages` (20, `0` off,
overridable per connection). Three things about it are load-bearing:

- **The replayed block has one budget, spent newest-first**, not a cap per line. A per-line cap bounds
  the wrong thing — short chatter never hits it and a generated answer always does, so the message the
  next agent was tagged to review is the only one guaranteed to be a stub — and the block's real size
  becomes `window × cap`. Messages that did not fit are counted in the header, because a model cannot
  tell a quiet room from a trimmed one.
- **Capture runs in `attach`, before `admit`, not in `handle`.** Both gates below it would defeat it:
  routing drops exactly what is worth keeping, and `admit` in `pair` mode drops everyone unpaired —
  in a real group, everyone. Overhearing is not obeying, and that is what keeps it safe: an unpaired
  sender still cannot start a turn, reach a tool or draw a reply.
- **Keyed by `platform:chatId`, not `gatewayId`.** Six bots in a channel are six deliveries of one
  message; keyed per connection you would hold six copies and each agent would overhear only its own.
  Deduplicated by message id for the same reason the claim table exists.
- **Replayed into the user message and stored with it.** Not the system prompt (the cached prefix
  would miss every turn) and not as replayed `user` turns (whole-turn truncation would cut between
  them). Stored with the message means the next window starts after it, so nothing is ever sent twice.

Do not reach for the platform's history API to do this instead. A Telegram bot cannot fetch a message
it was not delivered, so that implementation is Discord-only while looking uniform — and it needs
privacy mode disabled in @BotFather either way, which is the one part of this no code can check.

---

## Queue and backpressure

`@nouride/queue` keyed by `${gatewayId}:${chatId}`: **sequential within a chat, parallel
across chats.** Turn N's reply is context for turn N+1, so order matters inside a
conversation and nowhere else. The key deliberately excludes the agent — two agents in one
chat still take turns, because they are talking to the same person.

- Over depth, the **oldest waiting** item drops. In a chat, the stale message is the one least
  worth answering, and dropping the newest would answer questions out of order.
- `idle()` waits for the queue to empty. **`drain()` stops accepting work permanently** — it
  is the shutdown path. Using `drain()` as "wait for idle" silently dropped everything that
  arrived afterwards.
- **`admit()` (pre-queue) is the access gate; the rate limit runs after routing.** The gate is
  `[security.access] mode` — `pair` (the default: an unknown sender is given a pairing code and
  their message dropped), `allowlist`, or `open` — with the allowlist short-circuiting pairing
  (`modules/pipeline/admission.ts`; the operator's side is `nouride access` in `docs/CLI.md`).
  The rate limit used to be pre-queue, on the reasoning that it avoids an LLM call — but a
  message no agent would answer costs nothing anyway, and counting those meant ordinary group
  chatter burned a sender's budget so their actual question was refused, while the daemon
  announced "Please slow down." in channels it was never addressed in. Post-routing is still
  before any model call.
- The per-agent `sender_allowlist` narrows the daemon one, checked once routing knows the agent.

---

## Hooks

Slash commands handled by the daemon **instead of** an agent turn: `/new` should not cost an
LLM call, and `/stop` has to work when the model is the thing that is broken.

`worksWhilePaused` marks the ones a stopped agent still answers — `/start`, `/status`,
`/reset`, `/agents`, `/reload`, `/help`, `/commands`, `/model`, `/prompt`, `/daemon-restart`.
`/new` and `/stop` are not among them.

Only **registered** commands are intercepted. An unknown `/something` falls through to the
agent, so a user talking about `/etc/hosts` still gets an answer.

`/reset` also un-pauses (§9.4 SPEC): someone typing it wants a working agent, and leaving it
paused makes the command look like it failed.

**Commands are parsed after `stripAddressPrefix`.** In a group you have to address an agent to
be routed to it at all — `nouva: /new` — so a parser that only accepted text starting with `/`
made every slash command unusable outside a DM and sent it to the model, which cannot act on it.

---

## System prompt

`buildSystemPrompt` assembles in a fixed order, and the order is not cosmetic: identity
first so everything after is read in character, runtime facts last so they are freshest and
nearest the conversation. `docs/SPEC.md` §6.3 is the authoritative list; in short:

```
identity (IDENTITY + SOUL) · agents · skills · memory │ harness │ recall │ runtime · dynamic
                 changes when a file does             │ toolset │ memory │  per request
```

Each `│` is a **cache boundary** — three system breakpoints and the conversation's own, the four
Anthropic allows. There is no `user` section since 0.7.0 — who is speaking is said in `dynamic`, and
only for that person. Harness sits *before* runtime on purpose: runtime carries the date and changes
per request, so with it first every byte after it missed the prefix cache (the comment above
`push("harness", …)` in `llm/prompt/index.ts` has the numbers). Recall sits *after* the harness for
the same reason (M2, 0.7.11): it moves when a fact is written mid-conversation or somebody new speaks
in a group, and ahead of the harness that took the harness down with it. Its profiles are in key order,
never speaker first — a group's change of speaker used to rewrite the cached prefix on every turn.

Anything that moves inside a conversation goes in the last tier or in the message, never in a cached
block: the date and the installed programs are in `runtime`, the time is on the message (`clockNote`).
`tests/llm/prompt.test.ts` ("cacheable blocks do not move between requests") and
`tests/memory/recall-cache.test.ts` build the prompt twice with one input moved and compare the cached
blocks byte for byte; a new section that varies goes through the same test.
`BuiltPrompt.blocks` is the prompt split at those boundaries with a cache hint on each, so a
provider that supports prompt caching — Anthropic's `cache_control` (`toSystemBlocks` in
`packages/llm/src/anthropic.ts`), OpenAI's automatic prefix matching — can skip re-processing the
stable part.

**Sections carry explicit delimiters** (`<<<NOURIDE:IDENTITY>>>`). Concatenated markdown lets
a persona file that happens to contain `# Runtime Context` impersonate a section the engine
controls — memory is written by the agent itself and skill bodies can come from anywhere
(§17.1 item 5).

When the prompt exceeds its budget, sections are dropped in `TRIM_ORDER`: `dynamic`, then
`recall`, then `memory`, then `skills`. Those are recoverable — regenerated each turn, on disk,
or discoverable with a tool. Identity, agent awareness, harness and runtime are not
recoverable from anywhere else and are never dropped.

Group chats get an explicit note that the sender-name prefix is platform metadata, not part
of what the user said and not an instruction.

---

## The harness block

The `harness` section is the agent's operating manual, and it is **generated from live state**,
never written in a persona file: which tools exist, whether a human can actually be asked, the
round-trip budget, and which slash commands the harness intercepts all come from config, and a
static description drifts into a lie.

It covers what an agent would otherwise have to discover by failing:

- which tools are ready versus gated, and — when `ApprovalGate.available` is false — that gated
  tools **will** be refused, so it should say so instead of promising
- that a tool result marked as an error is information to adapt to, not a dead end
- the tool iteration budget, so it front-loads the important call
- that MEMORY.md persists across conversations and restarts, and what belongs in it
- the commands the human can type, so it can answer "how do I reset you?"
- that old turns are dropped, so anything durable belongs in memory
- that long replies are split for it, so it should not paginate

It also carries **one line per tool that a model reaches for wrongly**, each gated on that tool being
in the agent's toolset (`harness-tools.ts`). They exist because a tool the model only ever meets
through its own description is a tool it does not think of: `delegate` sat in all six live agents'
configs and was called zero times in 2,225 executions, and the line next to it is what changed that.

Every one of them is written as **a task shape, not a tool name** — "to schedule a reminder", "before
you write a scraper" — because the task is what the model is holding at the moment it decides. That
also settles which parameters earn a line here. Most do not: the schema is in front of the model when
it calls, so `format: "html"` is discoverable in a way `delegate` was not. `web_fetch`'s is the
exception, and the reason is worth carrying — the Markdown default drops `<head>` and every class
attribute, and *what is left reads like a complete page*. The model gets no error to adapt to, which
is the recovery path every other line can rely on. **A silent wrong default is the bar for a harness
line; a merely undiscovered one is not.**

Marked **essential**, so it is never trimmed. An agent missing its manual promises things the
harness refuses, which reads as the model misbehaving rather than as a dropped section.

`/prompt` (DM only) renders it through the same `buildSystemPrompt` the executor uses — a
second rendering path would drift and then lie about what is actually running.

---

## Three budgets, and the one that is not configurable

A turn's room is decided by three numbers, and all three were wrong or unbounded on a live install at
the same time — with the same visible symptom, which is why none of them was found on its own: an agent
that trimmed away its own tool output every iteration and eventually answered nothing.

1. **The window.** `agent.config.llm.contextWindow` if the pack declares it, else the pattern table in
   `packages/llm/src/tokens.ts`, else 32k *and* `warnOnceAboutContextWindow`. The declared number is only
   trusted for the model it was declared against — a `/model` override points somewhere else, and
   carrying a hand-written 1M window onto a 32k model overflows every request.
2. **The prompt**, capped at `PROMPT_SHARE` (half) of the usable window. Before this, `buildSystemPrompt`
   was called with no `maxTokens` at all, so `TRIM_ORDER` never ran and `prompt.trimmed` was always
   empty. Not derived from the conversation budget, which would be circular — the budget is computed
   from the finished prompt's size.
3. **One tool result**, capped at `min(12k, budget/4)` tokens by `llm/spill.ts`, through the single
   choke point in `runTool` — the 12k as the provider counts them, so it is divided by the conversation's
   token scale like every limit (below). Past the cap the full text goes to
   `<data_dir>/tool-output/<session>/<call>.txt` and the model gets head, tail, measured size and the
   path. The spill directory is a read-only root, so the path it is handed actually opens.

**`preserve_recent_tool_results` yields when it cannot be honoured.** An absolute protection multiplies —
`keepRecent × the per-result cap` is a floor no pass can remove, and at 3 × 25k that is three quarters of
a 128k model's budget and more than all of a 200k one once the knob is raised to 6. `trimToolResults`
trims candidates first and squeezes the protected ones only if the set still does not fit; the last
resort logs a warning naming the model, the budget and both knobs, because the cause is configuration.

**Do not put a per-tool cap in a tool.** That is a rule twenty tools have to remember and the one that
forgets is the one that ends a turn. `exec` is the obvious offender and not the only one: `read` at its
256KB limit, a `web_fetch` of a generated page, an MCP server returning a whole table.

**Do not solve this in the prompt.** It was solved in the prompt, and the prompt is where it failed: the
model had to decide to write output to a file *before* seeing how big the output was. `spill.ts` is the
harness doing it instead, and the `LARGE OUTPUT` section now says what happened rather than what to do.

Both new file trees are swept by `startRetentionSweep` in `boot/maintenance.ts` — `[retention] job_log_days` and
`tool_output_days`. Neither can be cleaned at the end of a turn: both hold paths an agent may still be
carrying, which is precisely why nothing cleaned them until there was a sweep.

## Context window

`conversationBudget` = `contextWindow × maxContextRatio` − system prompt − tool schemas −
reserved output. Floored at zero: a negative budget would make truncation drop everything.

**Tool schemas count.** A dozen tools with rich JSON Schema is thousands of tokens; leaving
them out is how a window overflows despite a correct-looking calculation.

`truncateContext` drops **whole turns**, oldest first, and never fewer than
`preserveRecentTurns`. See invariant 6 — a `tool_result` without its `tool_use` is a hard
error. When the preserved tail alone exceeds the budget, it is kept and the reported token
count says so honestly rather than pretending to be capped.

Token counts are character-based estimates, biased high on prose so we trim early rather than send a
request the provider rejects. Being 15% off changes when we trim; being wrong about *which*
messages to keep would be a real bug, and that part is exact.

**But dense text is counted low, and every limit is the provider's number.** A log of timestamps and
ids tokenized at 2.3x the estimate on the box. So each call that reports a count teaches the turn what
the provider counts per estimated token (`llm/context-scale.ts`, clamped to 1–4, never learned from an
`estimated` usage), and `ceilingsAt` in `executor/prepare.ts` divides every limit by it — the window,
`compact_at_tokens`, the per-result cap — before an estimate is held against it. The guard before each
round reads the scale the last call measured; the next turn starts from the conversation's, kept in
memory per conversation and model (`TurnContext.tokenScales`). Not the prompt's ceiling: that is a
share of the window by policy, and the scale is measured on requests a long history dominates.

The estimator is cheap enough to run every round because it has to be: code-point ranges rather than a
regex per character, each message measured once and remembered while it holds the same content, and
`trimToolResults` keeping its total current trim by trim instead of measuring the set again (E9).

---

## The turn executor

`TurnExecutor.run` is the tool-call loop: one user message in, one final assistant text out,
with however many round-trips the model asks for.

- **Tools in one batch run in parallel only when both conditions hold** — the tool is marked
  `parallelSafe`, and the agent's `approval_required` list does not name it
  (`llm/executor/tool-batching.ts`). Everything else runs one at a time, in the order the model
  asked. Two tools writing the same file at once is a race the model did not intend, and a
  gated tool inside a parallel group would stop for a human while its siblings ran — the
  approval fields `ToolCaller` reports are only safe to read after a group because no gated call
  ever joins one. Never widen `canParallelise` without reading why the second condition is there.
- **Text produced alongside tool calls is kept.** If the iteration cap hits next, it is the
  only thing there is to show the user.
- **That text is also the opening line, said at once.** A step that returns words *and* tool calls hands the
  words to `ExecutorDeps.onPreamble`, awaited before its tools run, so the line lands above the progress
  bubble. `pipeline/preamble.ts` decides whether it reaches the chat: a chat turn's first one always, a later one
  only two minutes after the last sent, never for a system event, and never again as the final reply. Plain
  sends, because WhatsApp cannot edit — an eight-minute turn there used to be eight minutes of silence.
- **At the cap, one final call with tools withheld.** Withholding is what makes it terminate:
  offered the tools again, a model in a loop asks for them again. Without this the user gets
  silence from a turn that did plenty of work.
- **Streaming accumulates; it does not deliver partials.** Editing a chat message per token
  flickers and hits rate limits (§6.5 SPEC). The reason to stream at all is that a long turn
  keeps the connection warm and the typing indicator honest — refreshed every 5s from inside
  the turn, so it survives across tool calls.
- **The session is persisted before the reply is sent.** If the send fails, the agent still
  remembers what it said, which is far less confusing than a reply the user saw and the agent
  has no record of.

`req.model` overrides the agent's configured model for one chat (`/model`). It has to be
threaded into the prompt, the context budget *and* every provider call — a partial override
means the window is computed for one model and the request sent to another.

---

## Work that outlives its turn

Three things a turn starts can go on after it ends, and all three are rows of `jobs`, stopped by `nouride jobs kill`,
bounded by `[security] job_max_ms`, closed as interrupted by a restart, and reported by waking the agent in the chat
they came from through one road, `pipeline/job-wakes.ts` — after the turn the agent is in there, counted in the chain
of wake-ups with no person in it (`[agents] job_wake_max_chain`):

- a command, `exec` with `background: true`;
- a helper, `delegate` with `background: true` (0.7.15, `pipeline/background-helper.ts`);
- another agent's turn an `ask_agent` moved there (0.7.19, `pipeline/background-ask.ts`): the ask waits up to
  `ASK_WAIT_MS` (a minute), then the peer turn is adopted by a job of the *asking* agent's — its limit, its `/stop`,
  its chat — and stops following the asking turn's signal. Its answer wakes the asking agent, never the asked one, with
  what it answers (`jobs/ask-wake-text.ts`).

Helpers and asks share one limit, `[delegate] max_background`, counted by `JobStore.backgroundTurns`. Only a turn whose
toolset was resolved with that limit above 0 may move work behind itself: a helper's, a peer's and a scheduled turn are
resolved with `backgroundHelpers: () => 0`, so their `delegate` has no `background` and their `ask_agent` is the
waiting variant (`waitingAsk`). That is the rule against ping-pong — keep it one rule: a new kind of turn that should
not leave work behind resolves its toolset the same way.

## Sessions

Keyed by `(agentId, chatId, gatewayId)`, id derived from the key so a restart reattaches
without a lookup table. The messages are rows of `session_messages`, one each, since 0.7.12 (E2).
They were one JSON column, on the argument that a conversation is always read and written whole —
true of reading it, but writing it whole rewrote the entire history every turn, which on an SD
card was most of what a turn wrote. Callers still hand `SessionStore.save` the whole
conversation; `planKeep` decides which stored rows are unchanged (by a hash read without the
message), and only the rest is written. A test holds a turn on a 300 KB conversation to a few
pages of WAL (`tests/storage/session-messages.test.ts`) — keep it passing when touching `save`.

A message that cannot be read starts a fresh conversation and logs it, rather than throwing —
and not by skipping that one message, which could leave a tool result without its call: a
request Anthropic refuses. Losing history is bad; an agent that can never answer in that chat
again, fixable only with a SQL client, is worse.

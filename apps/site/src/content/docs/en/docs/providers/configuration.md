---
title: Provider profiles
description: A profile is an endpoint, not a vendor, and one credential can serve several.
---

The unit of LLM configuration is the **endpoint**: a wire format, a base URL, and a credential.

```toml
[providers.nougate-anthropic]
kind = "anthropic"                                     # which wire format, not which company
base_url = "https://nougate.nouverse.tech/anthropic/v1"
api_key = "nougate"                                    # a secret NAME, never the value

[providers.nougate-openai]
kind = "openai"
base_url = "https://nougate.nouverse.tech/openai/v1"
api_key = "nougate"                                    # the same credential
```

An agent then says `provider = "nougate-anthropic"`, and moving it to a different deployment is a
one-word change.

The earlier shape, one environment variable per vendor (`ANTHROPIC_API_KEY` and `OPENAI_API_KEY`),
could not express this at all. A credential belongs to a **base URL**, and one gateway key serves both
of its protocol endpoints. Naming the secret once and referencing it twice says exactly that.

## `kind` is only the wire format

Two values, and neither of them names a company:

| | |
|---|---|
| `anthropic` | the Anthropic Messages API shape |
| `openai` | the OpenAI Chat Completions shape |

The model behind `antigravity:claude-sonnet-4-6` on an OpenAI-shaped endpoint is Claude, and nothing
in the engine needs to care. A proxy can serve either format.

## Common profiles

```toml
[providers.anthropic]
kind = "anthropic"
base_url = "https://api.anthropic.com/v1"
api_key = "anthropic_api_key"
identify = true                              # written for the two vendors' own APIs; see below

[providers.openai]
kind = "openai"
base_url = "https://api.openai.com/v1"
api_key = "openai_api_key"
max_tokens_field = "max_completion_tokens"   # OpenAI's own API only; see below
identify = true

[providers.openrouter]
kind = "openai"
base_url = "https://openrouter.ai/api/v1"
api_key = "openrouter"
headers = { "HTTP-Referer" = "https://nouverse.tech" }

# Anything that speaks the OpenAI shape on your own network.
[providers.ollama]
kind = "openai"
base_url = "http://127.0.0.1:11434/v1"
api_key = "ollama"
```

`headers` is for literal, non-secret headers. They are sent as written and stay readable in the
config, so a credential belongs in `api_key` (a secret name), not here. (A per-agent MCP server's
`headers` are checked and refused if a value looks like a credential; a provider profile's are not.)

`identify = true` says which agent and conversation each request is for: `user`, `prompt_cache_key` and an
`x-client-id` header on the OpenAI wire, `metadata.user_id` on Anthropic's. A gateway such as Nougate tells
its clients and sessions apart by them, and OpenAI sends a conversation's requests to the cache its prefix is
already in. It is off unless set, because a strict server rejects a field it does not know.

OpenAI's own API and Anthropic's own API take those fields, so you do not need to write it for them: setup, the
dashboard and `nouride provider add` write `identify = true` for a profile on `https://api.openai.com/v1` or
`https://api.anthropic.com/v1`, and the first start after an update writes it into a profile made before, once, and
says so in the log. `nouride config check` says when the next start will write it. To keep it off, write
`identify = false`: a profile that says `identify` either way keeps what it says. Any other server stays as you
configured it, Nougate included, where you turn it on yourself.

What is sent names no person. The agent goes by its id, as you named it in its pack. The conversation goes as an
opaque id, 32 letters and digits made from the conversation's own id by a one-way hash, the same on every request of
that conversation: it holds no chat id, phone number, username or name.

`max_tokens_field` is the field a reply's output limit is sent in, on the OpenAI wire. OpenAI's own API refuses
`max_tokens` for its newer models (the GPT-5 family among them) with `Unsupported parameter: 'max_tokens'`, and
takes `max_completion_tokens` for every chat model. Other servers that speak the same shape (OpenRouter,
Ollama, vLLM, llama.cpp, Nougate) may only know `max_tokens`, which is what is sent when the key is left out. You do
not need to write it yourself: setup, the dashboard and `nouride provider add` write `max_tokens_field =
"max_completion_tokens"` for a profile on `https://api.openai.com/v1`, and the first start after an update writes it
into a profile made before, once, and says so in the log. A profile that already says `max_tokens_field` either way
keeps what it says. `nouride config check` lists a profile whose limit goes in `max_completion_tokens`, and says when
the next start will write the key. The Anthropic wire has one field, `max_tokens`, so an Anthropic profile that asks
for `max_completion_tokens` does not load.

`cache_minutes` is how long the endpoint keeps a conversation's cached prompt after its last request. Nouride clears
old tool output from a conversation's history when that costs nothing, and one such moment is when the conversation
has been idle for longer than its endpoint keeps a cache: the next request would be read in full anyway. A profile on
`https://api.anthropic.com/v1` is read as `cache_minutes = 5` without your writing it, which is the lifetime Anthropic
documents for the kind of cache Nouride asks for. Every other endpoint is read as `60` unless you set the key: taking a
cache for alive when it is gone only leaves old output in place a while longer, and the other way round would throw
away a cache you are paying less to read. OpenAI's own API is among those, since it documents lifetimes from a few
minutes to a day depending on the model and the organization's settings. Set `cache_minutes` where you know better;
`0` is for an endpoint that caches nothing.

## Managing them

From the dashboard: **Models** (admin only), endpoint, wire format, credential. Or:

```bash
nouride provider                                       # profiles, and which have a credential
nouride provider add nougate-anthropic --kind anthropic \
  --url https://nougate.nouverse.tech/anthropic/v1 --stdin
nouride provider rm nougate-anthropic
```

![The Models page: each provider profile, the name of its credential and the agents using it](/media/dashboard-models.png)

The key is read from stdin rather than taken as an argument. A key on a command line lands in shell
history, in `ps` output, and in any CI log that echoes its commands.

`add` tries the endpoint with the key first and refuses to write a profile that does not answer;
`--no-probe` writes it anyway, for an endpoint that is not up yet. Both the CLI and the dashboard
store a new profile's key as `<profile>_api_key`. To share one credential between two profiles, as at
the top of this page, point the second profile's `api_key` at the first one's secret in
`config.toml`.

A profile still named by an agent cannot be removed: the agent would load and then fail on its first
message.

## Defaults, and per-agent overrides

```toml
[llm.defaults]
provider = "nougate-anthropic"
model = "claude-sonnet-4-20250514"
max_tokens = 8192
temperature = 0.7
```

One agent overrides any of it in its own pack:

```toml
# .nouride/agents/nouva/config.toml
[llm]
provider = "nougate-anthropic"
model = "claude-sonnet-4-20250514"
max_tokens = 8192
temperature = 0.7
# context_window = 200000      # only when Nouride does not know this model's window
# fallbacks = [                                    # who answers when the model above cannot, in order
#   { provider = "nougate", model = "antigravity:gemini-3-flash" },
#   { provider = "ollama-local", model = "qwen3:8b" },
# ]
# effort = "medium"            # how long a thinking model thinks: low, medium, high, xhigh, max
```

And one *conversation* overrides it again with `/model`, which is scoped to that chat, not to the
agent, and kept through a restart until `/model default` or `/reset`.

**`fallbacks` answer when the agent's model cannot**: a list, each a provider and a model on it, because
a model's name means nothing on another provider. After the provider's own retries, the turn is asked of
the next pair, in order, and stays on the one that answered for the rest of that turn; the chat's
progress line says so, and its usage is charged to that provider. Another model on the same provider
answers a rate limit, an overloaded provider or a model that is not served; another provider also
answers one that is down, out of credit or refusing its key. A provider counts as down when it cannot
be reached (the connection refused, no answer in time, a stream that dropped before its reply began),
and only another provider answers that. A stream that drops before its reply began is first asked
once more of the same model, since nothing was shown and nothing ran; the fallback answers if it drops
again. A stream that drops once the reply has begun is not asked again or fallen back on: part of the
answer has already been written. The call that closes a turn, the reply written when it
has to stop calling tools, falls back like the others. A refused request is never retried on a
fallback: any model would get the same answer. `[llm.defaults] fallbacks` is the list for every agent
that names none, and the agent's **Model** tab in the dashboard edits its own. The operator hears of an
outage once, not once a turn. 0.8.0 rewrote a pack's 0.7 `fallback_model` at its first boot into one
pair on its own provider; a pack that says `fallback_model` again is refused for that agent, naming the
`fallbacks` line to write.

**`effort` is how long a thinking model thinks before it answers**: `low`, `medium`, `high`, `xhigh` or
`max`, sent as `output_config.effort` to an Anthropic profile and as `reasoning_effort` to an
OpenAI-compatible one. Unset, each provider's default stands. It is worth setting for a chat agent: Claude
Sonnet 5.5 at its default thinks for about twenty seconds before a short answer, and nothing appears while
it does; at `medium` the answer starts in about two. `[llm.defaults] effort` sets it for every agent, and an
agent's own `[llm] effort` wins; the agent's **Model** tab in the dashboard chooses its own. A value that is not one
of the five refuses to start. A model that does not
take it (one that does not reason, an older Claude, a level its endpoint does not know) is asked again
without it and sent none from then on; the log says so once. `/effort high` in a chat sets that chat's own level over
the agent's, and a refusal of that level is said in the chat too, once, under the answer.

An agent on a coding CLI (Claude Code, Codex) gets the same `effort`, set on its CLI where the CLI offers that level
for its model; where it does not, the CLI keeps its own. You need not edit the file: choose it on the agent's **CLI**
tab in the dashboard, or ask the agent ("think at xhigh") and it sets its own with `agent_configure`, which asks you
first like any change to its config, unless the agent's approvals are `trusted`. **Default** follows
`[llm.defaults] effort`.

**The context window comes from the gateway when it says, else from the model id.** An endpoint whose
`/models` listing states a model's window (Nougate's `context_window`, OpenRouter's `context_length`,
vLLM's `max_model_len`) is believed, from its last listing: it is asked when the daemon starts and
then at most hourly, and no turn waits for it. Otherwise the model id is looked up in a table of
families, a gateway's prefix ignored, so `antigravity:claude-sonnet-4-6` is looked up as
`claude-sonnet-4-6`. A model nothing knows is assumed to have 32k, and its history is trimmed far harder
than it needs to be; the log says so once per model. `context_window` in the agent's `[llm]` is the fix,
and wins over both.

A route can also allow less than the table says: the same model behind another account or plan. When the provider
answers that a request is past its window, the turn is asked once more with the older half of what was sent left out,
and answers from what is left. An overflow on every turn of a long conversation is a window set too high: put the
route's real one in `context_window`.

**Model versus Models** is a real distinction. A profile is infrastructure, defined once and shared;
a model is one agent's choice within it. That is what lets one agent move without touching the
others.

## Budgets and limits

```toml
[llm.limits]
max_tokens_per_turn   = 32000
max_tool_iterations   = 250
max_turn_duration_ms  = 3600000
max_daily_cost_usd    = 0        # 0 = off
max_daily_tokens      = 0        # 0 = off
cost_alert_threshold_pct = 80
```

Two ceilings. Both are checked before the provider is called, and whichever is reached first refuses
the turn.

`max_daily_cost_usd` can only see models that are in the price book: the models Anthropic, OpenAI
and Google list on their pricing pages, by exact id, at the prices those pages gave on the day each
row names. A model they do not list (one released since, a preview, a self-hosted model) is
unpriced, and a daemon pointed at a self-hosted gateway may have no priced calls at all, so there
the dollar cap is not a partial measure, it is nothing.

A provider profile can say its calls are a subscription: `billing = "included"`, as Nougate's OAuth
accounts are. Those cost nothing per token: they are left out of `max_daily_cost_usd`, still counted
by `max_daily_tokens`, and shown as included rather than as list-price spend.

`max_daily_tokens` counts input and output together across every model, priced or not: every model
call is metered (a turn's own, and the compaction, reflection, image reading and embeddings it
causes), and a provider that reports no usage is estimated, never read as zero. Past either cap, the
work nobody waits on stops too. **If you set only one, set this one.**

Before a cap stops anything, the operator hears of it twice a day at most: once past
`cost_alert_threshold_pct`, once past 95%, each naming the agents and models that spent the most of
the day, not again after a restart.

Usage and cost are recorded per turn and the dashboard shows today's spend against the cap, using
the same number the enforcement uses.

## Context: compaction rather than truncation

```toml
[llm.context]
max_context_ratio     = 0.8
truncation_strategy   = "summary"     # summary | sliding_window
preserve_recent_turns = 4
compact_at_ratio      = 0.8
# compact_at_tokens   = 160000        # unset: each model has its own
preserve_recent_tool_results = 3
# summary_model = "claude-haiku-4-5-20251001"
```

`sliding_window` drops the oldest turns. Correct for fitting, wrong for remembering: an agent an hour
into a job has no record of what it already did, so it repeats a step or reports success for one it
cannot see.

`summary`, the default, replaces those turns with one compacted note and keeps it. It costs one
provider call per compaction, not one per turn, and nothing happens at all until history crosses
`compact_at_ratio`. A summary that fails or comes back empty leaves the history untouched and
truncation proceeds exactly as `sliding_window` would, so the downside is bounded at the old
behaviour.

The summary is written by `summary_model`, on the agent's own provider. Unset, it is written by the
helper model (`[memory] pass_model`, the **Helper model** card in Knowledge & Memory → Settings) when that is set,
else by the agent's own model. That card also says whether summarizing has failed in the last 24 hours.

**`compact_at_tokens` is a flat ceiling on the whole request, prompt and tools included, and the
threshold is the lower of it and the ratio.** Unset, each model gets its own: 200k for Gemini 3 Flash
and later, 160k for the rest. An agent's `[llm] compact_at_tokens` beats both.

The ceiling exists because a ratio scales with the window: on a million-token model the ratio put
compaction near 610k, so a 426k-token chat never compacted once and every iteration of a turn resent
all of it, 12M input tokens for one reply, and the turn died on its deadline (five minutes then) while
it was still making progress. A window says what a model *can* read; it was never a claim about what
it should carry to answer well.

`preserve_recent_tool_results` is the same idea inside a single turn. Trimming replaces the
*content*; the message itself always stays, because an orphaned tool call is rejected outright by
Anthropic. What is cleared is not lost: the whole output is first written to the conversation's
`data/tool-output/` directory (kept as long as `[retention] tool_output_days`), and the marker names
that file, so the agent opens it with `read` instead of running the command again.

Once a turn is over the line, old results are cleared in one go, down to well under it, and the steps
after that clear nothing until the turn has grown back. Clearing one result a step would change the
start of the conversation at every step, and a provider's prompt cache would read nothing back.

When clearing old results is not enough, the text old `write`, `edit` and `multi_edit` calls carried
goes next, oldest first: the call stays with its path and its result, and the text becomes a line
saying how big it was, that the call ran, and to read the file for what it holds now. The calls of
the latest step are never shortened. Without this a long coding turn carried every file it wrote until the window was full.

And when the steps themselves fill the window, with nothing left in them to clear (from 0.8.37), the turn's oldest
steps are summed up by the same summarizer, and the turn goes on from its notes and its newest steps. Before, such a
turn ended on a full context. It starts at the line compaction starts at and makes room down to the line history is
trimmed to, so a long turn is asked for notes once in a while, not at every step. A call and its result leave
together, and the newest step always stays. If the summarizer fails, the turn's activity says so once and the turn
carries on as it was.

A tool's result is also made smaller by what it is before it enters the conversation: a terminal's colour codes are
taken out, a line a progress bar redrew is kept at its last state, three or more identical lines become one counted
`[× N]`, and JSON loses the spaces between its parts. A diff and a file read with `read` are kept exactly. The whole
output goes to the same directory first, and the result's last line names it.

## Prompt caching

The system prompt is split where its **stability** changes, and marked so a provider can cache the
stable part:

| Tier | Holds | Changes when | Cached |
|---|---|---|---|
| `files` | identity, user, agents, skills, memory, what is remembered about the people in the chat | the pack or that memory changes | ✓ |
| `capability` | the harness block | the toolset or the exec posture changes | ✓ |
| `request` | the date, model, platform, who is speaking | the day, the model or the sender changes | ✗ |

The last tier never carries a marker of its own: it is the part that changes, and a cache entry
nobody reads again is a 25% surcharge rather than a saving. The time of day is not in the prompt at
all. It is on the message being answered, so the prompt does not change between requests just
because time passed.

On the Anthropic path the conversation gets a marker too, on its last block, and it moves forward with
every request. A turn's twentieth tool call then reads everything up to the nineteenth from the cache
and writes only what was added since.

**Order is load-bearing independently of the markers**, because an implicit prefix cache, which is
all the OpenAI path has, stops matching at the first byte that differs. Putting the harness before the
per-request block took the cache-eligible prefix from 5.0k tokens to ~8.0k on every request and on every one
of a turn's tool iterations.

## Streaming

```toml
[llm.streaming]
enabled = true               # accumulates the stream; partial replies are not sent
typing_indicator = true
progress_in_chat = true
```

`progress_in_chat` posts **one** message naming the tool the agent is running, edits it as the turn
progresses, and replaces it at the end with `✓ 4 steps · 12s`, on platforms that can edit a message.
One message and not one per step, because editing re-notifies nobody: a twenty-tool turn would
otherwise be twenty phone notifications. A turn that runs no tools posts nothing at all.

The same switch covers the agent's **opening line**, on every platform, including the ones that cannot
edit a message (WhatsApp). When the model writes a sentence beside its first tool call ("Okay, I'll go
through the 52 documents first"), that sentence is sent to the chat at once, as its own message, instead
of waiting for the turn to end. A later one goes out only when two minutes have passed since the last,
so long work gets an occasional status and not a running commentary; the rest stay in the conversation.
The final answer never repeats it. A question answered without tools is one message, as before, and a
background job's or a schedule's turn sends no opening line.

An agent a coding CLI answers (Claude Code, Codex) is the exception to the two minutes: what the CLI
writes between its steps goes to the chat as it is written, each its own message, the way its own
terminal shows it. Each time it does, the progress message so far closes on `✓ 3 steps · 20s` and the
steps after it start a new one below. A message you send while it works gets its own answer, before the
next one starts.

## Concurrency

```toml
[queue]
max_concurrent_per_agent = 1     # per chat. The loader refuses anything higher
max_concurrent_turns     = 8     # across every conversation. 0 lifts the ceiling
max_queue_depth          = 20
queue_timeout_ms         = 3600000
```

Per-chat concurrency is fixed at 1 and that is not a tuning decision: a conversation is stored as one
JSON document, so two turns at once in the same chat would both read it and both write the whole
thing back. The slower one wins and the other exchange is gone from the transcript with nothing
logged. Different chats already run in parallel with no setting.

`max_concurrent_turns` is the total. Without it, fifty active chats meant fifty simultaneous provider
calls, fifty times the spend per second, and a rate limit hit immediately. An agent's `delegate` helpers
and the agents it asks with `ask_agent` count toward it too: they use the turn's own slot, and another
only when one is free. On a busy daemon they run one after another rather than all at once. Helpers
and asks that work on in the background are bounded by `[delegate] max_background` instead.

`queue_timeout_ms` is matched to `max_turn_duration_ms` rather than picked on its own: a message
queued behind a turn has to outlive that turn, or one slow reply silently costs the next message. The
loader warns if it is the shorter of the two.

## When the provider fails

A request that fails for a reason waiting can fix is tried again for about half a minute: a rate
limit (429), an overload, a 5xx, a timeout, a dropped connection. That is six attempts, 1, 2, 4, 8 and
16 seconds apart. A wait the provider names (`Retry-After` or `retry-after-ms`) is honoured when it is
longer, up to a minute. A provider asking for longer than that has usually run out of quota, and
waiting would only hold the chat, so the request fails at once.

A provider that does not answer at all is tried twice, not six times, because each attempt can take
two minutes. Those two minutes are for the provider to start answering: a reply that has started
streams for as long as it needs, and is cut only when it goes quiet for a minute and a half. A
stream cut before any of its reply is asked again once, on the same model.
`/stop` or a shutdown during a wait stops the turn at once, and a `base_url` that is not a valid URL
fails at once: that is configuration, not a network blip.

If the provider is down for longer than that, the turn ends, keeps what it did, and says so:

> `…I'll try again in a few minutes, or say "continue".`

About three minutes later, plus up to a minute so a burst of failed chats spreads out, the daemon
tries the turn once more and carries on from where it stopped. It does not when someone has said
anything in that chat since, for a scheduled run, for a turn that was itself a second try, or for a
failure no wait fixes: an expired or refused key, an empty balance, a bad request. Those are yours
to fix. A restart within those minutes does not drop it: the daemon that comes back finds the turn by
what it told you, and tries it once, when the few minutes are up. "Continue" works too.

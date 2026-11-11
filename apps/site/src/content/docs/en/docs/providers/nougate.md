---
title: Nougate gateway
description: Nouverse's own LLM gateway, and the one case a per-vendor key could not express.
---

**Nougate** is Nouverse's LLM gateway. From Nouride's point of view a Nougate on the network is an
ordinary provider endpoint: there is no special integration, and nothing in the engine knows it is
not Anthropic.

It is worth its own page for one reason: it serves **both wire formats from one deployment under one
credential**, and that is the case a per-vendor `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` pair could not
describe.

```toml
[providers.nougate-anthropic]
kind = "anthropic"
base_url = "https://nougate.nouverse.tech/anthropic/v1"
api_key = "nougate"                 # a secret NAME → $NOUGATE

[providers.nougate-openai]
kind = "openai"
base_url = "https://nougate.nouverse.tech/openai/v1"
api_key = "nougate"                 # the same credential

[llm.defaults]
provider = "nougate-anthropic"
model = "antigravity:claude-sonnet-4-6"
```

Two profiles, one secret, named once and referenced twice.

Store the credential the same way as any other:

```bash
printf '%s' "$KEY" | nouride secret set nougate --stdin
```

## Model names

Nougate namespaces models by upstream, so a model name carries where it comes from:
`antigravity:claude-sonnet-4-6`. Nouride passes the string through untouched: `kind` decides the
request shape and nothing else, so the model behind an OpenAI-shaped endpoint can perfectly well be
Claude.

The prefix is set aside in one place only, sizing the context: the window is looked up for
`claude-sonnet-4-6`. A model Nouride has no window for is assumed to have 32k, so set
`context_window` in the agent's `[llm]` when that is wrong.
[Per-agent overrides →](/en/docs/providers/configuration/#defaults-and-per-agent-overrides)

## Who asked, and who answered

With `identify = true` on the profile, each request says which agent and which conversation it is for, so
six agents behind one key are six clients in Nougate's cost reports, not one. On the OpenAI wire it also sends
`prompt_cache_key`, which a provider that routes by it uses to keep a conversation on the cache its prefix is
already in. The usage card on the dashboard's home shows each profile's cached share, and says when one caches far
below another for the same model.
[Configuration →](/en/docs/providers/configuration/)

Claude caches only up to a marker, and a request on the OpenAI wire cannot carry one, so Nougate places them (since
Nouride 0.8.17): on the last tool, the system prompt and the two newest messages. An agent's next step reads back
what the last one sent, as on the Anthropic wire. Whichever wire it answers on, the cache read is reported where
that wire's clients read it.

Nougate answers in kind on every response: `x-nougate-provider` (the provider that served), `x-nougate-model`
(the model as that provider names it) and `x-nougate-attempts` (how many providers it tried, `1` unless it
failed over). A model name with a prefix goes to that provider alone; a bare one may be served by any provider
that has it. Nouride keeps the three with the call's usage, and `nouride turns show` prints them beside each
call: `via antigravity`, or `via copilot, 2 tried` after a failover.

When no provider answered at all, Nougate's error still says which it tried, in order, in `x-nougate-tried`
(with `x-nougate-attempts`). A turn that fails on it records them in its error, `(through nougate, tried
antigravity, claudecode)`, for whoever reads the turn; the chat is told only that the model is not responding.

## Running it inside the daemon

Nougate is normally a separate service reached over HTTP. Every Nouride install also carries it inside
the daemon, on its own port, `18256`, and it stays off until you ask for it. Choosing it in setup, or
**Turn on Nougate** on the dashboard's **LLM Gateway** page (under Settings), starts it at once, without a restart, and keeps it on
from then on. **Turn off** on the same page names the agents that stop answering, then restarts Nouride once nothing is
running; where nothing would start Nouride again, it is saved and stops at the next start.

**No API key needed to start.** The setup wizard's first step still takes an API key, and under it
offers **Use Nougate**: sign in to an account you already have, one of Claude (Pro or Max),
ChatGPT (through Codex), GitHub Copilot, Google Gemini (through Antigravity) or Kiro, and the daemon
connects itself to the gateway with a key it mints and never shows you. The agent step then lists the
models those accounts can serve. Claude, ChatGPT and Gemini sign in by OAuth: the tab you approve in
ends on a `localhost` page that does not load, and you paste its address back. Copilot and Kiro give
you a short code to enter on their site, and the wizard finishes by itself.

**Models come from the accounts.** Nougate asks each provider which models it serves: when it starts, when an
account is added, and every six hours. A model the provider releases shows up in the agent's model list without an
update of Nouride, and one it retires leaves. The last list is kept on disk, so a restart or an outage of the
provider does not empty the list. A provider with no account signed in lists no models.

**One dashboard.** After setup the gateway is the **LLM Gateway** page in the Nouride dashboard, for
admins: accounts, gateway keys, usage and cost, the playground, custom providers. It opens with your
Nouride sign-in; there is no second password. Since 0.7.10 port `18256` takes gateway keys only: its
own console there no longer signs anyone in, so the password the daemon lent it at first start does
not outlive the one you changed. The exception is a dashboard that cannot show the page (the
dashboard switched off, or a gateway bundle from before 2026-10-15), where the console on `18256`
(`/frontend/`) keeps its own login, the username and password the daemon printed at first start or
your `INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD`. The gateway
binds to the address in `HOST`, loopback unless you set it, so other tools on your network reach its
API only when you set it wider.

The wizard writes the profile for you. To point another profile at it by hand:

```toml
[providers.local-gateway]
kind = "anthropic"
base_url = "http://127.0.0.1:18256/anthropic/v1"
api_key = "nougate"
```

The switch on the page writes `[nougate] in_process` in `.nouride/config.toml`; to move the port, edit the same
table. `NOUGATE_IN_PROCESS=true` or `false` in `.env` decides it for the server, and the page then shows the
switch as set there. A build without the gateway (one compiled from the public source alone) does not offer
it, and turning it on there stops the daemon at boot, with a sentence saying this build does not carry it:

```toml
[nougate]
in_process = false
port = 18256
```

**What it buys** is measured: a separate gateway process costs 44.6 MB, and bundling it costs the
daemon 6.0 MB, a saving of 38.6 MB. Almost all of that is a second copy of the Bun runtime, which a
process cannot share and a listener does not need. The gateway's own code is 0.3 MB of its 79.0 MB
binary.

**What it costs** is +0.4 MB of binary and one crash domain: a bug in the gateway is then one stack
frame from the agent loop.

Nothing else changes. A gateway hosted here is addressed by a provider profile's `base_url` exactly
like a remote one, so `in_process = false` puts it back with no code change.

[Build variants and their measured costs →](/en/docs/deployment/binaries/)

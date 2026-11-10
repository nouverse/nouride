---
title: Configuration
description: Every section of config.toml, what it controls, and the environment variables that override it.
---

Two files, and the split is strict.

| | |
|---|---|
| **`.nouride/config.toml`** | everything structural. Safe to commit, print and render in a browser |
| **`.env`** | credentials and per-host values. `0600` |

**No credentials in `config.toml`.** Where one is needed, the setting names a **secret**, and the
value is resolved from the environment or the secret store at the moment it is used:

```
api_key = "nougate"   →   $NOUGATE
                      →   $NOURIDE_SECRET_NOUGATE
                      →   data/secrets.enc
```

Environment wins over the store, so a container platform can always pin a value. The store is what
the dashboard writes to, which is why adding a bot token does not need a redeploy.

**Every value in `config.example.toml` matches a built-in default**, so a missing file boots the same
daemon. Delete anything you are not changing. The keys almost nobody changes are left out of it and of the
blocks below; they are listed once, under [Advanced settings](#advanced-settings).

```bash
nouride config check [file]       # would this configuration start? Nothing is launched
nouride config schema [section]   # every valid key, as JSON Schema
nouride config explain <path>     # e.g. security.web.search_endpoint
```

An annotated copy ships beside the binary as `config.example.toml`, with the reasons behind every key
in it; this page is the map.

---

## `[daemon]`

```toml
name = "nouride"
log_level = "info"                  # debug | info | warn | error
data_dir = "./.nouride/data"
agents_dir = "./.nouride/agents"
workspace_dir = "./.nouride/workspace"
timezone = "UTC"
backup_keep = 4
# backup_dir = "/mnt/usb/nouride"
# backup_seal = "nrseal1:…"         # written by `nouride secret seal`, never by hand
# orchestrator = "nouva"
```

Three paths rather than one root, because the three hold different kinds of thing: daemon state,
identity worth committing, and output that can grow large. `workspace_dir` on another disk is a
supported arrangement.

`backup_keep` is how many snapshots are kept of each of five things, taken at boot and then weekly:
the persona packs (`data/backups/agents/`), the database (`data/backups/db/`), the memory vault
(`data/backups/memory/`) and, since 0.8.18, `config.toml` with the people and the MCP library
(`data/backups/config/`) and the skill pool (`data/backups/skills/`). Each skips its boot snapshot while the newest
is under a week old. All of them sit on the same disk as what they protect, unless `backup_dir` names another: a
directory on that disk, which is never created, so a USB drive left unplugged means snapshots are
skipped and logged, not written onto the card under the empty mount point. A snapshot taken right
before a migration or a vault tidy stays under `data/backups/` either way.

`backup_seal` (0.8.18) puts the secret store into the config snapshots, sealed to a passphrase. `nouride secret seal
--stdin`, or the backup password on the dashboard's Secrets page, sets it: the line holds a salt and the public half
of a key the passphrase derives, never the passphrase, so the daemon seals each snapshot's `secrets.sealed`, and since
0.8.19 the copy beside the store at each change, and can open none of them. Only the passphrase opens one, with
`nouride secret unseal`, or `nouride secret restore` to put the secrets back. Without it no snapshot holds a secret,
and a box rebuilt from one needs every credential set again. A value the command did not write is refused at load.

`orchestrator` (`default_agent` before 0.7.18, refused since 0.8.0) answers when a message
mentions nobody, arrives on a gateway with no owner, and matches no channel binding. It is also the front desk of a
room several of our bots share: a message there that tags, names or replies to nobody (which every bot gets a copy of)
is answered by it alone, once, through its own bot, unless the room requires a mention (`groups_require_mention`, or
`/mention on` in that group). A message that addresses someone routes exactly as before, and DMs are unaffected. The
first agent you make becomes it.

`groups_require_mention` is about groups on Telegram, Discord and WhatsApp. A room you make in the dashboard answers as
its members say: the orchestrator when it is in the room, or the room's only agent, and otherwise nobody. Only
`/mention on` in that room makes it wait for a tag.

## `[agents]`

```toml
mentions_enabled = true
nudge_after_minutes = 5
groups_require_mention = false
group_context_messages = 20
```

[What each of these does in practice →](/en/docs/manual/chatting/)

## `[providers.<name>]`

```toml
[providers.nougate-anthropic]
kind = "anthropic"                  # the wire format, not the vendor
base_url = "https://nougate.nouverse.tech/anthropic/v1"
api_key = "nougate"                 # a secret NAME
# headers = { "HTTP-Referer" = "https://nouverse.tech" }
# identify = true                   # say which agent and conversation each request is for
# billing = "included"              # a subscription: no cost per token
# max_tokens_field = "max_completion_tokens"   # OpenAI's own API: where a reply's output limit goes
# cache_minutes = 5                 # how long this endpoint keeps a conversation's cached prompt
```

`max_tokens_field` is for `kind = "openai"`: `max_tokens` when it is left out, or `max_completion_tokens`, which
OpenAI's own API needs for its newer models. Setup writes it for a profile on `https://api.openai.com/v1`, and the first
start after an update adds it to one made before. Leave it out for any other server.

`cache_minutes` is how long the endpoint keeps a conversation's cached prompt after its last request, in whole
minutes. A conversation that has been idle for longer has lost its cache, so that is when old tool output is cleared
from its history: the rewrite costs nothing then. Left out, a profile on `https://api.anthropic.com/v1` is read as `5`,
the lifetime Anthropic documents, and any other as `60`. Set it where you know your endpoint's; `0` is for one that
caches nothing. `nouride config check` shows the figure in force for each profile that has one.

No profiles exist by default. The setup wizard, the dashboard or this file creates the first one,
and `[llm.defaults] provider` stays empty until then.
[Provider profiles →](/en/docs/providers/configuration/)

## `[gateways.<platform>.<name>]`

```toml
[gateways.telegram.nouva]
enabled = true
token = "telegram-nouva"            # a secret NAME
agent = "nouva"
mode = "polling"                    # or leave it out; "webhook" is refused
# groups_require_mention = true     # this connection's own [agents] setting
# group_context_messages = 20       # likewise

[gateways.discord.main]
enabled = true
token = "discord-main"

[gateways.discord.main.cache]
messages = 0                        # per channel
users = 0                           # global
members = 0                         # per guild

[gateways.whatsapp.main]
enabled = false
encryption_key = "wa-encryption-key"
# session_dir = "..."               # optional; unset: <data_dir>/whatsapp
```

None are defined by default, so a fresh install brings up the dashboard and nothing else rather than
retry-looping against a platform it has no token for. [Gateways →](/en/docs/gateways/overview/)

## `[security]`

```toml
approvals = "balanced"                 # careful | balanced | trusted
# model_guard = "off"                 # the second look: unset follows the level; "off" | a tier | a model id
tool_timeout_ms = 30000
approval_timeout_ms = 300000        # unanswered requests expire as DENIALS
max_conversation_turns = 200
job_max_ms = 0                      # stop a background job still running after this; 0 = never
```

`job_max_ms` counts from a job's start, and a service (`service: true`) is exempt: the agent decides
what is one, so this stops a runaway rather than drawing a boundary. At most 2147483647 (about 24 days).

## `[security.access]`

```toml
mode = "pair"                       # pair | allowlist | open
allowlist = []
```

:::caution
The daemon **refuses to start** when a chat gateway is enabled, an agent holds `exec` and `mode` is
`"open"`, whatever `allowlist` holds, since `open` lets everyone in before the list is read. That
combination is a remote shell for anyone who finds the bot. `pair`, the default, is enough to avoid it.
:::

`[security] sender_allowlist`, the allowlist's old name, is refused since 0.8.0, naming `allowlist`.

[Who may talk to it →](/en/docs/manual/access/)

## `[security.exec]`

```toml
landlock = "auto"                   # auto | require | off: Landlock on each agent's own user, where the kernel has it
blocked = []                        # your own veto: refused before anything else, at every level
max_memory_mb = 0                   # 0 = unlimited. Linux only, via prlimit; background jobs too
max_cpu_seconds = 0                 # a service is spared this one: a server spends it by running
```

What asks is `[security] approvals` (`careful`, `balanced` or `trusted`) over one fixed list. `mode`, `ask`,
`ask_fallback`, `sensitive_paths` and `allowlist` went into it in 0.8.0: a file that still writes one starts with a
warning naming it, and `mode = "deny"`, `mode = "allowlist"`, `ask = "always"` and `sensitive_paths = "hardline"` are
refused, each naming what to write instead.

[Approvals & permissions →](/en/docs/manual/approvals/)

## `[security.web]`

```toml
allow_private_urls = false
search_kind = "brave"               # brave | searxng | exa
search_api_key = "brave_search_api_key"
search_endpoint = ""
fallback_enabled = true
fallback_backends = ["duckduckgo"]  # the keyless chain, also used when no API key is set
```

## `[security.rate_limit]`

```toml
messages_per_minute = 10            # per sender, per gateway
```

## `[media]`

```toml
image_model = ""                    # empty = the image goes to the agent's own model, as a picture; or a tier: "small"
read_images = true                  # sent in a chat, opened with `read`, or returned by an MCP server
read_audio = true
audio_input = "auto"                # auto | always
max_audio_seconds = 600
transcribe_provider = ""            # a profile with /audio/transcriptions; empty = no transcription
transcribe_model = "whisper-1"
```

**An image attached to a message is sent to the agent's model as an image.** Not a description of
one, the actual pixels, so the agent sees the layout, the colours and where two things overlap.
It costs nothing extra: no second model call, no round trip, and the transcript stores a pointer to
the file rather than the picture, so a screenshot from last week is not re-uploaded on every turn.

Setting `image_model` switches that off and restores the older behaviour: the image goes to *that*
model, which answers in text, and the text is what the agent gets. Two good reasons to want it, 
the conversation model cannot see, or it can and something cheaper should do the looking.

:::caution[A description has no coordinates]
That is the trade, and it is worth knowing before making it. "What does this error say?" survives
being turned into prose. "Why do these two elements overlap?" does not, the answer is in positions
and sizes, and those are exactly what the prose leaves out.
:::

**A voice note goes to the model as sound**, but only to a model known to hear. `auto` trusts the
gateway's model list (Nougate says which of its models hear); `always` vouches for a provider that
hears without saying so, and sends mp3, which needs ffmpeg on this machine. For a model that cannot
hear, `transcribe_provider` turns the clip into text first: OpenAI, Groq, or a Whisper server of your
own. Left empty, the agent says it could not listen.

Documents are **not** sent to a model at all. They land in the agent's workspace and it opens them
with `read` or a command, so a PDF costs nothing until the agent looks.

## `[alerts]`

```toml
gateway = ""                        # e.g. "telegram:nouva"
chat_id = ""
```

Where the daemon reports on *itself*, a gateway that gave up reconnecting, a session that needs
relinking. Boot, `nouride doctor` and `nouride config check` warn while it is empty.

## `[dashboard]`

```toml
[dashboard]
enabled = true
host = "127.0.0.1"                  # $HOST overrides. The container image sets 0.0.0.0
port = @@PORT@@                     # $PORT overrides
public_url = ""                     # empty rather than a guess. Links in a chat are built from it
password_login = true               # off only when [dashboard.oauth] is configured

# [dashboard.oauth]                 # Nouverse sign-in. Read only by the Pro edition
# issuer = ""
# client_id = ""
# secret_name = ""
# label = "Nouverse"
```

## `[llm.defaults]`, `[llm.limits]`, `[llm.context]`

```toml
[llm.defaults]
provider = ""
model = ""                          # the default tier
# small_model = ""                  # the small tier; unset, it is `model`
# high_model = ""                   # the high tier; unset, it is `model`
max_tokens = 0                      # 0 = by model: 32000 for Claude 4/5, Gemini 2.5/3, GPT-5; else 8192
temperature = 0.7
# fallbacks = []                   # who answers when an agent's model cannot: [{ provider, model }], in order

[llm.limits]
max_tokens_per_turn = 32000
max_tool_iterations = 250
max_turn_duration_ms = 3600000
max_daily_cost_usd = 0              # 0 = off
max_daily_tokens = 0                # 0 = off. Applies to every model, priced or not
cost_alert_threshold_pct = 80

[llm.context]
# compact_at_tokens = 160000        # unset: each model's own figure, 200k on Gemini Flash, 160k others
# summary_model = "small"           # a model, or a tier's name; unset: [memory] pass_model, else the agent's own
```

[What each does, and why →](/en/docs/providers/configuration/)

### Three model tiers

`model` is the default for everything. Beside it, `small_model` and `high_model` name a cheaper model and a stronger
one, both optional, and unset each is `model`, so an install that never writes them behaves as before.

An agent picks a tier for the work it hands off: `delegate` and `ask_agent` take `tier = "small" | "default" |
"high"`, and leaving it out is `default`. Its prompt names the three, what each is for and how they compare in cost
(in words, never in money, which Nouride does not know) and which models they are on this agent. A helper runs on
the asking agent's model of that tier; an agent asked with `ask_agent` answers on its own.

A pack can name its own pair in its `[llm]`. Without one it inherits the install's while it runs on the install's
`provider` (a model id means nothing on another endpoint), and otherwise its tiers are its `model`. The dashboard
shows an agent's three on its Model tab, and the install's with each helper's on the Models page, behind its
**Model tiers** button.

Each helper key also takes a tier's name: `summary_model`, `[memory] pass_model`, `[media] image_model`,
`[skills.learning] model` and `[queue] steer_reply_model`. `summary_model = "small"` is each agent's own small model,
on its own provider; `pass_model = "small"` stands without `pass_provider`, which is refused beside a tier. Helpers
still default to each agent's own model until one is written: moving them to the cheap model is one word each, and
nothing moves by itself.

## `[queue]`

```toml
max_concurrent_turns = 8            # across every conversation. 0 lifts the ceiling
steer = true                        # a message sent mid-turn is read at its next step (a room: from whoever started it)
```

## `[attachments]` and `[retention]`

```toml
[attachments]
max_size_mb = 50                    # counted as the file arrives; each file has 30 s to download

[retention]
session_days = 30                   # the conversation, the files that belong to it, and an ended mission
audit_days = 30
job_log_days = 3
tool_output_days = 2
log_days = 3                        # the daemon's own log as the dashboard shows it
scratchpad_days = 3
```

How long a file is kept is **not** in `[attachments]`. It is `session_days`, the same window as the
transcript that mentions it, a file is part of what was said. It used to have its own key, seven
days against a thirty-day transcript, and the result was a conversation that mentioned a screenshot
for another twenty-three days after the screenshot was deleted.

`0` on any of these keeps everything: the off position, not "delete all".

## `[memory]` and `[rollover]`

```toml
[memory]
dir = "./.nouride/memory"
pass = false                        # the setup wizard's last step turns it on
pass_at = "01:00"
pass_per_night = 20                 # per agent; direct conversations first
pass_provider = ""                  # empty: each agent's own
pass_model = ""                     # a model on pass_provider, or a tier's name with pass_provider empty
max_attempts = 3
facts = "off"                       # auto | ask | off; a [[people]] entry's own `facts` wins
propose_shared = false              # let the pass propose shared.md entries, each waiting for you
prompt_recent = 3
recall = true                        # what is remembered goes into each prompt; a [[people]] entry's own recall wins
transcript_days = 180                # 0 keeps every transcript forever
archive = true

[memory.semantic]
enabled = false
provider = ""
model = ""
dimensions = 512

[mcp_server]                        # Nouride as an MCP server at /mcp
enabled = false

[rollover]
mode = "none"                       # none | daily | idle
at_hour = 4
idle_minutes = 360
```

`[rollover]` replaces 0.5's `[session_memory]`, which is refused since 0.8.0, naming `[rollover]`.
[Upgrading from an older version →](/en/docs/deployment/updating/#from-an-older-version)

[What this is for →](/en/docs/architecture/storage/#memory)

## People: `people/<key>.toml`

Since 0.8.18 each person is a file of their own beside `config.toml`, `people/alex.toml`, its name their key (set
once; their memory profile is `people/<key>.md` in the vault, a different folder):

```toml
[person]
name  = "Alex"
ids   = ["telegram:5550001111", "discord:214777"]  # their accounts, optional; a bare number is refused
notes = "Prefers short answers."
facts = "auto"                             # overrides [memory] facts for this person
recall = false                             # overrides [memory] recall: nothing about them in prompts
morning = "07:00"                          # their morning line, in [daemon] timezone; absent: none
morning_to = "telegram:5550001111"         # where it goes, one of their ids; absent: where they last wrote from
```

None by default. A key is lowercase letters and digits, words joined by `-`. An account is `platform:account`
whichever bot it writes to, and one written with the connection it came in on (`telegram:nouva:814` is
`telegram:814`) is refused. `morning` is a time of day, `HH:MM`, and `morning_to` one of their telegram, discord
or whatsapp `ids`. A file that does not load (not TOML, an account another person's file already holds, a bad
time) is named in the log and that person left out; the daemon starts. The People page, the CLI and the agents
write these files, each keeping its last versions as `<key>.toml.bak.N`, and a file edited by hand is what the
next write patches. [The morning line →](/en/docs/manual/schedule/#the-morning-line)

Until 0.8.17 they were `[[people]]` entries in `config.toml`. The first start of 0.8.18 writes each into its file and
keeps the block, marked as moved, for the way back: 0.8.17 reads it, and 0.8.18 does not while `people/` exists. What
0.8.17 changes in it after a rollback comes along: the next start of 0.8.18 sees the block is not what it moved, and
moves it again, each file it replaces kept beside it as `<key>.toml.bak.1`.
[Access & people →](/en/docs/manual/access/)

## `[cron]` and `[jobs]`

```toml
[cron]
enabled = true
unattended_approval = "auto"        # auto | deny

[jobs]
quiet_after_minutes = 5             # 0 never tells
```

`quiet_after_minutes` is for background jobs: one that prints nothing that long wakes its agent to say
it is still running, then again at double the time, and double again. Nothing is stopped for being
quiet (`[security] job_max_ms` is what stops a job that runs too long), and an agent can set its own
in its `[jobs]`. [Scheduled work →](/en/docs/manual/schedule/)

## `[missions]`

```toml
[missions]
per_agent = 1                       # working at once for one agent; one being checked is not counted
# max_running = 3                   # running at once on this box; unset: half the agents, 1 to 8
limit_hours = 8                     # hours of work; time waiting for you is not counted
limit_turns = 100                   # each turn up to [llm.limits] max_tool_iterations steps
limit_tokens = 100000000            # input and output, the reviewer's included
```

A mission takes its limits when it starts; reaching one asks you to continue or stop. A mission waiting for you holds
no slot. Left unset, `max_running` follows the agents that are on (half of them, rounded down, at least 1 and at most
8), and it can be set as high as all of them. Set from the dashboard's settings too. [Missions →](/en/docs/manual/missions/)

## `[[external_clis]]`

A coding CLI you add for [external agents](/en/docs/manual/external-agents/), beside the two built in, `claude-code`
and `codex`. One table per CLI:

```toml
[[external_clis]]
id = "opencode"                     # what a pack's [external] cli names: lowercase, digits and "-", up to 32
name = "OpenCode"                   # shown beside it; absent: the id
command = "opencode"                # the program that speaks ACP, on the daemon's PATH or by path
args = ["acp"]                      # what starts its ACP mode
install = "npm i -g opencode-ai"    # said where it is not installed
version_args = ["--version"]        # what prints its version (the default)
profile_env = "OPENCODE_HOME"       # the variable pointing it at a profile folder; absent: its profile is its HOME
instruction_file = "AGENTS.md"      # the file it reads about itself where it works (the default)
login = ["auth", "login"]           # run in a terminal on the box to sign in; absent: no sign-in from Nouride
# login_note = "…"                  # said beside the sign-in
status = ["auth", "status"]         # exits 0 when signed in; absent: a session it opens says
# signed_out = ["…"]                # words in a refusal that mean it is not signed in
modes = { folder = "build", all = "plan" }   # each preset as the CLI's own mode id; one left out: its default
```

An id a built-in CLI has is refused at load, and so is an id written twice; a key it does not read is warned about.
There is no `env`: a secret the CLI needs is bound to its command in the agent's `[security.exec_secrets]`. A CLI you add
runs as the agent's own user only where each agent has one, gets no skills, and signs in once per agent.

Per agent, in its pack's `config.toml`:

```toml
[external]
cli = "claude-code"                 # required: claude-code, codex or an [[external_clis]] id
profile = "default"                 # the account: lowercase, digits and "-", up to 24 (the default)
permissions = "risky"               # folder | risky | all; absent: folder where agents are their own users, risky elsewhere
model = "sonnet"                    # as the CLI names it; absent: the CLI's default
```

`folder` is *Free in its folder*, `risky` *Ask when risky* and `all` *Ask for everything*. Where agents are not their
own users (Docker, macOS, no helper), `folder` asks as `risky` does. `[look]` in the same file is the agent's cat in
the [Office](/en/docs/manual/office/#a-look-for-each-agent).

## `[skills]` and `[skills.learning]`

```toml
[skills]
off = []                            # names nobody loads, whatever their own skills.toml says

[skills.learning]
mode = "ask"                        # off | ask | auto
model = ""                          # empty: the agent's own model; or a tier's name
notify_chat = true                  # announce a new draft in the chat it came from
```

`mode` is how much skill learning does without you: `off` examines nothing, `ask` drafts a skill and
waits, `auto` approves its own drafts and tells you afterwards. The weekly review's proposals wait for
a person in every mode. Anything unrecognised is read as `ask`, never as `auto`: a bad value should
cost an approval, not grant autonomy. When the pass looks, and how often, is the daemon's own, not a
setting.

`[skills.learning]` was `[rsi]` before 0.7.27, with `require_approval` for `ask` and `always_allow` for
`auto`. An `[rsi]` table is refused since 0.8.0, naming `[skills.learning]`.
[Skills & learning →](/en/docs/manual/skills/)

## `[nougate]`

```toml
in_process = false                  # the dashboard's LLM Gateway page switches it
```

Every official build carries the gateway, off by default. Choosing **Use Nougate** in setup or **Turn on Nougate** on the
LLM Gateway page writes `true` and starts it without a restart; **Turn off** writes `false` and restarts Nouride.
A Router install's first start on Community writes `true` when the file has no `in_process` and the gateway has
data, so it stays on. On a build without the gateway (compiled from the public source alone), turning it on stops
the daemon from starting, with a message saying the build does not carry the gateway. `$NOUGATE_IN_PROCESS`
overrides it.
[Nougate →](/en/docs/providers/nougate/)

---

## Environment variables

Only these override the config file. Everything else structural belongs in `config.toml`.

| | overrides |
|---|---|
| `HOST` | `[dashboard] host`. **Required as `0.0.0.0` in a container** |
| `PORT` | `[dashboard] port` |
| `LOG_LEVEL` | `[daemon] log_level` |
| `TZ` | `[daemon] timezone` |
| `NOURIDE_DATA_DIR` | `[daemon] data_dir` |
| `NOURIDE_AGENTS_DIR` | `[daemon] agents_dir` |
| `NOURIDE_PUBLIC_URL` | `[dashboard] public_url` |
| `NOURIDE_PASSWORD_LOGIN` | `[dashboard] password_login` |
| `NOURIDE_OAUTH_ISSUER`, `_CLIENT_ID`, `_SECRET_NAME`, `_LABEL` | `[dashboard.oauth]`. Pro edition only |
| `NOUGATE_IN_PROCESS` | `[nougate] in_process` |

`NOURIDE_CONFIG` names the file itself and `NOURIDE_HOME` the install it lives in. The rest, from the
first admin account to what the daemon sets for the commands agents run, is on
[Environment variables](/en/docs/reference/environment/).

Everything else in `.env` is a **credential**, named by your own config:

```bash
# [providers.nougate-anthropic] api_key = "nougate"  →
NOUGATE=

# [gateways.telegram.nouva] token = "telegram-nouva" →
TELEGRAM_NOUVA=

# 64 hex characters: openssl rand -hex 32
WA_ENCRYPTION_KEY=

# [security.web] search_api_key = "brave_search_api_key". Without it, web_search falls back to the
# keyless DuckDuckGo chain.
BRAVE_SEARCH_API_KEY=

# Or Exa: [security.web] search_kind = "exa", search_api_key = "exa_api_key". Exa has no keyless
# fallback: without its key, web_search is not offered.
EXA_API_KEY=
```

There is no fixed list. Every variable exists because something in your `config.toml` names it, 
delete the ones your config does not reference.

If a name is too generic for your environment, `NOURIDE_SECRET_<NAME>` is read as well.

## Per-agent config

`.nouride/agents/<id>/config.toml` and `skills.toml`.
[Agents & persona packs →](/en/docs/architecture/agents/#configtoml)

## Advanced settings

Rarely needed, and kept out of the way: these are not in `config.example.toml`, and the dashboard shows the one it
has a control for behind **Advanced**. Each works exactly as it always did when written into `config.toml`, and
`nouride config explain <key>` describes it in full.

| Key | Default | What it does |
|---|---|---|
| `[daemon] shutdown_timeout_ms` | `30000` | How long a graceful stop waits for turns in flight. |
| `[daemon] log_pretty` | `false` | Human-readable log lines instead of one JSON object per line. For development. |
| `[agents] mention_max_hops` | `5` | Agent-to-agent handovers by @mention before the chain stops; a person speaking resets it. Also on the dashboard's Agent Settings, under Advanced. |
| `[agents] job_wake_max_chain` | `100` | Times a finished background job may wake its agent with nobody having spoken. `0` lifts the ceiling. |
| `[security] tool_max_output_bytes` | `104857600` | Most of one command's output kept on disk (100 MB). The model sees an excerpt either way. |
| `[security] credentials_dir` | `""` | Where file-shaped credentials live; empty is `<data_dir>/credentials`, created `0700`. No file tool reaches it, only a command through `$NOURIDE_CREDENTIALS_DIR`, and the daemon refuses to start if it lands inside a readable root. |
| `[security.access] code_ttl_ms` | `900000` | How long a pairing code stays usable. |
| `[security.access] notify_cooldown_ms` | `300000` | Gap between "I don't know you" replies to the same sender. |
| `[security.access] deny_cooldown_ms` | `86400000` | How long a denied sender is ignored before a message is a new request. Block keeps somebody out until unblocked. |
| `[security.rate_limit] cooldown_reply` | `"Please slow down."` | What a sender over the rate limit is told. |
| `[alerts] cooldown_ms` | `300000` | Gap between repeats of the same alert. |
| `[media] max_image_bytes` | `8388608` | Images larger than this are reported rather than looked at. |
| `[media] max_audio_bytes` | `20971520` | Clips larger than this, after any transcode, are reported rather than sent. |
| `[control] enabled` | `true` | Serve the token-guarded control API the CLI talks to. |
| `[control] chat` | `true` | Register the in-process gateway `nouride chat` delivers through. |
| `[llm.streaming] enabled` | `true` | Stream replies from the provider rather than waiting for the whole message. |
| `[llm.streaming] typing_indicator` | `true` | Show the platform's typing indicator while a turn runs. |
| `[llm.streaming] progress_in_chat` | `true` | One live line in the chat naming the tool running now, and the agent's opening line sent at once. |
| `[llm.context] max_context_ratio` | `0.8` | Share of the model's window the conversation may fill. |
| `[llm.context] truncation_strategy` | `"summary"` | `summary` compacts old turns into a kept summary; `sliding_window` drops them. |
| `[llm.context] preserve_recent_turns` | `4` | Turns never dropped, however tight the budget. |
| `[llm.context] compact_at_ratio` | `0.8` | Share of the budget at which room starts being made. `compact_at_tokens` is the everyday knob. |
| `[llm.context] preserve_recent_tool_results` | `3` | Recent tool results kept in full when room is made inside a turn. |
| `[queue] max_concurrent_per_agent` | `1` | Turns at once in one conversation. Must be 1; the loader refuses more. |
| `[queue] max_queue_depth` | `20` | Messages waiting per conversation before the oldest is dropped. |
| `[queue] queue_timeout_ms` | `3600000` | How long a message may wait. Matched to `max_turn_duration_ms`; the loader warns when it is shorter. |
| `[queue] steer_reply` | `true` | Under a steered message's "Got it", one sentence in the agent's own words. |
| `[queue] steer_reply_model` | `""` | The model that sentence is asked of; empty is the agent's own, and a tier's name works. The Models page shows it with the other helpers. |
| `[queue] steer_reply_timeout_ms` | `15000` | Past this, "Got it" stands alone. |
| `[cron] min_interval_ms` | `60000` | Shortest repeat a job may ask for. |
| `[cron] max_jobs` | `100` | Scheduled jobs across every agent. |
| `[cron] run_retention_days` | `3` | Days of run history kept. |
| `[cron] catchup_window_ms` | `3600000` | How late an overdue job may still fire after downtime. |
| `[cron] fail_streak_limit` | `10` | Failures in a row before a job switches itself off. |
| `[cron] command_timeout_ms` | `600000` | Hard kill for a scheduled command. |
| `[nougate] port` | `18256` | Loopback port of the in-process gateway. |

## Fixed since 0.8.0

Nobody tuned these, so they are values in the code now. A `config.toml` that still writes one loads, and the line is
named in a warning (`config key is a fixed value since 0.8.0 and ignored`, also in `nouride config check`): delete it.

| Was | Is |
|---|---|
| `[health] heartbeat_interval_ms`, `disk_warn_threshold_mb`, `wal_warn_threshold_mb` | a disk check every minute, alerting under 1 GB free; `/health` degraded past a 100 MB write-ahead log |
| `[cron] tick_interval_ms` | the scheduler sleeps a minute at most |
| `[queue] dedup_window_ms` | a repeated message id within a second is ignored |
| a gateway's `[resilience]` table | each platform's own reconnect pacing, WhatsApp's slower than the others' |

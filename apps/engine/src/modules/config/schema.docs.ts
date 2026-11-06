/**
 * What each config key is for, in one place — the prose `nouride config explain` prints.
 *
 * Split from `schema.ts` when that file went over its line budget, and it is the seam that was
 * always there: this is data, the rest is the machinery that walks `DEFAULT_CONFIG` and turns it into
 * a schema. One grows every time a key is added and the other almost never does.
 */

import type { Annotation } from "./schema.ts";

/**
 * Prose, by TOML path. Everything not named here still reports its type and current default.
 *
 * Weighted deliberately: a key whose name says everything (`dashboard.port`) gets a line, a key with
 * a companion setting or a security consequence gets the caveat that saves the round trip.
 *
 * `live: true` marks a key a save applies at once — one its setter (`config/settings/*.ts`) answers with
 * `restartRequired: false`. Every other key waits for a restart. `running-config.test.ts` runs the setters and holds this
 * list to what they answer, both ways.
 */
export const ANNOTATIONS: Record<string, Annotation> = {
  // ── daemon ────────────────────────────────────────────────────────────────
  "daemon.name": { description: "Name this install reports in health and alerts." },
  "daemon.log_level": { description: "Log floor. `debug` is verbose enough to read a whole turn." },
  "daemon.log_pretty": { description: "Human-readable log lines instead of one JSON object per line." },
  "daemon.data_dir": {
    description: "Where the database, secrets and logs live.",
    caveat:
      "The credentials directory must stay outside every workspace and skill root, or `read` can pull a private key into a conversation. The daemon refuses to boot if it is not.",
  },
  "daemon.agents_dir": { description: "Where agent packs are loaded from, one directory per agent." },
  "daemon.workspace_dir": { description: "Default working directory for agents that declare no roots." },
  "daemon.shutdown_timeout_ms": { description: "How long a graceful shutdown waits for in-flight turns." },
  "daemon.timezone": {
    description:
      "IANA zone the daemon keeps time in: the nightly memory pass (`[memory] pass_at`), cron jobs without a zone of their own, the daily rollover, the Box's update window, and every timestamp shown to an agent. Empty is this machine's zone; `TZ` in the environment wins.",
    caveat: "A name `Intl` does not know (a typo, or a POSIX string like `CET-1CEST` in `TZ`) is refused at load.",
  },
  "daemon.orchestrator": { live: true,
    description:
      "The agent that answers a message addressed to nobody and, in a room several of our bots share, the front desk: a message there that tags, names or replies to nobody is answered by it alone, through its own bot, and it hands on to the peer whose headline fits. Set to the first agent made; `default_agent` until 0.7.18.",
    caveat:
      "A room that requires a mention (`groups_require_mention`, or `/mention on` in that group) stays quiet for it too. A message that addresses someone routes as it always did, and DMs are unaffected. Never an external agent (0.8.1): Nouride's approval level, fixed list and tool switches do not reach a coding CLI's own commands, and the orchestrator is the agent anyone in a room reaches. Making one the orchestrator from the dashboard is refused; a save of its pack that adds `[external]` is put back; a start that finds one anyway runs with no orchestrator and says so.",
  },
  "daemon.backup_keep": { description: "How many snapshots of each kind to keep (the database, the vault, the packs), the oldest deleted first: taken at boot and weekly, so four is a month back." },
  "daemon.backup_seal": { live: true,
    description: "The secret store in the config snapshots, sealed to a passphrase: only the public half of the key it derives is kept here. Set and cleared with `nouride secret seal --stdin` and `--off`; empty keeps every secret out of snapshots.",
    caveat: "Opened with `nouride secret unseal <file> --stdin --out <path>` and the passphrase. A passphrase lost is the sealed copies lost: the daemon cannot open them, by design." },
  "daemon.backup_dir": {
    description: "Where the scheduled snapshots go instead of data/backups: the database, the memory vault, the persona packs. Empty means data/backups.",
    caveat:
      "Never created: point it at a directory on the drive (/mnt/usb/nouride, not /mnt/usb), so an unplugged drive skips snapshots instead of filling the card underneath its mount point. Snapshots taken before a migration or a vault tidy stay in data/backups.",
  },

  // ── agents ────────────────────────────────────────────────────────────────
  "agents.mentions_enabled": { live: true, description: "Whether agents may address each other by @mention." },
  "agents.mention_max_hops": { live: true,
    description: "Agent-to-agent exchanges allowed before the chain stops.",
    caveat: "Reset whenever a human speaks: a person joining in is what a fresh budget is for.",
  },
  "agents.job_wake_max_chain": {
    description:
      "Times a finished background job may wake an agent with nobody having spoken. 0 lifts the ceiling.",
    caveat:
      "At the limit the wake-up is still delivered (the agent is told to report the result and start nothing further), because suppressing it would hide the failures this ceiling was added alongside. Reset whenever a person says anything.",
  },
  "agents.nudge_after_minutes": {
    description:
      "Minutes before long work is nudged, then at double, and double again (5, 10, 20, 40…). A helper or an agent asked with `ask_agent` is told to stop and report honestly if it is stuck, and the agent waiting on one in the background is told how long it has run; a chat turn someone is waiting on is asked for a one-line status. 0 is off.",
    caveat: "Nothing is stopped: `llm.limits.max_turn_duration_ms` stays the one hard limit, and `nouride jobs kill` stops a delegate in the background.",
    example: "nudge_after_minutes = 5",
  },
  "agents.groups_require_mention": {
    description: "In a group, answer only when tagged, named, or replied to. DMs are unaffected.",
    caveat: "Can be overridden per connection with `groups_require_mention` on a `[gateways.*]` entry, and per group with `/mention`.",
  },
  "agents.group_context_messages": { live: true,
    description:
      "Recent group messages replayed as context when an agent is finally addressed. 0 is off, 100 the ceiling.",
    caveat:
      "Everything said in the room becomes context for the agents in it, paired senders or not. They still cannot trigger a turn. Telegram delivers unaddressed group messages only once privacy mode is disabled in @BotFather. Overridable per connection with `group_context_messages` on a `[gateways.*]` entry.",
  },

  // ── security ──────────────────────────────────────────────────────────────
  "security.tool_timeout_ms": { description: "Hard kill for one tool call." },
  "security.tool_max_output_bytes": {
    description:
      "Most of one command's output kept on disk. The model sees an excerpt of it either way; past this the command keeps running and the file stops.",
  },
  "security.approval_timeout_ms": {
    description: "How long a parked approval waits for a human before it expires.",
    caveat:
      "An approval also dies with the turn that asked, so the effective window is whichever of this and `llm.limits.max_turn_duration_ms` runs out first.",
  },
  "security.max_conversation_turns": { description: "Turns kept in a stored session before the oldest are dropped." },
  "security.job_max_ms": {
    description:
      "How long a background job may run before the daemon stops it and tells its agent it did not finish. Wall-clock from the start. 0 never stops one.",
    caveat:
      "Services are exempt, and the agent chooses what is one: this stops a runaway, it is not a boundary. Read at boot; a restart to change it also stops running jobs. At most 2147483647 (about 24 days).",
    example: "job_max_ms = 7200000   # two hours; 0 never stops a job",
  },
  "security.rate_limit.messages_per_minute": { description: "Inbound messages per sender per minute." },
  "security.rate_limit.cooldown_reply": { description: "What to say to a sender who is over the limit." },
  "security.access.mode": { live: true,
    description:
      "`open` answers anyone, `allowlist` answers only listed senders, `pair` (the default) issues a code an operator approves.",
    caveat:
      "`open` with a chat gateway and an agent holding `exec` is refused, at boot and when switched to: anyone who finds the bot could run commands on this host. The allowlist does not change that; `open` admits everyone before it is read.",
  },
  "security.access.allowlist": {
    description: "Sender ids admitted without pairing, bare or gateway-scoped (`telegram:main:123`), in `pair` and `allowlist` mode.",
    caveat: "`[security] sender_allowlist`, its name before `[security.access]`, is refused at load since 0.8.0: the ids go here.",
  },
  "security.access.code_ttl_ms": { description: "How long a pairing code stays valid." },
  "security.access.notify_cooldown_ms": { description: "Gap between pairing notices for the same sender." },
  "security.access.deny_cooldown_ms": { description: "How long a denied sender waits before they may ask again. Block keeps them out until unblocked." },
  "security.approvals": {
    description:
      "How much is asked before a tool call runs, when neither the agent nor the person has said. `careful` asks a new command or change once and every entry of the fixed list every time (`nouride policy`); `balanced` asks only a config.toml changed, someone given access, the daemon stopped, a stored secret replaced or deleted, a credential leaving, this machine's system packages changed (`nouride pkg install|remove|upgrade`), and the four classes every level asks; `trusted` asks nothing but those four: work nobody watches sending somewhere its job did not name, a program installed for every agent (`nouride tools run`), a change to an agent's own persona, and a change to who People says a person is (`people set|remove`, `access approve --as|--me|--new`). A new install writes `careful`; unset is `balanced`.",
    caveat:
      "`trusted` answers everything else by itself, which is why no CLI verb and no chat command can set it: a chat sender is not authenticated. This file and the dashboard are the two ways in.",
  },
  "security.model_guard": {
    description:
      "The second look (0.8.0): before work nobody watches (a scheduled job's run, a webhook's, a mission) sends something off the machine after reading outside content, a model is asked whether the action belongs to the work. It sees the work's goal and the action, never the content, and may add a question, never remove one. Unset: by the approval level (on at `careful` and `balanced` on the agent's high tier, off at `trusted`). `off`: off everywhere. A tier (`small`, `default`, `high`) or a model id: on at every level, `trusted` too. A pack's `[security] model_guard` says it for one agent.",
    caveat:
      "Not a lock: the fixed list still decides what asks, and the second look runs after it, only on these actions. When it cannot be reached, a person is asked. Not the empty string for off: empty is the default.",
    example: 'model_guard = "off"',
  },
  "security.exec.landlock": {
    description:
      "Landlock on top of each agent's own user: where an agent's command may change files (its own folder, `shared/`, its declared roots, the temporary folders), whatever the files' modes would let its user do. `auto` applies it where the kernel has it, `require` runs no command where it does not, `off` leaves it to the user.",
    caveat:
      "Only where each agent's commands run as their own user (the helper `install.sh` sets up); in a container, on macOS or without the helper it does nothing. `nouride doctor` says whether this kernel has it.",
    example: 'landlock = "auto"   # off | auto | require',
  },
  "security.exec.max_memory_mb": { description: "Memory ceiling for a spawned command. 0 disables it." },
  "security.exec.max_cpu_seconds": { description: "CPU ceiling for a spawned command. 0 disables it." },
  "security.exec.blocked": { description: "Commands refused outright, whatever else permits them." },
  "security.credentials_dir": {
    description: "Directory of credential files an agent may use by name without ever reading them.",
    caveat:
      "Must be outside every workspace and skill root. The daemon refuses to boot otherwise, because `read` would reach it.",
  },
  "security.web.allow_private_urls": {
    description: "Permit outbound requests to private and loopback addresses (RFC1918, 127.0.0.0/8, link-local).",
    caveat:
      "Required for a self-hosted search endpoint or a webhook on your own network. Left false, the SSRF guard blocks them and the failure reads as the tool being broken.",
    example: 'allow_private_urls = true   # needed for search_endpoint = "http://192.0.2.10:8080/…"',
  },
  "security.web.search_kind": {
    description: "Which search backend `web_search` talks to.",
    caveat:
      "`searxng` has no public default and must be given a `search_endpoint`. With no usable backend the tool falls back to keyless scraping rather than disappearing: an agent with no search does not stop searching, it writes a scraper.",
  },
  "security.web.search_endpoint": {
    description: "Base URL of the search API or the proxy in front of it. Empty uses the backend's own default.",
    caveat:
      "A private address here needs `allow_private_urls = true`. Setting this also relaxes the API-key requirement, on the grounds that a proxy is handling authentication upstream.",
    example: 'search_endpoint = "http://192.0.2.10:8080/search"',
  },
  "security.web.search_api_key": {
    description: "Name of the credential holding the search API key.",
    secretRef: true,
    caveat:
      "The *name*, never the key. Resolved from the secret store or the environment at call time, so the value never enters this file.",
    example: 'search_api_key = "brave_search_api_key"',
  },
  "security.web.fallback_enabled": {
    description: "On a 429, a 5xx or a timeout from the primary backend, try the fallback chain before giving up.",
  },
  "security.web.fallback_backends": {
    description: "Backends to try, in order, when the primary fails at runtime.",
    caveat:
      "`duckduckgo` is the keyless scraping chain: no endpoint, no credential, which is why it is not a `search_kind`. A named search kind falls back on its *own* default endpoint, never this section's: a SearXNG URL is not a Brave URL. So `searxng` cannot be a fallback (it has no public default) and `brave` needs `search_api_key` set. Both are reported by `nouride doctor` rather than dialled to earn a 404 or a 401.",
    example: 'fallback_backends = ["duckduckgo"]',
  },

  // ── media ─────────────────────────────────────────────────────────────────
  "media.image_model": { live: true,
    description:
      "Leave empty and images go to the conversation model as pictures. Name a model here and they " +
      "are described by it in text instead, for a conversation model that cannot see, or a cheaper " +
      "one that should do the looking. Also a tier's name (`small`, `default` or `high`) for each agent's own model of that tier (0.8.0).",
  },
  "media.read_images": { description: "Whether images are looked at at all: one sent in a chat, one an agent opens with `read`, one an MCP server returns." },
  "media.max_image_bytes": { description: "Images larger than this are reported rather than looked at." },
  "media.read_audio": {
    description:
      "Whether voice notes and audio files are sent to the model. Even on, a clip is sent only to a " +
      "model known to hear it; otherwise the agent says it could not listen.",
  },
  "media.audio_input": {
    description:
      "`auto` trusts the gateway's `/models` listing (Nougate says which models hear) and treats every " +
      "other model as unable to. `always` is for a provider that hears but does not say so: audio goes " +
      "as mp3, and a refusal is caught and answered without it.",
  },
  "media.max_audio_seconds": { description: "Clips longer than this are reported rather than sent." },
  "media.transcribe_provider": {
    description:
      "A provider profile whose `/audio/transcriptions` turns speech into text when the conversation " +
      "model cannot hear: OpenAI, Groq, or a Whisper server on another machine. Empty: no " +
      "transcription. It sends the voice note to that service.",
    caveat:
      "Each clip is a metered call (`purpose: transcription`) recorded by its length, not tokens: a transcription is billed by the minute, and no price for one is in the price book, so it shows as unpriced.",
    example: 'transcribe_provider = "groq"',
  },
  "media.transcribe_model": { description: "The model `transcribe_provider` uses, e.g. `whisper-1`." },
  "media.max_audio_bytes": {
    description: "Clips larger than this, after any transcode, are reported rather than sent.",
  },

  // ── jobs ──────────────────────────────────────────────────────────────────
  "jobs.quiet_after_minutes": { live: true,
    description:
      "Minutes a background job may print nothing before its agent tells the person it is still " +
      "running, then at double, and double again (5, 10, 20, 40…). New output starts the count over. " +
      "Nothing is stopped for being quiet (`security.job_max_ms` stops one for running too long). 0 never tells. " +
      "An agent can override it in its own `[jobs]`.",
    example: "quiet_after_minutes = 5",
  },

  // ── delegate ──────────────────────────────────────────────────────────────
  "delegate.max_background": {
    description:
      "Helpers one agent may have working in the background at once (`delegate` with `background: true`). Each is a " +
      "job of its own: the turn that started it ends at once, the person can talk to the agent meanwhile, and each " +
      "helper's result wakes the agent as that helper finishes. One is the habit for a long task, two for two " +
      "independent pieces. 0 turns them off; at most 4. An agent can have its own in its pack's `[delegate]`, set " +
      "from its Settings page in the dashboard, which applies to the next helper it starts. Since 0.7.19 it counts the " +
      "agent's asks in the background too (an `ask_agent` past its minute), and at 0 every ask waits for its answer.",
    caveat:
      "A helper does not take a slot under `[queue] max_concurrent_turns` (it exists so the agent stays free for the " +
      "person), so this number, per agent, is what bounds them. Each one spends like a turn of its own, against " +
      "`max_daily_tokens` and `max_daily_cost_usd`.",
    example: "max_background = 2",
  },

  // ── missions ──────────────────────────────────────────────────────────────
  "missions.per_agent": { live: true,
    description:
      "Missions one agent may have running at once. A mission is long work an agent finishes alone, started with " +
      "`/mission`, from the dashboard, or by the agent when the work needs one. The next one waits in the queue, " +
      "saying which it waits for. An agent's own, in its pack's `[missions] per_agent` or on its Settings page, is used " +
      "in its place (0.8.11).",
    caveat: "A mission waiting for a person holds no slot. Two missions in one repository take turns, whatever this is.",
    example: "per_agent = 1",
  },
  "missions.max_running": { live: true,
    description:
      "Missions running at once on this box, across every agent. Unset, it follows the agents that are on: half of them, " +
      "rounded down, at least 1, and at most 8 however many there are. A box of six runs three.",
    caveat: "It may be set as high as every agent running its `per_agent` at once. More could never run.",
    example: "max_running = 3",
  },
  "missions.limit_hours": { live: true,
    description: "Hours a mission may work before it stops and asks to continue. Time waiting for a person is not counted.",
    caveat: "A mission takes its limits when it starts: a change reaches the missions started after it.",
    example: "limit_hours = 8",
  },
  "missions.limit_turns": { live: true,
    description: "Turns a mission may take before it stops and asks to continue, the reviewer's and failed checks' included.",
    example: "limit_turns = 100",
  },
  "missions.limit_tokens": { live: true,
    description:
      "Input and output tokens a mission may spend before it stops and asks to continue, its helpers and the reviewer " +
      "included. Tokens rather than money, because tokens are always counted and a price is not always known.",
    caveat: "The daily cap in `[llm.limits]` still holds on top.",
    example: "limit_tokens = 100000000",
  },

  // ── alerts ────────────────────────────────────────────────────────────────
  "alerts.gateway": {
    description: "Connection the daemon speaks through in its own voice.",
    caveat: "Unset, a daemon failure reaches the log and nobody else.",
  },
  "alerts.chat_id": { description: "Chat that receives daemon alerts." },
  "alerts.cooldown_ms": { description: "Gap between repeats of the same alert." },

  // ── dashboard and control ─────────────────────────────────────────────────
  "dashboard.enabled": { description: "Serve the dashboard." },
  "dashboard.host": {
    description: "Interface the dashboard binds to.",
    caveat: "`127.0.0.1` is loopback only: reach it over an SSH tunnel rather than opening the port.",
  },
  "dashboard.port": { description: "Port for the dashboard and the control API." },
  "dashboard.public_url": {
    description: "The address this daemon is reachable at from outside, e.g. https://agents.example.com.",
    caveat:
      "Only needed when that is not host:port, as behind a proxy or a container port map. It is what webhook URLs are built from; without it they are shown as host:port, which reaches nobody from outside.",
  },
  "dashboard.password_login": { live: true,
    description: "Allow signing in with a username and password.",
    caveat:
      "Turning it off needs `[dashboard.oauth]` configured, or there is no way in at all. The daemon refuses to start otherwise. Existing passwords are not deleted; they work again when this is switched back on.",
  },
  "dashboard.oauth.issuer": {
    description:
      "OpenID Connect issuer that may sign people in, e.g. https://service.nouverse.tech/api/auth. Empty turns external sign-in off.",
    caveat:
      "Its endpoints are read from `<issuer>/.well-known/openid-configuration`, so this is the only URL to set. Must be https unless it is loopback.",
  },
  "dashboard.oauth.client_id": {
    description: "Client id this install was registered with at that issuer.",
    caveat: "Issued per install, alongside a redirect URI the provider will refuse to vary from.",
  },
  "dashboard.oauth.secret_name": {
    description: "Name of the secret holding the client secret, never the secret itself.",
    caveat:
      "Resolved from the environment or the secret store, the same way a provider key is. `nouverse_oauth` reads $NOUVERSE_OAUTH.",
  },
  "dashboard.oauth.label": {
    description: "What the sign-in button is called, e.g. Nouverse.",
  },
  "control.enabled": { description: "Serve the token-guarded control API the CLI talks to." },
  "control.chat": { description: "Allow the control API to send messages into a conversation." },

  // ── llm ───────────────────────────────────────────────────────────────────
  "llm.defaults.provider": {
    description: "Provider profile used by an agent that names none.",
    caveat: "Must match a `[providers.*]` name, or the daemon refuses to boot.",
  },
  "llm.defaults.model": { description: "Model used by an agent that names none: the `default` tier." },
  "llm.defaults.small_model": { live: true,
    description: "The install's cheaper model: the `small` tier, for quick and simple work an agent hands off with `tier = \"small\"`. Empty: `model`.",
    caveat: "Inherited by an agent on this provider that names no `small_model` of its own; an agent on another provider names its own, or its small tier is its model. A tier's name here is refused: it names a model.",
  },
  "llm.defaults.high_model": { live: true,
    description: "The install's strongest model: the `high` tier, for hard work that has to be right. Empty: `model`.",
    caveat: "Inherited like `small_model`. Nothing runs on it unless an agent asks for `high` or a helper key names it.",
  },
  "llm.defaults.max_tokens": { description: "Output ceiling per reply, unless an agent sets its own. 0 is by model: 32000 for the Claude 4/5, Gemini 2.5/3 and GPT-5 families, 8192 for a model Nouride does not know." },
  "llm.defaults.temperature": { description: "Sampling temperature, unless an agent sets its own." },
  "llm.defaults.effort": {
    description:
      "How long a thinking model thinks before it answers, unless an agent sets its own `[llm] effort`: low, medium, high, xhigh or max. " +
      "Sent as `output_config.effort` to an Anthropic profile and `reasoning_effort` to an OpenAI-compatible one. Unset, each provider's " +
      "own: on Claude Sonnet 5.5 that thinks for many seconds before the first word; `medium` answers a chat in about two.",
  },
  "llm.defaults.fallbacks": {
    description:
      "Who answers when an agent's model cannot, in order: each `{ provider = \"…\", model = \"…\" }`, a provider profile and a model on it. " +
      "Tried after the provider's own retries: another model on the same profile for a rate limit, an overloaded provider or a model not served; " +
      "another profile for those and an endpoint that is down (a 5xx, a refused connection, a timeout, a stream dropped before its reply began), out of credit or refusing its key. " +
      "A stream that fails after its reply began is not fallen back on. The rest of the turn stays on the pair that answered, and its closing call uses the list too.",
    caveat: "For an agent whose pack names no `fallbacks` of its own; a pair that is an agent's own model is left out for it. Every provider must be a `[providers.*]` name, or the daemon refuses to boot.",
  },
  "llm.limits.max_tokens_per_turn": { description: "Hard ceiling on output tokens per request, over any agent's own setting." },
  "llm.limits.max_tool_iterations": { live: true,
    description: "Tool round-trips per reply before the model is asked to summarize and stop. 5–9999; 250 is the default, enough to carry a long piece of work through in one turn. An agent can override this in its own `[llm]` table.",
    caveat: "Every round-trip re-sends the conversation, compacted as it grows, so a long turn costs more than a short one. Work that waits on something slow (a build, a coding agent's run) belongs in a background job, which wakes the agent when it is done.",
  },
  "llm.limits.max_turn_duration_ms": { live: true,
    description: "Wall-clock cap on one turn, including time spent waiting for a human.",
    caveat:
      "A parked approval dies with the turn, so this also bounds `security.approval_timeout_ms` in practice.",
  },
  "llm.limits.max_daily_cost_usd": { live: true,
    description: "Spend ceiling per day, in dollars. 0 disables it.",
    caveat:
      "Only counts models that are in the price book: each vendor's listed models by exact id, at the price on the day its row names; a model it does not list is unpriced, and a daemon pointed at a self-hosted gateway may have no priced calls at all, so there this cap sees nothing. A provider profile with `billing = \"included\"` (a subscription) costs nothing per token and is left out of it. `max_daily_tokens` is the one that always applies.",
  },
  "llm.limits.max_daily_tokens": {
    description: "Token ceiling per day, input and output together, across every model. 0 disables it.",
    caveat:
      "Enforced on the same path as the dollar cap and before the provider is called; whichever is reached first refuses the turn, and past either, the calls nobody waits on are not made: a compaction, `/compact`, a reflection pass, the memory pass's questions, an embedding catch-up. Unlike the dollar cap this needs no price book: every metered call counts (the turn's own, and the compaction, reflection, image reading and embedding it causes), a provider's silence estimated, never read as zero.",
  },
  "llm.limits.cost_alert_threshold_pct": { description: "Percentage of the daily cap that triggers an alert." },
  "llm.streaming.enabled": { description: "Stream replies from the provider rather than waiting for the whole message." },
  "llm.streaming.typing_indicator": { description: "Show the platform's typing affordance while a turn runs." },
  "llm.streaming.progress_in_chat": { description: "Keep a live progress line in the chat naming the tool running now, and send the agent's opening line before long work at once (a later one at most every two minutes)." },
  "llm.context.max_context_ratio": {
    description: "Share of the model's context window the conversation may use, after the system prompt and tools.",
    caveat:
      "The window itself is looked up from the model id. A model nobody has an entry for is assumed to be 32k and its history trimmed far harder than it needs to be. The daemon says so in the log once per model.",
  },
  "llm.context.truncation_strategy": {
    description: "`sliding_window` drops the oldest turns; `summary` spends a provider call compacting them first.",
  },
  "llm.context.preserve_recent_turns": { description: "Turns never dropped, however tight the budget is." },
  "llm.context.summary_model": { live: true,
    description: "Model used for compaction, on the agent's own provider profile. Unset: `[memory] pass_model` on its profile when that is set, else the agent's own model. Also a tier's name (`small`, `default` or `high`) for each agent's own model of that tier (0.8.0).",
  },
  "llm.context.compact_at_ratio": {
    description: "Share of the budget at which compaction starts, so there is still room to work in.",
    caveat:
      "Scales with the window, so a big model raises it. `compact_at_tokens` is the flat ceiling that stops that, and the lower of the two wins.",
  },
  "llm.context.compact_at_tokens": {
    description:
      "Context carried before compacting: the whole request, prompt and tools included. Unset gives each model its own figure (Gemini Flash 200k, others 160k); an agent's `[llm] compact_at_tokens` beats both.",
    caveat:
      "On a million-token window the ratio alone put compaction at ~610k, so a long chat never compacted and one turn resent 12M tokens. Inert on small windows, where the ratio is already lower.",
  },
  "llm.context.preserve_recent_tool_results": {
    description: "Recent tool results kept in full when room has to be made mid-turn.",
  },

  // ── queue ─────────────────────────────────────────────────────────────────
  "queue.max_concurrent_per_agent": {
    description: "Turns at once in one conversation.",
    caveat: "1 is what keeps replies in order: turn N's answer is context for turn N+1.",
  },
  "queue.max_concurrent_turns": { description: "Turns at once across every conversation. 0 removes the ceiling." },
  "queue.max_queue_depth": { description: "Messages waiting per conversation before the oldest is dropped." },
  "queue.queue_timeout_ms": {
    description: "How long a message may wait before it is dropped as stale.",
    caveat: "Below `llm.limits.max_turn_duration_ms`, a message queued behind one full-length turn is dropped before it ever runs.",
  },
  "queue.steer_reply": { description: "In place of the instant \"Got it\" a steered message gets (rewritten into it where the platform edits messages, under it where not), a one-sentence reply in the agent's own words saying what it will do with it. One small call to the agent's model, beside the turn. None of the conversation is sent.", caveat: "Not sent if it takes longer than `steer_reply_timeout_ms` or the turn reads the message first; \"Got it\" alone then. Needs `steer`." },
  "queue.steer_reply_model": { live: true, description: "Model the steering reply is asked of, on the agent's own provider. A fast one without long reasoning answers in a second. Empty uses the agent's own model. Also a tier's name (`small`, `default` or `high`) for each agent's own model of that tier (0.8.0)." },
  "queue.steer_reply_timeout_ms": { description: "How long the steering reply may take. Past it, \"Got it\" stands alone." },
  "queue.steer": { description: "Read a message sent to an agent already working at the running turn's next step, instead of after the turn. Nothing running is cut off; the person is told it was received.", caveat: "In a room only the person who started the turn steers it, by addressing the agent; anybody else is told the agent is busy." },

  // ── attachments and retention ─────────────────────────────────────────────
  "attachments.max_size_mb": { description: "Inbound files larger than this are reported rather than stored." },
  "retention.session_days": { live: true, description: "Days of conversation history kept." },
  "retention.audit_days": { live: true, description: "Days of audit log kept." },
  "retention.job_log_days": { live: true,
    description: "Days a background job's log file is kept on disk. 0 keeps them forever.",
    caveat: "The agent may still be holding the path `exec` handed it, so these cannot be deleted when the job ends.",
  },
  "retention.tool_output_days": {
    description: "Days a tool result too large for the context is kept on disk. 0 keeps it forever.",
    caveat: "Swept per conversation by directory mtime, so a chat still producing output keeps all of its files.",
  },
  "retention.scratchpad_days": {
    description: "Days a file in an agent's `.scratchpad/` is kept. 0 keeps them forever.",
    caveat: "Not swept at the end of the turn: the next message is often about the file that was just sent.",
  },

  "nougate.in_process": {
    description:
      "Run the LLM gateway inside this daemon instead of reaching one over the network. Needs the router or pro edition, which carry it.",
  },
  "nougate.port": { description: "Loopback port for the in-process gateway." },
  "update.track": { live: true,
    description: "Which releases this install is offered: `latest`, the newest; or `lts`, a long-term line (1.0 the first), which an install on an older line moves to and stays on, told when a newer line is out.",
    caveat: "A Pro install or a Box asks Nouverse, which takes the track from the box's sync; the dashboard's Update page sets it either way." },
  // ── rollover ──────────────────────────────────────────────────────────────
  "rollover.mode": {
    description: "`none` never clears a conversation's context, `daily` clears it at a fixed hour, `idle` after a quiet gap. Memory is unaffected either way.",
  },
  "rollover.at_hour": { description: "Hour of the day a `daily` rollover happens, in `daemon.timezone`." },
  "rollover.idle_minutes": { description: "Quiet minutes before an `idle` rollover happens." },

  // ── memory ────────────────────────────────────────────────────────────────
  "memory.dir": {
    description: "The memory vault: conversations (episodes), people's profiles, shared knowledge, and the graph stubs Obsidian reads. Never inside `daemon.agents_dir`.",
  },
  "memory.pass": { live: true, description: "Cut the day's conversations into episodes and file them each night. Off until the setup wizard asks." },
  "memory.pass_at": { live: true, description: "Local time the nightly pass starts (HH:MM, `daemon.timezone`), once no turn is running." },
  "memory.pass_per_night": { live: true,
    description: "Episodes filed per agent per night, direct conversations first. The rest wait for the next night.",
    caveat: "An agent with more conversations a day than this falls further behind every night: the Memory page and `nouride doctor` say so, with the number that files what waits within a week. `pass_max_tokens` caps what a raised count may spend.",
  },
  "memory.pass_max_tokens": { live: true,
    description: "Tokens the nightly pass may use in one night, every agent's together, in and out. Past it the pass stops before the next conversation, and the rest wait for the next night. 0 sets no limit of its own.",
    caveat: "Counted as each call reported, or estimated where the provider reported none (Nougate's OpenAI-compatible path), and the night's report says which. The pass's embeddings are not counted. `[llm.limits]` applies as well.",
  },
  "memory.pass_provider": { live: true, description: "Provider profile for the nightly pass. Empty uses each agent's own." },
  "memory.pass_model": { live: true, description: "Model for the nightly pass. A small one is enough. Empty uses each agent's own. A tier's name (`small`) is each agent's own model of it, on its own provider, so `pass_provider` stays empty beside it. It writes compaction summaries too while `[llm.context] summary_model` is unset. When it cannot answer (not served, no access, out of quota), each agent's own model is asked instead, and `nouride doctor` says so." },
  "memory.max_attempts": { live: true, description: "Tries per episode before it is left for a person to look at." },
  "memory.facts": { live: true,
    description: "What the nightly pass does to people's profiles: `auto` keeps, rewrites and removes facts on its own, `ask` asks before every change, `off` files conversations only. A `[[people]]` entry's own `facts` overrides it for that person.",
  },
  "memory.propose_shared": { live: true, description: "Let the nightly pass propose shared knowledge (`shared.md`). Every proposal waits for a person either way." },
  "memory.prompt_recent": { live: true, description: "Conversation summaries in each prompt. 0 leaves them out." },
  "memory.recall": { live: true,
    description: "Put what is remembered into each prompt: people's facts, shared knowledge, what is coming up and the latest conversations. Off, the nightly pass still learns and agents still search memory with their tools. A `[[people]]` entry's own `recall` overrides it for that person; off there, their facts are left out everywhere and a DM with them carries none.",
  },
  "memory.transcript_days": { live: true, description: "Days a conversation's transcript stays readable. Its summary is kept forever. 0 keeps transcripts forever: `archive` has nothing to do, and transcripts archived before come back at the next pass." },
  "memory.archive": { live: true, description: "Keep a compressed copy of each transcript when it stops being readable, to file again later. Agents cannot read it." },
  "memory.semantic.enabled": { live: true, description: "Search memory by meaning as well as by words. Needs `provider` and `model`." },
  "memory.semantic.provider": { live: true, description: "Provider profile that embeds (OpenAI's `/embeddings`: OpenAI, Gemini, Mistral, Jina, Ollama). Conversation summaries and facts are sent to it." },
  "memory.semantic.model": { live: true, description: "Embedding model, e.g. `text-embedding-3-small` or `bge-m3`." },
  "memory.semantic.dimensions": { live: true, description: "Vector size asked of models that can shorten theirs. Others keep their own size." },

  // ── mcp_server ────────────────────────────────────────────────────────────
  "mcp_server.enabled": { live: true, description: "Serve this install's memory and personas to other tools over MCP at `/mcp`, to tokens made with `nouride mcp-server token create`." },

  // ── cron ──────────────────────────────────────────────────────────────────
  "cron.enabled": { description: "Run scheduled jobs. Agents manage them through `nouride cron`." },
  "cron.min_interval_ms": { description: "Shortest repeat a job may ask for." },
  "cron.max_jobs": { description: "Scheduled jobs allowed to exist at once." },
  "cron.run_retention_days": { live: true, description: "Days of run history kept per job." },
  "retention.log_days": { live: true,
    description:
      "Days of the daemon's own log kept in the database, readable from System Logs. 0 keeps it forever; stdout still reaches the journal either way.",
  },
  "cron.catchup_window_ms": {
    description: "How far back a run missed while the daemon was down is still worth doing.",
  },
  "cron.fail_streak_limit": { description: "Consecutive failures before a job is disabled and reported." },
  "cron.unattended_approval": {
    description: "What a scheduled turn does when a tool needs approval and nobody is watching.",
    caveat:
      "`auto` approves it and records that against the job (a different promise from approving it once by hand); `deny` refuses it. Hardline commands are refused either way.",
  },
  "cron.command_timeout_ms": { description: "Hard kill for a scheduled command." },

  // ── rsi ───────────────────────────────────────────────────────────────────
  "skills.off": { live: true,
    description: "Skills no agent loads, whatever their own skills.toml says.",
    caveat:
      "The other axis from the per-agent switches, and the only removal a built-in has: those ship inside the executable, so deleting one is refused. Read on every pack reload, so a change applies from the next message. A name matching nothing is ignored, not refused.",
  },
  "skills.learning.mode": { live: true,
    description:
      "How much of skill learning runs without you: off examines nothing, ask drafts and waits, auto lets an agent keep the skills it learns. Was `[rsi] mode` (require_approval, always_allow) until 0.7.27.",
    caveat:
      "auto writes to the pool unattended: a new skill is on only for the agent that learned it, and the weekly review's proposals still wait. Anything unrecognised is read as ask, never as auto.",
  },
  "skills.learning.model": { live: true,
    description: "Model for the pass. Empty uses the agent's own. Also a tier's name (`small`, `default` or `high`) for each agent's own model of that tier (0.8.0).",
    caveat: "Resolved against the agent's provider profile, so it has to be a model that profile can serve.",
  },
  "skills.learning.notify_chat": { live: true,
    description: "Announce a new draft in the conversation that produced it.",
  },
};

/**
 * Built-in defaults — §20 SPEC.
 *
 * Every value in `config.example.toml` also appears here, so a missing or partial
 * `data/config.toml` still boots a working daemon. The one thing defaults cannot supply is
 * a credential: no gateways are defined by default, so a fresh checkout starts a dashboard
 * and nothing else rather than retry-looping against a platform it has no token for.
 */

import type { GlobalConfig, ProviderProfile } from "@nouride/shared";

/**
 * No profiles by default — each one is created explicitly by the operator, either through
 * the setup wizard, the dashboard or the config file. A fresh install starts with an empty
 * list and the setup flow creates the first one.
 */
const DEFAULT_PROVIDERS: Record<string, ProviderProfile> = {};

export const DEFAULT_CONFIG: GlobalConfig = {
  daemon: {
    name: "nouride",
    logLevel: "info",
    logPretty: false,
    // One root, three concerns. An install is a single directory an operator can back up, move or
    // delete as a unit — which the previous layout (`./data` and `./agents` scattered beside whatever
    // else was in the working directory) could not express.
    dataDir: "./.nouride/data",
    agentsDir: "./.nouride/agents",
    workspaceDir: "./.nouride/workspace",
    shutdownTimeoutMs: 30_000,
    // Empty: this machine's zone, read at load (`global/env.ts`). It was "UTC", so an install that never set it ran the
    // nightly pass at 08:00 in Jakarta and kept cron and the daily rollover on a clock nobody there reads.
    timezone: "",
    // Optional keys are listed as `undefined` rather than omitted: `mergeConfig` treats this
    // object as the schema, so a key absent here is reported as a typo. Omitting them would
    // make every optional setting unsettable.
    orchestrator: undefined,
    /**
     * Dated copies of the persona packs kept under `data/backups/agents/`. 0 disables it.
     *
     * `MEMORY.md` is the only thing in this installation that is not in git and cannot be rebuilt —
     * `docs/DEPLOY.md` names it first under what to keep. The `.bak` rotation `memory_write` does
     * covers the agent corrupting its own memory; it does not cover the directory being deleted.
     *
     * Seven is a week of daily snapshots of a few kilobytes of markdown.
     */
    backupKeep: 4,
    // Empty: `<data_dir>/backups`. A path names a directory that must already exist — a USB drive's.
    backupDir: "",
    // No passphrase, no secrets in snapshots: a copy on a USB drive must not be a copy of every credential.
    backupSeal: "",
  },
  providers: DEFAULT_PROVIDERS,
  agents: {
    // On, because an operator running two agents in one channel expects them to be able to hand work
    // over — and because the runaway that motivated the old blanket ban is bounded by the hop budget
    // rather than by refusing the whole category.
    mentionsEnabled: true,
    /**
     * Five, which is one full handover plus room to come back for a correction.
     *
     * "Here is a job / here is the result / thanks" is three, and the useful shape past that is one
     * round of "that is not quite it / fixed" — five. Beyond that a conversation between two models
     * is not converging on anything, and every hop is a paid provider call.
     *
     * Raised from four after a live room ran to ten: ten hops of "hop N, lanjut @nox" that a human
     * had to sit through, at ten calls for one message. The ceiling is worth having low, because the
     * thing it bounds is chatter with nobody watching.
     */
    mentionMaxHops: 5,
    /**
     * High on purpose. The chain this bounds is usually legitimate — a multi-step install is a job
     * per step — so the ceiling is a runaway guard, not a workflow limit. `0` removes it.
     */
    jobWakeMaxChain: 100,
    // Five, as `[jobs] quiet_after_minutes`: past most turns by far, and soon enough that fourteen minutes of a delegate
    // digging somewhere nobody asked it to is two nudges, not silence.
    nudgeAfterMinutes: 5,
    // Off by default: an operator setting `agent` on a single-bot gateway expects it to answer
    // untagged chatter in groups unless this is enabled.
    groupsRequireMention: false,
    /**
     * Twenty messages of the room replayed when an agent is finally tagged.
     *
     * On by default, because the behaviour it replaces reads as the agent being broken: asked
     * "@nouva ini" about the message above, it had no record of that message and asked what "ini"
     * meant. Twenty covers the exchange a tag usually points at and costs roughly 600–1500 tokens on
     * the turns where there is anything to replay.
     *
     * Worth knowing what it changes: everything said in a group the agent is in becomes context for
     * that agent, including from people `[security.access]` has not paired. Overhearing is not
     * obeying — an unpaired sender still cannot start a turn, run a tool or get a reply — but if a
     * room's chatter should not reach a model at all, this is the setting that says so.
     */
    groupContextMessages: 20,
  },
  security: {
    toolTimeoutMs: 30_000,
    // Disk, not memory: `exec` streams a large output to a file and holds only its two ends (see
    // `tools/builtins/exec-output.ts`), so this bounds a file swept after two days, not the heap.
    toolMaxOutputBytes: 100 * 1024 * 1024,
    approvalTimeoutMs: 300_000,
    maxConversationTurns: 200,
    // Off, as every other ceiling on a job is: no limit has been measured against the work these boxes run, and the
    // repository knows a two-hour build and a forty-minute clone. An operator who wants one sets the number.
    jobMaxMs: 0,
    rateLimit: {
      messagesPerMinute: 10,
      cooldownReply: "Please slow down.",
    },
    access: {
      // Pair by default. The old behaviour was `open` whenever the allowlist was empty — which is what
      // a fresh install has — so anyone who found the bot could run the agent's tools.
      mode: "pair",
      allowlist: [],
      codeTtlMs: 15 * 60_000,
      notifyCooldownMs: 5 * 60_000,
      // A day: long enough that a "no" is not answered by the next message, short enough that a wrong
      // "no" mends itself. Reset on the Access page ends it sooner; Block is the one that lasts.
      denyCooldownMs: 24 * 60 * 60_000,
    },
    exec: {
      // What a command may run and when it asks is the approval level's (`approvals` below) over one fixed list, since
      // 0.8.0: `mode`, `ask`, `ask_fallback`, `sensitive_paths` and the editable allowlist are gone.
      // Where the kernel has it, and nothing refused where it does not: Landlock is a layer on the agent's own user,
      // not the wall, and the boxes in the field mostly do not have it on.
      landlock: "auto",
      /**
       * Kernel ceilings on a command, in megabytes and seconds of CPU. 0 = unlimited.
       *
       * Off by default because a limit that stops a legitimate build is worse than no limit on a
       * machine nobody else uses — but on a server this is the difference between a runaway command
       * killing a turn and killing the host. The timeout does not help: a process can spin a core
       * flat or allocate until the machine swaps for the whole of it.
       *
       * Linux only, through `prlimit`. A native macOS install has no equivalent and says so at boot
       * rather than pretending the setting applied.
       */
      maxMemoryMb: 0,
      maxCpuSeconds: 0,
      // Nothing by default: an operator's own veto list is theirs to write. What always asks — deletes, teardowns,
      // this daemon's own state — is `@nouride/policy`'s fixed list, so this is not the place those belong.
      blocked: [],
    },
    /**
     * How much gets asked when neither the agent nor the person has said.
     *
     * `balanced`, for a new install too: setup writes no level. It wrote `careful` into a new install's file while
     * making its agents `balanced`, two answers for one install; an install that has a level in its file keeps it.
     * What `balanced` still asks — a config.toml changed, someone given
     * access, the daemon stopped, a secret replaced, a credential leaving, this machine's packages changed, and what
     * every level asks — is `BALANCED_ASKS`.
     *
     * `trusted` is a valid value here and is deliberately hard to reach: no CLI verb writes it, and a chat
     * command cannot set it. The dashboard, which requires a login, and this file, which is a hardline
     * path for an agent, are the two ways in.
     */
    approvals: "balanced" as const,
    // Empty is by the approval level: on at careful and balanced, off at trusted (0.8.0, `types/model-guard.ts`).
    modelGuard: "",
    // Empty resolves to `<data_dir>/credentials` once the data directory is known. Not written as a
    // literal here because `data_dir` is itself configurable, and two places deriving the same path
    // is how they come to disagree.
    credentialsDir: "",
    web: {
      allowPrivateUrls: false,
      /**
       * Which search service `web_search` talks to.
       *
       * Brave because it has a public endpoint and a free tier, and the default is the one kind that
       * falls back to the free sources while it has no key. `exa` is another search API with a key;
       * `searxng` is the self-hosted alternative and needs no key — see
       * `tools/builtins/search-backends.ts` for the compose service and the two settings a fresh
       * instance gets wrong.
       */
      searchKind: "brave",
      /** Empty uses the backend's own default. Required for a backend that has none. */
      searchEndpoint: "",
      /**
       * The **name** of the credential, never the value.
       *
       * Kept as a name so one key can serve several endpoints, and so this file stays safe to commit.
       * The old hard-coded `brave_search_api_key` is the default, so an existing `.env` keeps working.
       */
      searchApiKey: "brave_search_api_key",
      /**
       * Fall back to alternative backends on runtime failures (429, 5xx, timeout).
       *
       * On by default. An operator who wants a hard failure when their chosen backend is down
       * sets this to false — but the default should be resilience, not precision about which
       * service answered.
       */
      fallbackEnabled: true,
      /**
       * The fallback chain. `"duckduckgo"` is the keyless scraping chain, same as what runs
       * when no API key is configured at all. Listed explicitly so an operator can see what
       * will happen and can disable it by setting `fallback_enabled = false`.
       */
      fallbackBackends: ["duckduckgo"],
    },
  },
  media: {
    // Empty = the agent's own model. Naming a specific one here would be a guess about the
    // operator's provider list, and a wrong guess fails at the first image rather than at boot.
    imageModel: "",
    readImages: true,
    maxImageBytes: 8 * 1024 * 1024,
    readAudio: true,
    // `auto` hears nothing until a gateway says a model can. That is the safe default: the other way
    // round, the first voice note to a model behind a gateway that drops audio gets an invented answer.
    audioInput: "auto",
    maxAudioSeconds: 600,
    maxAudioBytes: 20 * 1024 * 1024,
    // Empty: nobody's voice leaves the conversation's own provider unless the operator says where.
    transcribeProvider: "",
    transcribeModel: "whisper-1",
  },
  jobs: {
    // Five: past the median background job here (16s) by far, so an ordinary one never meets it, and
    // soon enough that a person waiting on a long one hears something before they start to wonder.
    quietAfterMinutes: 5,
  },
  delegate: {
    // Unset: what the machine has room for, four at most (`commons/machine.ts`). A number written here would hold a
    // phone and a server to the same one. 0 turns background helpers off.
    maxBackground: undefined,
  },
  missions: {
    // One mission per agent. On the box, unset: what the machine has room for, four at most, and no more than its
    // agents could run (`missions/slots.ts`). A person may set it as high as every agent at once.
    perAgent: 1,
    maxRunning: undefined,
    // A working day, a hundred turns of up to `max_tool_iterations` steps each, and 100 million tokens — a million a turn,
    // above nine in ten chat turns measured on a live box (807 turns over 14 days to 2026-10-24: ~190k at the median,
    // ~880k at the 90th percentile). Raised from 50 and 50 million in 0.8.0: long work should not stop to
    // ask at half a day's steps. Reaching one asks to go on; it never fails the mission.
    limitHours: 8,
    limitTurns: 100,
    limitTokens: 100_000_000,
  },
  alerts: {
    // Empty by default: a fresh checkout has no bot and no chat id to send to, and inventing one
    // would be a config that looks wired and is not. Boot warns when a gateway is enabled and this
    // is still empty, because that is the case where silence actually costs something.
    gateway: "",
    chatId: "",
    cooldownMs: 5 * 60_000,
  },
  dashboard: {
    enabled: true,
    host: "127.0.0.1",
    port: 18254,
    // Empty rather than a guess. See `DashboardSection.publicUrl`.
    publicUrl: "",
    /**
     * Off. An empty issuer is the switch, so a fresh install has password login and nothing else —
     * which is the only thing it *can* have: a client id is issued by a provider, per install, and
     * no default can invent one.
     */
    oauth: {
      issuer: "",
      clientId: "",
      secretName: "",
      label: "Nouverse",
    },
    /**
     * On, and it has to be: a fresh install has no identity provider, so this
     * is the only way in. Turning it off is a deliberate act on an install that
     * has arranged an alternative, and `validate()` checks that it has.
     */
    passwordLogin: true,
  },
  control: {
    enabled: true,
    chat: true,
  },
  gateways: [],
  llm: {
    defaults: {
      provider: "",
      model: "",
      // Empty: `model`. The cheaper and the strongest models of the install, for the work an agent starts on a tier.
      smallModel: "",
      highModel: "",
      /** 0 is "by model" — each model's own figure, 8192 for one Nouride does not know (`llm/output-cap.ts`). */
      maxTokens: 0,
      temperature: 0.7,
      /** Unset: each provider's own — no level suits every model, and a model that does not think is sent none. */
      effort: undefined,
      /** None: a turn whose model cannot answer ends with what its provider said, unless the agent's pack names some. */
      fallbacks: [],
    },
    limits: {
      /**
       * A ceiling on every request's `max_tokens`, whatever chose it. 32,000 — the model table's own figure — so it
       * never undercuts a model-aware cap; it was 16,384, which did (`llm/output-cap.ts`).
       */
      maxTokensPerTurn: 32_000,
      /**
       * 250, so one turn can carry a long piece of work through — a refactor, a debugging session —
       * the way a coding agent does, instead of stopping at 25 to ask whether to go on. Within the turn,
       * as the context fills, old tool output and the text old writes and edits carried are cleared from
       * it, oldest first (`trimToolResults`); `/stop` ends one at once.
       */
      maxToolIterations: 250,
      /**
       * An hour, for the same reason, and the most a turn may be given (`TURN_SECONDS_MAX`).
       *
       * Was five minutes, then ten: chosen against chat work, and short for a build, a test suite, or
       * work that takes a coding agent an afternoon. A turn cut off half-way reports a half-finished job,
       * which costs the whole turn again.
       *
       * It is a ceiling, not a target: the overwhelming majority of turns finish in seconds and pay
       * nothing for this being larger. What it costs is the tail — see `queue_timeout_ms`, which is
       * matched to it deliberately and has to move with it.
       */
      maxTurnDurationMs: 3_600_000,
      // 0 = off, and now that means off rather than unimplemented. Every model call is metered
      // (`llm/metered.ts`), and a turn over the cap is refused *before* the provider is called —
      // discovering the limit after the money is gone is not enforcement.
      //
      // Still zero by default: a cap nobody asked for that stops an agent mid-job is a worse first
      // experience than no cap. Set it once you know what a normal day costs, which the dashboard now
      // shows.
      //
      // The figure cannot see models with no published price. Those are counted separately and said
      // out loud rather than folded in as zero.
      maxDailyCostUsd: 0,
      costAlertThresholdPct: 80,
      // Off, like the dollar cap, and for the same reason: a ceiling nobody chose is a ceiling that
      // stops a legitimate day's work at a number this file invented.
      maxDailyTokens: 0,
    },
    streaming: {
      enabled: true,
      typingIndicator: true,
      // On by default. The failure it removes is the one every operator hits first: a turn that reads
      // four files and runs a command is indistinguishable, from a phone, from a bot that has hung.
      progressInChat: true,
    },
    context: {
      maxContextRatio: 0.8,
      /**
       * What happens when a conversation outgrows its budget.
       *
       * `sliding_window` drops the oldest turns. Correct for *fitting*, and wrong for *remembering*:
       * an agent an hour into a piece of work has no record of what it already changed, so it repeats
       * a step or reports success for one it can no longer see.
       *
       * `summary` replaces those turns with one compacted note and **persists it**, so the cost is paid
       * per compaction rather than per turn: one call for a stretch that fits half the summarizer's window,
       * one per piece of one that does not. Each is metered under the turn, as a compaction.
       *
       * Now the default, reversing the earlier reasoning ("it spends money on a background call that a
       * short chat never needs, and a wrong summary is a quieter failure than a missing turn"). Two
       * things changed. A short chat never pays either way — neither mode does anything until the
       * history crosses `compact_at_ratio`, and by then the alternative is not "keep the turns", it is
       * "lose them". And `compactHistory` degrades *to* `sliding_window`: a failed or empty summary
       * returns the history untouched and truncation proceeds exactly as before. So the downside is
       * bounded at the old behaviour, while the upside is an agent that still knows what it did an
       * hour ago — which is the whole point of a daemon meant for long work.
       */
      truncationStrategy: "summary",
      preserveRecentTurns: 4,
      /** Empty uses the agent's own model. A cheaper one here is the obvious economy. */
      summaryModel: undefined,
      // 80%: enough headroom that compaction and trimming happen while there is still room to work in,
      // late enough that a short conversation never pays for either.
      compactAtRatio: 0.8,
      // Unset: each model gets its own figure (`compactionLimitInfo`), and an agent's `[llm]
      // compact_at_tokens` beats that. Present as a key so the merge accepts it from a file. Was a
      // flat 120k of history alone — far below the ~610k the ratio produced on a million-token window,
      // where nothing ever compacted and one turn billed 12M input tokens.
      compactAtTokens: undefined,
      // Three, because a tool loop's live working set is usually the last read plus the two calls it
      // led to. Keeping fewer starts costing the model the thing it is mid-way through using.
      preserveRecentToolResults: 3,
    },
  },
  queue: {
    maxConcurrentPerAgent: 1,
    // Eight: high enough that a personal deployment never meets it, low enough that a busy one cannot
    // turn a burst of chats into a rate-limit wall and a bill nobody chose. Messages over the ceiling
    // queue rather than drop, and a drop is now said out loud.
    maxConcurrentTurns: 8,
    maxQueueDepth: 20,
    // Matched to `max_turn_duration_ms`, not chosen independently. At 120s a message queued behind one
    // full-length turn was dropped before it ever ran — the timeout fired while the thing it was
    // waiting for was still legitimately in progress. It moved from 300s to 600s to an hour with the
    // turn clock, and has to keep moving with it: a queue that expires sooner than a turn may legally
    // run drops the next message in a busy chat, silently and only while something long is in flight.
    queueTimeoutMs: 3_600_000,
    // On: a long turn should hear "use the staging DB" at its next step, not an hour later.
    steer: true,
    // On: "siap, abis ini gw pindah ke staging" says more than a fixed line, for a few hundred tokens.
    steerReply: true,
    steerReplyModel: "",
    // A reasoning model through a gateway took ten seconds for one sentence, live; past fifteen the turn has
    // usually read the message already, and the line would be answering for a step it cannot shape.
    steerReplyTimeoutMs: 15_000,
  },
  attachments: {
    maxSizeMb: 50,
  },
  retention: {
    /**
     * Thirty days of conversation, thirty of audit.
     *
     * It was ninety, chosen so that "what did it do last quarter" stayed answerable. That reasoning
     * was about the *audit log*, and it got applied to the conversation window by proximity — where
     * it buys much less and costs much more. A transcript is the bulky one: it carries every turn,
     * every step, every room message, and now the attachment bytes as well, since a file is part of
     * what was said and lives as long as the saying.
     *
     * Thirty is what the install this was measured on had already been set to by hand, which is the
     * strongest evidence available about what the number should be. A month covers "what did we
     * decide about this" — and anything worth longer than that belongs in `MEMORY.md`, which no
     * sweep touches.
     *
     * `0` on either one keeps everything: the off position, not "delete all".
     */
    sessionDays: 30,
    auditDays: 30,
    /**
     * Two directories of transient files the daemon writes and nothing ever deleted.
     *
     * `data/jobs/*.log` is a background command's output; `data/tool-output/<agent>/<conversation>/` is a tool
     * result too big for the context. Both are pointers the agent may still be holding, so neither can
     * be deleted at the end of a turn — and until now that meant never. A live install was found with
     * job logs a week old, which was harmless only because the jobs had been small.
     *
     * Different numbers because they are different bets. A job log is something an operator might go
     * looking for tomorrow; a spilled tool result is something the agent reads within the turn or the
     * one after it, so keeping it two days is already generous. `0` disables a sweep rather than
     * deleting everything. Job logs were fourteen days until 0.8.12; now three, as the daemon log keeps.
     */
    jobLogDays: 3,
    toolOutputDays: 2,
    /**
     * Three days of scratchpad. Long enough for "kirim ulang yang tadi" the next morning, short
     * enough that a chatty agent's screenshots never become a disk problem.
     */
    scratchpadDays: 3,
    /**
     * Three days of the daemon's own log lines.
     *
     * Enough for "it broke overnight"; short enough that the busiest table in the database is also
     * one of the smallest. The journal keeps the rest, and `[retention] log_days = 0` turns the
     * table off as a store without turning off the logging.
     */
    logDays: 3,
  },
  /**
   * Off, and the default is the right answer for almost every install.
   *
   * A gateway serving several machines has no business living inside one of them — and today both
   * boxes here reach a remote one and pay nothing for it. Hosting it here is for a device that has
   * to work without a network, and it costs a shared crash domain: a bug in a provider adapter is
   * then one stack frame from the agent daemon.
   */
  nougate: {
    // Off on every build, whichever edition carries it: switched on by the setup wizard's "Use Nougate", the LLM
    // Gateway page, or this key. An install that ran it on Router's default has the key written for it
    // (`boot/router-gateway.ts`).
    inProcess: false,
    // Beside the daemon's own 18254 rather than nougate's usual 3000: a gateway hosted here is part
    // of this install, and its port should read like one.
    port: 18256,
  },
  // The newest release, as every install took before tracks existed (0.8.18).
  update: { track: "latest" },
  rollover: {
    // Off by default: rolling a conversation over is a visible behaviour change in every chat, not
    // something an upgrade should start doing on its own. Memory does not need it — episodes are cut
    // from the turn log — so this only decides how long a context runs before it starts fresh.
    mode: "none",
    // 4am, not midnight — a conversation running at 1am belongs to the evening it started in.
    atHour: 4,
    // Only consulted in `idle` mode. Six hours is a gap that means the conversation ended rather
    // than paused.
    idleMinutes: 360,
  },
  memory: {
    // Beside the packs, never inside them: `agents/` is usually a git repository.
    dir: "./.nouride/memory",
    // Off until the setup wizard's last step asks: it spends model calls while nobody is watching.
    pass: false,
    // One in the morning: after the evening's conversations, before anyone starts the next day.
    passAt: "01:00",
    passPerNight: 20,
    // No limit of its own: the count above and [llm.limits] bound a night, as before it existed. A box that raises the
    // count to keep up sets one, so a night of hundreds of conversations costs what it was told it may.
    passMaxTokens: 0,
    passProvider: "",
    passModel: "",
    maxAttempts: 3,
    // Off until someone chooses it: what the agents learn about a person is theirs to decide on.
    facts: "off",
    proposeShared: false,
    // Three summaries is a couple of hundred tokens: enough to know what happened lately, and RECALL already lists the
    // conversations not filed yet beside them; `memory_search` reaches older ones.
    promptRecent: 3,
    // On: what an agent remembers is what makes it the same agent tomorrow. Off is for a person who would rather it asked.
    recall: true,
    // Half a year of verbatim transcript; the summary is kept forever. `0` keeps transcripts forever.
    transcriptDays: 180,
    archive: true,
    // Off: it needs a provider that embeds, and naming one is a decision about where text is sent.
    semantic: { enabled: false, provider: "", model: "", dimensions: 512 },
  },
  // Off: turning it on opens memory to whoever holds a token, and that is a decision, not a default.
  mcpServer: { enabled: false },
  // Empty by default: a fresh install has no idea who its operator is, and inventing an entry would
  // be a config that looks wired and is not.
  people: [],
  externalClis: [],
  cron: {
    enabled: true,
    // A minute. Anything a person schedules is coarser than this, and anything finer is a poll
    // that wants `every` on a background job rather than the scheduler.
    minIntervalMs: 60_000,
    maxJobs: 100,
    // Three days, as the daemon log and job output keep (0.8.12); it was fourteen.
    runRetentionDays: 3,
    catchupWindowMs: 3_600_000,
    failStreakLimit: 10,
    quietHours: "",
    unattendedApproval: "auto",
    // Ten minutes: long enough for a backup or a test suite, short enough that a hung command is
    // noticed on the next run rather than holding a slot forever.
    commandTimeoutMs: 600_000,
  },
  skills: {
    /**
     * Empty: every skill in the pool is offered to every agent unless that agent's own
     * `skills.toml` says otherwise.
     *
     * This list is the other axis — off for everyone, whatever the packs say. It exists because a
     * built-in cannot be deleted, so switching it off is the only removal it has.
     */
    off: [],
    /**
     * Propose, and wait for a person.
     *
     * `auto` is what Hermes does and it is not the safe default for a daemon somebody else may be talking to: a skill is
     * read by every agent it is on for on every matching turn, so a wrong one is wrong repeatedly and quietly. The
     * operator who wants the loop closed says so.
     *
     * On by default, and what makes that safe is the trigger rather than the loop: it looks only after a turn that
     * failed several times and recovered, a long stretch of work, a tool this agent had not used before, or somebody
     * asking for a skill in words — and not past today's cap. Every call is metered under the turn, as a reflection.
     *
     * The model is empty — the agent's own, like `[llm.context] summary_model`: naming one would be a guess about the
     * operator's provider list.
     */
    learning: { mode: "ask", model: "", notifyChat: true },
  },
};

/**
 * Frozen all the way down. Every config is built from a copy of these (`parseConfig` clones them), and a save changes
 * the running config in place (`config/follow.ts`) — so a config built by spreading these instead, as tests do, would
 * have a save write into the defaults themselves, and every config after it start from the changed value. Frozen, that
 * is a TypeError at the write rather than a setting that leaks into the rest of the process.
 */
function freezeAll(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeAll(child);
}
freezeAll(DEFAULT_CONFIG);

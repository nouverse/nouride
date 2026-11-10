/** Daemon configuration — §20 SPEC. Mirrors config.example.toml one-to-one. */

import type { ApprovalLevel, ExternalCliConfig, FallbackPair } from "./agent.ts";
import type { LogLevel } from "../logger.ts";
import type { GatewayName } from "./envelope.ts";
import type { LlmEffort, ProviderKind } from "./llm.ts";

export interface DaemonSection {
  name: string;
  logLevel: LogLevel;
  /** Human-readable console output instead of JSON lines. Dev only. */
  logPretty: boolean;
  /**
   * Daemon-owned state: the database, the secret store, the control token, attachments, backups.
   *
   * Everything under here is the daemon's, and none of it is the operator's work product. That split
   * is the reason `workspaceDir` is a separate key rather than a subdirectory of this one — see there.
   */
  dataDir: string;
  /**
   * Persona packs — one directory per agent, holding `IDENTITY.md`, `SOUL.md` and `MEMORY.md`.
   *
   * Config-as-code, and meant to be version-controlled. Nothing mutable that an agent produces goes
   * in here.
   */
  agentsDir: string;
  /**
   * Where agents do their work.
   *
   * Split out of `dataDir` deliberately. Work product and daemon state have different backup
   * policies (`docs/DEPLOY.md` says to keep `data/` for the conversations and grants inside it — a
   * rule that made no sense while the operator's half-built project lived there too), different
   * sensitivity, and different size. Keeping them apart also means this one can point at another
   * disk without dragging the database along.
   *
   * Contains `shared/`, reachable by every agent, and `private/<id>/` for one agent alone.
   */
  workspaceDir: string;
  shutdownTimeoutMs: number;
  /**
   * The agent that answers a message addressed to nobody (0.7.18; `default_agent` before): a DM with no bot of its own,
   * the dashboard and `nouride chat` when no agent is picked, and a room several of our bots share — where it is the
   * front desk, the one answer, unless that room requires a mention.
   */
  orchestrator?: string;
  /** IANA zone used in the system prompt's runtime block. */
  timezone: string;
  /** Dated persona-pack snapshots to keep under `data/backups/agents/`. 0 disables it. */
  backupKeep: number;
  /**
   * Where the scheduled snapshots go — the database, the memory vault, the persona packs — instead of
   * `<dataDir>/backups`. Empty means there; absolute once loaded.
   *
   * For a box on an SD card or eMMC, a USB drive: snapshots are the largest writes this daemon makes,
   * and the card is what they exist to outlive. Never created — `commons/backup-dir.ts` says why.
   */
  backupDir: string;
  /**
   * The secrets in the snapshots, sealed to a passphrase (0.8.18): `nrseal1:<salt>:<public key>`, which
   * `nouride secret seal` writes. Only the public half of the key the passphrase derives is here, so the daemon seals
   * every config snapshot's `secrets.sealed` and opens none. Empty: no secret goes into a snapshot.
   */
  backupSeal: string;
}

/**
 * A named endpoint an agent can talk to.
 *
 * The unit of configuration is the *endpoint*, not the vendor: a credential belongs to a
 * base URL, and one credential often serves several endpoints. A Nougate deployment
 * exposes both wire formats on one key, which two profiles express by naming the same
 * secret — the earlier "one env var per vendor" shape could not say that at all.
 */
export interface ProviderProfile {
  /** Which wire format to speak. Not which company: a proxy can serve either. */
  kind: ProviderKind;
  baseUrl: string;
  /** Name of the secret holding the credential — never the credential itself. */
  apiKeySecret: string;
  /** Extra headers, e.g. OpenRouter attribution or a gateway key. */
  headers?: Record<string, string>;
  /**
   * Say which agent and conversation each request is for — the fields a gateway such as Nougate tells its
   * clients and sessions apart by, and that route a conversation to the cache its prefix is already in. Off unless
   * set: a strict server rejects a field it does not know. A profile on OpenAI's or Anthropic's own API is written
   * with it (`known-endpoints.ts`). The conversation goes as a digest, the agent by its id.
   */
  identify?: boolean;
  /**
   * How calls through this profile are billed. `included`: a subscription that costs nothing per token — Nougate's
   * OAuth accounts — so they are kept out of `max_daily_cost_usd` and still counted by `max_daily_tokens`, and the
   * spend says so instead of showing a list price as money spent. Absent is `metered`, priced from the price book.
   */
  billing?: "metered" | "included";
  /**
   * The request field that carries a reply's output ceiling on the OpenAI wire. OpenAI's own API refuses `max_tokens`
   * for its newer models and takes `max_completion_tokens` for every chat model; a server that speaks the same format
   * may know only `max_tokens`. Absent is `max_tokens`, what every such server reads.
   */
  maxTokensField?: MaxTokensField;
  /**
   * Minutes this endpoint keeps a conversation's cached prompt after its last request (`cache_minutes`), from the
   * profile or, for an endpoint known by its address, from the known endpoints' table. Idle past it, the cache is
   * gone, and that is the moment old tool output is cleared from the history for nothing. Absent: not known.
   */
  cacheMinutes?: number;
}

/** Where an OpenAI-shaped request puts its output ceiling (`ProviderProfile.maxTokensField`). */
export type MaxTokensField = "max_tokens" | "max_completion_tokens";

export interface RateLimitSection {
  messagesPerMinute: number;
  cooldownReply: string;
}

/**
 * What a human answered.
 *
 * `allow-always` is the one that makes the gate survivable, and the one that needs care: it is
 * bound to an exact command identity, and some classes of command can never earn it.
 */
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

/**
 * Exec's configuration. Whether a command runs, asks or is refused is `@nouride/policy`'s, under the approval level
 * (`[security] approvals`): 0.8.0 took the four knobs that guessed at it — `mode`, `ask`, `ask_fallback`,
 * `sensitive_paths` — and the editable allowlist into the levels and one fixed list. What is left is
 * the ceilings on a command, and the operator's own veto.
 */
export interface ExecPolicySection {
  /** Megabytes of address space a command may claim. 0 = unlimited. Linux only. */
  maxMemoryMb?: number;
  /** Seconds of CPU a command may burn. 0 = unlimited. Linux only. */
  maxCpuSeconds?: number;
  /**
   * Landlock on top of each agent's own user (0.8.0): `auto` where the kernel has it, `require` runs nothing where it
   * does not, `off`. Only where the helper runs commands as their agents — it is the helper that applies it. Absent is
   * `auto`, the default.
   */
  landlock?: "off" | "auto" | "require";
  /**
   * Refused before anything else: beats a durable grant and every approval level.
   *
   * The one rule no runtime answer can override, which is why it is the right place for
   * "never on this machine, whatever I click at 2am".
   */
  blocked: string[];
}

/** Outbound fetch policy — see `apps/engine/src/modules/tools/url-safety.ts`. */
export interface WebPolicySection {
  /**
   * Permit private, loopback and CGNAT addresses.
   *
   * Off by default. On a server, an agent that can fetch `127.0.0.1` or the LAN can read every
   * service that assumed only the host could ask it — and a prompt is enough to make it. Cloud
   * metadata stays blocked either way.
   */
  allowPrivateUrls: boolean;
  /**
   * Which search service `web_search` uses: `brave`, `searxng` or `exa`.
   *
   * Typed as a string rather than the union, because config arrives from a file an operator wrote and
   * an unknown value has to reach a validator that can name it — not fail to parse with a type error
   * from somewhere else entirely.
   */
  searchKind: string;
  /** Empty uses the backend's own default. Required for one that has none, such as SearXNG. */
  searchEndpoint: string;
  /** The **name** of the credential, resolved by `@nouride/secrets`. Never the value. */
  searchApiKey: string;
  /**
   * Whether to fall back to alternative search backends when the primary fails at runtime
   * (HTTP 429, 5xx, timeouts). Defaults to true.
   *
   * When enabled, a failed primary search cascades to the fallback chain before returning
   * an error to the agent. When disabled, a primary failure is reported immediately.
   */
  fallbackEnabled: boolean;
  /**
   * Explicit fallback backend chain. Defaults to `["duckduckgo"]`, which uses the keyless
   * scraping chain.
   *
   * Only consulted when `fallbackEnabled` is true and the primary configured backend fails
   * at runtime. `"duckduckgo"` means the keyless provider chain (same as what runs when no
   * API key is configured). Other search kinds (`"brave"`, `"searxng"`, `"exa"`) can be listed if
   * the operator has multiple backends configured — but that is a future extension.
   */
  fallbackBackends: string[];
}

/**
 * How a stranger becomes someone the daemon will act for.
 *
 * `pair` is the default because the other two are each wrong for a different reason: `open` means
 * anyone who finds the bot can run the agent's tools, and `allowlist` is correct but adding a person
 * requires editing a file and restarting.
 */
export type AccessMode =
  /** Anyone may talk to it. Only sane for a daemon with no chat gateway. */
  | "open"
  /** Only ids in `allowlist`. Anyone else is dropped in silence — no reply, no error. */
  | "allowlist"
  /** An unknown sender gets a pairing code; the operator approves it and they are remembered. */
  | "pair";

export interface AccessSection {
  mode: AccessMode;
  /**
   * Pre-approved senders, honoured in every mode.
   *
   * Two spellings: `telegram:nouva:123456789` (fully qualified) or a bare `123456789`. Reach for the
   * qualified form when one daemon runs bots on more than one platform — a Telegram user id and a
   * Discord snowflake are both numeric, so a bare id can match on the wrong platform.
   */
  allowlist: string[];
  /** How long a pairing code stays usable. Long enough to forward, short enough not to linger. */
  codeTtlMs: number;
  /**
   * Minimum gap between "I do not know you" replies to the same sender.
   *
   * Without it an unknown sender can make the daemon answer every message they send, which is both a
   * way to spam a chat and a way to bury the operator in pair requests.
   */
  notifyCooldownMs: number;
  /**
   * How long a denied sender is ignored before a message from them is a new request.
   *
   * Deny is "no, this time". It used to be for good, which made one "no" pressed at a code nobody
   * recognised a ban with nothing on any screen to say so. Block is the one that lasts.
   */
  denyCooldownMs: number;
}

/**
 * How agents behave towards each other.
 *
 * Separate from `[security]` because this is not a permission — an agent mentioning another is
 * ordinary use, and the limit here is about cost and noise rather than about what anyone is allowed
 * to reach.
 */
export interface AgentsSection {
  /**
   * Whether an agent may address another by name and have it answer.
   *
   * With this off, a message from one of our own bots is treated the way every bot message used to
   * be: ignored. That is the behaviour that existed before, kept reachable in one line.
   */
  mentionsEnabled: boolean;
  /**
   * Agent-to-agent messages allowed in one chain before mentions stop being followed.
   *
   * The hard brake. The soft one is the convention that a mention hands work over and a reply without
   * one closes it — but a model cannot be relied on to *not* do something, and every hop is a paid
   * provider call. Reset whenever a human speaks.
   */
  mentionMaxHops: number;
  /**
   * How many times a finished background job may wake an agent with no person having said anything.
   *
   * The second unattended budget, and it is here because it answers the same question
   * `mentionMaxHops` does: how far may this run without me. A job that finishes wakes its agent, that
   * turn often starts the next step, and its completion wakes the agent again — a chain with nobody in
   * it, each hop costing a provider call. Watched live: nine in a row during a nine-step install, which
   * was legitimate and is exactly why the ceiling is high.
   *
   * At the limit the wake-up is still **delivered** — suppressing it would hide the very failures this
   * budget was added alongside — and the agent is told to report the result and start nothing further.
   * Any message from a person resets the count.
   *
   * `0` lifts the ceiling, for an install that wants an agent working unattended for a day.
   */
  jobWakeMaxChain: number;
  /**
   * Minutes before work that runs long is nudged — then at double, and double again (5, 10, 20, 40…). `0` is off.
   *
   * Never a kill (the turn's clock stays the one hard stop). A delegate — a helper, an agent asked with `ask_agent` — is
   * told before its next step to stop and report honestly if it is stuck, and once it works in the background the
   * agent that started it is told too; a chat turn somebody is waiting on is asked for a one-line status
   * (`pipeline/budget-nudges.ts`). Daemon-wide: one number, the same rhythm as `[jobs] quiet_after_minutes`.
   */
  nudgeAfterMinutes: number;
  /**
   * Whether unaddressed messages in group chats are ignored.
   *
   * When true, an agent in a group chat only answers if explicitly tagged (@mention or name prefix)
   * or replied to. DMs are unaffected and continue answering all messages.
   */
  groupsRequireMention: boolean;
  /**
   * Messages from a group chat replayed as context when an agent is finally addressed. 0 is off.
   *
   * Unaddressed chatter still triggers nothing — it is remembered, not answered. What changes is that
   * "@nouva ini" arrives with the exchange it points at instead of on its own.
   *
   * Overridable per connection with `group_context_messages` on a `[gateways.*]` entry.
   */
  groupContextMessages: number;
}

/**
 * Ceiling on `group_context_messages`, wherever it is set.
 *
 * Lives beside the field because three layers bound it and they have to agree: the config loader
 * refuses a larger number, the dashboard field will not offer one, and the buffer re-applies it to a
 * value the dashboard wrote into the live config without going through the loader. The block rides on
 * every turn in the room, so this is a recurring token bill rather than a one-off — a hundred short
 * messages is already a few thousand tokens ahead of the actual question.
 */
export const GROUP_CONTEXT_MAX = 100;

export interface SecuritySection {
  /** The daemon-wide fallback level. See `@nouride/policy`'s `approvals.ts`. */
  approvals: ApprovalLevel;
  /**
   * The second look (0.8.0, `model-guard.ts`): empty is by the approval level, `"off"` is off, a tier or a model id is
   * on everywhere. A pack's `[security] model_guard` says it for its agent.
   */
  modelGuard: string;

  toolTimeoutMs: number;
  toolMaxOutputBytes: number;
  approvalTimeoutMs: number;
  maxConversationTurns: number;
  /**
   * How long a background job may run before the daemon stops it — SIGTERM to everything it started, SIGKILL after
   * five seconds — and wakes its agent to say it did not finish. Wall-clock from the start, unlike `[jobs]
   * quiet_after_minutes`, which counts silence and never stops anything. `0`, the default, never stops a job.
   *
   * A service (`service: true`, or a command `exec` recognises as a server) is exempt: running is its job, the same
   * reason it has no CPU-seconds ceiling. The agent decides which a job is, so this stops a runaway, not an agent
   * set on running long. Daemon-wide and here rather than in a pack because a pack is writable by its agent.
   *
   * Read at boot: changing it takes a restart, and a restart stops every running job anyway.
   */
  jobMaxMs: number;
  rateLimit: RateLimitSection;
  access: AccessSection;
  exec: ExecPolicySection;
  web: WebPolicySection;
  /**
   * Where file-shaped credentials live — a service-account JSON, an OAuth token cache.
   *
   * Some credentials cannot be an environment variable: a Google service account is a file a library
   * opens by path, and an OAuth token cache is a file that gets *rewritten* on refresh. Those need a
   * directory, and the directory must not be one the model can read.
   *
   * So it is deliberately **not** a workspace root. `read`, `glob` and `grep` cannot reach it; only a
   * child process can, through `$NOURIDE_CREDENTIALS_DIR`. That distinction is the whole design: a
   * script the operator wrote may open the file, while the agent cannot pull it into a conversation —
   * and a credential that reaches the context window is in the provider's request log, in the session
   * on disk, and in whatever the model says next.
   *
   * Empty means `<data_dir>/credentials`. An absolute path elsewhere works, but the daemon must be
   * able to write there: under systemd that means adding it to `ReadWritePaths`, and boot says so if
   * it cannot.
   */
  credentialsDir: string;
}

/**
 * Background jobs, and what the daemon does about a long one on its own: say it is still going. Stopping one that
 * runs too long is `[security] job_max_ms`, and off unless the operator sets it.
 */
export interface JobsSection {
  /**
   * Minutes a running job may print nothing before its agent is woken to tell the person it is still
   * running — then again at twice that, four times, eight: 5, 10, 20, 40, 80… by default. New output
   * starts the count over. `0` never tells.
   *
   * Nothing is stopped for being quiet. A build that captures its output until the end is silent the whole way
   * and perfectly healthy, and the daemon cannot tell it from one that hung — least of all when the work
   * runs on another machine over ssh. So it tells, and the agent and the person decide.
   *
   * An agent can set its own in `[jobs] quiet_after_minutes`.
   */
  quietAfterMinutes: number;
}

/**
 * How long this agent's jobs may be quiet, in milliseconds, before the first notice. `0` is off.
 *
 * Absent follows the daemon, like the turn budget. A negative or non-finite number is treated as off
 * rather than as a notice every tick: this is a number an agent with write access to its pack can edit.
 */
export function resolveQuietAfterMs(perAgentMinutes: number | undefined, daemonMinutes: number): number {
  const minutes = perAgentMinutes ?? daemonMinutes;
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}

/**
 * Helpers that work in the background — `delegate` with `background: true` (0.7.15). Each is a job of its own, and
 * its result wakes the agent that started it when it arrives.
 */
export interface DelegateSection {
  /**
   * How many background helpers one agent may have running at once. Unset, it follows the machine: four at most, fewer
   * where its cores or memory are few (the engine's `commons/machine.ts`). 0 turns them off — `delegate` then works
   * only in the foreground, where the agent waits for its helpers.
   *
   * An agent can set its own in its pack's `[delegate] max_background`.
   */
  maxBackground: number | undefined;
}

/**
 * Missions (0.8.0): long work an agent finishes alone — the five limits a person may want to move. Everything else
 * about a mission is a constant in the engine
 * (`modules/missions/limits.ts`): nobody would tune it, and each is one more thing a Box owner could set wrong.
 */
export interface MissionsSection {
  /** Missions working at once for one agent — one being checked runs its reviewer, not the agent, and is not counted (0.8.11). 1. */
  perAgent: number;
  /**
   * Missions running at once on the box. Unset, it follows the machine, four at most, and never more than every agent
   * at its own `per_agent` could run (`missions/slots.ts`).
   */
  maxRunning: number | undefined;
  /** Hours a mission may work, waits on a person left out. 8. */
  limitHours: number;
  /** Turns, the reviewer's and failed checks' included. 100. */
  limitTurns: number;
  /** Input and output tokens, its helpers and the reviewer included. 100 million, as measured. */
  limitTokens: number;
}

/**
 * The most missions one agent may have working at once: the daemon's `[missions] per_agent`, and an agent's own in its
 * pack's `[missions]` (0.8.11), which is held to the same.
 */
export const MOST_MISSIONS_PER_AGENT = 4;

/** Why this many is not allowed for one agent, or null when it is — the pack loader's and the dashboard's one rule. */
export function missionsPerAgentRefusal(value: unknown, where: string): string | null {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MOST_MISSIONS_PER_AGENT) {
    return `${where} must be a whole number from 1 to ${MOST_MISSIONS_PER_AGENT}, got ${JSON.stringify(value)}`;
  }
  return null;
}

/**
 * The most background helpers one agent may run at once, whatever it is set to.
 *
 * Four, the fan-out the foreground `delegate` has always had. A helper does not take a slot under `[queue]
 * max_concurrent_turns` — it exists so the agent stays free for the person, and one that held a chat's slot would be
 * the thing keeping the person waiting — so this, per agent, is what bounds them.
 */
export const MAX_BACKGROUND_HELPERS = 4;

/** Why this many is not allowed, or null when it is — the pack loader's, the config's and the dashboard's one rule. */
export function maxBackgroundRefusal(value: unknown, where: string): string | null {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_BACKGROUND_HELPERS) {
    return `${where} must be a whole number from 0 (off) to ${MAX_BACKGROUND_HELPERS}, got ${JSON.stringify(value)}`;
  }
  return null;
}

/**
 * How many background helpers this agent may run at once: its own number when its pack names one, the daemon's
 * otherwise. Read at the moment one is started, so a change from the dashboard applies to the next. Anything that is
 * not a whole number from 0 is read as off — this is a number an agent with write access to its pack can edit.
 */
export function resolveMaxBackground(perAgent: number | undefined, daemon: number): number {
  const chosen = perAgent ?? daemon;
  return Number.isInteger(chosen) && chosen > 0 ? Math.min(chosen, MAX_BACKGROUND_HELPERS) : 0;
}

/**
 * Reading what arrives as media.
 *
 * Openclaw keeps a list of media-understanding models with capability tags, because the model that
 * holds a conversation and the model that reads a screenshot need not be the same one — and the
 * cheap one is usually right for the second job.
 *
 * Ours is one knob, because there is one capability so far. Empty means **use the agent's own
 * model**, which is the honest default: Sonnet on a Nougate deployment is multimodal, so an operator
 * who configures nothing gets working image reading rather than a feature that silently does nothing.
 */
export interface MediaSection {
  /**
   * Model for reading images, `provider:model-id` as Nougate namespaces them.
   *
   * **Empty means the image goes to the conversation model itself, as a picture.** That is the
   * default and it is what you want: the model sees the layout, the colours and where things
   * overlap, rather than somebody else's prose about them.
   *
   * Setting it switches that off and restores the older shape — a separate call whose output is
   * text, injected as text. Two reasons to want that, and they are both real: the conversation
   * model cannot see, or it can and a cheaper one should do the looking
   * (`antigravity:gemini-3.1-flash-lite`) because images arrive often.
   *
   * The cost of the second reason is the thing to know before choosing it: a description carries no
   * coordinates. It is the right trade for "what does this error say" and the wrong one for "why do
   * these two elements overlap".
   */
  imageModel: string;
  /**
   * Whether to look at images at all.
   *
   * Off is a legitimate posture, not a bug: every image becomes a model call someone pays for, and an
   * operator who does not want that should be able to say so without the agent then pretending it
   * cannot see anything for an unrelated reason.
   */
  readImages: boolean;
  /** Cap per image. Beyond it the agent is told the image was too large to look at. */
  maxImageBytes: number;
  /**
   * Whether voice notes and audio files are sent to the model at all.
   *
   * On, a clip goes to the conversation model as sound — **only when that model is known to hear**.
   * Off, and it never does, and the agent says it was not listened to rather than guessing.
   */
  readAudio: boolean;
  /**
   * Who decides a model can hear. `auto`: the gateway's `/models` listing, and nothing else — a model
   * it does not say hears is treated as deaf, because a gateway that drops audio silently looks
   * exactly like one that says nothing. `always`: the operator vouches for it, and audio goes as mp3.
   */
  audioInput: "auto" | "always";
  /** Longer clips are not sent; the agent is told the length and why. */
  maxAudioSeconds: number;
  /** Measured on the file that would be sent, after any transcode. 20 MB is OpenAI's own ceiling. */
  maxAudioBytes: number;
  /**
   * A provider profile to transcribe speech with, when the conversation model cannot hear. Empty: no
   * transcription, and the agent says it could not listen.
   *
   * Opt-in because it sends somebody's voice to a service — which may be one the operator runs at home
   * (a Whisper server on another machine), and may not.
   */
  transcribeProvider: string;
  /** The model that profile transcribes with — `whisper-1` for OpenAI, `whisper-large-v3` for Groq. */
  transcribeModel: string;
}

/**
 * Whether images go to the conversation model as pixels, or as a description of pixels.
 *
 * Derived from `imageModel` rather than being a setting of its own, and that is the honest reading
 * of what an operator has already said:
 *
 * - **empty** — "my conversation model handles images". Then it can be handed the image itself, and
 *   the description step is a round trip that loses the coordinates, the bounding boxes and the
 *   z-order, which is the information a screenshot was sent for.
 * - **set** — "use *this* model for pictures". That is what somebody writes when the conversation
 *   model cannot see, or when it can and they would rather pay a cheaper one. Either way the answer
 *   is the same: send the image to the model they named and the text to the one they talk to.
 *
 * So there is no new flag to get wrong, and the escape hatch already exists: an operator who wants
 * the old behaviour from a multimodal model names that model here.
 */
export function nativeVision(media: MediaSection): boolean {
  return media.readImages && media.imageModel.trim() === "";
}

/**
 * How this daemon reads an image, as one word.
 *
 * The same question `nativeVision` answers, plus the third case it folds away. An image that arrives
 * with a message and an image opened later by `attachment_read` have to answer it identically — a
 * daemon that shows one and describes the other is one where the agent's account of what it can see
 * depends on how the file got there.
 *
 * `off` earns its own name because the honest reply to "what is in this picture" is then that it was
 * not looked at, and the agent should say so rather than guess.
 */
export function imageMode(media: MediaSection): "native" | "described" | "off" {
  if (!media.readImages) return "off";
  return nativeVision(media) ? "native" : "described";
}

/**
 * Where the daemon reports on itself.
 *
 * Without this the only record of a dead gateway or a failing provider is a log file nobody is
 * tailing, so the operator finds out when the agent stops answering — hours later, looking like a
 * different problem.
 */
export interface AlertsSection {
  /** Gateway instance id (`telegram:nouva`). Empty disables chat alerts; logs still carry them. */
  gateway: string;
  /** Chat to send to on that gateway. */
  chatId: string;
  /**
   * Per-alert-kind suppression window.
   *
   * A reconnect loop emits the same failure every few seconds. An alert channel that repeats
   * itself gets muted, and a muted channel is worse than none because it looks like coverage.
   */
  cooldownMs: number;
}

export interface DashboardSection {
  enabled: boolean;
  host: string;
  port: number;
  /**
   * The address this daemon is reachable at from outside, when that is not `host:port`.
   *
   * Needed the moment something has to *hand out* a URL rather than serve one — a webhook endpoint
   * pasted into GitHub, for instance. The daemon knows what it bound to, which behind a reverse
   * proxy or a container port map is `0.0.0.0:18254` and reaches nobody. An agent that confidently
   * reports that address has given a wrong answer, which is worse than declining to guess.
   *
   * Empty means fall back to `host:port` and say so where it matters.
   */
  publicUrl: string;
  /**
   * Signing in with an external identity provider, instead of only a local password.
   *
   * Off unless `issuer` is set, and that is the whole switch — there is no separate boolean.
   * A flag beside these fields would add one state that can be true while the client id is
   * empty, which is a dashboard offering a button that cannot work.
   */
  oauth: DashboardOAuthSection;
  /**
   * Whether a username and password may be used to sign in.
   *
   * On by default, and turning it off is only meaningful on an install that has
   * an identity provider — so `validate()` refuses `false` unless
   * `[dashboard.oauth]` is fully configured. Without that guard the setting is
   * a way to lock yourself out of your own daemon with one line of TOML, and
   * the daemon would boot happily and serve a login page nobody can satisfy.
   *
   * It does not delete anything. Existing passwords stay in the database and
   * start working again the moment this is switched back on.
   */
  passwordLogin: boolean;
}

/**
 * An OpenID Connect client, for "sign in with <somebody else>".
 *
 * The daemon is the *client* here and never the provider. That direction is the point: a
 * self-hosted install cannot register a Google app for a domain it does not own, so the only way it
 * gets social sign-in is by trusting an issuer that already has those credentials. For Nouverse
 * that is `service.nouverse.tech` — see its `docs/OAUTH_PROVIDER.md`.
 *
 * It never replaces password login. An install whose issuer is unreachable must still let its owner
 * in, and a self-hosted box has no issuer at all.
 */
export interface DashboardOAuthSection {
  /**
   * The provider's base URL — `https://service.nouverse.tech/api/auth`.
   *
   * Empty is off. Discovery is read from `<issuer>/.well-known/openid-configuration`, so the
   * endpoint paths are the provider's business rather than something configured here.
   */
  issuer: string;
  /** The client id the provider issued for *this* install. */
  clientId: string;
  /**
   * Name of the secret holding the client secret — never the secret itself.
   *
   * Same rule as `apiKeySecret` on a provider profile: config is a file people read, paste and
   * commit, and a credential in it is a credential in a screenshot.
   */
  secretName: string;
  /** What the button says. `Nouverse` produces "Continue with Nouverse". */
  label: string;
}

/**
 * The surface the CLI drives.
 *
 * On by default, unlike a chat gateway, because it is how the daemon is operated — and it is
 * guarded by a token generated into `data/.control-token`, not left open. `chat` additionally
 * registers the in-process `local` gateway so `nouride chat` has something to deliver through.
 */
export interface ControlSection {
  enabled: boolean;
  /** Register the local gateway, enabling `nouride chat`. */
  chat: boolean;
}

/**
 * Platforms that can be configured as a connection.
 *
 * `web` — the daemon's own local connection — is excluded by type, not by a runtime check: it has no
 * token, no endpoint and no adapter in `@nouride/gateways` — the daemon creates it when the dev endpoint is on. Making
 * that a type means the config parser and the adapter factory both get it for free.
 */
export type ConfigurableGatewayName = Exclude<GatewayName, "web">;

/**
 * One gateway connection.
 *
 * Instances are named, so a multi-agent daemon can run a bot identity per agent —
 * `telegram:nouva` and `telegram:nox` are two bots, two tokens, two connections. A single
 * `DISCORD_BOT_TOKEN` could only ever describe one.
 */
export interface GatewayInstanceConfig {
  /** `platform:name`, e.g. `telegram:nouva`. Unique across the daemon. */
  id: string;
  platform: ConfigurableGatewayName;
  name: string;
  enabled: boolean;
  /** Name of the secret holding the bot token. */
  tokenSecret: string;
  /**
   * Agent that owns this bot identity.
   *
   * When set, everything arriving on this connection routes to that agent unless another
   * is explicitly addressed — which is what "one bot per agent" means in practice, without
   * having to enumerate every chat id in a binding.
   */
  agent?: string;

  /** Telegram only: it polls, the one mode there is. */
  mode?: "polling";

  /** WhatsApp only. */
  sessionDir?: string;
  encryptionKeySecret?: string;
  /** Override for `[agents] groups_require_mention` on this specific gateway instance. */
  groupsRequireMention?: boolean;
  /** Override for `[agents] group_context_messages` on this specific gateway instance. */
  groupContextMessages?: number;
  /**
   * Discord only: how much platform state this connection keeps in memory.
   *
   * Defaults are zero across the board — nothing in the adapter reads these caches, and discord.js
   * ships them unbounded. Raise one only if something starts needing it; see `DiscordCacheLimits`.
   */
  cache?: { messages?: number; users?: number; members?: number };
}

export interface LLMDefaultsSection {
  /** Name of a `[providers.*]` profile. */
  provider: string;
  model: string;
  /**
   * The install's cheaper model, and its strongest — the `small` and `high` tiers (`types/tiers.ts`). Empty: `model`.
   * An agent on this provider inherits them; its pack's own `small_model`/`high_model` beats them.
   */
  smallModel?: string;
  highModel?: string;
  /** Output per reply for an agent that sets none; 0, the default, is "by model" (the engine's `outputCap`). */
  maxTokens: number;
  temperature: number;
  /** How long a thinking model thinks, for an agent that sets none (`LLM_EFFORTS`). Unset: the provider's default. */
  effort?: LlmEffort;
  /**
   * Who answers when an agent's model cannot, for an agent whose pack names no `fallbacks` of its own — each a provider
   * and a model, in order (`AgentLLMConfig.fallbacks`). A pair that is an agent's own model is left out for that agent.
   */
  fallbacks?: FallbackPair[];
}

/**
 * How many tool round-trips one reply may take, and why it has both a floor and a ceiling.
 *
 * The number is a budget, not a safety rail: past it the turn does not fail, the model is asked to
 * summarise what it has and stop. So the cost of setting it high is paid in tokens and wall clock,
 * and the cost of setting it low is an agent that reports a half-finished job.
 *
 * **Five at the bottom.** Below that a turn cannot complete an ordinary loop — read a file, run a
 * command, read the result, decide, answer — so the agent would be capped before it could do the
 * one thing it was asked. One or two is not a tighter budget; it is a broken agent.
 *
 * **9999 at the top**, and it is a guard against a typo rather than a considered maximum. Every
 * iteration re-sends the whole conversation, so the spend of a runaway turn is quadratic in this
 * number, not linear. Somebody who means 100 and types 1000 gets a turn that can cost a hundred
 * times more than the one before it, on a model priced per token, with nobody watching.
 *
 * **50 to 250 is the range that works**, read from a month of one live box's turns (2,531, to 2026-10-17):
 * half used one tool call or none and 99% used 38 or fewer, but one in 35 used more than 25 — so 25, the
 * old default, cut real work short, and the turns that reached that box's cap of 50 were busy, not looping
 * (33 to 50 different steps of their 50). 250, the default an install ships with, carries a long piece of
 * work through one turn — a refactor, a debugging session — with the context compacted as it grows; at the
 * 7 to 12 seconds a round took there it is most of the hour a turn is given (`max_turn_duration_ms`), so a
 * bigger number is ended by the clock instead. Past it the right tool is a background job, not a bigger budget.
 */
export const TOOL_ITERATIONS_MIN = 5;
export const TOOL_ITERATIONS_MAX = 9999;
/**
 * The range every surface advises: the refusal below, `nouride tool-budget`, and the dashboard's copy
 * (`SWEET_SPOT`). Its top is the shipped default, which `config-validate.test.ts` holds inside it.
 */
export const TOOL_ITERATIONS_ADVISED = { from: 50, to: 250 } as const;

/**
 * Why this value is not allowed, or null when it is.
 *
 * One function so the global config, an agent's own pack and the dashboard's form all refuse the
 * same values with the same words. Three copies of a bound is how one of them ends up off by one,
 * and the one that is wrong is the one nobody tests.
 */
export function toolIterationsRefusal(value: unknown, where: string): string | null {
  if (!Number.isInteger(value)) return `${where} must be a whole number, got ${JSON.stringify(value)}`;
  const n = value as number;
  if (n < TOOL_ITERATIONS_MIN) {
    return (
      `${where} must be at least ${TOOL_ITERATIONS_MIN}, got ${n}. Below that a turn cannot ` +
      `finish an ordinary read, run, check, answer loop, so the agent is capped before it can do ` +
      `the thing it was asked`
    );
  }
  if (n > TOOL_ITERATIONS_MAX) {
    return (
      `${where} must be at most ${TOOL_ITERATIONS_MAX}, got ${n}. Every iteration re-sends the whole ` +
      `conversation, so a runaway turn costs more than linearly in this number; ` +
      `${TOOL_ITERATIONS_ADVISED.from} to ${TOOL_ITERATIONS_ADVISED.to} is the range that works, and a turn ` +
      `that needs more than that is usually stuck rather than busy`
    );
  }
  return null;
}

/**
 * What this agent's turn may actually spend, given its own setting and the daemon's.
 *
 * An agent that names none follows the daemon, which is the whole point of the per-agent field:
 * one number to raise for the agent doing long refactors, without raising it for the one answering
 * questions in a group chat.
 *
 * Clamped rather than trusted. Config is validated at load, but a pack can be edited by an agent
 * with file access, and this is the number that decides how much a single message may spend.
 */
export function resolveToolIterations(perAgent: number | undefined, daemon: number): number {
  const chosen = perAgent ?? daemon;
  return Math.min(TOOL_ITERATIONS_MAX, Math.max(TOOL_ITERATIONS_MIN, chosen));
}

/**
 * The wall clock, in seconds at the edges and milliseconds inside.
 *
 * 30 at the bottom because a turn that has to reach a model at all spends several seconds before
 * the first token, and a cap under that is a turn that cannot answer anything. 3600 at the top
 * because this number also decides how long every other message in the same chat waits: the queue
 * is per chat, so one turn allowed an hour is an hour of silence for whoever messaged next.
 */
export const TURN_SECONDS_MIN = 30;
export const TURN_SECONDS_MAX = 3600;

/**
 * Why this many seconds is not allowed, or null when it is.
 *
 * The clock's half of `toolIterationsRefusal`, and it exists for the same reason: the daemon
 * config, an agent's pack and the dashboard's form all have to refuse the same values with the same
 * words, and three copies of a bound is how one of them ends up off by one.
 */
export function turnSecondsRefusal(value: unknown, where: string): string | null {
  if (!Number.isInteger(value)) return `${where} must be a whole number of seconds, got ${JSON.stringify(value)}`;
  const n = value as number;
  if (n < TURN_SECONDS_MIN) {
    return (
      `${where} must be at least ${TURN_SECONDS_MIN}, got ${n}. A turn spends several seconds ` +
      `reaching the model before it can say anything, so below that it is cut off mid-sentence ` +
      `every time`
    );
  }
  if (n > TURN_SECONDS_MAX) {
    return (
      `${where} must be at most ${TURN_SECONDS_MAX}, got ${n}. The queue is per chat, so this is ` +
      `also how long the next person to message waits behind one slow turn. Anything that needs ` +
      `more than a few minutes belongs in a background job, which does not hold the queue`
    );
  }
  return null;
}

/**
 * What this agent's turn may actually spend on the clock, given its own setting and the daemon's.
 *
 * Absent follows the daemon, exactly as the tool budget does. Clamped rather than trusted, for the
 * same reason: a pack is a file an agent with write access can edit, and this is one of the two
 * numbers that decide what a single message may cost.
 */
export function resolveTurnDurationMs(perAgentMs: number | undefined, daemonMs: number): number {
  const chosen = perAgentMs ?? daemonMs;
  return Math.min(TURN_SECONDS_MAX * 1000, Math.max(TURN_SECONDS_MIN * 1000, chosen));
}

export interface LLMLimitsSection {
  /** A ceiling on every request's `max_tokens` — per request, despite the name; whatever chose the number. */
  maxTokensPerTurn: number;
  maxToolIterations: number;
  /**
   * Hard wall-clock cap on one turn, tool calls included.
   *
   * Separate from the per-request and per-tool timeouts because those bound one *step*: 25
   * iterations each finishing just inside their own limit is a turn that legitimately runs for
   * a quarter of an hour while its chat's queue waits behind it.
   */
  maxTurnDurationMs: number;
  maxDailyCostUsd: number;
  costAlertThresholdPct: number;
  /**
   * Tokens a day, across every model, or 0 for no ceiling.
   *
   * The cap that works. `max_daily_cost_usd` can only see models that are in the price book, and on
   * the live install that was 8 of 88 requests in twenty-four hours — six agents and an unattended
   * scheduler sharing a brake blind to 91% of the traffic. A token count needs no price book: every
   * response carries its usage, priced or not, so this is the number that is never partly measured.
   *
   * It is not a substitute for the dollar cap, and neither replaces the other: this one is
   * enforceable everywhere and says nothing about money, and the dollar cap says exactly what you
   * will spend on the models it knows. Whichever is reached first refuses the turn.
   */
  maxDailyTokens: number;
}

/**
 * There is no chunk interval here on purpose.
 *
 * Streaming accumulates the response and sends it once (§6.5 SPEC) — editing a chat message per
 * token flickers and hits rate limits — so a "minimum interval between sends" bounds something that
 * only ever happens once. `chunk_interval_ms` existed as a reserved key for live editing, and a
 * reserved key that outlives the phase reserving it is indistinguishable from a setting that does
 * nothing. Removed rather than left advertised; add it back with the feature, if ever.
 */
export interface LLMStreamingSection {
  enabled: boolean;
  typingIndicator: boolean;
  /**
   * Show what the agent is doing, in the conversation, while it does it.
   *
   * One message that is edited as the turn runs, not one per step: editing re-notifies nobody, which
   * is what keeps a twenty-tool turn from becoming twenty notifications. Nothing is posted for a turn
   * that runs no tools. Gateways that cannot edit a message ignore this.
   */
  progressInChat: boolean;
}

export interface LLMContextSection {
  maxContextRatio: number;
  truncationStrategy: "sliding_window" | "summary";
  preserveRecentTurns: number;
  summaryModel?: string;
  /**
   * Fraction of the conversation budget at which room starts being made.
   *
   * A ratio and not a turn number, deliberately: one turn can be fifty tokens or sixty thousand — a
   * single `read` at the tool cap is 256KB — so "compact at turn 20" is sometimes early and sometimes
   * three turns too late. Below 1 so there is headroom; at 1 the first time anything happens is the
   * moment the request would already have overflowed.
   */
  compactAtRatio: number;
  /**
   * Hard ceiling on the working context, in tokens, whatever the ratio works out to.
   *
   * `compact_at_ratio` is a share of the window, so a bigger window buys a bigger prompt — which is
   * the right instinct for *fitting* and the wrong one for everything else. On a million-token model
   * the ratio put the threshold at ~610k, so a 426k-token Telegram session never compacted once and
   * every iteration resent the lot: one turn on 2026-09-04 spent 11,957,058 input tokens across 20
   * calls, ~15 seconds each, and died on the five-minute deadline while genuinely making progress.
   *
   * A window is how much a model *can* read. It was never a statement about how much it *should*
   * read to answer well, and paying a proportional share of it per call is how a long conversation
   * becomes slow and expensive at the same time. This is the absolute half of the pair: the
   * threshold is the lower of the two, so a small model keeps the ratio it always had and a huge one
   * stops scaling its bill with its window.
   *
   * Measures the whole request — system prompt, tools and history — so it is the number an operator
   * sees in the usage log. Unset by default: each model then gets its own figure
   * (`compactionLimitInfo` in `@nouride/llm`), and an agent's `[llm] compact_at_tokens` beats both.
   * Set here, it applies to every agent that does not name its own.
   */
  compactAtTokens?: number;
  /**
   * Tool results kept verbatim when trimming inside a turn.
   *
   * The recent ones are what the model is still working from. Older output has usually been read,
   * acted on, and is being carried for no reason but that nothing removed it.
   */
  preserveRecentToolResults: number;
}

export interface LLMSection {
  defaults: LLMDefaultsSection;
  limits: LLMLimitsSection;
  streaming: LLMStreamingSection;
  context: LLMContextSection;
}

export interface QueueSection {
  maxConcurrentPerAgent: number;
  maxQueueDepth: number;
  queueTimeoutMs: number;
  /**
   * A message to an agent already working in a one-to-one chat is read by that turn at its next step,
   * rather than waiting for it to finish (`pipeline/steering.ts`). A room is not steered.
   */
  steer: boolean;
  /**
   * In place of the "Got it" a steered message gets — rewritten into it, or under it where a platform cannot edit — a
   * sentence in the agent's own words about what it will do with it, one small model call beside the turn
   * (`pipeline/steer-reply.ts`). Off: "Got it" alone.
   */
  steerReply: boolean;
  /** The model that line is asked of, on the agent's own provider. Empty: the agent's own model. */
  steerReplyModel: string;
  /** How long that line may take before "Got it" stands alone. */
  steerReplyTimeoutMs: number;
  /**
   * Turns running at once across every conversation. `0` lifts the ceiling.
   *
   * Distinct from `maxConcurrentPerAgent`, which is per conversation and fixed at 1. This is the total,
   * and without it fifty active chats meant fifty simultaneous provider calls — fifty times the spend
   * per second and a rate limit hit immediately.
   */
  maxConcurrentTurns: number;
}

/**
 * Inbound files: how big, and nothing about how long.
 *
 * `retention_days` used to be here, seven days against a thirty-day transcript, and the result was a
 * conversation that mentioned a screenshot for another twenty-three days after the screenshot was
 * deleted — the index kept a ref, the ref resolved to nothing, and `attachment_read` answered "no
 * local copy and no way to fetch it again" about a file the conversation was visibly still about.
 *
 * A file is part of what was said, so it lives as long as the saying: `[retention] session_days`.
 * That is the same argument the turn store makes about its own rows, and two knobs for one history
 * is how they end up disagreeing.
 */
export interface AttachmentsSection {
  maxSizeMb: number;
}

/**
 * How long what only ever grows is kept — swept at boot and daily (`boot/maintenance.ts`). `0` on any knob means
 * "keep everything", never "delete everything".
 *
 * One window per kind of history, not per table: what a conversation said — its turns and their rows in the event
 * stream, a room's notices and messages, its files and their index — goes together on `session_days`, because two
 * knobs for one history is how a transcript ended up mentioning a screenshot already deleted (`[attachments]` had a
 * window of its own until 0.7). What this daemon did and spent — the audit log, usage, settled approvals, decided
 * drafts — goes on `audit_days`. Memory's change feed is kept ninety days, a window of its own and not a knob.
 */
export interface RetentionSection {
  /** Conversations untouched for this many days are dropped, with everything that is part of what was said in them. */
  sessionDays: number;
  /** Audit entries, usage rows, settled approvals and decided drafts older than this are dropped. */
  auditDays: number;
  /** Background-job logs (`data/jobs/*.log`) older than this are deleted. 0 keeps them forever. */
  jobLogDays: number;
  /**
   * Spilled tool output (`data/tool-output/<session>/`) older than this is deleted. 0 keeps it forever.
   *
   * Swept per session directory by its mtime, so a conversation still producing output keeps all of it.
   */
  toolOutputDays: number;
  /**
   * Files in an agent's `.scratchpad/` older than this are deleted. 0 keeps them forever.
   *
   * Short by design, and short is what makes the scratchpad usable: an agent that has somewhere
   * genuinely disposable to put a screenshot stops reaching for `/tmp`, and nothing accumulates
   * because nobody has to remember to clean up. Not deleted at the end of the turn, because the next
   * message is often about the file that was just sent.
   */
  scratchpadDays: number;
  /**
   * Days of the daemon's own log kept in the database. 0 keeps it forever.
   *
   * Short on purpose. This is the window an incident is diagnosed in, not an archive — stdout still
   * goes to the journal (or Docker, or launchd), which is where a longer history belongs and where
   * retention is somebody else's problem. Three days covers "it broke overnight and I looked on
   * Monday" without a table nobody prunes becoming the largest thing in the file.
   */
  logDays: number;
}

/**
 * Clearing a conversation's context on a schedule, so a chat nobody resets does not carry a week of
 * history into every turn.
 *
 * A session concern, not memory's: memory is cut from the turn log (`docs/SPEC.md` §12.2), so
 * clearing the context loses nothing. Evaluated when a message arrives rather than on a timer — a
 * conversation nobody is having needs no closing.
 */
export interface RolloverSection {
  /**
   * `none` never rolls over; `daily` closes a conversation that began before today's boundary;
   * `idle` closes one nobody has touched for `idle_minutes`.
   */
  mode: "none" | "daily" | "idle";
  /**
   * Hour of the local day, in `[daemon] timezone`, that `daily` treats as the boundary.
   *
   * Defaults to 4am rather than midnight because a conversation running at 1am belongs to the
   * evening it started in, not to the calendar date it happens to cross.
   */
  atHour: number;
  /** Minutes of silence before `idle` closes a conversation. */
  idleMinutes: number;
}

/**
 * The scheduler — §8 SPEC, TD-011.
 *
 * An early plan deferred this on the reasoning that "cron is not a reason to run a daemon — a
 * system timer does it". That is true of a timer that runs a script, and false of everything this
 * is for: a reminder that reaches a Telegram chat, a job that wakes an agent with its history and
 * tools, a run recorded where the operator already looks. None of that exists outside the process
 * holding the gateway sockets.
 */
export interface CronSection {
  enabled: boolean;
  /**
   * The floor on a recurring schedule.
   *
   * Not a performance guard — it is the difference between an agent scheduling a check and an
   * agent scheduling a loop. `every 1s` with an `agentTurn` payload is a provider call every
   * second until someone notices the bill.
   */
  minIntervalMs: number;
  /** Total jobs, across every agent. A model that can create jobs can create them in a loop. */
  maxJobs: number;
  /** Run history older than this is swept. `0` keeps everything. */
  runRetentionDays: number;
  /**
   * How late an overdue one-shot may be and still fire on boot.
   *
   * A daemon down for three days should not open with three days of missed reminders — that is
   * noise arriving at the worst possible moment. Inside the window the reminder is still worth
   * having; outside it, the run is recorded as skipped so the record does not lie about it.
   */
  catchupWindowMs: number;
  /**
   * Consecutive failures before a job disables itself.
   *
   * An unattended job that cannot succeed should stop, not keep asking for attention on schedule.
   */
  failStreakLimit: number;
  /**
   * What happens when a scheduled turn needs an approval and nobody is there to give it.
   *
   * `"auto"` approves it and records the decision in the audit log against the job. That is a real
   * escalation and it is chosen deliberately: a 3am job that stops at a prompt nobody will ever
   * see has not run at all. Hardline classes — privilege escalation, recursive deletes, credential
   * paths, this daemon's own state — are refused either way; they are not approval-gated, they are
   * refused, and a schedule does not change that.
   *
   * `"deny"` refuses instead, and the agent gets a tool error it can report.
   */
  unattendedApproval: "auto" | "deny";
  /** Wall-clock ceiling on a `command` payload. */
  commandTimeoutMs: number;
}

/**
 * Somebody the agents talk to.
 *
 * A family install has several, and the agent needs to know which one is speaking — not to decide
 * what it may do, but to answer the right person. Nouride has always carried the platform's display
 * name; it never told the agent in a DM, which is where a household actually talks to it.
 *
 * **A sender is recognised by their account, never by name.** `sender_access` already states why: the
 * display name is "whatever the platform reports", and anyone can rename themselves to "Sam" in
 * Telegram. So a sender is matched against the accounts in `ids` — `<platform>:<account>` — and the
 * name here is what the *operator* wrote, not what the platform said.
 *
 * The distinction reaches the prompt: a matched person is stated plainly, an unmatched sender is
 * marked as unverified. A model that cannot tell those apart is one that can be impersonated by a
 * rename.
 */
export interface Person {
  /**
   * Who this is — shown as "Person Key". Lowercase letters and digits, words joined by "-", unique, set
   * once: it names their memory profile (`people/<key>.md`), and every writer, the dashboard and
   * Access's "Approve as" find them by it.
   *
   * The person since 0.7.0. Until then the first of their accounts was (`id`, required), so nobody
   * could be added before an id for them was known, and every write had to take care never to lose
   * that one id. An entry written without a key is given one from its name when the file is read.
   */
  key: string;
  /**
   * The accounts they send from, all equal — and none at all for somebody added by name whose account
   * is attached later, from Access ("Approve as") or People. Such a person is never the one speaking.
   *
   * One person is one person, and platforms disagree: WhatsApp reports both a `@lid` and a phone
   * `@s.whatsapp.net` for the same account, a household member has a Telegram id and a Discord
   * snowflake, and the dashboard login is an id of its own (`web:<account id>`).
   *
   * Each is the platform and the account — `discord:214…` names them on every bot of ours on that
   * platform. A bare `5550001111` is refused: a Telegram user id and a Discord snowflake are both
   * numeric strings, and trusting one as the other is how the wrong person gets recognised. An `id = "…"`
   * from before 0.7.0 is refused at load since 0.8.0, naming this list.
   */
  ids?: string[];
  /** What to call them. Written by the operator, so it can be trusted as far as the operator is. */
  name: string;
  /**
   * Who they are and what does not change about them — role in the household, how they like to be
   * addressed, a birthday, an allergy. Markdown, rendered with the name on every turn with them.
   *
   * Written by the operator; by `person_record`, a first line for somebody nobody has described; and by
   * `person_notes`, at the person's own word, a line at a time and only ever theirs. What the agents
   * *learn* that changes over time is their memory profile (`[memory]`), not this field.
   */
  notes?: string;
  /**
   * What the nightly pass may do to this person's profile, over `[memory] facts`. Absent follows it.
   * Only the pass: a fact an agent writes on purpose, or a person types, is kept either way.
   */
  facts?: FactsMode;
  /**
   * Whether what is remembered about them goes into prompts, over `[memory] recall`. Absent follows it. Off, their facts
   * are left out everywhere, and a DM with them carries no RECALL at all.
   */
  recall?: boolean;
  /**
   * Their morning line (0.8.0): a time of day, `"07:00"`, in `[daemon] timezone`. Absent, there is none. Each morning
   * then, a message to their own chat on what happened while they were away — runs that failed, approvals and missions
   * waiting on them, missions finished, and for an admin what was spent. A quiet morning sends nothing.
   */
  morning?: string;
  /**
   * Where their morning line goes (0.8.0, `morning_to`): one of their `ids` on a chat platform, `"telegram:555"`. Absent,
   * the account they last wrote from — and if that one's connection is down, the next of theirs that is up.
   */
  morningTo?: string;
}

/** What the nightly pass may do to a profile: keep facts on its own, propose every change, or none. */
export type FactsMode = "auto" | "ask" | "off";

/**
 * What the agents remember, and about whom — `docs/SPEC.md` §12.
 *
 * Install-wide rather than per agent: who owns the install and who is remembered is one answer, and
 * an agent that disagreed would show one person's memory where another agent would not.
 */
export interface MemorySection {
  /**
   * Where memory lives. Never inside `daemon.agents_dir`: the packs are usually git repositories,
   * and a household's conversations do not belong in one.
   */
  dir: string;
  /** Cut the day's conversations into episodes and file them, nightly. Off until the setup wizard asks. */
  pass: boolean;
  /** Local time (`HH:MM`, daemon time zone) the nightly pass starts, once no turn is running. */
  passAt: string;
  /** Episodes filed per agent per night, direct conversations first; the rest wait for the next night. */
  passPerNight: number;
  /**
   * Tokens the pass may use in one night, every agent's calls together, in and out — as each call reported them, or as
   * estimated where a provider reported none. Past it the pass stops before the next conversation, and the rest wait
   * as they do past `passPerNight`. `0` sets no limit of its own: the count and `[llm.limits]` still bound a night.
   */
  passMaxTokens: number;
  /** Provider profile for the pass. Empty uses each agent's own. */
  passProvider: string;
  /** Model for the pass — a small one is enough. Empty uses each agent's own. */
  passModel: string;
  /** Tries per episode before it is left for a person to look at. */
  maxAttempts: number;
  /**
   * What the pass may do to profiles: `auto` adds facts and proposes rewrites and removals, `ask`
   * proposes every change, `off` files episodes only. A person's own `facts` overrides it.
   */
  facts: FactsMode;
  /** Whether the pass proposes shared knowledge (`shared.md`). Each proposal still waits for a person. */
  proposeShared: boolean;
  /** Episode summaries in each prompt. `0` leaves them out. */
  promptRecent: number;
  /**
   * Whether what is remembered goes into each prompt (RECALL). Off, the pass still learns and an agent still searches
   * and reads memory with its tools. A person's own `recall` overrides it.
   */
  recall: boolean;
  /** Days an episode keeps its transcript readable. After that only its summary is kept. `0` keeps it forever. */
  transcriptDays: number;
  /** Keep a compressed copy of each transcript when it stops being readable. Moot with `transcriptDays = 0`. */
  archive: boolean;
  /** Search by meaning as well as by words. Off until a provider that embeds is named. */
  semantic: MemorySemanticSection;
}

/**
 * Nouride as an MCP server, at `/mcp`: other tools (Claude Code, an editor) reach this install's
 * memory and personas with tokens a person owns. The other direction — an agent using someone
 * else's MCP server — is per agent, switched on from the library (`agents/<id>/mcp.toml`).
 */
export interface McpServerSection {
  enabled: boolean;
}

export interface MemorySemanticSection {
  enabled: boolean;
  /** A provider profile whose API has `/embeddings` — OpenAI, Gemini, Mistral, Jina, Ollama. */
  provider: string;
  model: string;
  /** Asked of models that can shorten their output; the model's own size is stored otherwise. */
  dimensions: number;
}

/**
 * How much of skill learning runs without a person.
 *
 * Whether to *look* and whether to *trust the result* are separate questions: a homelab owner watching their own agent
 * learn wants the drafts to land by themselves, and the same code running where a wrong skill would reach somebody
 * else must not.
 *
 * - `off` — no turn is examined. Drafts already queued stay decidable; nothing new is proposed.
 * - `ask` — propose and wait. The default.
 * - `auto` — approve its own drafts the moment they are written, which is what Hermes does: its background review
 *   writes skills through its own tools with no gate. The audit row records the daemon as the approver, so "who let
 *   this in" still has an answer. The weekly review's proposals wait for a person in every mode.
 *
 * `[rsi] mode` until 0.7.27 said `require_approval` and `always_allow`; 0.8.0 refuses `[rsi]`, naming `ask` and `auto`.
 */
export type SkillLearningMode = "off" | "ask" | "auto";

/**
 * `[skills.learning]` — agents writing skills from their own work (`modules/reflection`). Was `[rsi]` until 0.7.27,
 * with five tuning dials beside these three; the dials are the pass's own now (`modules/reflection/tuning.ts`).
 */
export interface SkillLearningSection {
  /**
   * Whether a finished turn is examined, and whether what comes out waits for a person.
   *
   * Looking costs one small provider call and *only* on a turn that met a trigger — one that failed several times and
   * then recovered, a long stretch of work, or one where somebody asked for a skill in so many words. A normal
   * conversation never reaches the pass.
   */
  mode: SkillLearningMode;
  /**
   * Model for the pass. Empty uses the agent's own.
   *
   * The same reasoning as `[llm.context] summary_model`: this is a short, mechanical extraction and a cheaper model is
   * the obvious economy. It resolves against the *agent's* provider profile, so name a model that profile can serve.
   */
  model: string;
  /**
   * Whether a new draft is announced in the conversation that produced it.
   *
   * On, because that is where the person who just watched the work happen is. Off leaves the drafts surface in the
   * dashboard and `nouride skills drafts` as the only way to find one.
   */
  notifyChat: boolean;
}

/**
 * The LLM gateway, hosted in this process instead of reached over the network.
 *
 * Nougate is normally its own service — one per network, addressed by a provider profile's
 * `base_url`, and that is still the default and costs this daemon nothing. `[nougate] in_process =
 * true` starts it here instead, on its own port, for a box that has to work without one.
 *
 * The two are not exclusive in any interesting way: a gateway running in this process is reached
 * through a provider profile exactly like a remote one, so the only thing that changes is which
 * host the `base_url` names.
 *
 * ## Why `in_process` and not `bundled`
 *
 * It was `in_process` until 2026-09-10, and renaming it to match `--bundle-nougate` was the obvious
 * move and the wrong one: the two control different things and can disagree. The flag decides
 * whether the code is *in the binary*; this decides whether the daemon *starts* it. A bundle build
 * with this off is the normal shape — the code is there, switched off — which is why the build
 * prints "set `[nougate] in_process = true` to use it".
 *
 * `in_process` because the WhatsApp bridge already had a word for exactly this topology:
 * `bridge_transport = "inproc"`. One concept, one vocabulary.
 */
export interface NougateSection {
  /**
   * Start the gateway in this process.
   *
   * Off by default, and the default is the right answer for almost every install: a gateway serving
   * several machines has no business living inside one of them, and hosting it here puts a bug in a
   * provider adapter one stack frame from the agent daemon.
   *
   * Requires a build that carries it — `bun run build:binary --bundle-nougate`. A build without it
   * refuses at boot rather than at the first request.
   */
  inProcess: boolean;
  /**
   * Where the in-process gateway listens. Adjacent to the daemon's own 18254 on purpose.
   *
   * Loopback only, and not configurable to anything else: a gateway hosted here exists to serve the
   * daemon it lives in, and binding it wider would publish an LLM proxy from a process nobody
   * expected to be one.
   */
  port: number;
}

/** `latest`: the newest release. `lts`: stay on a long-term line (0.8.18; `packages/update/src/track.ts`). */
export const UPDATE_TRACKS = ["latest", "lts"] as const;
export type UpdateTrack = (typeof UPDATE_TRACKS)[number];

export interface UpdateSection {
  /**
   * Which releases this install is offered. `latest` takes the newest; `lts` stays on a long-term line (1.0 the first)
   * and is told when a newer line is out. Read at each check, so a save counts at the next one.
   */
  track: UpdateTrack;
}

export interface GlobalConfig {
  daemon: DaemonSection;
  /** Keyed by profile name — the value agents put in `[llm] provider`. */
  providers: Record<string, ProviderProfile>;
  agents: AgentsSection;
  security: SecuritySection;
  media: MediaSection;
  jobs: JobsSection;
  delegate: DelegateSection;
  missions: MissionsSection;
  alerts: AlertsSection;
  dashboard: DashboardSection;
  control: ControlSection;
  /** Every configured connection, enabled or not. */
  gateways: GatewayInstanceConfig[];
  llm: LLMSection;
  queue: QueueSection;
  attachments: AttachmentsSection;
  retention: RetentionSection;
  rollover: RolloverSection;
  memory: MemorySection;
  mcpServer: McpServerSection;
  nougate: NougateSection;
  update: UpdateSection;
  /**
   * Who the agents are talking to, keyed by gateway-scoped sender id.
   *
   * Daemon-level rather than per-pack: a person is a person whichever agent they message, and
   * repeating the household in every agent's config is how two of them come to disagree.
   */
  people: Person[];
  /** The coding CLIs the person added for external agents, beside the built-in ones (0.8.1). */
  externalClis: ExternalCliConfig[];
  cron: CronSection;
  skills: SkillsSection;
}

/**
 * The pool, from the operator's side rather than an agent's.
 *
 * Per-agent switches live in each pack's `skills.toml` — that is one cell of a matrix, and it is the
 * right shape for "nero does not need this one". It is the wrong shape for "nobody should be
 * carrying this", which is the thing a built-in needs and cannot otherwise have: a pool skill can be
 * deleted, and a built-in ships inside the executable, so switching it off is the only removal it
 * has.
 *
 * Doing that by writing `false` into every pack would not be off. It would be off for the agents
 * that existed when the button was pressed, and the next agent created would carry the skill again
 * with nothing to say why.
 */
export interface SkillsSection {
  /**
   * Skills no agent loads, whatever their own `skills.toml` says.
   *
   * Names, not paths. A name here that matches nothing is left alone rather than refused — a skill
   * switched off and then deleted would otherwise make the config unloadable, and "off" is the one
   * state where a missing skill is not a problem.
   */
  off: string[];
  /** Agents writing skills from their own work — see `SkillLearningSection`. */
  learning: SkillLearningSection;
}

/** `telegram:nouva` — the id used in bindings, sessions and the dashboard. */
export function gatewayInstanceId(platform: ConfigurableGatewayName, name: string): string {
  return `${platform}:${name}`;
}


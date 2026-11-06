/**
 * Everything that refuses a config, warns about one, or says what a key used to be called.
 *
 * Invariant 7 lives here: fail at load, not at an agent's first message. The deliberate exception is
 * `reportConfigAdvisories`, which says what loads fine and is still worth a line.
 */

import {
  ConfigError,
  createLogger,
  GROUP_CONTEXT_MAX,
  maxBackgroundRefusal,
  modelGuardRefusal,
  type GlobalConfig,
  toolIterationsRefusal,
  turnSecondsRefusal,
} from "@nouride/shared";
import { boundsOf, CONFIG_ENUMS, UNSET_NUMBERS } from "@/modules/config/schema.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { isWritableDir, statFile } from "@nouride/runtime";
import { isSearchKind } from "@/modules/tools/builtins/search-backends.ts";
import { asWritten, isPlainObject, typeProblems } from "./merge.ts";
import { validateMemory } from "./validate-memory.ts";
import { validatePeople } from "./validate-people.ts";
import { parseBackupSeal } from "@/modules/config/sealed-secrets.ts";
import { validateTiers } from "./validate-tiers.ts";
import { fallbackPair } from "@nouride/persona";

const log = createLogger("config");

/** The longest a timer can be set for: a longer one fires at once (`[security] job_max_ms`). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Refuse a configuration that turns the daemon into an open remote shell.
 *
 * A chat gateway plus an agent holding `exec` plus no sender allowlist means anyone who finds the
 * bot can run commands on the host. That is what a first server deployment naturally lands on,
 * which is exactly why it is a refusal and not a warning nobody reads.
 *
 * How much an agent asks is *not* part of the refusal: that is the approval level, and boot says so at `warn` when an
 * agent or the daemon is set to `trusted` (`boot/preflight.ts`).
 *
 * Agents are not loaded yet at this point, so the exec check is applied by the caller once the
 * registry exists; this function covers what config alone can see.
 */
export function assertGatewayExecPosture(params: {
  gatewaysEnabled: boolean;
  agentsWithExec: string[];
  /** How unknown senders are handled. `pair` and `allowlist` both stop them; `open` does not. */
  accessMode: "open" | "allowlist" | "pair";
}): void {
  if (!params.gatewaysEnabled || params.agentsWithExec.length === 0) return;

  const who = `${params.agentsWithExec.join(", ")} ${params.agentsWithExec.length === 1 ? "has" : "have"} the exec tool`;

  // The question is "can a stranger reach this agent", and there are two ways to answer it no.
  //
  // This used to check the static allowlist alone, which made it refuse a *safe* install: with
  // `access.mode = "pair"` — the default — an unknown sender is given a code and their message is
  // dropped until the operator approves it. That is the same protection the allowlist provides,
  // arrived at from the other direction, and the guard did not know the mode existed.
  //
  // It cost a live outage. An agent wired up its own Telegram gateway, the daemon then refused to
  // boot over an empty allowlist it did not need, systemd restarted it every five seconds, and the
  // chat that could have fixed it was gone with the process. Only `open` is genuinely unguarded.
  //
  // And `open` is unguarded whatever the allowlist says: it admits everyone before the list is read
  // (`AccessStore.check`). Counting a non-empty list as protection let exactly this posture boot — and
  // the refusal's own advice, "set an allowlist", led there.
  if (params.accessMode === "open") {
    throw new ConfigError(
      `refusing to start: a chat gateway is enabled and ${who}.\n` +
        `  - [security.access] mode = "open", so anyone who finds the bot can run commands on this host:\n` +
        `    open admits everyone, whatever [security.access] allowlist holds\n` +
        `Use access mode "pair" (strangers get a code you approve) or "allowlist" with your own account in\n` +
        `[security.access] allowlist, or remove exec from those agents. See docs/CLI.md.`,
    );
  }
}

function validateEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  where: string,
): void {
  if (!allowed.includes(value as T)) {
    throw new ConfigError(
      `${where} must be one of ${allowed.map((v) => `"${v}"`).join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * What boot says about settings that load fine and are worth a line: the spend cap that is in force, and a WhatsApp
 * number no agent owns. Said through `advise` (`boot/advisories.ts`) — at warn while new, at info after — so a choice
 * made on purpose is not a warning on every boot.
 */
export function reportConfigAdvisories(config: GlobalConfig, advise: (message: string, data?: Record<string, unknown>) => void): void {
  if (config.llm.limits.maxDailyCostUsd > 0) {
    // Not a warning any more — it is enforced. Said at info because a spend cap is worth confirming
    // at boot: an operator who set one wants to see that the daemon agrees it has one.
    log.info("[llm.limits] daily cost cap is in force", {
      cap_usd: config.llm.limits.maxDailyCostUsd,
      alert_at_pct: config.llm.limits.costAlertThresholdPct,
      // The one thing the cap cannot see. Said here rather than only when it happens, so it is not a
      // surprise on the day it matters.
      note: "models with no published price are counted separately and are not included in the figure",
    });
  }

  /**
   * A WhatsApp number with no owning agent.
   *
   * On Telegram or Discord an unowned connection is a reasonable setup: people address an agent by
   * name, and channel bindings cover the rest. WhatsApp has neither — there is no bot to @-mention,
   * and a number is an identity rather than a room. So without `agent`, routing falls to channel
   * bindings keyed by chat id, and any group chat that is not bound reaches nobody once more than
   * one agent is running. The message is dropped in silence, which reads as the bot ignoring you.
   *
   * A warning rather than a refusal: binding-based routing is a real choice, just an unusual one
   * here, and a daemon that will not boot over a routing preference is worse than one that says so.
   */
  for (const gateway of config.gateways) {
    if (gateway.platform === "whatsapp" && gateway.enabled && !gateway.agent) {
      advise("whatsapp gateway has no owning agent", {
        gateway: gateway.id,
        note: "a WhatsApp number is one identity: set `agent` unless you are routing by channel binding",
      });
    }
  }
}

export function validateStructure(config: GlobalConfig): void {
  // Read from `CONFIG_ENUMS` rather than repeated inline, so `nouride config schema` cannot advertise
  // a value this rejects. A schema that lies about what is accepted is worse than no schema.
  const exec = config.security.exec;
  if (exec.landlock !== undefined) validateEnum(exec.landlock, CONFIG_ENUMS["security.exec.landlock"], "[security.exec] landlock");
  validateEnum(config.security.access.mode, CONFIG_ENUMS["security.access.mode"], "[security.access] mode");
  /**
   * Refused at boot rather than linted, unlike `search_kind`: this decides whether *anything* asks, so a typo here is
   * not a feature quietly not working — it is the gate quietly being somewhere else. It was neither refused nor even linted until now, so
   * `approvals = "riksy"` passed `config check` with "this configuration would start" and then
   * resolved to `balanced` inside `skipsApproval`, which is the permissive branch. A person tightening
   * to `careful` and mistyping it loosened their install and was told nothing.
   */
  validateEnum(config.security.approvals, CONFIG_ENUMS["security.approvals"], "[security] approvals");
  // The second look (0.8.0): a value none of its three shapes would be sent to a provider as a model id, hours later.
  const guardRefusal = modelGuardRefusal(config.security.modelGuard);
  if (guardRefusal) throw new ConfigError(`[security] model_guard ${guardRefusal}`);
  // Set only when set: unset is the provider's own effort. Refused rather than linted, because every model call
  // would carry the typo and every one would fail.
  if (config.llm.defaults.effort !== undefined) {
    validateEnum(config.llm.defaults.effort, CONFIG_ENUMS["llm.defaults.effort"], "[llm.defaults] effort");
  }
  // Refused, not linted: the updater reads anything but `latest` as `lts`, so a typo would quietly stop an install
  // moving to a new line (0.8.18). New in 0.8.18, so no file accepted before holds it.
  validateEnum(config.update.track, CONFIG_ENUMS["update.track"], "[update] track");
  // The other enums in `CONFIG_ENUMS` are deliberately *not* refused here. The loader has always
  // tolerated them — an unrecognised `search_kind` is quietly ignored — and turning that tolerance
  // into a boot refusal would take down a running install over a file it accepted yesterday.
  // `lintConfig` reports them instead, which `nouride doctor` and `config check` both surface.

  const defaultProvider = config.llm.defaults.provider;
  if (defaultProvider && !config.providers[defaultProvider]) {
    const known = Object.keys(config.providers);
    throw new ConfigError(
      `[llm.defaults] provider "${defaultProvider}" is not defined` +
        (known.length > 0 ? ` (known profiles: ${known.join(", ")})` : " (no provider profiles are defined yet)"),
    );
  }
  // Each a provider and a model, every provider a profile — refused at load as the pack's own are (`fallbackPair`).
  const fallbacks: unknown = config.llm.defaults.fallbacks ?? [];
  if (!Array.isArray(fallbacks)) throw new ConfigError("[llm.defaults] fallbacks must be a list of { provider, model }");
  config.llm.defaults.fallbacks = fallbacks.map((entry, i) => fallbackPair(entry, `[llm.defaults] fallbacks[${i}]`, Object.keys(config.providers)));
  validateTiers(config);
}


export function validate(config: GlobalConfig): void {
  // At load, because the failure is otherwise invisible from both ends: a string or a negative here
  // resolves to 0 in `resolveGroupContextLimit`, which is the off position — the operator would see a
  // feature they configured doing nothing at all, with nothing anywhere saying why.
  const groupContext = config.agents.groupContextMessages;
  if (!Number.isInteger(groupContext) || groupContext < 0 || groupContext > GROUP_CONTEXT_MAX) {
    throw new ConfigError(
      `[agents] group_context_messages must be a whole number between 0 (off) and ${GROUP_CONTEXT_MAX}, ` +
        `got ${JSON.stringify(groupContext)}`,
    );
  }

  const { port } = config.dashboard;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`dashboard.port out of range: ${port}`);
  }

  // Refused at boot rather than at the moment a webhook URL is rendered: a typo here produces an
  // address that is handed to a person and pasted somewhere, and the failure surfaces as "GitHub
  // says it cannot reach you" days later.
  const publicUrl = config.dashboard.publicUrl.trim();
  if (publicUrl) {
    let parsed: URL;
    try {
      parsed = new URL(publicUrl);
    } catch {
      throw new ConfigError(`[dashboard] public_url is not a URL: ${publicUrl}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ConfigError(`[dashboard] public_url must be http or https: ${publicUrl}`);
    }
  }

  /**
   * External sign-in, refused half-configured rather than drawn and then broken.
   *
   * Three settings arrive together from whoever registered the client, and a file with two of them
   * shows an operator a working password form, no button, and no reason. The failure with `public_url`
   * missing is worse still: the button appears, the provider is reached, the user authenticates, and
   * the exchange is refused for a redirect URI mismatch — at the one moment when nothing can be
   * retried.
   */
  const { oauth } = config.dashboard;
  const oauthFields: [string, string][] = [
    ["issuer", oauth.issuer.trim()],
    ["client_id", oauth.clientId.trim()],
    ["secret_name", oauth.secretName.trim()],
  ];
  const filled = oauthFields.filter(([, value]) => value);
  if (filled.length > 0 && filled.length < oauthFields.length) {
    const absent = oauthFields.filter(([, value]) => !value).map(([name]) => name);
    throw new ConfigError(
      `[dashboard.oauth] is half configured: ${absent.join(" and ")} ` +
        `${absent.length > 1 ? "are" : "is"} empty. Set all of issuer, client_id and secret_name, ` +
        `or clear issuer to turn external sign-in off.`,
    );
  }

  const oauthConfigured = filled.length === oauthFields.length;

  if (oauthConfigured) {
    let parsedIssuer: URL;
    try {
      parsedIssuer = new URL(oauth.issuer.trim());
    } catch {
      throw new ConfigError(`[dashboard.oauth] issuer is not a URL: ${oauth.issuer}`);
    }
    if (parsedIssuer.protocol !== "https:" && parsedIssuer.hostname !== "localhost" && parsedIssuer.hostname !== "127.0.0.1") {
      // The identity is read over this connection and nothing else signs it, so plaintext to a
      // remote issuer means anyone on the path can choose who is logging in. Loopback is exempt
      // because that is a provider running on the same machine, for development.
      throw new ConfigError(`[dashboard.oauth] issuer must be https: ${oauth.issuer}`);
    }
    if (!publicUrl) {
      throw new ConfigError(
        `[dashboard.oauth] is configured but [dashboard] public_url is empty. The redirect URI ` +
          `sent to the provider is built from it, and a guess would be refused at the exchange.`,
      );
    }
  }

  /**
   * Refusing to lock the operator out of their own daemon.
   *
   * `password_login = false` with no identity provider is a login page nobody
   * can satisfy — and the daemon would boot, report healthy, and serve it. The
   * check is here rather than at the login route because by then the only
   * person who could fix it cannot get in.
   */
  if (!config.dashboard.passwordLogin && !oauthConfigured) {
    throw new ConfigError(
      `[dashboard] password_login = false needs [dashboard.oauth] configured, otherwise ` +
        `there is no way to sign in at all. Set the issuer, client_id and secret_name first, ` +
        `or leave password_login on.`,
    );
  }

  const ratio = config.llm.context.maxContextRatio;
  if (ratio <= 0 || ratio > 1) {
    throw new ConfigError(`llm.context.max_context_ratio must be in (0, 1]: ${ratio}`);
  }

  const compactAt = config.llm.context.compactAtRatio;
  if (compactAt <= 0 || compactAt > 1) {
    throw new ConfigError(`llm.context.compact_at_ratio must be in (0, 1]: ${compactAt}`);
  }
  // Refused rather than clamped. Zero or a negative makes `Math.min` the ceiling for every model,
  // so nothing ever fits and every turn compacts — an agent that has forgotten the message it is
  // answering, which reads as the model being broken rather than as one wrong number in a file.
  const compactCeiling = config.llm.context.compactAtTokens;
  if (compactCeiling !== undefined && (!Number.isInteger(compactCeiling) || compactCeiling < 16_000)) {
    throw new ConfigError(
      "[llm.context] compact_at_tokens must be a whole number of at least 16000: it is the whole request " +
        "(prompt, tools and history), and the lower of it and compact_at_ratio wins; leave it out to use " +
        `each model's own figure, got ${compactCeiling}`,
    );
  }
  if (!Number.isInteger(config.llm.context.preserveRecentToolResults) ||
      config.llm.context.preserveRecentToolResults < 0) {
    throw new ConfigError(
      "[llm.context] preserve_recent_tool_results must be a whole number (0 trims every tool result " +
        `that is not being read right now), got ${config.llm.context.preserveRecentToolResults}`,
    );
  }

  // Refused above 1, not merely floored at 1.
  //
  // The knob is wired to the queue's per-key concurrency, and the key is the *conversation*. Two turns
  // running at once in one conversation both `SessionStore.load()` it and each `save()`s what it loaded
  // with its own messages after — so the slower one's save drops the faster one's messages, and that
  // exchange is gone from the transcript with nothing logged. Rows (E2) did not change that: a save is
  // still of the whole conversation, written as what differs. Sequential-per-chat is not a default here,
  // it is what the session store requires; a value that silently loses conversation history is worth
  // refusing at boot rather than honouring.
  if (!Number.isInteger(config.queue.maxConcurrentPerAgent) || config.queue.maxConcurrentPerAgent < 1) {
    throw new ConfigError("queue.max_concurrent_per_agent must be at least 1");
  }
  if (config.queue.maxConcurrentPerAgent > 1) {
    throw new ConfigError(
      "queue.max_concurrent_per_agent must be 1: each turn saves the conversation it loaded with its own " +
        "messages after, so two turns running at once in the same chat would drop each other's. Parallelism " +
        "across different chats is automatic and needs no setting.",
    );
  }

  // At load, not at the first search. A mistyped backend would otherwise leave `web_search` quietly
  // not offered, and "the agent cannot search" gives no hint that a config line is the reason.
  if (!isSearchKind(config.security.web.searchKind)) {
    throw new ConfigError(
      `[security.web] search_kind must be "brave" or "searxng": got "${config.security.web.searchKind}"`,
    );
  }

  // ── Numeric sanity checks ──────────────────────────────────────────────
  // A zero or negative value here would not crash at boot but would cause silent misbehaviour
  // at runtime — tools that never time out, turns killed immediately, timers that spin, etc.
  // Catching them here turns a debugging session into a one-line config fix.
  const positiveInt = (value: number, where: string) => {
    if (!Number.isFinite(value) || value < 1) {
      throw new ConfigError(`${where} must be a positive integer, got ${value}`);
    }
  };
  positiveInt(config.security.toolTimeoutMs, "[security] tool_timeout_ms");
  positiveInt(config.security.approvalTimeoutMs, "[security] approval_timeout_ms");
  /**
   * Bounded, not merely positive.
   *
   * `positive` accepted 1 — an agent capped before it can finish a read, run, check, answer loop —
   * and it accepted 100000, where every iteration re-sends the whole conversation and a single
   * mistyped turn can outspend a day. The same function refuses both here and in an agent's own
   * pack, so the two cannot drift.
   */
  const iterations = toolIterationsRefusal(
    config.llm.limits.maxToolIterations,
    "[llm.limits] max_tool_iterations",
  );
  if (iterations) throw new ConfigError(iterations);
  /**
   * Bounded rather than merely positive.
   *
   * `positiveInt` accepted 1 millisecond and a year alike — the same gap `max_tool_iterations` had
   * before it got `toolIterationsRefusal`. Checked in seconds because that is the unit the bound is
   * written in, and the one an operator is thinking in when they pick the number.
   */
  {
    const refusal = turnSecondsRefusal(
      Math.round(config.llm.limits.maxTurnDurationMs / 1000),
      "[llm.limits] max_turn_duration_ms",
    );
    if (refusal) throw new ConfigError(refusal);
  }
  // Zero is the off position, so this is the non-negative check and not `positiveInt`. A negative
  // ceiling would read as "off" through the `> 0` guard in `checkBudget` and be a typo nobody saw.
  if (!Number.isInteger(config.llm.limits.maxDailyTokens) || config.llm.limits.maxDailyTokens < 0) {
    throw new ConfigError(
      `[llm.limits] max_daily_tokens must be a whole number of tokens (0 for no cap), got ${config.llm.limits.maxDailyTokens}`,
    );
  }
  // Zero is off. The ceiling is a timer's: one set past 2^31 - 1 ms fires at once rather than never, so a value meant
  // as "practically never" would stop every job the moment it started.
  if (!Number.isInteger(config.security.jobMaxMs) || config.security.jobMaxMs < 0 || config.security.jobMaxMs > MAX_TIMER_MS) {
    throw new ConfigError(
      `[security] job_max_ms must be 0 (never stop a job) or a whole number of milliseconds up to ${MAX_TIMER_MS}, about 24 days (got ${config.security.jobMaxMs})`,
    );
  }
  // Zero is off; the ceiling is the most one agent may run at once, whatever it asks for (`MAX_BACKGROUND_HELPERS`).
  const helpers = maxBackgroundRefusal(config.delegate.maxBackground, "[delegate] max_background");
  if (helpers) throw new ConfigError(helpers);
  positiveInt(config.queue.maxQueueDepth, "[queue] max_queue_depth");
  positiveInt(config.queue.steerReplyTimeoutMs, "[queue] steer_reply_timeout_ms");
  if (!Number.isInteger(config.queue.maxConcurrentTurns) || config.queue.maxConcurrentTurns < 0) {
    throw new ConfigError(
      `[queue] max_concurrent_turns must be a whole number (0 lifts the ceiling), got ${config.queue.maxConcurrentTurns}`,
    );
  }
  positiveInt(config.queue.queueTimeoutMs, "[queue] queue_timeout_ms");
  positiveInt(config.daemon.shutdownTimeoutMs, "[daemon] shutdown_timeout_ms");

  // Retention is the one family where 0 is meaningful — it means "keep everything" — so these are
  // checked for being whole and not negative rather than for being positive. A negative day count
  // would otherwise read as a cutoff in the future and delete the table.
  const retentionDays = (value: number, where: string) => {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new ConfigError(`${where} must be a whole number of days (0 disables), got ${value}`);
    }
  };
  // The queue-timeout-versus-turn-deadline check used to live here. It is a `lintConfig` rule now —
  // the same finding was being reported twice in one `nouride config check`, once as a loader warning
  // and once as a lint, and two voices saying the same thing reads as two problems.
  retentionDays(config.retention.sessionDays, "[retention] session_days");
  retentionDays(config.retention.auditDays, "[retention] audit_days");
  retentionDays(config.retention.scratchpadDays, "[retention] scratchpad_days");

  // Rollover, checked here because every one of these is invisible at runtime if wrong: a bad mode
  // silently never rolls over, and a bad hour silently picks a boundary nobody meant (invariant 7).
  const rolloverModes: readonly string[] = CONFIG_ENUMS["rollover.mode"];
  if (!rolloverModes.includes(config.rollover.mode)) {
    throw new ConfigError(`[rollover] mode must be one of ${rolloverModes.join(", ")}, got ${config.rollover.mode}`);
  }
  const atHour = config.rollover.atHour;
  if (!Number.isInteger(atHour) || atHour < 0 || atHour > 23) {
    throw new ConfigError(`[rollover] at_hour must be an hour 0-23, got ${atHour}`);
  }
  retentionDays(config.rollover.idleMinutes, "[rollover] idle_minutes");
  // `idle` with no window would close a conversation the moment it started.
  if (config.rollover.mode === "idle" && config.rollover.idleMinutes <= 0) {
    throw new ConfigError("[rollover] idle_minutes must be greater than 0 when mode is idle");
  }
  // Checked only when it already exists: boot creates the default, so "not there yet" is a fresh
  // install. A path that exists and cannot be written is refused here rather than discovered at the
  // first cut, where the only evidence is a log line and a conversation never filed (invariant 7).
  if (statFile(config.memory.dir) !== null && !isWritableDir(config.memory.dir)) {
    throw new ConfigError(
      `[memory] dir exists but is not a writable directory: ${config.memory.dir}. Check ownership, not just the path`,
    );
  }
  // People, checked where they are written: here the `[[people]]` block, whose first problem stops the load.
  validatePeople(config.people);
  // The seal the snapshots use (D5): one written wrong would seal to nothing anybody can open, said at load.
  parseBackupSeal(config.daemon.backupSeal);
  validateMemory(config);

  retentionDays(config.cron.runRetentionDays, "[cron] run_retention_days");

  positiveInt(config.cron.minIntervalMs, "[cron] min_interval_ms");
  positiveInt(config.cron.maxJobs, "[cron] max_jobs");
  positiveInt(config.cron.failStreakLimit, "[cron] fail_streak_limit");
  positiveInt(config.cron.commandTimeoutMs, "[cron] command_timeout_ms");
  if (config.cron.catchupWindowMs < 0 || !Number.isFinite(config.cron.catchupWindowMs)) {
    throw new ConfigError(
      `[cron] catchup_window_ms must be 0 or more (0 never replays a missed one-shot), got ${config.cron.catchupWindowMs}`,
    );
  }
  if (config.cron.unattendedApproval !== "auto" && config.cron.unattendedApproval !== "deny") {
    throw new ConfigError(
      `[cron] unattended_approval must be "auto" or "deny", got "${config.cron.unattendedApproval}"`,
    );
  }
  // Not refused, because an operator who wants a 10-second watch on their own machine is entitled
  // to it — but a floor under a minute means a model can schedule a provider call per tick, and
  // that is worth one line in the log the first time the config is read rather than a bill later.
  if (config.cron.minIntervalMs < 60_000) {
    log.warn("[cron] min_interval_ms is under a minute", {
      min_interval_ms: config.cron.minIntervalMs,
      hint: "an agent can schedule a recurring model call at this cadence",
    });
  }
  // Last, after the refusals by name above, which say more where they say anything: every number against its bounds.
  refuse(numberProblems(config));
}

/**
 * Every number the config holds, against its bounds (`boundsOf`) — a value of another type included, which is the same
 * mistake: `job_max_ms = "2h"`. Reported and reset to the default for one release (0.7.7), refused since 0.7.8: a
 * negative cap was "off" and a negative retention "keep nothing", read silently from a file `config check` passed.
 */
function numberProblems(config: GlobalConfig): string[] {
  const problems: string[] = [];
  const walk = (defaults: Record<string, unknown>, live: Record<string, unknown>, path: string) => {
    for (const [key, fallback] of Object.entries(defaults)) {
      const tomlPath = `${path}${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`;
      if (isPlainObject(fallback) && isPlainObject(live[key])) walk(fallback, live[key], `${tomlPath}.`);
      const value = live[key];
      if (typeof fallback !== "number" && !(UNSET_NUMBERS.has(tomlPath) && value !== undefined)) continue;
      const bounds = boundsOf(tomlPath);
      const fits =
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= bounds.min &&
        (bounds.max === undefined || value <= bounds.max) &&
        (!bounds.integer || Number.isInteger(value));
      if (fits) continue;
      const range = `${bounds.integer ? "a whole number" : "a number"} from ${bounds.min}${bounds.max === undefined ? " up" : ` to ${bounds.max}`}`;
      problems.push(`${asWritten(tomlPath)} = ${JSON.stringify(value)} is not ${range}`);
    }
  };
  walk(DEFAULT_CONFIG as unknown as Record<string, unknown>, config as unknown as Record<string, unknown>, "");
  return problems;
}

/**
 * Values of the wrong type other than numbers, refused before anything reads them (`typeProblems`) — run by
 * `parseConfig` straight after the merge, since the first thing after it reads `[[people]]` as a list.
 */
export function assertTypes(config: GlobalConfig): void {
  refuse(typeProblems(config));
}

/** Every value the file set that this daemon cannot use, in one refusal — so one edit fixes them all. */
function refuse(problems: string[]): void {
  if (problems.length === 0) return;
  throw new ConfigError(
    problems.length === 1 ? problems[0]! : `the config sets values this daemon cannot use:\n${problems.map((line) => `  - ${line}`).join("\n")}`,
  );
}

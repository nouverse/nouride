/**
 * Daemon-wide settings the dashboard can change: who may talk to the agents, how much of a group
 * they read, how far a mention chain runs, and the daily spend ceiling.
 *
 * All of them take effect on the next message rather than the next boot — see `setAccessMode` for
 * why that one setting is live.
 */

import { createLogger } from "@nouride/shared";
import {
  GROUP_CONTEXT_MAX,
  toolIterationsRefusal,
  turnSecondsRefusal,
  type AccessMode,
} from "@nouride/shared";
import { upsertTomlTable } from "@/modules/config/edit.ts";
import { assertGatewayExecPosture } from "@/modules/config/global/index.ts";
import { editConfigFile } from "./file.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings");

// ── Access ─────────────────────────────────────────────────────────────────

/**
 * Which rule admits a sender: `open`, `allowlist` or `pair`.
 *
 * The one setting here that takes effect **without a restart**, and deliberately so. Everything else
 * in this file describes something built at boot — an adapter, a client — so saving it can only
 * promise the next boot. Access is read per message, off `config.security.access`, and the save changes
 * that same object (`config/follow.ts`): flip it off and the very next stranger is dropped. An operator turning pairing
 * off is usually reacting to a spammer *right now*, and "restart the daemon to make it stop" is not
 * an answer.
 *
 * Turning pairing **off** means `allowlist`, not `deny`: senders already approved keep talking (the
 * store answers `approved` before the mode is consulted), and unknown ones are dropped in silence —
 * no code, no reply, nothing queued. That is the anti-spam posture. `open` is the one direction that
 * can be refused, because it is the one that boot itself refuses: an open daemon whose agents hold
 * `exec` is a remote shell, and writing that config from the dashboard would leave a daemon that
 * cannot be started again.
 */
export async function setAccessMode(deps: SettingsDeps, params: {
  mode: string;
  /** Ids of active agents holding `exec`, for the same guard boot applies. */
  agentsWithExec?: readonly string[];
  actor?: string;
}): Promise<SaveResult> {
  const mode = params.mode.trim() as AccessMode;
  if (mode !== "open" && mode !== "allowlist" && mode !== "pair") {
    return { ok: false, error: `unknown access mode "${params.mode}": use open, allowlist or pair` };
  }

  const previous = deps.config.security.access.mode;
  if (mode === previous) return { ok: true, restartRequired: false };

  try {
    assertGatewayExecPosture({
      gatewaysEnabled: deps.config.gateways.some((gateway) => gateway.enabled),
      agentsWithExec: [...(params.agentsWithExec ?? [])],
      accessMode: mode,
    });
  } catch (error) {
    // The boot guard's own words, minus the "refusing to start" framing — nothing is starting here.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message.replace(/^refusing to start: /, "") };
  }

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "security.access", { mode }));
  if (!saved.ok) return saved;

  log.info("access mode changed", { mode, previous, actor: params.actor });
  deps.audit?.record({
    action: "access_mode_changed",
    actor: params.actor,
    details: { mode, previous },
  });
  return { ok: true, restartRequired: false };
}

/**
 * How far back an agent reads a group it was not addressed in — for the whole daemon.
 *
 * The daemon-wide setting, and the one an operator actually reaches for. A connection may still
 * override it (`saveGateway`), the same way `groups_require_mention` works, but that is a
 * refinement on top of this rather than the place the decision is made.
 *
 * **Live, like `setAccessMode` and unlike everything else here.** The pipeline reads this off the
 * config object on every message, so the save changing it is the whole of the change — `restartRequired`
 * would be sending the operator to restart a daemon for a setting that already applies.
 */
export async function setGroupContextMessages(deps: SettingsDeps, params: {
  messages: number;
  actor?: string;
}): Promise<SaveResult> {
  const { messages } = params;
  if (!Number.isInteger(messages) || messages < 0 || messages > GROUP_CONTEXT_MAX) {
    return {
      ok: false,
      error: `group context must be a whole number between 0 (off) and ${GROUP_CONTEXT_MAX}`,
    };
  }

  const previous = deps.config.agents.groupContextMessages;
  if (messages === previous) return { ok: true, restartRequired: false };

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "agents", { group_context_messages: messages }));
  if (!saved.ok) return saved;

  log.info("group context window changed", { messages, previous, actor: params.actor });
  deps.audit?.record({
    action: "group_context_changed",
    actor: params.actor,
    details: { messages, previous },
  });
  return { ok: true, restartRequired: false };
}

// ── Agent mentions ────────────────────────────────────────────────────────

/**
 * Whether agents can @mention each other in their replies — for the whole daemon.
 *
 * **Live, like `setGroupContextMessages`.** The pipeline reads this off the config object on every
 * message, so mutating it is the whole of the change.
 */
export async function setMentionsEnabled(deps: SettingsDeps, params: {
  enabled: boolean;
  actor?: string;
}): Promise<SaveResult> {
  const { enabled } = params;
  if (typeof enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }

  const previous = deps.config.agents.mentionsEnabled;
  if (enabled === previous) return { ok: true, restartRequired: false };

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "agents", { mentions_enabled: enabled }));
  if (!saved.ok) return saved;

  log.info("agent mentions toggled", { enabled, previous, actor: params.actor });
  deps.audit?.record({
    action: "mentions_enabled_changed",
    actor: params.actor,
    details: { enabled, previous },
  });
  return { ok: true, restartRequired: false };
}

/**
 * How many agent-to-agent hops a mention chain may take before the daemon stops forwarding.
 *
 * **Live, like `setGroupContextMessages`.** The pipeline reads this off the config object on every
 * message, so mutating it is the whole of the change.
 */
export async function setMentionMaxHops(deps: SettingsDeps, params: {
  maxHops: number;
  actor?: string;
}): Promise<SaveResult> {
  const { maxHops } = params;
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 20) {
    return { ok: false, error: "mention_max_hops must be a whole number between 1 and 20" };
  }

  const previous = deps.config.agents.mentionMaxHops;
  if (maxHops === previous) return { ok: true, restartRequired: false };

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "agents", { mention_max_hops: maxHops }));
  if (!saved.ok) return saved;

  log.info("mention max hops changed", { maxHops, previous, actor: params.actor });
  deps.audit?.record({
    action: "mention_max_hops_changed",
    actor: params.actor,
    details: { maxHops, previous },
  });
  return { ok: true, restartRequired: false };
}

// ── Turn limits ────────────────────────────────────────────────────────────

/**
 * The daemon-wide tool budget every agent follows unless its own pack says otherwise.
 *
 * Live on the next turn rather than the next boot, and that matters more here than for most
 * settings: the number an operator raises is usually raised *because* a turn just stopped short,
 * and a change that needed a restart would mean losing the conversation it was meant to rescue.
 */
export async function setToolIterations(deps: SettingsDeps, params: {
  iterations: number;
  actor?: string;
}): Promise<SaveResult> {
  const refusal = toolIterationsRefusal(params.iterations, "[llm.limits] max_tool_iterations");
  if (refusal) return { ok: false, error: refusal };

  const previous = deps.config.llm.limits.maxToolIterations;
  if (params.iterations === previous) return { ok: true, restartRequired: false };

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "llm.limits", { max_tool_iterations: params.iterations }));
  if (!saved.ok) return saved;

  log.info("tool iteration budget changed", {
    iterations: params.iterations,
    previous,
    actor: params.actor,
  });
  deps.audit?.record({
    action: "tool_iterations_changed",
    actor: params.actor,
    details: { iterations: params.iterations, previous },
  });
  return { ok: true, restartRequired: false };
}

/**
 * The daemon-wide wall clock, taken and stored in the units each side reads best.
 *
 * Seconds in, milliseconds on disk: `max_turn_duration_ms` sits beside other `_ms` timeouts in a
 * file an operator reads once, and nobody picking this number is thinking in milliseconds.
 */
export async function setTurnSeconds(deps: SettingsDeps, params: {
  seconds: number;
  actor?: string;
}): Promise<SaveResult> {
  const refusal = turnSecondsRefusal(params.seconds, "[llm.limits] max_turn_duration_ms");
  if (refusal) return { ok: false, error: refusal };

  const ms = params.seconds * 1000;
  const previous = deps.config.llm.limits.maxTurnDurationMs;
  if (ms === previous) return { ok: true, restartRequired: false };

  /**
   * Refused rather than saved with a warning.
   *
   * The queue is per chat and drops anything that waits longer than `queue_timeout_ms`. A clock set
   * above it means the second message in a busy chat is discarded before it ever runs — silently,
   * and only while a long turn happens to be in flight, which is the hardest kind of bug to see.
   */
  if (ms > deps.config.queue.queueTimeoutMs) {
    return {
      ok: false,
      error:
        `a turn may not outlast the queue it waits in: ${params.seconds}s is above ` +
        `[queue] queue_timeout_ms (${Math.round(deps.config.queue.queueTimeoutMs / 1000)}s), so a ` +
        `message arriving behind a full-length turn would be dropped before it ran. Raise the queue ` +
        `timeout first.`,
    };
  }

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "llm.limits", { max_turn_duration_ms: ms }));
  if (!saved.ok) return saved;

  log.info("turn duration changed", { seconds: params.seconds, previous, actor: params.actor });
  deps.audit?.record({
    action: "turn_duration_changed",
    actor: params.actor,
    details: { ms, previous },
  });
  return { ok: true, restartRequired: false };
}

// ── Spend ──────────────────────────────────────────────────────────────────

/**
 * The most this daemon may spend on models in a day.
 *
 * **Live**, and for a sharper reason than the settings above: this one is read at the top of every
 * turn, *before* the provider is called (`TurnContext.checkSpend`). A cap that needed a restart to
 * take effect would be a cap you set while watching the number climb and that does nothing until
 * you stop the daemon — which is the moment it is least appealing to restart anything.
 *
 * `0` disables it, and that is the shipped default. The honesty of that is deliberate: the config
 * carried `max_daily_cost_usd` for a whole phase while nothing recorded spend, so the number read
 * like a budget and enforced nothing. `0` says outright that nothing is enforced unless asked for.
 *
 * Refusing is not the only thing the cap does. Past `[llm.limits] cost_alert_threshold_pct` of it
 * (80 by default) a turn still runs and carries a warning, so the ceiling announces itself before it
 * becomes a wall.
 */
export async function setDailyCostCap(deps: SettingsDeps, params: {
  usd: number;
  actor?: string;
}): Promise<SaveResult> {
  const { usd } = params;

  if (!Number.isFinite(usd) || usd < 0) {
    return { ok: false, error: "max_daily_cost_usd must be a number of dollars, or 0 for no cap" };
  }
  /**
   * Two decimals, checked rather than rounded.
   *
   * Rounding silently would accept `0.005` and save `0.01` — twice what was typed, in the one
   * setting where the number *is* the point. Refusing says which part was not understood.
   */
  if (Math.round(usd * 100) !== usd * 100) {
    return { ok: false, error: "max_daily_cost_usd takes at most two decimal places" };
  }
  /**
   * An upper bound, because the failure this guards is a typo and not an intention.
   *
   * `500` typed as `50000` is not a cap anyone meant, and it is indistinguishable from `0` in
   * effect — so the mistake produces exactly the unbounded daemon the operator was trying to avoid,
   * while the dashboard shows a number that looks like protection.
   */
  if (usd > 10_000) {
    return { ok: false, error: "max_daily_cost_usd above 10000 is almost certainly a typo: use 0 for no cap" };
  }

  const previous = deps.config.llm.limits.maxDailyCostUsd;
  if (usd === previous) return { ok: true, restartRequired: false };

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "llm.limits", { max_daily_cost_usd: usd }));
  if (!saved.ok) return saved;

  log.info("daily cost cap changed", { usd, previous, actor: params.actor });
  deps.audit?.record({
    action: "daily_cost_cap_changed",
    actor: params.actor,
    details: { usd, previous },
  });
  return { ok: true, restartRequired: false };
}

// ── Sign-in ────────────────────────────────────────────────────────────────

/**
 * Whether a username and password may be used to sign in to the dashboard.
 *
 * **Live, like `setAccessMode`.** The login route reads
 * `config.dashboard.passwordLogin` on every request, so the save changing the
 * object is the whole of the change — telling an admin to restart a daemon for a
 * setting that already applies would be an invented instruction.
 *
 * ## Refusing to lock the operator out
 *
 * The same guard `validate()` applies at boot, applied here for a better reason:
 * at boot the worst case is a daemon that will not start, which is loud and
 * fixable over SSH. From the dashboard the worst case is a daemon that keeps
 * running and can never be signed into again — the setting would take effect
 * immediately, on the session of the person who just made the mistake.
 *
 * So it is refused unless external sign-in is *actually working*: not merely
 * configured, but with the client secret present. A `secret_name` pointing at
 * nothing passes `validate()` (which cannot read secrets) and fails at the
 * token exchange, which would be the worst possible moment to find out.
 *
 * Turning it back on is never refused.
 */
export async function setPasswordLogin(deps: SettingsDeps, params: {
  enabled: boolean;
  actor?: string;
}): Promise<SaveResult> {
  const previous = deps.config.dashboard.passwordLogin;
  if (params.enabled === previous) return { ok: true, restartRequired: false };

  if (!params.enabled) {
    const { oauth, publicUrl } = deps.config.dashboard;
    const missing: string[] = [];
    if (!oauth.issuer.trim()) missing.push("issuer");
    if (!oauth.clientId.trim()) missing.push("client_id");
    if (!oauth.secretName.trim()) missing.push("secret_name");
    if (!publicUrl.trim()) missing.push("public_url");

    if (missing.length > 0) {
      return {
        ok: false,
        error:
          `external sign-in is not configured (${missing.join(", ")} missing), so turning off ` +
          `password sign-in would leave no way to sign in at all`,
      };
    }

    /**
     * The check `validate()` cannot make.
     *
     * It runs before the secret store is open, so a `secret_name` that resolves
     * to nothing satisfies it — and the failure surfaces at the token exchange,
     * after the person has already authenticated at the provider. Here the
     * store is available, so the one thing that turns a configured provider
     * into a working one is verifiable before the door is shut.
     */
    if (!deps.secrets.has(oauth.secretName)) {
      return {
        ok: false,
        error:
          `the client secret "${oauth.secretName}" resolves to nothing, so external sign-in ` +
          `cannot complete: set it before turning off password sign-in`,
      };
    }
  }

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, "dashboard", { password_login: params.enabled }));
  if (!saved.ok) return saved;

  log.info("password sign-in changed", { enabled: params.enabled, previous, actor: params.actor });
  deps.audit?.record({
    action: "password_login_changed",
    actor: params.actor,
    details: { enabled: params.enabled, previous },
  });
  return { ok: true, restartRequired: false };
}

/**
 * One agent's own pack: its endpoint and model, which skills it carries, its MCP servers.
 *
 * Writes into the pack rather than the daemon config, which is why every function here takes an
 * `agentConfigPath` (or, for skills, a `packDir`) instead of using `deps.configPath` — and a `reload`: each write goes
 * through the one checked write for a pack (`config/config-file.ts`), which reloads the agent and puts the file back
 * when it no longer loads. A save that answered ok over a pack that would not load was an agent gone at the next
 * restart; the route that called it used to reload after, and to say only that the reload had failed.
 */

import {
  approvalLevelRefusal,
  isAgentApprovalLevel,
  modelGuardRefusal,
  type AgentApprovalLevel,
  createLogger,
  type FallbackPair,
  toolIterationsRefusal,
  turnSecondsRefusal,
} from "@nouride/shared";
import { parseToml } from "@nouride/runtime";
import { editPackFile, editSkillStates, type ConfigEdit } from "@/modules/config/config-file.ts";
import { removeTomlKey, upsertTomlTable } from "@/modules/config/edit.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings");

/** Which pack, and how to reload its agent — what every write here is handed. */
interface PackWrite {
  agentConfigPath: string;
  reload: () => Promise<unknown>;
}

/** The pack's `config.toml` changed, its agent reloaded — or why nothing stayed written. */
async function savePack(input: PackWrite, edit: ConfigEdit): Promise<Extract<SaveResult, { ok: false }> | null> {
  const saved = await editPackFile({ path: input.agentConfigPath, reload: input.reload, edit });
  return saved.ok ? null : saved;
}

// ── An agent's model ───────────────────────────────────────────────────────

/**
 * How many tool round-trips this one agent's turns may take, or none to follow the daemon.
 *
 * `null` removes the key rather than writing a number, and that distinction is the feature: an
 * agent with no value tracks the daemon's, so raising the global later raises this agent too. A
 * number written here to mean "the same as the default" would silently stop tracking it.
 */
export async function saveAgentToolIterations(deps: SettingsDeps, input: {
  agentConfigPath: string;
  reload: () => Promise<unknown>;
  /** A whole number within the bounds, or null to follow the daemon. */
  iterations: number | null;
  actor: string;
  agentId: string;
}): Promise<SaveResult> {
  if (input.iterations !== null) {
    const refusal = toolIterationsRefusal(input.iterations, "max_tool_iterations");
    if (refusal) return { ok: false, error: refusal };
  }

  const refused = await savePack(input, (source) =>
    input.iterations === null
      ? removeTomlKey(source, "llm", "max_tool_iterations")
      : upsertTomlTable(source, "llm", { max_tool_iterations: input.iterations }),
  );
  if (refused) return refused;

  log.info("agent tool budget changed", {
    agent: input.agentId,
    iterations: input.iterations,
    actor: input.actor,
  });
  deps.audit?.record({
    action: "agent_tool_iterations_changed",
    actor: input.actor,
    details: { agent: input.agentId, iterations: input.iterations },
  });
  return { ok: true, restartRequired: false };
}

/**
 * One agent's own wall clock, or nothing at all to follow the daemon.
 *
 * `null` removes the key for the same reason it does on the tool budget: a number written because
 * that is what the global says today stops tracking the global tomorrow, and afterwards the two
 * cases are indistinguishable in the file.
 */
export async function saveAgentTurnSeconds(deps: SettingsDeps, input: {
  agentConfigPath: string;
  reload: () => Promise<unknown>;
  /** Whole seconds within the bounds, or null to follow the daemon. */
  seconds: number | null;
  actor: string;
  agentId: string;
}): Promise<SaveResult> {
  if (input.seconds !== null) {
    const refusal = turnSecondsRefusal(input.seconds, "max_turn_seconds");
    if (refusal) return { ok: false, error: refusal };
  }

  const refused = await savePack(input, (source) =>
    input.seconds === null
      ? removeTomlKey(source, "llm", "max_turn_seconds")
      : upsertTomlTable(source, "llm", { max_turn_seconds: input.seconds }),
  );
  if (refused) return refused;

  log.info("agent turn duration changed", {
    agent: input.agentId,
    seconds: input.seconds,
    actor: input.actor,
  });
  deps.audit?.record({
    action: "agent_turn_duration_changed",
    actor: input.actor,
    details: { agent: input.agentId, seconds: input.seconds },
  });
  return { ok: true, restartRequired: false };
}

/**
 * Who answers when an agent's model cannot — `[llm] fallbacks`, each a provider and a model, in order (SMART_AUTOMATION
 * §3.1) — or none, an empty list.
 *
 * Empty removes the key: no fallback of its own, and the install's `[llm.defaults] fallbacks` if it has any. The pack's
 * own check refuses a profile that is not configured, the agent's own model and a pair twice — and 0.7's
 * `fallback_model`, which 0.8.0 rewrote in every pack — and the checked write puts the file back when it does, so a
 * save of that is an error and nothing stays written.
 */
export async function saveAgentFallbacks(deps: SettingsDeps, input: {
  agentConfigPath: string;
  reload: () => Promise<unknown>;
  fallbacks: FallbackPair[];
  actor: string;
  agentId: string;
}): Promise<SaveResult> {
  const pairs = input.fallbacks.map((pair) => ({ provider: pair.provider.trim(), model: pair.model.trim() }));
  if (pairs.some((pair) => !pair.provider || !pair.model)) return { ok: false, error: "each fallback is a provider and a model on it" };

  const refused = await savePack(input, (source) =>
    pairs.length === 0 ? removeTomlKey(source, "llm", "fallbacks") : upsertTomlTable(source, "llm", { fallbacks: pairs }),
  );
  if (refused) return refused;

  log.info("agent fallbacks changed", { agent: input.agentId, fallbacks: pairs.map((pair) => `${pair.provider}/${pair.model}`), actor: input.actor });
  deps.audit?.record({
    action: "agent_fallbacks_changed",
    actor: input.actor,
    details: { agent: input.agentId, fallbacks: pairs },
  });
  return { ok: true, restartRequired: false };
}

/**
 * Point one agent at a different endpoint or model.
 *
 * Writes `[llm]` in the agent's own `config.toml` rather than the daemon's, because that is where
 * the choice belongs: the daemon owns the *profiles* (an endpoint, a wire format, a credential),
 * and each agent names one. Switching an agent to a different deployment stays a one-word change
 * in its pack, which is what makes a pack portable.
 *
 * Refuses a profile that is not defined. The agent would keep loading and fail on its first
 * message with a profile-not-found error, hours later, to whoever happened to message it.
 */
export async function saveAgentModel(deps: SettingsDeps, input: {
  agentConfigPath: string;
  reload: () => Promise<unknown>;
  provider: string;
  model: string;
  actor: string;
  agentId: string;
}): Promise<SaveResult> {
  const provider = input.provider.trim();
  const model = input.model.trim();
  if (!model) return { ok: false, error: "a model is required" };
  if (!deps.config.providers[provider]) {
    return {
      ok: false,
      error: `no provider profile "${provider}" (known: ${Object.keys(deps.config.providers).join(", ")})`,
    };
  }

  const refused = await savePack(input, (source) =>
    upsertTomlTable(source, "llm", { provider, model }),
  );
  if (refused) return refused;

  log.info("agent model changed", { agent: input.agentId, provider, model, actor: input.actor });
  deps.audit?.record({
    action: "agent_model_changed",
    actor: input.actor,
    details: { agent: input.agentId, provider, model },
  });
  return { ok: true, restartRequired: false };
}

/**
 * Turn an agent on or off in its own `config.toml`.
 *
 * **Not what `nouride agent pause` does.** `pause` is an in-memory `Set<string>` on the registry: it
 * lasts until the process restarts and no further. This edits the file the next boot reads. Both
 * exist because both are wanted, and conflating them is how an agent comes back after a deploy that
 * was supposed to have retired it.
 *
 * This is the capability the `agent_enable` tool held until the CLI became a tool of its own. It moved here rather than being
 * dropped because it fails both halves of the tool-or-CLI test: its arguments are a flag and an id,
 * and it is not scoped to the calling agent — it takes any id, exactly as a command does.
 */
export async function setAgentEnabled(deps: SettingsDeps, input: {
  agentConfigPath: string;
  reload: () => Promise<unknown>;
  agentId: string;
  enabled: boolean;
  actor: string;
}): Promise<SaveResult> {
  const refused = await savePack(input, (source) =>
    upsertTomlTable(source, "agent", { enabled: input.enabled }),
  );
  if (refused) return refused;

  log.info("agent enabled flag changed", { agent: input.agentId, enabled: input.enabled, actor: input.actor });
  deps.audit?.record({
    action: "agent_enabled",
    actor: input.actor,
    details: { agent: input.agentId, enabled: input.enabled },
  });
  return { ok: true, restartRequired: false };
}

/**
 * How much one agent asks, for everyone who talks to it.
 *
 * Written to the pack's `config.toml`, because it is that agent's posture — not a daemon-wide one, and
 * not a property of whoever happens to be chatting.
 *
 * **This is the only write path for `trusted`.** A chat command cannot set it (a chat sender is not
 * authenticated, which is why pairing exists) and no CLI verb writes it (the agent holds the `nouride`
 * tool, and this repo's notes record that `classifyHardline` says nothing about
 * `nouride config set security.exec.ask off` (exit 2 now, a verb gone) — so a CLI verb would be a way for an agent to be talked
 * into loosening its own gate). What is left is a dashboard behind a login, and this function.
 */
export async function setAgentApprovals(deps: SettingsDeps, input: {
  agentConfigPath: string;
  reload: () => Promise<unknown>;
  agentId: string;
  approvals: AgentApprovalLevel;
  actor: string;
}): Promise<SaveResult> {
  if (!isAgentApprovalLevel(input.approvals)) {
    return {
      ok: false,
      error: approvalLevelRefusal(input.approvals),
    };
  }

  const refused = await savePack(input, (source) =>
    upsertTomlTable(source, "agent", { approvals: input.approvals }),
  );
  if (refused) return refused;

  // `warn`, not `info`, for `trusted`: an agent with every gate off is a fact an operator reading the
  // journal later should not have to go looking for.
  const line = "agent approval level changed";
  const detail = { agent: input.agentId, approvals: input.approvals, actor: input.actor };
  if (input.approvals === "trusted") log.warn(line, detail);
  else log.info(line, detail);

  deps.audit?.record({
    action: "agent_approvals_changed",
    actor: input.actor,
    details: { agent: input.agentId, approvals: input.approvals },
  });
  return { ok: true, restartRequired: false };
}

/**
 * Whether the orchestrator installs and updates the programs every agent runs (`[security] shared_tools`, 0.8.0,
 * `toolchain/shared-tools.ts`). On is the default, so on takes the key out rather than writing `true`. Written into
 * whichever pack is asked; it counts only in the orchestrator's.
 */
export async function setAgentSharedTools(deps: Pick<SettingsDeps, "audit">, input: PackWrite & {
  agentId: string;
  on: boolean;
  actor: string;
}): Promise<SaveResult> {
  const refused = await savePack(input, (source) =>
    input.on ? removeTomlKey(source, "security", "shared_tools") : upsertTomlTable(source, "security", { shared_tools: false }),
  );
  if (refused) return refused;
  log.info(input.on ? "the orchestrator installs programs for every agent" : "the orchestrator no longer installs programs for every agent", {
    agent: input.agentId,
    actor: input.actor,
  });
  deps.audit?.record({ action: "agent_shared_tools_changed", actor: input.actor, details: { agent: input.agentId, on: input.on } });
  return { ok: true, restartRequired: false };
}

/**
 * This agent's second look (`[security] model_guard`, 0.8.0, `types/model-guard.ts`): `off`, a tier or a model id
 * written into its pack; null takes the key out, and the agent follows the daemon's setting again.
 */
export async function setAgentModelGuard(deps: Pick<SettingsDeps, "audit">, input: PackWrite & {
  agentId: string;
  value: string | null;
  actor: string;
}): Promise<SaveResult> {
  const value = input.value?.trim() || null;
  const refusal = modelGuardRefusal(value ?? undefined);
  if (refusal) return { ok: false, error: `model_guard ${refusal}` };
  const refused = await savePack(input, (source) =>
    value === null ? removeTomlKey(source, "security", "model_guard") : upsertTomlTable(source, "security", { model_guard: value }),
  );
  if (refused) return refused;
  log.info("an agent's second look changed", { agent: input.agentId, model_guard: value ?? "the daemon's", actor: input.actor });
  deps.audit?.record({ action: "agent_model_guard_changed", actor: input.actor, details: { agent: input.agentId, model_guard: value } });
  return { ok: true, restartRequired: false };
}

/**
 * A pack whose commands are no longer handed one secret (`[security.exec_secrets]`) — what deleting a secret does to
 * every pack that names it (`deleteSecret`), so nothing goes on asking for a value that is not there. The table loses
 * the key. Whether the file changed.
 */
export async function unnamePackSecret(input: PackWrite & { name: string }): Promise<boolean> {
  const saved = await editPackFile({ path: input.agentConfigPath, reload: input.reload, edit: (source) => withoutExecSecret(source, input.name) });
  return saved.ok && saved.changed;
}

/**
 * A secret an agent was just given, handed to its commands: `[security.exec_secrets] <name> = ["*"]`, every command, as
 * the owner wants a new one to be. A name the pack already binds is left as it is — a narrowed binding stays narrow.
 * Whether the file changed.
 */
export function bindPackSecret(input: PackWrite & { name: string }): ReturnType<typeof editPackFile> {
  return editPackFile({ path: input.agentConfigPath, reload: input.reload, edit: (source) => withExecSecret(source, input.name) });
}

function withExecSecret(source: string, name: string): string {
  const named = parseToml<{ security?: { exec_secrets?: unknown } }>(source).security?.exec_secrets;
  if (named && typeof named === "object" && name in named) return source;
  return upsertTomlTable(source, "security.exec_secrets", { [name]: ["*"] });
}

function withoutExecSecret(source: string, name: string): string {
  const named = parseToml<{ security?: { exec_secrets?: unknown } }>(source).security?.exec_secrets;
  return named && typeof named === "object" && name in named ? removeTomlKey(source, "security.exec_secrets", name) : source;
}

// ── An agent's built-in skills ─────────────────────────────────────────────

/**
 * Switch built-in skills on and off for one agent.
 *
 * **The input is the set to switch off, not the set to keep.** That shape is the whole design and
 * it is worth resisting the urge to "fix" — see `AgentConfig.skills.builtinDisabled`. An allow
 * list would have to be rewritten in full on every toggle, and a list written today cannot name a
 * skill that ships next month, so every later release would arrive switched off on any install
 * that had ever used this endpoint.
 *
 * **Live after the reload the write performs**, as `saveMcpServer` is: a skill is a file read during it.
 */
export async function saveAgentSkills(deps: SettingsDeps, input: {
  /** The agent's pack directory — `skills.toml` is written inside it. */
  packDir: string;
  reload: () => Promise<unknown>;
  agentId: string;
  /**
   * The decisions to change, `name → on/off`, merged into what the file holds when the write lands (`editSkillStates`).
   *
   * Not the whole map. The Workshop used to send its whole state on the claim that it kept two open tabs from
   * overwriting each other; it did the opposite — each tab's copy of the map was a last write that undid the other's
   * switch. A change merged under the file's lock leaves both.
   */
  changes: Record<string, boolean>;
  actor: string;
}): Promise<SaveResult> {
  const changes: Record<string, boolean> = {};
  for (const [rawName, value] of Object.entries(input.changes)) {
    const name = rawName.trim();
    if (!name) continue;
    if (typeof value !== "boolean") {
      // Refused rather than coerced. `"off"` coerced to `true` is a skill switched on while the
      // dashboard shows it off — the silent-setting bug this codebase keeps finding.
      return { ok: false, error: `skill "${name}" must be true or false, not ${JSON.stringify(value)}` };
    }
    changes[name] = value;
  }

  const saved = await editSkillStates({ packDir: input.packDir, changes, reload: input.reload });
  if (!saved.ok) return saved;

  log.info("agent skills changed", { agent: input.agentId, changes, actor: input.actor });
  deps.audit?.record({
    action: "agent_skills_changed",
    actor: input.actor,
    details: { agent: input.agentId, changes },
  });
  return { ok: true, restartRequired: false };
}

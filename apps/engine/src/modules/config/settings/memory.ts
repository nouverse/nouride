/**
 * How long the daemon keeps what it wrote down, and how memory behaves — the settings the dashboard
 * and `nouride memory set` change.
 *
 * Retention windows here are for records (logs, audit, conversations in the database). What memory
 * keeps is set under `[memory]` (`config.example.toml`): a conversation's transcript stays
 * readable for `transcript_days`, its summary forever, and an agent's own `MEMORY.md` is never swept.
 */

import { ConfigError, createLogger, type FactsMode, type GlobalConfig, type MemorySection } from "@nouride/shared";
import { validateMemory } from "@/modules/config/global/validate-memory.ts";
import { CONFIG_ENUMS } from "@/modules/config/schema.ts";
import { type TomlScalar, upsertTomlTable } from "@/modules/config/edit.ts";
import { editConfigFile } from "./file.ts";
import { writePersonMemory, type PersonMemorySetting } from "./people.ts";
import type { SaveResult, SettingsDeps } from "./types.ts";

const log = createLogger("settings.memory");

/**
 * The records this daemon prunes on a clock, and how long each is kept.
 *
 * One setter rather than a near-copy per window, because they differ only in which key gets the
 * integer. The sweep runs daily and reads the live config, which the save changes with the file
 * (`config/follow.ts`) — a value written only to the file would do nothing until the next restart.
 *
 * They are deliberately *different* numbers. The audit log is one row per decision and worth
 * keeping; the daemon log is every line it printed and worth keeping only while somebody might still
 * be diagnosing what it printed them about. A `max` per scope, because the ceiling that makes sense
 * for a decision record does not for a scroll.
 */
const RETENTION_SCOPES = {
  log: {
    table: "retention",
    key: "log_days",
    max: 90,
    read: (config: GlobalConfig) => config.retention.logDays,
  },
  audit: {
    table: "retention",
    key: "audit_days",
    max: 3650,
    read: (config: GlobalConfig) => config.retention.auditDays,
  },
  cronRuns: {
    table: "cron",
    key: "run_retention_days",
    max: 365,
    /**
     * `CronPort` holds a reference to `config.cron`, which the save changes in place, so it is what
     * the next sweep reads. If that ever becomes a copy, this setting silently stops taking effect
     * until a restart.
     */
    read: (config: GlobalConfig) => config.cron.runRetentionDays,
  },
  jobLogs: {
    table: "retention",
    key: "job_log_days",
    max: 365,
    read: (config: GlobalConfig) => config.retention.jobLogDays,
  },
  /**
   * Conversations — and, on the same number, what each turn did and what happened to the room.
   *
   * One window for three tables on purpose. A session's messages are what was *said*, `turn_records` is
   * the same history seen from the other side, and `chat_events` annotates it; two of the three
   * outliving the first would leave steps for a transcript that has been deleted and a room whose
   * only remaining content is notices about messages nobody can read.
   *
   * The widest ceiling here, because this is the one window whose contents a person may want years
   * later, and the narrowest thing to get wrong: unlike a log, there is no journal on the host
   * holding a second copy.
   */
  sessions: {
    table: "retention",
    key: "session_days",
    max: 3650,
    read: (config: GlobalConfig) => config.retention.sessionDays,
  },
} as const;

export type RetentionScope = keyof typeof RETENTION_SCOPES;

/**
 * The names, at runtime, so a caller can validate one without restating the list.
 *
 * The control route used to check `scope !== "log" && scope !== "audit" && …`, which is a second
 * copy of this map that nothing keeps in step: adding a window here left the route rejecting it, and
 * the only signal was a 400 from a control that looked wired. Derived, it cannot drift.
 */
export const RETENTION_SCOPES_NAMES = Object.keys(RETENTION_SCOPES) as RetentionScope[];

export function isRetentionScope(value: string): value is RetentionScope {
  return (RETENTION_SCOPES_NAMES as string[]).includes(value);
}

/** Every window, as the dashboard shows them. */
export function retentionWindows(deps: SettingsDeps): Record<RetentionScope, number> {
  return {
    log: RETENTION_SCOPES.log.read(deps.config),
    audit: RETENTION_SCOPES.audit.read(deps.config),
    cronRuns: RETENTION_SCOPES.cronRuns.read(deps.config),
    jobLogs: RETENTION_SCOPES.jobLogs.read(deps.config),
    sessions: RETENTION_SCOPES.sessions.read(deps.config),
  };
}

/**
 * Change one of them.
 *
 * `0` keeps everything, matching every other retention knob in this file. It never means "keep
 * nothing" — the opposite reading would make a mistyped zero delete the record on the next sweep,
 * and there is no undo for that.
 */
export async function setRetentionDays(deps: SettingsDeps, params: {
  scope: RetentionScope;
  days: number;
  actor?: string;
}): Promise<SaveResult> {
  const scope = RETENTION_SCOPES[params.scope];
  if (!scope) return { ok: false, error: `unknown retention scope "${params.scope}"` };

  const { days } = params;
  if (!Number.isInteger(days) || days < 0 || days > scope.max) {
    return {
      ok: false,
      error: `${scope.key} must be a whole number between 0 and ${scope.max} (0 keeps everything)`,
    };
  }

  const previous = scope.read(deps.config);
  if (days === previous) return { ok: true, restartRequired: false };

  const saved = await editConfigFile(deps, (source) => upsertTomlTable(source, scope.table, { [scope.key]: days }));
  if (!saved.ok) return saved;

  log.info("retention changed", { scope: params.scope, days, previous, actor: params.actor });
  deps.audit?.record({
    action: "retention_changed",
    actor: params.actor,
    details: { scope: params.scope, key: scope.key, days, previous },
  });
  return { ok: true, restartRequired: false };
}

/** The `[memory]` keys `nouride memory set` and the dashboard change. `dir` is not one: moving it moves every file. */
export type MemorySettings = Pick<
  MemorySection,
  "pass" | "passAt" | "passPerNight" | "passMaxTokens" | "passProvider" | "passModel" | "maxAttempts" | "facts" | "proposeShared" | "promptRecent" | "recall" | "transcriptDays" | "archive"
> & { semantic?: Partial<MemorySection["semantic"]> };

export const MEMORY_KEYS: Record<keyof MemorySettings, string> = {
  pass: "pass",
  passAt: "pass_at",
  passPerNight: "pass_per_night",
  passMaxTokens: "pass_max_tokens",
  passProvider: "pass_provider",
  passModel: "pass_model",
  maxAttempts: "max_attempts",
  facts: "facts",
  proposeShared: "propose_shared",
  promptRecent: "prompt_recent",
  recall: "recall",
  transcriptDays: "transcript_days",
  archive: "archive",
  semantic: "semantic",
};

/** The `[memory.*]` tables, and their keys — written to their own table rather than inline. */
const NESTED = {
  semantic: { enabled: "enabled", provider: "provider", model: "model", dimensions: "dimensions" },
} as const satisfies { [K in "semantic"]: Record<keyof MemorySection[K], string> };
type Nested = keyof typeof NESTED;
const isNested = (key: string): key is Nested => key in NESTED;

export function memorySettings(deps: SettingsDeps): MemorySettings {
  const memory = deps.config.memory;
  return Object.fromEntries(Object.keys(MEMORY_KEYS).map((key) => [key, memory[key as keyof MemorySettings]])) as MemorySettings;
}

/**
 * Change some of `[memory]`, checked by exactly the rules the loader applies (`validateMemory`), so a
 * value accepted here is one the next boot accepts too.
 *
 * **Live.** `modules/memory` reads the config object on every call, so the next turn sees it.
 */
export async function setMemorySettings(deps: SettingsDeps, params: {
  patch: Partial<MemorySettings>;
  actor?: string;
}): Promise<SaveResult> {
  const entries = Object.entries(params.patch).filter(([, value]) => value !== undefined) as [
    keyof MemorySettings,
    MemorySettings[keyof MemorySettings],
  ][];
  if (entries.length === 0) return { ok: true, restartRequired: false };
  for (const [key] of entries) {
    if (!(key in MEMORY_KEYS)) return { ok: false, error: `unknown [memory] setting "${key}"` };
  }

  const flat = entries.filter(([key]) => !isNested(key));
  const nested = (Object.keys(NESTED) as Nested[]).map((table) => {
    const patch = (params.patch[table] ?? {}) as Record<string, unknown>;
    const keys = NESTED[table] as Record<string, string>;
    return { table, entries: Object.entries(patch).filter(([key, value]) => value !== undefined && key in keys) };
  });
  const next = {
    ...deps.config.memory,
    ...Object.fromEntries(flat),
    ...Object.fromEntries(nested.map(({ table, entries: changed }) => [table, { ...deps.config.memory[table], ...Object.fromEntries(changed) }])),
  } as MemorySection;
  try {
    validateMemory({ memory: next, providers: deps.config.providers });
  } catch (err) {
    if (err instanceof ConfigError) return { ok: false, error: err.message };
    throw err;
  }

  const semanticChange = nested.find((entry) => entry.table === "semantic")?.entries.length ?? 0;
  if (semanticChange && next.semantic.enabled) {
    const refused = await probeEmbedding(deps, next.semantic);
    if (refused) return { ok: false, error: refused, probe: true };
  }

  const previous = memorySettings(deps);
  // After the embedding probe, which can take a minute: the file's lock is held only for the edit itself.
  const saved = await editConfigFile(deps, (source) => {
    let text = flat.length
      ? upsertTomlTable(source, "memory", Object.fromEntries(flat.map(([key, value]) => [MEMORY_KEYS[key], value as TomlScalar])))
      : source;
    for (const { table, entries: changed } of nested) {
      if (!changed.length) continue;
      const keys = NESTED[table] as Record<string, string>;
      text = upsertTomlTable(text, `memory.${table}`, Object.fromEntries(changed.map(([key, value]) => [keys[key]!, value as TomlScalar])));
    }
    return text;
  });
  if (!saved.ok) return saved;

  const changed = Object.fromEntries(entries);
  log.info("memory settings changed", { ...changed, actor: params.actor });
  deps.audit?.record({
    action: "memory_settings_changed",
    actor: params.actor,
    details: { changed, previous: Object.fromEntries(entries.map(([key]) => [key, previous[key]])) },
  });
  return { ok: true, restartRequired: false };
}

/**
 * What the nightly pass may do to one person's profile, over `[memory] facts`; null follows it again.
 * Written to their `[[people]]` block, and live like the rest of `[memory]`.
 */
export async function setPersonFacts(deps: SettingsDeps, params: {
  key: string;
  facts: FactsMode | null;
  actor?: string;
}): Promise<SaveResult> {
  const modes: readonly string[] = CONFIG_ENUMS["memory.facts"];
  if (params.facts !== null && !modes.includes(params.facts)) {
    return { ok: false, error: `facts must be one of ${modes.join(", ")}, or null to follow [memory] facts` };
  }
  return await setPersonMemory(deps, params.key, { field: "facts", value: params.facts }, params.actor);
}

/** Whether what is remembered about one person goes into prompts, over `[memory] recall`; null follows it again. */
export async function setPersonRecall(deps: SettingsDeps, params: {
  key: string;
  recall: boolean | null;
  actor?: string;
}): Promise<SaveResult> {
  if (params.recall !== null && typeof params.recall !== "boolean") return { ok: false, error: "recall must be true, false, or null to follow [memory] recall" };
  return await setPersonMemory(deps, params.key, { field: "recall", value: params.recall }, params.actor);
}

async function setPersonMemory(deps: SettingsDeps, key: string, setting: PersonMemorySetting, actor: string | undefined): Promise<SaveResult> {
  const saved = await writePersonMemory(deps, key, setting);
  if (!saved.ok) return saved;
  const { previous } = saved;
  if (previous === setting.value) return { ok: true, restartRequired: false };

  const name = `people.${key}.${setting.field}`;
  log.info(`person ${setting.field} changed`, { key, [setting.field]: setting.value, previous, actor });
  deps.audit?.record({ action: "memory_settings_changed", actor, details: { changed: { [name]: setting.value }, previous: { [name]: previous } } });
  return { ok: true, restartRequired: false };
}

/** Long enough for a local model on a CPU; a first `bge-m3` call on the box took 45 seconds. */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * What Ollama says a model is for — `["embedding"]`, `["completion", "tools"]` — or null when the
 * endpoint is not Ollama or does not say.
 *
 * Needed because Ollama embeds with any model it has, chat models included, and answers with a vector
 * of the right shape: the probe below passes, search "works", and finds nothing, because a chat
 * model's vectors are not built to be compared. OpenAI and Gemini refuse a chat model on their own.
 */
async function ollamaCapabilities(baseUrl: string, model: string): Promise<string[] | null> {
  const origin = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    const response = await fetch(`${origin}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { capabilities?: unknown };
    return Array.isArray(body.capabilities) ? body.capabilities.filter((item): item is string => typeof item === "string") : null;
  } catch {
    return null;
  }
}

/** Said after every refusal: what to add, so the person is not left with only what went wrong. */
const EMBEDDING_HINT =
  " To use one, add an OpenAI-compatible provider that makes embeddings on the Models page: Ollama (bge-m3), OpenAI (text-embedding-3-small) or Gemini (gemini-embedding-001).";

/**
 * Semantic search is switched on only once it works: the model is one that embeds, and one real
 * embedding with the profile and model named answers, before anything is written. Null when it
 * answered; otherwise why it stays off. Asked on every change while it is on, so pointing it at a
 * model that does not exist, or at a chat model, cannot slip through either.
 */
async function probeEmbedding(deps: SettingsDeps, semantic: MemorySection["semantic"]): Promise<string | null> {
  const off = `semantic search stays off for ${semantic.provider}/${semantic.model}`;
  let provider;
  try {
    provider = deps.providers.get(semantic.provider);
  } catch (err) {
    return `${off}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!provider.embed) return `${off}: that profile's API has no embeddings.${EMBEDDING_HINT}`;
  const endpoint = deps.providers.available().find((profile) => profile.name === semantic.provider);
  const capabilities = endpoint?.kind === "openai" ? await ollamaCapabilities(endpoint.baseUrl, semantic.model) : null;
  if (capabilities && !capabilities.includes("embedding")) {
    return `${off}: that is a chat model, not an embedding model. Pick one made for embeddings, like bge-m3 or nomic-embed-text`;
  }
  try {
    const result = await provider.embed({
      model: semantic.model,
      input: ["nouride embedding check"],
      dimensions: semantic.dimensions,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return result.vectors[0]?.length ? null : `${off}: the endpoint answered with no vector`;
  } catch (err) {
    return `${off}, which did not embed: ${err instanceof Error ? err.message : String(err)}.${EMBEDDING_HINT}`;
  }
}

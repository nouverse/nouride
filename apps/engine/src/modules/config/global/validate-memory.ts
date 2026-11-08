/**
 * `[memory]` — each key in `config.example.toml`, and memory in `docs/SPEC.md` §12. A person's key and memory
 * settings are checked with the rest of them (`validate-people.ts`, 0.8.18).
 *
 * Its own file because two callers apply it: the loader, at boot, and `setMemorySettings`, before a
 * change is written — so a value accepted from the dashboard is one the next boot accepts too.
 */

import { wireCapabilities } from "@nouride/llm";
import { ConfigError, isModelTier, type GlobalConfig } from "@nouride/shared";
import { CONFIG_ENUMS } from "@/modules/config/schema.ts";

/** At most this many summaries in the prompt — past it the section stops being cheap to cache. */
const MAX_PROMPT_RECENT = 20;

/** A setting of `[memory]` a refusal is about (0.8.23), by its name in the Memory page's settings; `semantic*` search by meaning's. */
export type MemoryField =
  | "promptRecent"
  | "transcriptDays"
  | "passAt"
  | "facts"
  | "passPerNight"
  | "passMaxTokens"
  | "maxAttempts"
  | "passProvider"
  | "passModel"
  | "semanticDimensions"
  | "semanticProvider"
  | "semanticModel";

/** The loader's refusal, saying which setting it refused: the dashboard names it, and the loader reads a `ConfigError`. */
export class MemoryConfigError extends ConfigError {
  override name = "MemoryConfigError";
  constructor(readonly field: MemoryField, message: string) {
    super(message);
  }
}

/** Each refusal is a memory that would otherwise be wrong, or a pass that would not run, without saying so. */
export function validateMemory(config: Pick<GlobalConfig, "memory"> & Partial<Pick<GlobalConfig, "providers">>): void {
  const recent = config.memory.promptRecent;
  if (!Number.isInteger(recent) || recent < 0 || recent > MAX_PROMPT_RECENT) {
    throw new MemoryConfigError("promptRecent", `[memory] prompt_recent must be a whole number from 0 to ${MAX_PROMPT_RECENT}, got ${recent}`);
  }
  const days = config.memory.transcriptDays;
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    throw new MemoryConfigError("transcriptDays", `[memory] transcript_days must be a whole number from 0 (keep forever) to 3650, got ${days}`);
  }
  validatePass(config);
}

/** At most this many episodes a night per agent — past it, one night's pass is a bill, not a sweep. */
const MAX_PER_NIGHT = 500;

/** `[memory]`'s nightly pass. Each refusal is a pass that would otherwise never run, or run wrong. */
function validatePass(config: Pick<GlobalConfig, "memory"> & Partial<Pick<GlobalConfig, "providers">>): void {
  const memory = config.memory;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(memory.passAt)) {
    throw new MemoryConfigError("passAt", `[memory] pass_at must be a time as HH:MM (e.g. "01:00"), got "${memory.passAt}"`);
  }
  const facts: readonly string[] = CONFIG_ENUMS["memory.facts"];
  if (!facts.includes(memory.facts)) {
    throw new MemoryConfigError("facts", `[memory] facts must be one of ${facts.join(", ")}, got "${memory.facts}"`);
  }
  if (!Number.isInteger(memory.passPerNight) || memory.passPerNight < 1 || memory.passPerNight > MAX_PER_NIGHT) {
    throw new MemoryConfigError("passPerNight", `[memory] pass_per_night must be a whole number from 1 to ${MAX_PER_NIGHT}, got ${memory.passPerNight}`);
  }
  if (!Number.isInteger(memory.passMaxTokens) || memory.passMaxTokens < 0) {
    throw new MemoryConfigError("passMaxTokens", `[memory] pass_max_tokens must be a whole number of tokens, 0 for no limit of the pass's own, got ${memory.passMaxTokens}`);
  }
  if (!Number.isInteger(memory.maxAttempts) || memory.maxAttempts < 1 || memory.maxAttempts > 10) {
    throw new MemoryConfigError("maxAttempts", `[memory] max_attempts must be a whole number from 1 to 10, got ${memory.maxAttempts}`);
  }
  validateSemantic(config);
  // A model means nothing without the profile that serves it: agents use different providers, so a
  // bare `pass_model` would be sent to each one's, and exist on some and not others. A tier is the exception: it is
  // each agent's own model of that tier, on its own provider (0.8.0) — so it is never beside a provider.
  if (isModelTier(memory.passModel)) {
    if (memory.passProvider) {
      throw new MemoryConfigError(
        "passProvider",
        `[memory] pass_model = "${memory.passModel}" is a tier (each agent's own model of it, on its own provider), so pass_provider goes: remove it, or name a model on that profile instead`,
      );
    }
  } else if (Boolean(memory.passProvider) !== Boolean(memory.passModel)) {
    // The one of the two left empty.
    throw new MemoryConfigError(memory.passProvider ? "passModel" : "passProvider", "[memory] pass_provider and pass_model go together: set both for one model for every agent, or neither for each agent's own");
  }
  // Checked where the providers are known; `setMemorySettings` validates memory alone.
  const provider = memory.passProvider;
  if (provider && config.providers && !config.providers[provider]) {
    const known = Object.keys(config.providers);
    throw new MemoryConfigError(
      "passProvider",
      `[memory] pass_provider "${provider}" is not a provider profile` +
        (known.length > 0 ? ` (known profiles: ${known.join(", ")})` : " (no provider profiles are defined yet)"),
    );
  }
}

/** `[memory.semantic]`: on means a provider and a model, and a provider that exists. */
function validateSemantic(config: Pick<GlobalConfig, "memory"> & Partial<Pick<GlobalConfig, "providers">>): void {
  const semantic = config.memory.semantic;
  if (!Number.isInteger(semantic.dimensions) || semantic.dimensions < 32 || semantic.dimensions > 4096) {
    throw new MemoryConfigError("semanticDimensions", `[memory.semantic] dimensions must be a whole number from 32 to 4096, got ${semantic.dimensions}`);
  }
  if (!semantic.enabled) return;
  if (!semantic.provider || !semantic.model) {
    throw new MemoryConfigError(semantic.provider ? "semanticModel" : "semanticProvider", "[memory.semantic] enabled needs provider and model: the profile that embeds, and its embedding model");
  }
  if (config.providers && !config.providers[semantic.provider]) {
    throw new MemoryConfigError("semanticProvider", `[memory.semantic] provider "${semantic.provider}" is not a provider profile`);
  }
  const kind = config.providers?.[semantic.provider]?.kind;
  if (kind && !wireCapabilities(kind).embeddings) {
    throw new MemoryConfigError("semanticProvider", `[memory.semantic] provider "${semantic.provider}" is an Anthropic profile, which has no embeddings: name an OpenAI-compatible one`);
  }
}

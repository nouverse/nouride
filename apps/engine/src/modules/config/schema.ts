/**
 * What every configuration key is, for something that cannot read this source.
 *
 * The problem this exists for: an agent running inside a *packaged* Nouride has no `src/` to look at.
 * It cannot discover that the search endpoint lives under `[security.web]` rather than `[web]`, that
 * `search_api_key` holds the *name* of a secret and never the secret, or that pointing an endpoint at
 * `192.168.0.10` does nothing until `allow_private_urls = true`. Without a way to ask, it configures by
 * trial and error against a daemon that refuses to boot — which is how a live install lost the
 * conversation that could have fixed it.
 *
 * ## Why this is derived rather than written out
 *
 * The key list comes from walking `DEFAULT_CONFIG`, because that object already *is* the authority:
 * `deepMerge` accepts a key if and only if it exists there (`if (!(key in base)) … ignored`). A
 * hand-maintained copy of the same list would be a second source of truth that drifts, and the drift
 * would be invisible — the schema would describe a key the loader ignores, or omit one it accepts.
 *
 * So the shape, the types and the defaults are computed. Only the prose is hand-written, and a key
 * with no prose still answers the two questions that matter most: what type is it, and what is it now.
 * `configAnnotationDrift` is the guard that keeps prose from outliving its key.
 *
 * Enum values live here too, and `config/global/validate.ts` validates against these tables rather than
 * repeating the literals. A schema that advertises a value the loader rejects is worse than no schema.
 */

import { LLM_EFFORTS, MAX_BACKGROUND_HELPERS, MOST_MISSIONS_PER_AGENT, UPDATE_TRACKS, type GlobalConfig } from "@nouride/shared";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ADVANCED_KEYS } from "@/modules/config/advanced.ts";
import { fallbackKeyNames, isSearchKind, resolveSearch, SEARCH_KINDS } from "@/modules/tools/builtins/search-backends.ts";

/** TOML is snake_case; the config object is camelCase. One conversion, used everywhere here. */
export function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

import { ANNOTATIONS } from "./schema.docs.ts";

/**
 * Allowed values, shared with the loader.
 *
 * Imported by `config/global/validate.ts` so `validateEnum` and `nouride config schema` cannot disagree
 * about what is accepted. Anything added here is offered *and* accepted, or neither.
 */
export const CONFIG_ENUMS = {
  /**
   * Listed late, and the omission was not harmless.
   *
   * Every other setting in `[security]` was enumerated and this one — the one that decides whether
   * anything asks at all — was not, so `approvals = "riksy"` passed `config check` with "this
   * configuration would start" and exit 0. `skipsApproval` then fell through its two exact
   * comparisons into the `balanced` branch, so a typo made while *tightening* to `careful` silently
   * loosened the install instead. Both halves are fixed: the value is refused here, and the
   * fall-through in `skipsApproval` now lands on `careful`.
   */
  "security.approvals": ["careful", "balanced", "trusted"],
  "security.exec.landlock": ["off", "auto", "require"],
  "security.access.mode": ["open", "allowlist", "pair"],
  // The search tool's own list, so a service it gains is accepted here without a second edit.
  "security.web.search_kind": SEARCH_KINDS,
  "daemon.log_level": ["debug", "info", "warn", "error"],
  "llm.context.truncation_strategy": ["sliding_window", "summary"],
  "rollover.mode": ["none", "daily", "idle"],
  "memory.facts": ["auto", "ask", "off"],
  "cron.unattended_approval": ["auto", "deny"],
  // Linted rather than refused: an unknown mode is read as `ask` (`reflection/index.ts`), never as `auto`.
  "skills.learning.mode": ["off", "ask", "auto"],
  // Linted rather than refused, like most of this list: a typo reads as `auto`, which hears less, not
  // more — the conservative direction.
  "media.audio_input": ["auto", "always"],
  // Refused at load, unlike most of this list: a value the provider does not know fails every request (`validate.ts`).
  "llm.defaults.effort": LLM_EFFORTS,
  // Refused at load: the updater reads anything but `latest` as staying on a line, so "lastest" would hold an install back.
  "update.track": UPDATE_TRACKS,
} as const satisfies Record<string, readonly string[]>;

/**
 * Names accepted in `[security.web] fallback_backends`.
 *
 * A superset of the search kinds, because `duckduckgo` is not one: it is the keyless scraping chain,
 * which needs no endpoint and no credential and therefore cannot be a `search_kind` the way the others
 * are. It is also the default fallback, so leaving it out of the accepted set would reject the
 * shipped configuration.
 */
export const FALLBACK_BACKEND_NAMES = ["duckduckgo", ...SEARCH_KINDS] as const;
export type FallbackBackendName = (typeof FALLBACK_BACKEND_NAMES)[number];

export type ConfigType = "string" | "number" | "boolean" | "string[]" | "table[]";

export interface ConfigField {
  /** Dotted TOML path in snake_case — what an operator actually types. */
  path: string;
  type: ConfigType;
  /** The value in force when the key is absent. `undefined` means the feature is off until set. */
  default: unknown;
  enum?: readonly string[];
  /** For a number: the least and the most it may be, and whether it must be whole (`boundsOf`). */
  minimum?: number;
  maximum?: number;
  integer?: boolean;
  description?: string;
  /**
   * The companion setting, or the trap.
   *
   * This field is the reason the whole command exists. Types and defaults can be guessed; "this does
   * nothing unless you also set that" cannot, and it is where the time goes.
   */
  caveat?: string;
  example?: string;
  /** The value is the *name* of a credential, resolved from the secret store. Never the secret. */
  secretRef?: boolean;
  /**
   * Whether a save through the daemon — a dashboard form, a `nouride` command — applies it at once (`true`), or the
   * daemon reads it at boot and the change waits for a restart (`false`). Said by what the key's setter answers
   * (`restartRequired`, `config/settings/*.ts`). A key no setter writes is changed by hand, and a hand edit always
   * waits for a restart (`config/follow.ts`). `running-config.test.ts` holds every `live` key to a setter that applies it.
   */
  live: boolean;
  /**
   * Rarely needed (`config/advanced.ts`): in the docs' one appendix and behind the dashboard's "Advanced", absent from
   * `config.example.toml`. It works as any key does.
   */
  advanced?: true;
}

/** Exported for `schema.docs.ts`, which holds the map of them. `live` is said only where it is true. */
export type Annotation = Omit<ConfigField, "path" | "type" | "default" | "enum" | "minimum" | "maximum" | "integer" | "live" | "advanced"> & { live?: true };

/**
 * What a number may be, past the rule every number in the config keeps: finite, not negative, and whole unless it says
 * `fraction`. A negative cap was read as "off" and a negative retention as "keep nothing", while `config check` said
 * the file would start. Keyed by TOML path, like `CONFIG_ENUMS`.
 */
const CONFIG_BOUNDS: Record<string, { min?: number; max?: number; fraction?: true }> = {
  "dashboard.port": { min: 1, max: 65_535 },
  "nougate.port": { min: 1, max: 65_535 },
  "llm.defaults.temperature": { max: 2, fraction: true },
  "llm.defaults.max_tokens": { min: 0 },
  "llm.limits.max_tokens_per_turn": { min: 1 },
  "llm.limits.max_daily_cost_usd": { fraction: true },
  "llm.limits.cost_alert_threshold_pct": { max: 100 },
  "llm.context.max_context_ratio": { max: 1, fraction: true },
  "llm.context.compact_at_ratio": { max: 1, fraction: true },
  "llm.context.compact_at_tokens": { min: 16_000 },
  "queue.max_concurrent_turns": { min: 1 },
  "delegate.max_background": { max: MAX_BACKGROUND_HELPERS },
  "missions.per_agent": { min: 1, max: MOST_MISSIONS_PER_AGENT },
  // No fixed most: as high as every agent at once, which only the agents loaded know (`missions/slots.ts`).
  "missions.max_running": { min: 1 },
  "missions.limit_hours": { min: 0.25, max: 168, fraction: true },
  "missions.limit_turns": { min: 1, max: 1000 },
  "missions.limit_tokens": { min: 100_000 },
  "queue.max_concurrent_per_agent": { min: 1 },
  "queue.max_queue_depth": { min: 1 },
  "rollover.at_hour": { max: 23 },
  "memory.semantic.dimensions": { min: 1 },
};

/**
 * Numbers with no default — absent is "worked out", not zero — so the walk has no value to read their type from. Each is
 * still a number, described as one and held to its bounds when set.
 */
export const UNSET_NUMBERS: ReadonlySet<string> = new Set(["llm.context.compact_at_tokens", "delegate.max_background", "missions.max_running"]);

/** The bounds a number at `path` keeps: its own, over the rule every number keeps. */
export function boundsOf(path: string): { min: number; max?: number; integer: boolean } {
  const own = CONFIG_BOUNDS[path] ?? {};
  return { min: own.min ?? 0, ...(own.max === undefined ? {} : { max: own.max }), integer: own.fraction !== true };
}


/** Sections whose keys are chosen by the operator, so no fixed list can describe them. */
const OPEN_SECTIONS: ConfigField[] = [
  {
    path: "providers",
    type: "table[]",
    default: undefined,
    live: true,
    description:
      "One `[providers.<name>]` table per endpoint you can reach. `<name>` is yours to choose and is what `llm.defaults.provider` and an agent's `[llm] provider` refer to.",
    caveat:
      "`api_key` holds the *name* of a credential, never the key. Keys are `kind` (\"openai\" or \"anthropic\"), `base_url` and `api_key`, then optional `headers`, `identify = true`, which says which agent and conversation each request is for (`user`, `prompt_cache_key` and an `x-client-id` header on the OpenAI wire, `metadata.user_id` on Anthropic's; the agent by its id, the conversation as an opaque id that holds no chat id, name or number; off unless set, because a strict server rejects a field it does not know; setup writes `identify = true` for a profile on `https://api.openai.com/v1` or `https://api.anthropic.com/v1`, which take those fields, and a start adds it, once, to such a profile that says neither: write `identify = false` to keep it off), and `billing = \"included\"` for a subscription that costs nothing per token (Nougate's OAuth accounts): its calls are kept out of `max_daily_cost_usd`, still counted by `max_daily_tokens`, and shown as included rather than as list-price spend. `max_tokens_field` is the request field a reply's output limit goes in on the OpenAI wire: `max_tokens` (absent), or `max_completion_tokens`, which OpenAI's own API needs for its newer models: setup writes it for a profile on `https://api.openai.com/v1`, and a start adds it, once, to such a profile that says neither. Leave it out for any other server: one that only speaks the format may know `max_tokens` alone, as Nougate does for its Gemini accounts. `cache_minutes` is how long the endpoint keeps a conversation's cached prompt after its last request, in whole minutes: a conversation idle for longer has lost its cache, so old tool output is cleared from its history then, when the rewrite costs nothing. Left out, a profile on Anthropic's own API is read as 5, the lifetime Anthropic documents, and any other as 60; set it where you know your endpoint's (0 for one that caches nothing).",
    example: '[providers.antigravity]\nkind = "openai"\nbase_url = "http://127.0.0.1:8080/v1"\napi_key = "antigravity_key"',
  },
  {
    path: "gateways",
    type: "table[]",
    default: undefined,
    // A connection is a socket opened at boot, so a saved one waits for a restart (`settings/gateways.ts`).
    live: false,
    description:
      "One `[gateways.<platform>.<name>]` table per connection. Several may share a platform: that is one bot per agent.",
    caveat:
      "`token` holds the *name* of a credential. `agent` binds the connection to one agent, which is what makes a shared channel answer once instead of once per bot.",
    example: '[gateways.telegram.bot]\nenabled = true\ntoken = "telegram_bot_token"\nagent = "nouva"',
  },
  {
    path: "people",
    type: "table[]",
    default: undefined,
    live: true,
    description:
      "One `[[people]]` entry per person an agent should recognise, so a sender's account becomes a name it knows.",
    caveat:
      "`key` is the person: unique, set once, and the name of their profile (`[memory] dir`/people/<key>.md): lowercase letters and digits, words joined by \"-\". An entry written without one is given one from its name. `ids` are their accounts, each the platform and the account, and may be none yet: attach one when they pair. `facts` (`auto`, `ask`, `off`) overrides `[memory] facts` for them; absent follows it.",
    example: '[[people]]\nkey = "alex"\nname = "Alex"\nids = ["telegram:5550001111"]\nnotes = "Runs this homelab."',
  },
  {
    path: "external_clis",
    type: "table[]",
    default: undefined,
    // Nothing saves it but a hand edit, which the running daemon reads at its next start.
    live: false,
    description:
      "One `[[external_clis]]` entry per coding CLI you add for external agents, beside the two built in (Claude Code, Codex). A pack's `[external] cli` names one by `id`.",
    caveat:
      "`id` (lowercase letters, digits and dashes) is what a pack names; one a built-in row has (`claude-code`, `codex`) is refused. `name` is shown beside it (absent: the id). `command` and `args` start the CLI's ACP mode, from the agent's folder, as the agent's own user where the helper `install.sh` sets up is installed, as the daemon's user elsewhere. `install` is said where it is not installed. `version_args` prints its version (absent: `--version`). `profile_env` is the variable that points it at a sign-in folder, one per `[external] profile`; absent, the folder is its HOME. `modes` maps the presets `folder`, `risky` and `all` to the CLI's own mode ids. `instruction_file` is its instruction file in the agent's folder, where Nouride writes the persona between its markers (absent: `AGENTS.md`). `login` is run in a terminal to sign in, with `login_note` said beside it; `status` is the words run to ask whether a profile is signed in, exiting 0 when it is; `signed_out` lists words in a refusal that mean it is not. A secret it needs is bound in `[security.exec_secrets]`: there is no `env` here, and any other key is warned about and ignored.",
    example:
      '[[external_clis]]\nid = "opencode"\nname = "OpenCode"\ncommand = "opencode"\nargs = ["acp"]\ninstall = "npm i -g opencode-ai"\nlogin = ["auth", "login"]',
  },
];

function typeOf(value: unknown, path: string): ConfigType {
  if (Array.isArray(value)) return "string[]";
  if (typeof value === "number" || UNSET_NUMBERS.has(path)) return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  // No default to read the type from — `daemon.orchestrator`, `llm.context.summary_model`. Both are
  // strings, and both mean "off until set", which is why they have no default in the first place.
  return "string";
}

/**
 * Every configuration key, computed from the defaults and annotated where there is prose.
 *
 * Sorted by path so the output is stable — a diff of two `config schema` runs should show what
 * changed in the config surface, not what changed in object key order.
 */
export function describeConfig(): ConfigField[] {
  const fields: ConfigField[] = [];

  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${snakeCase(key)}` : snakeCase(key);
      // Open-shaped sections are described by hand below: their keys are operator-chosen, so walking
      // whatever happens to be loaded would document one install rather than the format.
      if (OPEN_SECTIONS.some((section) => section.path === path)) continue;

      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, path);
        continue;
      }

      const annotation = ANNOTATIONS[path];
      const enumValues = CONFIG_ENUMS[path as keyof typeof CONFIG_ENUMS];
      const bounds = typeof value === "number" || UNSET_NUMBERS.has(path) ? boundsOf(path) : undefined;
      fields.push({
        path,
        type: typeOf(value, path),
        default: value,
        ...(enumValues ? { enum: enumValues } : {}),
        ...(bounds ? { minimum: bounds.min, ...(bounds.max === undefined ? {} : { maximum: bounds.max }), integer: bounds.integer } : {}),
        ...(annotation ?? {}),
        live: annotation?.live === true,
        ...(ADVANCED_KEYS.has(path) ? { advanced: true as const } : {}),
      });
    }
  };

  walk(DEFAULT_CONFIG as unknown as Record<string, unknown>, "");
  fields.push(...OPEN_SECTIONS);
  return fields.sort((a, b) => a.path.localeCompare(b.path));
}

/** Fields under a dotted section prefix, or everything when no section is named. */
export function fieldsIn(section?: string): ConfigField[] {
  const all = describeConfig();
  if (!section) return all;
  const prefix = `${section}.`;
  return all.filter((field) => field.path === section || field.path.startsWith(prefix));
}

export function findField(path: string): ConfigField | null {
  return describeConfig().find((field) => field.path === path) ?? null;
}

const JSON_TYPES: Record<ConfigType, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  "string[]": "array",
  "table[]": "array",
};

/**
 * JSON Schema for a section, or for the whole file.
 *
 * Nested to match the TOML, because the nesting is the thing people get wrong — `[security.web]`
 * versus `[web]` versus `[tools.web]`. A flat list of dotted paths would answer the easy half.
 */
export function configJsonSchema(section?: string): Record<string, unknown> {
  const fields = fieldsIn(section);
  const root: Record<string, unknown> = {};

  for (const field of fields) {
    const relative = section && field.path !== section ? field.path.slice(section.length + 1) : field.path;
    const parts = relative.split(".");
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      const existing = cursor[part] as Record<string, unknown> | undefined;
      const next = existing ?? { type: "object", properties: {} };
      cursor[part] = next;
      cursor = next.properties as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]!] = {
      type: field.integer ? "integer" : JSON_TYPES[field.type],
      ...(field.minimum === undefined ? {} : { minimum: field.minimum }),
      ...(field.maximum === undefined ? {} : { maximum: field.maximum }),
      ...(field.type === "string[]" ? { items: { type: "string" } } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
      ...(field.enum ? { enum: [...field.enum] } : {}),
      ...(field.description ? { description: field.description } : {}),
      ...(field.caveat ? { "x-caveat": field.caveat } : {}),
      ...(field.example ? { "x-example": field.example } : {}),
      ...(field.secretRef ? { "x-secret-ref": true } : {}),
      "x-live": field.live,
      ...(field.advanced ? { "x-advanced": true } : {}),
    };
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: section ? `Nouride configuration: ${section}` : "Nouride configuration",
    type: "object",
    properties: root,
  };
}

/** Paths that have prose but no key any more. Zero, or the annotation table is describing fiction. */
export function configAnnotationDrift(): string[] {
  const known = new Set(describeConfig().map((field) => field.path));
  return Object.keys(ANNOTATIONS).filter((path) => !known.has(path));
}

export interface ConfigLint {
  level: "warn" | "bad";
  message: string;
  hint: string;
  /**
   * A default the project chose on purpose — no spend cap — still worth saying when asked (`config check`, `doctor`),
   * and said at info at boot rather than warned about on every one.
   */
  deliberate?: true;
}

const PRIVATE_HOST =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?$|localhost$)/i;

/**
 * Read a value out of the config by its TOML path.
 *
 * The config object is camelCase and the paths here are snake_case, so each segment is converted on
 * the way down. Returns undefined for a path that does not resolve, which the caller treats as
 * "nothing to check" rather than as a failure — `describeConfig` is the thing that knows which paths
 * exist, and it derives them from the same object.
 */
function valueAtPath(config: GlobalConfig, path: string): unknown {
  let cursor: unknown = config;
  for (const segment of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    const camel = segment.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    cursor = (cursor as Record<string, unknown>)[camel];
  }
  return cursor;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * The combinations that are individually valid and together do not work.
 *
 * `config check` already answers "would this boot". These are the ones that boot fine and then fail
 * at the first call, which is a worse place to find out: the endpoint is set, the key is set, and the
 * SSRF guard silently refuses every request because the companion flag is still false.
 *
 * `secretSet` answers whether a secret name holds a value, for the one lint that turns on a key the file only names by
 * convention (a fallback's own). Absent, where the store cannot be opened, that lint says nothing rather than guess.
 */
export function lintConfig(config: GlobalConfig, options: { secretSet?: (name: string) => boolean } = {}): ConfigLint[] {
  const out: ConfigLint[] = [];

  /**
   * Enum values reported rather than refused.
   *
   * Only four of these were ever validated at boot, and the loader has always *tolerated* the rest —
   * an unrecognised `search_kind` is quietly ignored, which is its own kind of lie but a live install
   * may already depend on it booting. Turning tolerance into a refusal would brick a daemon on a file
   * it accepted yesterday, so the new ones say so loudly here instead. Driven off `CONFIG_ENUMS`, so
   * an enum added there is linted without anything else being touched.
   */
  for (const [path, allowed] of Object.entries(CONFIG_ENUMS)) {
    const value = valueAtPath(config, path);
    if (value === undefined) continue;
    if (!(allowed as readonly string[]).includes(String(value))) {
      out.push({
        level: "bad",
        message: `[${path.split(".").slice(0, -1).join(".")}] ${path.split(".").pop()} = ${JSON.stringify(value)} is not a recognised value`,
        hint: `Use one of ${(allowed as readonly string[]).map((v) => `"${v}"`).join(", ")}.`,
      });
    }
  }

  const web = config.security.web;

  const endpointHost = web.searchEndpoint ? hostOf(web.searchEndpoint) : null;
  if (endpointHost && PRIVATE_HOST.test(endpointHost) && !web.allowPrivateUrls) {
    out.push({
      level: "bad",
      message: `[security.web] search_endpoint points at ${endpointHost}, which the SSRF guard blocks`,
      hint: "Set `allow_private_urls = true` in the same section, or web_search fails on every call.",
    });
  }

  if (web.searchKind === "brave" && !web.searchApiKey && !web.searchEndpoint) {
    out.push({
      level: "warn",
      message: '[security.web] search_kind = "brave" has neither search_api_key nor a proxy endpoint',
      hint: "Set `search_api_key` to a credential name, or point `search_endpoint` at a proxy that authenticates upstream. Until then search falls back to keyless scraping.",
    });
  }

  // Any other service that needs a key is not offered at all without one: only the default falls back, above. Asked of
  // `resolveSearch` itself, so this says what the tool will do rather than a second opinion on it.
  const chosen = isSearchKind(web.searchKind)
    ? resolveSearch({ kind: web.searchKind, endpoint: web.searchEndpoint, apiKey: web.searchApiKey || undefined })
    : null;
  if (chosen && "unavailable" in chosen && chosen.needs === "key") {
    out.push({
      level: "bad",
      message: `[security.web] search_kind = "${web.searchKind}" has no search_api_key`,
      hint: "Set `search_api_key` to the name of the secret that holds its key. Until then the agents have no web search.",
    });
  }

  if (web.searchKind === "searxng" && !web.searchEndpoint) {
    out.push({
      level: "bad",
      message: '[security.web] search_kind = "searxng" needs a search_endpoint: it has no public default',
      hint: 'Point it at your instance, e.g. `search_endpoint = "http://127.0.0.1:8888/search"`.',
    });
  }

  for (const name of web.fallbackBackends ?? []) {
    if (!(FALLBACK_BACKEND_NAMES as readonly string[]).includes(name)) {
      out.push({
        level: "warn",
        message: `[security.web] fallback_backends contains "${name}", which is not a backend`,
        hint: `Use one of ${FALLBACK_BACKEND_NAMES.join(", ")}. An unknown name contributes nothing, so the chain is shorter than it looks.`,
      });
    }
  }
  // A fallback uses its own key, never the primary's `search_api_key`, and one without it is skipped at search time.
  for (const { kind, name } of options.secretSet && web.fallbackEnabled ? fallbackKeyNames(web) : []) {
    if (options.secretSet!(name)) continue;
    out.push({
      level: "warn",
      message: `[security.web] fallback_backends lists ${kind}, but there is no ${kind} key, so searches never fall back to it`,
      hint: `A fallback uses its own key, never the one in search_api_key. Keep ${kind}'s key as the secret "${name}", or take ${kind} out of the list.`,
    });
  }

  if (web.fallbackBackends?.includes("searxng") && web.searchKind !== "searxng") {
    out.push({
      level: "warn",
      message: "[security.web] fallback_backends lists searxng, which cannot be reached as a fallback",
      hint: "A fallback uses its own default endpoint, and SearXNG has none: `search_endpoint` belongs to the configured `search_kind`. Make searxng the primary, or use duckduckgo for the fallback.",
    });
  }

  if (config.queue.queueTimeoutMs < config.llm.limits.maxTurnDurationMs) {
    out.push({
      level: "warn",
      message: `[queue] queue_timeout_ms (${config.queue.queueTimeoutMs}) is below [llm.limits] max_turn_duration_ms (${config.llm.limits.maxTurnDurationMs})`,
      hint: "A message queued behind one full-length turn is dropped before it ever runs. Match them, or raise the queue timeout.",
    });
  }

  // `mode = "full"` with `ask = "off"` is deliberately *not* here. The loader already warns about it
  // from `assertGatewayExecPosture`, which knows which agents hold `exec` and whether a gateway is
  // enabled — both of which sharpen the message and neither of which this function can see.

  // Only once there is a chat gateway to send one to: a fresh install with none was warned about a channel it cannot
  // have yet, on every boot.
  if ((!config.alerts.gateway || !config.alerts.chatId) && config.gateways.some((gateway) => gateway.enabled)) {
    /**
     * The example names a connection this install actually has.
     *
     * It used to say `gateway = "telegram:bot"`, which is not a gateway id — it is a *shape*, and one
     * that stopped matching anything here the day the instance was renamed to `telegram:nouva`. An
     * operator reading a hint that names something they do not have has to work out whether the hint
     * is telling them to create it. Naming their own connection removes the question, and `config` is
     * already in hand.
     *
     * No need to exclude `local` — `config.gateways` holds only the configurable platforms and the
     * in-process gateway is not one of them, which the compiler will say if that ever changes.
     */
    const reachable = config.gateways.find((gateway) => gateway.enabled)!;
    out.push({
      level: "warn",
      message: "[alerts] has no gateway or chat_id, so daemon failures reach the log and nobody else",
      hint: `Point it at a chat you read: \`gateway = "${reachable.id}"\`, \`chat_id = "…"\`.`,
    });
  } else if (config.alerts.gateway && !config.gateways.some((gateway) => gateway.id === config.alerts.gateway)) {
    // Named, and no connection is called that: every alert would go nowhere, as the dashboard's `local:dev` (until
    // 0.6) did for whoever kept it — said rather than read as a gateway nothing answers to.
    out.push({
      level: "warn",
      message: `[alerts] gateway "${config.alerts.gateway}" is no connection of this daemon, so daemon failures reach the log and nobody else`,
      hint: `Name one of [gateways]: ${config.gateways.map((gateway) => `"${gateway.id}"`).join(", ") || "none is configured yet"}.`,
    });
  }

  /**
   * Warned about together, because the dollar cap alone is not a ceiling on most installs.
   *
   * Measured live over twenty-four hours: 8 of 88 requests were on a model in the price book. A
   * daemon pointed at a self-hosted gateway has none, so `max_daily_cost_usd` there is not a
   * partial measure but a decoration. The hint names the one that always applies.
   */
  if (config.llm.limits.maxDailyCostUsd === 0 && config.llm.limits.maxDailyTokens === 0) {
    out.push({
      level: "warn",
      deliberate: true,
      message: "[llm.limits] neither max_daily_cost_usd nor max_daily_tokens is set, so nothing caps usage",
      hint: "A loop that retries a large context can spend a lot before anyone notices. `max_daily_tokens` works on every model, priced or not; `max_daily_cost_usd` only sees the ones with a published price.",
    });
  } else if (config.llm.limits.maxDailyTokens === 0 && config.llm.limits.maxDailyCostUsd > 0) {
    // Still a warning rather than a note: a dollar cap set on an install with no priced models is
    // not a smaller version of a ceiling, it is the absence of one, and it reads as protection.
    out.push({
      level: "warn",
      message: "[llm.limits] max_daily_cost_usd only counts models with a published price",
      hint: "Add `max_daily_tokens` for a ceiling that applies to every model: a self-hosted gateway has no prices at all, so the dollar cap sees nothing there.",
    });
  }

  return out;
}

/**
 * The two open-shaped sections: `[providers.*]` and `[gateways.<platform>.<name>]`.
 *
 * Open-shaped means the *names* are the operator's, so the generic deep merge cannot tell a new
 * profile from a misspelled key — it would accept both. These are validated field by field instead,
 * with errors that name the table they came from.
 */

import {
  ConfigError,
  createLogger,
  gatewayInstanceId,
  GROUP_CONTEXT_MAX,
  type ConfigurableGatewayName,
  type GatewayInstanceConfig,
  type ProviderProfile,
} from "@nouride/shared";
import { assertSecretName } from "@nouride/secrets";

const log = createLogger("config.gateways");
import { FIXED_KEY_HINT, FIXED_KEY_IGNORED } from "./gone-keys.ts";
import {
  isPlainObject,
  requireBoolean,
  requireCount,
  requireString,
} from "./merge.ts";


/**
 * `web` is deliberately absent: that gateway, `web:dashboard`, is created by the daemon, not configured as a
 * connection with a token.
 */
const PLATFORMS: ConfigurableGatewayName[] = ["discord", "telegram", "whatsapp"];

/**
 * The keys each open table reads. Any other is a typo the generic merge cannot see here — the names are the operator's
 * — and `enable = true` left a gateway off with nothing said. Warned about as the merge warns about its own.
 */
const PROVIDER_KEYS = new Set(["kind", "base_url", "api_key", "headers", "identify", "billing"]);
const GATEWAY_KEYS = new Set([
  "token", "enabled", "agent", "mode", "session_dir", "encryption_key", "bridge_transport",
  "bridge_command", "groups_require_mention", "group_context_messages", "cache",
]);

function warnUnknown(value: Record<string, unknown>, known: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value)) {
    if (!known.has(key)) log.warn("unknown config key ignored", { key: `${where} ${key}` });
  }
}

export function parseProviders(raw: unknown): Record<string, ProviderProfile> {
  const profiles: Record<string, ProviderProfile> = {};
  if (raw === undefined) return profiles;

  if (!isPlainObject(raw)) throw new ConfigError("[providers] must be a table");

  for (const [name, value] of Object.entries(raw)) {
    const where = `[providers.${name}]`;
    if (!isPlainObject(value)) throw new ConfigError(`${where} must be a table`);
    warnUnknown(value, PROVIDER_KEYS, where);

    const base = profiles[name];
    const kind = requireString(value.kind, `${where} kind`) ?? base?.kind;
    if (kind !== "openai" && kind !== "anthropic") {
      throw new ConfigError(`${where} kind must be "openai" or "anthropic", got ${String(kind)}`);
    }

    const baseUrl = requireString(value.base_url, `${where} base_url`) ?? base?.baseUrl;
    if (!baseUrl) throw new ConfigError(`${where} needs a base_url`);

    const apiKeySecret = requireString(value.api_key, `${where} api_key`) ?? base?.apiKeySecret;
    if (!apiKeySecret) throw new ConfigError(`${where} needs api_key (a secret name)`);
    assertSecretName(apiKeySecret, `${where} api_key`);

    const identify = requireBoolean(value.identify, `${where} identify`) ?? base?.identify;
    const billing = requireString(value.billing, `${where} billing`) ?? base?.billing;
    if (billing !== undefined && billing !== "metered" && billing !== "included") {
      throw new ConfigError(`${where} billing must be "metered" or "included", got "${billing}"`);
    }
    profiles[name] = {
      kind,
      baseUrl,
      apiKeySecret,
      ...(isPlainObject(value.headers)
        ? { headers: value.headers as Record<string, string> }
        : base?.headers
          ? { headers: base.headers }
          : {}),
      ...(identify ? { identify } : {}),
      ...(billing === "included" ? { billing } : {}),
    };
  }

  return profiles;
}

export function parseGateways(raw: unknown): GatewayInstanceConfig[] {
  if (raw === undefined) return [];
  if (!isPlainObject(raw)) throw new ConfigError("[gateways] must be a table");

  const instances: GatewayInstanceConfig[] = [];

  for (const [platform, byName] of Object.entries(raw)) {
    if (!PLATFORMS.includes(platform as ConfigurableGatewayName)) {
      throw new ConfigError(
        `[gateways.${platform}] is not a known platform (${PLATFORMS.join(", ")})`,
      );
    }
    if (!isPlainObject(byName)) {
      throw new ConfigError(`[gateways.${platform}] must contain named instances`);
    }

    for (const [name, value] of Object.entries(byName)) {
      instances.push(parseGatewayInstance(platform as ConfigurableGatewayName, name, value));
    }
  }

  const ids = new Set<string>();
  for (const instance of instances) {
    if (ids.has(instance.id)) throw new ConfigError(`duplicate gateway instance ${instance.id}`);
    ids.add(instance.id);
  }

  return instances;
}

function parseGatewayInstance(
  platform: ConfigurableGatewayName,
  name: string,
  value: unknown,
): GatewayInstanceConfig {
  const where = `[gateways.${platform}.${name}]`;
  if (!isPlainObject(value)) throw new ConfigError(`${where} must be a table`);
  /**
   * How a connection reconnects is its adapter's, fixed since 0.8.0 (`config/global/gone-keys.ts`): nobody tuned it, and
   * WhatsApp's slower pacing is a fact about WhatsApp, which lives in its adapter. Named and ignored, as the daemon's
   * other fixed keys are.
   */
  const { resilience: fixedPacing, ...rest } = value;
  if (fixedPacing !== undefined) log.warn(FIXED_KEY_IGNORED, { key: `${where} resilience`, hint: FIXED_KEY_HINT });
  warnUnknown(rest, GATEWAY_KEYS, where);

  const tokenSecret = requireString(value.token, `${where} token`);
  const enabled = requireBoolean(value.enabled, `${where} enabled`) ?? false;

  // WhatsApp reaches its bridge rather than an API, so it is the one platform with no bot
  // token of its own.
  if (enabled && !tokenSecret && platform !== "whatsapp") {
    throw new ConfigError(`${where} is enabled but has no token (a secret name)`);
  }
  if (tokenSecret) assertSecretName(tokenSecret, `${where} token`);

  /**
   * Telegram polls. `mode = "webhook"` was never implemented — refused at boot for an enabled connection, and 0.7.22's
   * boot removed it from every file — so in 0.8.0 it is refused for any, naming the fix, rather than read.
   */
  const mode = requireString(value.mode, `${where} mode`);
  if (mode === "webhook") throw new ConfigError(`${where} mode = "webhook" is gone: it was never implemented. Remove mode: Telegram polls.`);
  if (mode !== undefined && mode !== "polling") throw new ConfigError(`${where} mode must be "polling", or left out`);

  /**
   * The bridge runs in this process, and `inproc` — written out, or left unset — is the one transport left.
   *
   * `stdio` spawned a second executable the tarball used to ship, and `ws` dialled a bridge running somewhere else;
   * 0.7.22's boot rewrote `stdio` as `inproc` and dropped `bridge_command`. Refused in 0.8.0, each naming what to
   * remove, rather than read as something they did not say.
   */
  const transport = requireString(value.bridge_transport, `${where} bridge_transport`);
  if (transport === "ws" || transport === "stdio") {
    throw new ConfigError(
      `${where} bridge_transport = "${transport}" is gone: the bridge runs in this process, one WhatsApp number per daemon. ` +
        `Remove bridge_transport${transport === "ws" ? " and bridge_url" : ""} from this table.`,
    );
  }
  if (transport !== undefined && transport !== "inproc") {
    throw new ConfigError(`${where} bridge_transport must be "inproc", or left out`);
  }
  if (value.bridge_command !== undefined) {
    throw new ConfigError(`${where} bridge_command is gone with the stdio transport: remove it from this table.`);
  }

  const encryptionKeySecret = requireString(value.encryption_key, `${where} encryption_key`);
  if (encryptionKeySecret) assertSecretName(encryptionKeySecret, `${where} encryption_key`);

  const groupsRequireMention = requireBoolean(
    value.groups_require_mention,
    `${where} groups_require_mention`,
  );

  const groupContextMessages = requireCount(
    value.group_context_messages,
    `${where} group_context_messages`,
    GROUP_CONTEXT_MAX,
  );

  const cache = parseGatewayCache(value, where);

  return {
    id: gatewayInstanceId(platform, name),
    platform,
    name,
    enabled,
    tokenSecret: tokenSecret ?? "",
    ...(requireString(value.agent, `${where} agent`)
      ? { agent: String(value.agent) }
      : {}),
    ...(mode !== undefined || platform === "telegram" ? { mode: "polling" as const } : {}),
    ...(requireString(value.session_dir, `${where} session_dir`)
      ? { sessionDir: String(value.session_dir) }
      : {}),
    ...(encryptionKeySecret ? { encryptionKeySecret } : {}),
    ...(groupsRequireMention !== undefined ? { groupsRequireMention } : {}),
    ...(groupContextMessages !== undefined ? { groupContextMessages } : {}),
    ...(cache ? { cache } : {}),
  };
}

/**
 * `[gateways.discord.<name>] cache` — how much platform state to keep in memory.
 *
 * Absent means the adapter's own defaults, which are zero across the board. Only read for Discord;
 * naming it on another platform is one of the unknown keys the merge already warns about, and there
 * is nothing here that could act on it.
 */
function parseGatewayCache(
  value: Record<string, unknown>,
  where: string,
): { messages?: number; users?: number; members?: number } | undefined {
  const raw = value.cache;
  if (!isPlainObject(raw)) return undefined;

  const read = (key: "messages" | "users" | "members"): number | undefined => {
    const found = raw[key];
    if (found === undefined || found === null) return undefined;
    if (typeof found !== "number" || !Number.isInteger(found) || found < 0) {
      throw new ConfigError(`${where} cache.${key} must be a whole number of entries, 0 or more`);
    }
    return found;
  };

  const limits = {
    ...(read("messages") !== undefined ? { messages: read("messages")! } : {}),
    ...(read("users") !== undefined ? { users: read("users")! } : {}),
    ...(read("members") !== undefined ? { members: read("members")! } : {}),
  };
  return Object.keys(limits).length > 0 ? limits : undefined;
}

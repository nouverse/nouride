/**
 * snake_case TOML → camelCase config, and the type checks a merge needs on the way.
 *
 * `DEFAULT_CONFIG` doubles as the schema: a key that is not in it is a typo, and saying so is the
 * whole reason this is a guided merge rather than `Object.assign`.
 */

import { ConfigError, createLogger, type GlobalConfig } from "@nouride/shared";

const log = createLogger("config");

export function mergeConfig(base: GlobalConfig, raw: Record<string, unknown>): GlobalConfig {
  const found: Mismatch[] = [];
  const merged = deepMerge(base, raw, "", found) as GlobalConfig;
  mismatchesByConfig.set(merged, found);
  return merged;
}

/** A value whose type is not its default's: where, what it should be, what it was. */
interface Mismatch {
  /** As the file writes it: `security.web.allow_private_urls`. */
  path: string;
  /** As the config object holds it: `["security", "web", "allowPrivateUrls"]`. */
  keys: string[];
  expected: string;
  value: unknown;
}

const mismatchesByConfig = new WeakMap<object, Mismatch[]>();

/** `security.web.allow_private_urls` as the file writes it: `[security.web] allow_private_urls`. */
export function asWritten(path: string): string {
  const at = path.lastIndexOf(".");
  return at < 0 ? path : `[${path.slice(0, at)}] ${path.slice(at + 1)}`;
}

/**
 * What a file set to a type its key does not hold, other than numbers, each as the line that refuses it — `validate`
 * says these first, before anything reads them: a string where a boolean belongs was true (`allow_private_urls =
 * "false"` let private hosts through the SSRF guard), and a number where a string belongs took the load down on its
 * first `.trim()`. Numbers are `validate`'s, against their bounds, after its own refusals by name.
 *
 * Reported and reset to the default for one release (0.7.7); refused since 0.7.8.
 */
export function typeProblems(config: GlobalConfig): string[] {
  return (mismatchesByConfig.get(config) ?? [])
    .filter((mismatch) => mismatch.expected !== "number")
    .map((mismatch) => `${asWritten(mismatch.path)} = ${JSON.stringify(mismatch.value)} ${WANTED[mismatch.expected] ?? `is not a ${mismatch.expected}`}`);
}

/** What each kind of key holds, as the refusal says it — with the fix, where the mistake is the usual one. */
const WANTED: Record<string, string> = {
  boolean: "is not true or false: write it without quotes",
  string: "is not text: put it in quotes",
  list: 'is not a list: write it as ["…"]',
  table: "is not a table: it is a section of its own",
};

/** What a default says its key holds — the type a value set for it has to have. Null where the default says nothing. */
function kindOf(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return "table";
  return typeof value;
}

function camelize(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown, path: string, found: Mismatch[], keys: string[] = []): unknown {
  // Arrays replace rather than concatenate: `[security.access] allowlist = []` has to be able to mean
  // "nobody", which a merge that appended could never express.
  if (!isPlainObject(patch) || !isPlainObject(base)) return patch;

  const result: Record<string, unknown> = { ...base };
  for (const [rawKey, value] of Object.entries(patch)) {
    const key = camelize(rawKey);
    const keyPath = path ? `${path}.${rawKey}` : rawKey;

    if (!(key in base)) {
      /**
       * Warned about and ignored. There is no table of former key names here, on purpose.
       *
       * A spelling a released version wrote and the next minor stopped reading is refused by name, where
       * dropping it would change what the daemon does (`parseConfig`'s `RETIRED`), and listed in
       * `docs/DEPLOY.md` § The upgrade window. A key no release wrote gets this line, which already tells
       * an operator exactly which key in their file does nothing.
       */
      log.warn("unknown config key ignored", { key: keyPath });
      continue;
    }
    const expected = kindOf(base[key]);
    if (expected !== null && kindOf(value) !== expected) {
      found.push({ path: keyPath, keys: [...keys, key], expected, value });
      // A table given a scalar is kept at its default until `validate` refuses it: nothing downstream survives reading
      // a string as a section. A scalar goes through as written, and is refused there.
      if (expected === "table") continue;
    }
    result[key] = deepMerge(base[key], value, keyPath, found, [...keys, key]);
  }
  return result;
}

export function requireString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ConfigError(`${where} must be a string`);
  return value;
}

export function requireBoolean(value: unknown, where: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new ConfigError(`${where} must be true or false`);
  return value;
}

/**
 * A whole count in `[0, max]`, refused rather than clamped.
 *
 * Clamping silently is how a setting ends up meaning something other than what the file says: an
 * operator who typed 500 would get 100 and have nothing to read that explains the difference.
 */
export function requireCount(value: unknown, where: string, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new ConfigError(`${where} must be a whole number between 0 and ${max}`);
  }
  return value;
}

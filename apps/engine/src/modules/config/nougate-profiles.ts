/**
 * The gateway a build carries, as two provider profiles every new install has: `nougate-openai` and
 * `nougate-anthropic`, on its loopback port, one key between them.
 *
 * Written at a new install's first start whether or not the gateway is turned on, so the Models page has them where a
 * person looks, marked off until it runs and an account is signed in there; given their key once it runs (the setup
 * wizard's "Use Nougate", the Nougate page's Turn on, a start with it on). Before, a profile was written only by the
 * wizard's "Use Nougate", on the OpenAI wire alone, and an install that skipped it had none to find later. An install
 * that was there before is not touched: its profiles are its own.
 */

import { createLogger, type GlobalConfig, type ProviderKind } from "@nouride/shared";
import { editDaemonConfig } from "./config-file.ts";
import { upsertTomlTable } from "./edit.ts";

const log = createLogger("config.nougate");

export const NOUGATE_PROFILES: readonly { name: string; kind: ProviderKind; path: string }[] = [
  { name: "nougate-openai", kind: "openai", path: "/openai/v1" },
  { name: "nougate-anthropic", kind: "anthropic", path: "/anthropic/v1" },
];
/**
 * The one secret both name: the key the gateway minted for this daemon. Not `nougate_api_key`, which a secret's name is
 * read from the environment by first (`NOUGATE_API_KEY`): that is the name a key to a Nougate on another machine takes,
 * and set there, it was read in place of this one, refused here, and a new key minted at every start.
 */
const NOUGATE_SECRET = "nougate_local_key";
/** The key's name on the gateway's own API Keys page. */
const NOUGATE_KEY_NAME = "Nouride agents";

/** The gateway this build carries, as far as its profiles need it: where it listens, and the key it mints. */
export interface KeyingGateway {
  url: string;
  ensureHostKey(name: string, current?: string | null): Promise<{ key: string; minted: boolean }>;
}

/** Where the gateway this build carries listens, on or off: loopback, on `[nougate] port`. */
export function bundledOrigin(config: Pick<GlobalConfig, "nougate">): string {
  return `http://127.0.0.1:${config.nougate.port}`;
}

/** The two profiles written where the file has neither name yet: the names written. */
export async function writeNougateProfiles(input: { configPath: string; config: GlobalConfig }): Promise<{ ok: true; written: string[] } | { ok: false; error: string }> {
  const origin = bundledOrigin(input.config);
  const missing = NOUGATE_PROFILES.filter((profile) => !input.config.providers[profile.name]);
  if (missing.length === 0) return { ok: true, written: [] };
  const saved = await editDaemonConfig(input.configPath, input.config, (text) =>
    missing.reduce((next, profile) => upsertTomlTable(next, `providers.${profile.name}`, { kind: profile.kind, base_url: `${origin}${profile.path}`, api_key: NOUGATE_SECRET }), text),
  );
  return saved.ok ? { ok: true, written: missing.map((profile) => profile.name) } : saved;
}

/**
 * A new install's first start, on a build that carries the gateway: the two profiles, the gateway left as it is. Its
 * database not there before this start is what a new install is; one that was there keeps its profiles as they are.
 * A file that cannot be written leaves the start going on, said.
 */
export async function nougateProfilesAtFirstStart(input: { newInstall: boolean; carried: boolean; configPath: string; config: GlobalConfig }): Promise<void> {
  if (!input.newInstall || !input.carried) return;
  const saved = await writeNougateProfiles(input);
  if (!saved.ok) log.warn("a new install's Nougate profiles were not written: add them on the Models page", { error: saved.error });
  else if (saved.written.length > 0) log.info("a new install's Nougate profiles written, the gateway as it was", { profiles: saved.written });
}

/**
 * Every profile on the running gateway given the key it minted for this daemon, where its secret holds none that still
 * verifies: the two above, and any a person pointed at it. The secrets set. The gateway hands back the key a secret
 * holds while it verifies, so a start with it on mints nothing new.
 */
export async function keyBundledProfiles(input: {
  config: GlobalConfig;
  gateway: KeyingGateway;
  secrets: { resolve(name: string): string | undefined; set(name: string, value: string): Promise<unknown> };
}): Promise<string[]> {
  const secrets = new Set(Object.values(input.config.providers).filter((profile) => profile.baseUrl.startsWith(`${input.gateway.url}/`)).map((profile) => profile.apiKeySecret));
  const set: string[] = [];
  for (const name of secrets) {
    const current = input.secrets.resolve(name) ?? null;
    const { key } = await input.gateway.ensureHostKey(NOUGATE_KEY_NAME, current);
    if (key === current) continue;
    await input.secrets.set(name, key);
    set.push(name);
  }
  return set;
}

/**
 * Where a profile on the gateway this build carries stands: off, on with no account signed in there, or ready to
 * answer. Null for any other profile, or where the build carries none. What the Models page marks it by, and why an
 * agent's model picker leaves it out until it is ready.
 */
export function bundledState(baseUrl: string, gateway: { origin: string | null; running: { connectedModels(): string[] } | null }): "off" | "no-account" | "ready" | null {
  if (!gateway.origin || !baseUrl.startsWith(`${gateway.origin}/`)) return null;
  if (!gateway.running) return "off";
  return gateway.running.connectedModels().length > 0 ? "ready" : "no-account";
}

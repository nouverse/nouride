/**
 * What the settings service is handed, and the shapes it hands back.
 */

/**
 * Editing gateways and provider profiles from the dashboard.
 *
 * Setting up a Telegram bot used to mean opening `config.toml` over SSH. That is a reasonable thing to
 * ask of the person who installed the daemon and an unreasonable thing to ask of anyone else, so this
 * puts the same edits behind the control API — with the same rules the file has.
 *
 * Two of those rules are load-bearing:
 *
 * **A token's value goes to the secret store; only its NAME is written to the config.** This is the
 * single place most likely to break §17.1, because the obvious implementation writes what the operator
 * typed straight into the file they back up. It never does. `tokenSecret` is a name, and the value
 * reaches disk only through `SecretStore.set`, which writes `0600`.
 *
 * **A saved gateway is not a running gateway.** Adapters are constructed once, at boot, from the config
 * as it was then. Writing the file does not reach into a live websocket, so every mutation here reports
 * `restartRequired` and the dashboard says so rather than showing a connection that does not exist. The
 * alternative — hot-swapping adapters — is a real feature, but pretending to have it is worse than not
 * having it.
 */

import {
  type ConfigurableGatewayName,
  type GatewayInstanceConfig,
  type GlobalConfig,
  type ProviderKind,
} from "@nouride/shared";
import { type SecretStore } from "@nouride/secrets";
import type { AuditPort } from "@/commons/audit.store.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { KeyHeld } from "@/modules/people/entry.ts";


/** The platforms a person can add from the dashboard. `local` is not one — the daemon owns it. */
export const GATEWAY_PLATFORMS: readonly ConfigurableGatewayName[] = [
  "telegram",
  "discord",
  "whatsapp",
];

export const PROVIDER_KINDS: readonly ProviderKind[] = ["openai", "anthropic"];

/**
 * An instance name has to survive being pasted into a TOML header and an id.
 *
 * `[gateways.telegram.my bot]` does not parse, and `telegram:my:bot` cannot be split back into a
 * platform and a name. Both failures happen at load, on the next boot, to someone who has forgotten
 * what they typed — so the name is checked here, while they are still looking at the form.
 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface GatewayView extends GatewayInstanceConfig {
  /** Live connection state, or null when this instance was added since the last boot. */
  status: string | null;
  /** Whether `tokenSecret` resolves to anything. A gateway with no credential cannot connect. */
  hasCredential: boolean;
}

export interface ProviderView {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKeySecret: string;
  hasCredential: boolean;
  /** True for a profile that came from `defaults.ts` rather than the config file. */
  builtIn: boolean;
  /**
   * Its extra headers by name. A value is never sent to a browser, since one may hold a gateway's key: `null`, but
   * for the one value that is no secret by what it is, `{session}`, which the form shows as it was filled.
   */
  headers: Record<string, string | null>;
}

export interface SettingsDeps {
  config: GlobalConfig;
  configPath: string;
  secrets: SecretStore;
  providers: ProviderRegistry;
  /** Live gateway states, keyed by instance id. Empty in tests that do not boot adapters. */
  gatewayStatus: () => Map<string, { status: string }>;
  /**
   * Take a live connection down as part of removing it.
   *
   * Supplied by the daemon, which owns the gateway map. Absent in tests and in any process that edits
   * config without running adapters, and then removal is config-only and asks for a restart — the old
   * behaviour, which is still correct when there is nothing running to retire.
   *
   * For WhatsApp this is what makes delete mean delete: it logs the device out and stops the bridge
   * *before* the session files are removed. Without it the bridge stays alive and rewrites
   * `creds.enc` on the next credential update, so the directory comes back moments after it is
   * deleted — the operator sees a connection they removed still holding a login.
   */
  retireGateway?: (id: string) => Promise<{ stopped: boolean; loggedOut: boolean; reason?: string }>;
  /**
   * What still holds a key nobody in `[[people]]` has — memory, an MCP token (`people/entry.ts`). Supplied
   * by the daemon; absent, a key is free once nobody in the file has it, as before.
   */
  keyHeld?: KeyHeld;
  /**
   * Each agent's pack and the secrets its commands are handed (`[security] exec_secrets`): what names a secret besides
   * this config, and what deleting one takes it out of. Supplied by the daemon from its registry; absent, only this
   * config names one.
   */
  packs?: () => PackSecrets[];
  audit?: AuditPort;
}

/** One agent's pack as a secret reaches it: where it is, how its agent reloads, and the secrets its commands are handed. */
export interface PackSecrets {
  agentId: string;
  configPath: string;
  reload: () => Promise<unknown>;
  secrets: readonly string[];
}

export type SaveResult<Field extends string = string> =
  | { ok: true; restartRequired: boolean }
  /**
   * `conflict`: refused because what it was made against changed meanwhile — a 409, not a 400. `probe`: because the
   * model it would use did not answer a test call (semantic search's embedding model), which the dashboard says in its
   * own words (0.8.20). `field` (0.8.23): the one field of the form whose value was refused, by its name here, which the
   * route names to the page in the dashboard's words; absent where no one field was (a file that would not load).
   */
  | { ok: false; error: string; conflict?: true; probe?: true; field?: Field };

/** A writer's refusal of one field of what it was sent: which, and why, in the words its `error` says it. */
export interface FieldRefusal<Field extends string> {
  field: Field;
  error: string;
}

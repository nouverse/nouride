/**
 * `@nouride/gateways` — one adapter per platform, instantiated once per configured
 * connection, all normalizing to `MessageEnvelope` before the engine sees anything.
 */

import {
  createLogger,
  type Gateway,
  type GatewayInstanceConfig,
} from "@nouride/shared";
import { WhatsAppGateway, type BridgeChannelFactory } from "./channels/whatsapp/gateway.ts";

export { UndeliverableError, type GatewayIdentity } from "./commons/resilience.ts";
/**
 * Types only, and that is load-bearing rather than tidiness.
 *
 * A value re-export is a static import: naming `DiscordGateway` here would pull `discord.js` into
 * every build of every consumer, which is exactly the cost `createGateway` goes to the trouble of
 * deferring. `export type` is erased, so these cost nothing. The classes stay reachable from their
 * own modules for anyone who genuinely wants one — which, outside this package, is nobody.
 */
export type { DiscordCacheLimits, DiscordGatewayOptions } from "./channels/discord/gateway.ts";
export type { TelegramGatewayOptions } from "./channels/telegram/gateway.ts";
export type { Node as MarkdownNode, TableNode, TableRow } from "./commons/markdown.ts";
export { escapeMarkdown } from "./commons/markdown.ts";
export {
  WhatsAppGateway,
  type BridgeChannel,
  type BridgeChannelFactory,
  type BridgeContext,
  type WhatsAppGatewayOptions,
} from "./channels/whatsapp/gateway.ts";

const log = createLogger("gateway.factory");

/**
 * Resolves a secret name to its value.
 *
 * Injected rather than imported so this package stays unaware of where credentials live —
 * the engine owns that decision, and tests can hand in a plain map.
 */
export type SecretResolver = (name: string, usedBy: string) => string;

/**
 * Opens a transport to the WhatsApp bridge.
 *
 * Injected for the same reason as `SecretResolver`, and one more: the bridge is `@nouride/wa-bridge`, a package
 * this one does not depend on, and the engine hosts it in its own process
 * (`apps/engine/src/modules/gateways/bridge.ts`). So the engine supplies the opener, this package stays a pure
 * protocol client, and a test hands over a fake channel.
 */
export type BridgeOpener = (instance: GatewayInstanceConfig) => BridgeChannelFactory;

/**
 * Build every enabled instance.
 *
 * A misconfigured instance is skipped with an error log rather than aborting boot: one bad
 * bot token should not take the other bots, the other platforms, and the dashboard down
 * with it.
 */
export async function createGateways(
  instances: GatewayInstanceConfig[],
  resolveSecret: SecretResolver,
  openBridge?: BridgeOpener,
): Promise<Map<string, Gateway>> {
  const gateways = new Map<string, Gateway>();

  /**
   * One at a time, not `Promise.all`.
   *
   * Boot order is observable here — the error log for a bad token should name instances in the
   * order the operator wrote them — and concurrency buys nothing: the work behind the import is
   * module evaluation, which is synchronous once resolved.
   */
  for (const instance of instances) {
    if (!instance.enabled) continue;

    try {
      gateways.set(instance.id, await createGateway(instance, resolveSecret, openBridge));
    } catch (err) {
      log.error("gateway instance not created", { gateway: instance.id, error: String(err) });
    }
  }

  return gateways;
}

/**
 * One adapter, and its SDK loaded only if this install actually uses the platform.
 *
 * The imports were static, so every install paid for every platform. Measured on the Pi — two
 * daemons, same config, one with the SDKs stubbed out — `discord.js` costs **16.2 MB of RSS** and
 * `grammy` **0.7 MB**, configured or not. The cost is module *evaluation* at boot, not the
 * connection: a box running six Discord agents measured within 2 MB of a box running one Telegram
 * agent, because both paid the same import. On a 415 MB Pi with Telegram only, that was 16 MB
 * rented to a platform it had never spoken to.
 *
 * `await import()` defers it to the first instance of that platform, so an install pays for what it
 * configured. The module is cached after the first call, so a second Discord instance costs a
 * resolved promise.
 *
 * The barrel must stay free of value imports for these modules or this is undone in silence — a
 * bundler follows a re-export as eagerly as an import. `tests/lazy-adapters.test.ts` holds that
 * line, because nothing else fails when it breaks.
 */
async function createGateway(
  instance: GatewayInstanceConfig,
  resolveSecret: SecretResolver,
  openBridge?: BridgeOpener,
): Promise<Gateway> {
  const identity = { id: instance.id, platform: instance.platform };

  switch (instance.platform) {
    case "discord": {
      const { DiscordGateway } = await import("./channels/discord/gateway.ts");
      return new DiscordGateway({
        ...identity,
        token: resolveSecret(instance.tokenSecret, `[gateways.discord.${instance.name}]`),
        ...(instance.cache ? { cache: instance.cache } : {}),
      });
    }

    case "telegram": {
      const { TelegramGateway } = await import("./channels/telegram/gateway.ts");
      return new TelegramGateway({
        ...identity,
        token: resolveSecret(instance.tokenSecret, `[gateways.telegram.${instance.name}]`),
        mode: instance.mode ?? "polling",
      });
    }

    case "whatsapp": {
      // Refused at construction, not at the first message. Without an opener this instance could
      // never connect, and a gateway that reports itself as configured and then does nothing is the
      // failure mode invariant 5 exists to prevent.
      if (!openBridge) {
        throw new Error(
          `[gateways.whatsapp.${instance.name}] cannot start: this daemon was built without a bridge opener`,
        );
      }
      return new WhatsAppGateway({
        ...identity,
        // How the bridge is reached is the engine's to decide, not the adapter's.
        sessionDir: requireSessionDir(instance),
        // WhatsApp tags a number, not a name. Knowing whose number this is turns "we were tagged"
        // into a mention the router can act on.
        ...(instance.agent ? { agentId: instance.agent } : {}),
        // Refused rather than defaulted: an unencrypted WhatsApp session on disk is a
        // standing credential leak (§17.1 item 6), and a generated-per-boot key would lock
        // you out of your own session on restart.
        encryptionKey: resolveSecret(
          instance.encryptionKeySecret ?? "wa_encryption_key",
          `[gateways.whatsapp.${instance.name}]`,
        ),
        openChannel: openBridge(instance),
      });
    }

    default: {
      // Exhaustiveness guard: a new platform without an adapter should fail here, not fall
      // through to `undefined` at the call site.
      const exhaustive: never = instance.platform;
      throw new Error(`no adapter for platform ${String(exhaustive)}`);
    }
  }
}

export { createTypingKeepalive, type TypingKeepalive } from "./commons/typing.ts";
export { attachmentTypeFor } from "./commons/attachments.ts";
export type { DiscordAttachmentLike } from "./channels/discord/attachments.ts";
export type { TelegramMediaMessage } from "./channels/telegram/attachments.ts";

/** Filled by the config loader (`<data_dir>/whatsapp` when unset), so absent means it was bypassed. */
function requireSessionDir(instance: GatewayInstanceConfig): string {
  if (!instance.sessionDir) {
    throw new Error(`[gateways.whatsapp.${instance.name}] has no session_dir: build instances through the config loader, which defaults it`);
  }
  return instance.sessionDir;
}

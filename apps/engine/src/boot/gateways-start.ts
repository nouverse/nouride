/**
 * The gateways started side by side, and waited for a bounded time (0.8.15).
 *
 * A start resolves after its first connect — up or failed and handed to the reconnect loop — but a connect can hang
 * inside the platform's client: Telegram's `bot.init()` retries a `getMe` that failed on the network by itself, with
 * waits that grow from a hundred seconds, and one that hung took the client's whole sixty-second timeout. The daemon
 * waited for it: on the live box the dashboard's routes, the CLI, the inbox, the missions and the scheduler all started
 * a minute late because `telegram:nouva` was slow to say hello (2026-11-02). A box that boots before its internet is up
 * would wait for as long as Telegram stays unreachable.
 *
 * Past `GATEWAY_START_WAIT_MS` the boot goes on and a slow gateway keeps connecting on its own. What is sent through it
 * meanwhile is held in its buffer and goes out once it is up (`BaseGateway.send`).
 */

import { contained, createLogger, type Gateway } from "@nouride/shared";

const log = createLogger("daemon");

/**
 * How long the boot waits for its gateways — a starting value. Above what a healthy start takes on the live box (a
 * Telegram bot in under a second, a Discord bot's session in about twenty) so an ordinary boot is unchanged.
 */
const GATEWAY_START_WAIT_MS = 30_000;

/** Every gateway started; resolves once all are, or when `waitMs` is up. The ids still connecting then. */
export async function startGateways(gateways: ReadonlyMap<string, Gateway>, waitMs: number = GATEWAY_START_WAIT_MS): Promise<string[]> {
  const starting = new Set(gateways.keys());
  const started = Promise.all(
    [...gateways].map(async ([id, gateway]) => {
      try {
        await gateway.start();
      } catch (err) {
        log.error("gateway failed to start", { gateway: id, error: String(err) });
      } finally {
        starting.delete(id);
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(contained(log, "the wait for the gateways could not end", resolve), waitMs);
  });
  await Promise.race([started, waited]);
  clearTimeout(timer);
  const late = [...starting];
  if (late.length > 0) {
    log.warn("still connecting: the daemon goes on without them, and what is sent there waits until they are up", { gateways: late, waited_ms: waitMs });
  }
  return late;
}

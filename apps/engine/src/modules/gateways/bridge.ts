/**
 * Opening a transport to the WhatsApp bridge, which runs in this process.
 *
 * The adapter in `@nouride/gateways` is a protocol client: it moves newline-delimited JSON and knows nothing about
 * where the bridge runs, so the engine hands it the way to reach the far side. There is one way now.
 *
 * `stdio` spawned a second executable that the tarball shipped beside the daemon, and went when every edition compiled
 * the bridge in (2026-09-16). `ws` dialled a bridge running somewhere else, and nothing in this repository ever served
 * one — the standalone bridge spoke stdin and stdout only; it went in 0.7.10. A config that names either is refused at
 * load (`open-sections.ts`).
 */

import type { GatewayInstanceConfig } from "@nouride/shared";
import type { BridgeChannelFactory } from "@nouride/gateways";

/**
 * Hosted in this process — no spawn, no pipe, and no second copy of the Bun runtime.
 *
 * Imported lazily so the module graph is only walked by a daemon that actually connects to WhatsApp; the import is
 * still what tells the bundler to carry it.
 */
export function bridgeOpener(instance: GatewayInstanceConfig): BridgeChannelFactory {
  return async (context) => {
    const { openInProcess } = await import("./bridge-inproc.ts");
    return await openInProcess(instance.name, context);
  };
}

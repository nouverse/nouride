/**
 * The WhatsApp bridge hosted inside the daemon, instead of spawned beside it.
 *
 * ## What this buys, measured
 *
 * A separate bridge process duplicates the Bun runtime. Measured on the live box by running one
 * binary twice: **~36 MB of runtime and bundle pages are shared between processes of the same
 * executable, and ~14.5 MB of JS heap is private to each.** A bridge that is its own executable
 * shares nothing, so it pays that ~36 MB over again. Hosting it here is what reclaims it.
 *
 * ## Why it is still one seam from being separate again
 *
 * The wire protocol does not change. The bridge still speaks newline-delimited JSON and the adapter
 * still reads it through `BridgeChannel`; only the pipe between them is memory instead of a pair of
 * file descriptors. Nothing else imports the bridge, so a separate process would be a new transport
 * behind the same channel — there is none today: `ws` reached a bridge nothing here served, and went
 * in 0.7.10.
 *
 * ## Loaded on demand
 *
 * The import is dynamic, and that is not decoration: a static one would *evaluate* Baileys at boot
 * on every install, configured or not — the mistake `discord.js` was making until the gateways went
 * lazy, which cost 16 MB of RSS there.
 *
 * **It does not keep Baileys out of the artefact.** The bundler follows a literal `await import()`,
 * so the code ships either way — which is what every edition now wants. The specifier stays a
 * package name rather than a relative path because that is what `packages/wa-bridge` declares in its
 * `exports`, and a name is what the build links into `node_modules` for its own run.
 */

import { createLogger } from "@nouride/shared";
import type { BridgeChannel, BridgeContext } from "@nouride/gateways";

const log = createLogger("gateway.whatsapp.inproc");

/**
 * A bridge for each WhatsApp connection, and never two for one.
 *
 * `packages/wa-bridge` kept its connection state at module scope — the socket, the auth handle, the
 * reconnect timer — so it was one WhatsApp number for each daemon, refused here at a second. Each bridge
 * holds its own now (`openBridge`), with a channel of its own, so a daemon hosts one for each number.
 *
 * What is still refused is a second bridge for the *same* connection while the first is open: two sockets
 * on one login write the same credentials and WhatsApp closes both. The adapter closes one before it opens
 * the next; this is the line that says so if it ever does not.
 */
const hosted = new Set<string>();

export async function openInProcess(
  instance: string,
  context: BridgeContext,
): Promise<BridgeChannel> {
  if (hosted.has(instance)) {
    throw new Error(`[gateways.whatsapp.${instance}] cannot start: this connection's WhatsApp bridge is already open in this daemon`);
  }

  /**
   * The one place Baileys enters this binary. Present in every edition — but caught anyway.
   *
   * It was absent from two of them until 2026-09-16, and the raw failure is a resolver error naming
   * a package the operator never mentioned. A source checkout reaches this too, and that is the
   * reading somebody will actually need: nothing depends on the package by name, so `bun install`
   * never links it — a build links it for its own run (`withPluginsResolvable`) and removes the link.
   */
  let plugin: typeof import("nouride-wa-bridge");
  let io: typeof import("nouride-wa-bridge/io");
  try {
    plugin = await import("nouride-wa-bridge");
    io = await import("nouride-wa-bridge/io");
  } catch (err) {
    throw new Error(
      `[gateways.whatsapp.${instance}] the WhatsApp bridge could not be loaded. Every release ` +
        `carries it, so this is a source checkout, where nothing links the package: run ` +
        `\`ln -s ../packages/wa-bridge node_modules/nouride-wa-bridge\` at the repository root, ` +
        `the link a build makes for itself and removes again. Underlying error: ${String(err)}`,
    );
  }

  hosted.add(instance);

  /**
   * Events out of the bridge, queued for the adapter to iterate.
   *
   * A queue rather than a callback because `BridgeChannel.lines()` is an async iterator, and the
   * adapter may be awaiting the network when an event arrives. Dropping it would lose a message;
   * blocking the bridge would deadlock it against its own socket.
   */
  const pending: string[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const finish = (): void => {
    if (done) return;
    done = true;
    hosted.delete(instance);
    // The socket first, then the waiter: a reconnect firing between the two would open a connection
    // nobody owns. Same ordering the `shutdown` command uses.
    try {
      bridge.stop();
    } catch (err) {
      log.warn("bridge teardown failed", { instance, error: String(err) });
    }
    wake?.();
    resolveClosed();
  };

  /**
   * This bridge's own channel, and the session key with it: handed over directly, never through the
   * environment. A bridge run as its own process was given the key in its `env`, which was safe because
   * that child was the bridge and nothing else. Here it would be the *daemon's* environment, which every
   * command an agent runs through `exec` inherits — a WhatsApp session key one `printenv` away from the
   * model.
   *
   * Once the channel is closed a line goes nowhere and `exit` stops nothing: the adapter's own disconnect
   * queues a `shutdown` just before it closes, and an exit that still reached a process's own took the
   * whole daemon down with code 0 on every WhatsApp reconnect.
   */
  const bridge = plugin.openBridge({
    name: `whatsapp:${instance}`,
    sessionDir: context.sessionDir,
    encryptionKey: context.encryptionKey,
    io: {
      write: (line) => {
        if (done) return;
        pending.push(line);
        wake?.();
      },
      exit: (code) => {
        // Never `process.exit` here. The bridge decides it is finished; the daemon that hosts it has
        // other gateways and a dashboard that are not finished at all.
        if (done) return;
        log.info("bridge asked to exit", { instance, code });
        finish();
      },
    },
  });

  /**
   * Commands in, serialised.
   *
   * The bridge's own comment says why: `send` awaits the network, and handling the next line
   * concurrently would let two replies to the same chat race into the wrong order. A bridge reading
   * stdin got that for free from its `for await`; here it has to be kept on purpose.

   */
  let queue: Promise<void> = Promise.resolve();

  return {
    writeLine: (line: string) => {
      if (done) return;
      queue = queue.then(async () => {
        // A command queued before `close` arrives after `finish` tore the bridge down: there is
        // nothing left for it to act on.
        if (done) return;
        try {
          await bridge.handleLine(line);
        } catch (err) {
          if (err instanceof io.BridgeExit) return; // `finish` already ran, through `exit`.
          log.error("bridge command failed", { error: String(err) });
        }
      });
    },
    lines: async function* () {
      while (!done || pending.length > 0) {
        const line = pending.shift();
        if (line !== undefined) {
          yield line;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = () => {
            wake = null;
            resolve();
          };
        });
      }
    },
    close: finish,
    closed,
  };
}

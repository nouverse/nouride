/**
 * The LLM gateway hosted inside the daemon, on its own port.
 *
 * ## What this is for, and what it is not
 *
 * Nougate is a *service*: one per network, addressed by a provider profile's `base_url`. Both boxes
 * here reach a remote one today and pay nothing for it, and that stays the default. This exists for
 * the other case — a device that has to answer without a network.
 *
 * It is one process and two listeners, not one listener with merged routes. Both projects claim
 * `/api/*`, so the gateway keeps its own port for what calls it — the daemon's model calls, and any
 * client on the network with a gateway key. Two `Bun.serve()` calls in one process cost nothing and
 * collide over nothing.
 *
 * Its **dashboard** is the exception, and is not a second listener: the daemon's own dashboard shows
 * it as the "LLM Gateway" page, under `/llm-gateway/` on the daemon's port (`web/llm-gateway.ts`).
 * Those requests are handed to the gateway's fetch handler in this process, by `serveAs`, after the
 * daemon has checked its own session — so one sign-in opens both, and the gateway's frontend carries
 * the prefix it was served under rather than hardcoding `/api`.
 *
 * ## What it saves
 *
 * One Bun runtime instead of two. Measured on the live box by running one binary twice: ~36 MB of
 * runtime and bundle pages are shared between processes of the same executable, and ~14.5 MB of JS
 * heap is private to each — so a second *process* pays the 36 MB again where a second *listener*
 * pays nothing. Nougate's own code adds about 0.4 MB to the binary, measured against a bare Bun
 * hello-world.
 *
 * ## What it costs
 *
 * nougate's only dependency is `drizzle-orm`, so it adds almost nothing to the graph. The cost is a
 * shared crash domain: this daemon depends on the gateway for every model call, and
 * hosting it puts a bug in a provider adapter one stack frame from the agent loop. Restarting to
 * update the gateway drops every chat connection with it.
 *
 * ## Loaded on demand, and left out of most builds
 *
 * The import is dynamic so nougate is never *evaluated* on a build that does not bundle it, and
 * the build (`scripts/build/core.ts`) externalises the package unless `--router` or `--pro` was passed, so it is not in
 * the artefact either. Both matter: the WhatsApp bridge taught us that a dynamic import alone still
 * costs 9 to 11 MB of RSS for the module graph.
 */

import { dirname, join, resolve, serveHttp } from "@nouride/runtime";
import { createLogger } from "@nouride/shared";
import { keepsStandaloneLogin, withoutStandaloneLogin } from "@/modules/gateways/nougate-port.ts";

const log = createLogger("nougate.inproc");

/**
 * What the daemon says about a request it hands the gateway — the gateway's `HostRequest`.
 *
 * Declared here rather than imported, because no import of the gateway package may sit at the top of
 * an engine file, not even a type-only one: `nougate-inproc.test.ts` reads every file for exactly
 * that, and a rule with an exception for types is a rule somebody extends to values. Structural, so
 * the two stay one shape without a link between them.
 */
export interface HostRequest {
  /** The daemon's name for the signed-in person. */
  username: string;
  /** Where the daemon serves the gateway's dashboard, e.g. `/llm-gateway`. */
  basePath: string;
  /** Where a client reaches the gateway's API from the viewer's network, when the daemon knows. */
  apiOrigin?: string;
}

/**
 * The requests this daemon built itself and vouches for — see `serveAs`.
 *
 * Keyed by the request **object**. A request that arrived over the network on the gateway's own
 * port was created by that server, so nothing it carries can put it in here: not a cookie, not a
 * header, not a path. Weak, so a request is forgotten with the request.
 */
const vouched = new WeakMap<Request, HostRequest>();

/** `<install>/.nouride/nougate` — a folder of its own, still inside the one directory an operator mounts and backs up. */
function pointGatewayHome(dataDir: string): void {
  // The gateway puts its state in `$NOUGATE_HOME/data`.
  process.env.NOUGATE_HOME ??= join(dirname(resolve(dataDir)), "nougate");
}

export interface EmbeddedGateway {
  /** Where a provider profile should point its `base_url`. */
  url: string;
  /** The gateway's own port, where clients with a gateway key call it. */
  port: number;
  /**
   * Whether that port answers beyond this machine (`HOST` is not loopback).
   *
   * Decides what the dashboard may tell a person to point a client at: the address they are browsing
   * from, at this port — or nothing, because from their machine there is nothing there.
   */
  reachableFromNetwork: boolean;
  /**
   * Answer a request the daemon built, as the person it has already signed in.
   *
   * The daemon's dashboard forwards `/llm-gateway/*` here after checking its own session
   * (`web/llm-gateway.ts`). The gateway asks who is signed in and where it is mounted, and gets
   * `as` — for this request object and no other.
   */
  serveAs(request: Request, as: HostRequest): Promise<Response>;
  /** A key for the daemon's own model calls — reused while `current` still verifies. */
  ensureHostKey(name: string, current?: string | null): Promise<{ key: string; minted: boolean }>;
  /** Models an account is signed in for, prefixed as the daemon sends them. */
  connectedModels(): string[];
  /**
   * Whether the gateway's dashboard bundle beside the executable can be shown inside the daemon's.
   *
   * The bundle is a directory of its own and an update did not always replace it: a box updated
   * from 0.7.1 is swapped by 0.7.1's code, which left it at the flashed version. Framed, an old
   * bundle calls the daemon's API instead of the gateway's — so the LLM Gateway page is offered only
   * where this says yes, and the next update (done by code that swaps it) makes it true.
   */
  dashboardEmbeddable(): boolean;
  /**
   * Every gateway account removed, for the Box's "reset sign-in". The gateway does it itself, so
   * nothing here — or in the appliance plugin — needs to know its database file or its tables.
   */
  resetAccounts(): Promise<number>;
  /** Stop listening, then have the gateway write what it holds and close its database (`shutdown`). */
  stop(): Promise<void>;
}

/** Addresses that answer only on this machine. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Start the gateway and return where to reach it.
 *
 * Loopback only. A gateway hosted here exists to serve the daemon it lives in; binding it wider would
 * publish an LLM proxy from a process nobody expected to be one, on a box whose firewall was written
 * for a chat daemon.
 */
export async function startEmbeddedNougate(

  port: number,
  options?: {
    dataDir?: string;
    /** Whether this daemon serves a dashboard the gateway's can be a page of — see `withoutStandaloneLogin`. */
    hostedDashboard?: boolean;
  },
): Promise<EmbeddedGateway> {
  if (options?.dataDir) pointGatewayHome(options.dataDir);
  /**
   * Absent in a build made without `--router` or `--pro`, where the package is externalised.
   *
   * Named rather than left as a resolver error: the operator wrote `[nougate] in_process = true` and
   * needs to know the build cannot honour it, not the name of a package they never mentioned.
   */
  let gatewayModule: typeof import("@nouverse/nougate-backend");
  try {
    gatewayModule = await import("@nouverse/nougate-backend");
  } catch (err) {
    throw new Error(
      `[nougate] in_process = true, but this build does not carry the gateway ` +
        `(built without --router or --pro). Point a provider at a nougate running ` +
        `elsewhere, or use a ` +
        `build that includes it. Underlying error: ${String(err)}`,
    );
  }

  const fetch = await gatewayModule.boot({ host: (req) => vouched.get(req) ?? null });
  /**
   * Through the runtime adapter, not `Bun.serve` — invariant 1, and `check-arch` enforces it.
   *
   * It also brings the EADDRINUSE message with it, which matters more here than for the daemon's own
   * port: an operator who already has a nougate on this box will hit exactly that, and a raw syscall
   * trace names the failure without naming the thing to do about it.
   */
  // The daemon's own exposure, on purpose: the console is reached the way the dashboard is — on a
  // Box or in the Router image, from the LAN. Every route behind it asks for a key or a sign-in.
  const hostname = process.env.HOST ?? "127.0.0.1";
  /**
   * Its own sign-in off once its dashboard is a page of this one: a second password to every upstream account,
   * on the LAN where `HOST` puts it. Kept where that page cannot be shown — no dashboard here, or a bundle beside the
   * binary too old to frame — because then the gateway's own port is the only way in.
   */
  const embeddable = typeof gatewayModule.dashboardEmbeddable === "function" && gatewayModule.dashboardEmbeddable();
  const standaloneLogin = keepsStandaloneLogin({ hostedDashboard: options?.hostedDashboard === true, embeddable });
  log.info(standaloneLogin ? "the gateway's own port keeps its sign-in: its dashboard is not shown in this one" : "the gateway's own port takes keys only: its dashboard is signed in through this one", { port });
  const server = serveHttp({
    port,
    hostname,
    fetch: standaloneLogin ? fetch : withoutStandaloneLogin(fetch),
    // A streamed completion can outlive any sane idle window, so the ceiling is the largest the
    // adapter allows rather than the 60s default a control API is happy with.
    idleTimeoutSeconds: 255,
  });

  const url = `http://127.0.0.1:${port}`;
  log.info("embedded gateway listening", { url, hostname, port });

  return {
    url,
    port,
    reachableFromNetwork: !LOOPBACK.has(hostname),
    serveAs: async (request, as) => {
      vouched.set(request, as);
      return await fetch(request);
    },
    // A build of the gateway older than these has neither: said, rather than a TypeError at a click.
    ensureHostKey: async (name, current) => {
      if (typeof gatewayModule.ensureHostKey !== "function") throw new Error("this build of nougate cannot mint a key for the daemon");
      return await gatewayModule.ensureHostKey(name, current);
    },
    connectedModels: () => (typeof gatewayModule.connectedModels === "function" ? gatewayModule.connectedModels() : []),
    dashboardEmbeddable: () =>
      typeof gatewayModule.dashboardEmbeddable === "function" ? gatewayModule.dashboardEmbeddable() : false,
    // A build of the gateway older than this function has no reset: say so rather than pretend.
    resetAccounts: async () => {
      if (typeof gatewayModule.resetAccounts !== "function") throw new Error("this build of nougate cannot reset its accounts");
      return await gatewayModule.resetAccounts();
    },
    stop: async () => {
      // `true` closes in-flight requests too. A streamed completion held open by a model that has
      // stopped sending would otherwise keep the daemon from shutting down. Not awaited: nothing below
      // waits on a request finishing.
      void server.stop(true);
      // Then what the gateway holds — buffered usage rows, a debounced state file — written, and its database closed:
      // the process ends right after this. A build of the gateway older than `shutdown` has none to call.
      if (typeof gatewayModule.shutdown === "function") {
        try {
          await gatewayModule.shutdown();
        } catch (err) {
          log.warn("the gateway could not write what it held before stopping", { error: String(err) });
        }
      }
      log.info("embedded gateway stopped");
    },
  };
}

/**
 * HTTP surface — Hono (TD-002) on top of the `Bun.serve` adapter.
 *
 * Three things live behind one port: `/health` for probes, `/api/*` for the
 * dashboard, and the built SPA at `/dashboard/`. One process, one port, no reverse
 * proxy needed to try it locally.
 *
 * Bound first, served last (D1). The port is taken the moment boot has its config and its lock, and
 * until the app is handed over everything on it says the daemon is starting and what it is doing —
 * `bindWebServer`. It used to be bound at the end of boot, so for the tens of seconds a Pi takes over
 * migrations, the database check, the vault and the MCP servers, a daemon that was running looked like
 * one that was not: `nouride status` asked whether it was, a probe saw a refused connection, and the
 * dashboard gave up on a restart that was still under way.
 */

import {
  dirExists,
  dirname,
  type HttpServer,
  join,
  moduleDir,
  serveHttp,
} from "@nouride/runtime";
import { Hono, type Context } from "hono";
import { createLogger, type GlobalConfig } from "@nouride/shared";
import type { DaemonContext } from "@/commons/context.ts";
import { dashboardFile } from "@/modules/web/dashboard-files.ts";
import type { HealthPayload } from "@nouride/wire";
import { buildHealth, startingHealth, type HealthResult } from "@/modules/web/health.ts";
import { LLM_GATEWAY_PREFIX } from "@/modules/web/llm-gateway.ts";

const log = createLogger("web");

/**
 * Where the built SPA might be — three layouts, all real.
 *
 * A `bun build --compile` binary has no source tree: `import.meta.url` there is
 * `file:///$bunfs/root/nouride`, a valid URL pointing into Bun's virtual filesystem, so a
 * source-relative path resolves to `/$bunfs/dashboard/dist` and simply does not exist. That is why
 * the compiled daemon once served nothing at `/dashboard/` while looking perfectly healthy on
 * `/health`.
 *
 * The **container** is a third layout and it was missing, which meant every Docker deployment of
 * Nouride — including the Pro image the managed pods run — answered `/dashboard/` with a 503 while
 * the assets sat in the image at `/app/apps/dashboard/dist`. The bundle is one file at `/app`, so
 * neither of the other two candidates could ever have found them: the source-relative one walks four
 * levels above `/app`, and `process.execPath` is `/usr/local/bin/bun`, which is where the error
 * message unhelpfully told people to put a directory.
 *
 * So all three are tried in order rather than detecting which mode we are in. Each layout puts the
 * dashboard next to the thing that runs, and "next to" means something different in each.
 */
const DASHBOARD_CANDIDATES = [
  // Four levels: this file is `apps/engine/src/modules/web/server.ts`, and the target is
  // `apps/dashboard/dist`. Counted from `moduleDir`, so moving this file moves the count with it —
  // which is exactly what a `new URL("../../../…")` silently did not do when it last moved.
  join(moduleDir(import.meta.url), "../../../../dashboard/dist"),
  join(dirname(process.execPath), "dashboard"),
  /**
   * The container: `nouride.bundle.js` and `apps/dashboard/dist` share a directory.
   *
   * `moduleDir` of a bundle is the bundle's own directory — `/app` — so this is the same "beside the
   * artifact" rule as the line above it, spelled for the layout the Dockerfile builds.
   * `apps/engine/tests/contracts/dashboard-assets.test.ts` checks the two files still agree.
   */
  join(moduleDir(import.meta.url), "apps/dashboard/dist"),
];

/** Resolved on first use and remembered — the answer cannot change while the process runs. */
let dashboardDist: string | null | undefined;

function resolveDashboardDist(): string | null {
  if (dashboardDist !== undefined) return dashboardDist;

  dashboardDist = DASHBOARD_CANDIDATES.find((candidate) => dirExists(candidate)) ?? null;
  if (dashboardDist) log.debug("dashboard assets found", { path: dashboardDist });
  else {
    /**
     * A warning, not silence.
     *
     * The container bug lived for as long as it did because nothing said anything: `/health` was
     * green, the log was clean, and the only evidence was a 503 somebody had to go and ask for.
     * One line at boot naming every place that was looked at turns that into a five-second answer.
     */
    log.warn("no dashboard assets found, so /dashboard/ will answer 503", {
      looked_in: DASHBOARD_CANDIDATES,
    });
  }
  return dashboardDist;
}

export interface WebDeps {
  /** Called to register `/api/control/*` — see `web/control/index.ts`. */
  mountControl?: (app: Hono) => void;
  /**
   * Called to register `POST /hooks/:token` — see web/hooks.ts.
   *
   * Separate from `mountControl` because it is the one public route: keeping them apart is what
   * stops a later route being added to the wrong group and quietly losing its session check.
   */
  mountHooks?: (app: Hono) => void;
  /** `POST /mcp` — memory for other tools, by its own tokens. Outside `/api` for the reason hooks are. */
  mountMcp?: (app: Hono) => void;
  /**
   * `/llm-gateway/*` — the bundled gateway's dashboard, shown as a page of this one. Only on a build
   * and config that host the gateway in this process; see `web/llm-gateway.ts`.
   */
  mountLlmGateway?: (app: Hono) => void;
}

// The dashboard is a static SPA talking to same-origin JSON, so a strict CSP costs
// nothing here and removes the whole class of injected-script bugs. 'unsafe-inline'
// for styles only: Vite emits an inline style tag for critical CSS, and a style
// attribute carries no equivalent risk.
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    /**
     * `blob:` is for the page's own object URLs.
     *
     * A file the person just picked has no address until `URL.createObjectURL` gives it one, and
     * that address is a `blob:`. Without it a picked screenshot renders as a broken-image icon —
     * silently, because a CSP refusal is a console warning and nothing else.
     *
     * Narrower than the `data:` already here, not looser: a blob URL can only name something this
     * document created, in this tab, and dies with it.
     */
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

/**
 * The gateway's dashboard has a policy of its own (S9), written from what it loads rather than copied from this one.
 *
 * It is another product's frontend, served on this origin with this session, and it was served under the dashboard's
 * policy with `frame-ancestors` swapped — so whatever the dashboard ever needed, the gateway's page was allowed too,
 * and any loosening made for one reached the other. This starts from `default-src 'none'` and allows what the
 * gateway's bundle uses, checked in a browser against every one of its pages, framed and in a tab of its own:
 *
 * - its own scripts and stylesheets — and no inline style, which the dashboard needs for Vite and this bundle does not;
 * - its own images and the `data:` SVGs daisyUI's spinners are masked with — no `blob:`, it makes no object URLs;
 * - its own API, the event stream included;
 * - no fonts from anywhere (the gateway drops its Google Fonts links when hosted), no frames, workers, objects or
 *   manifests, and forms that post only here;
 * - framed by this origin's LLM Gateway page and nothing else.
 *
 * Not narrowed to `/llm-gateway/` by path. A path needs the origin spelled out (`'self'` takes none), and behind a
 * reverse proxy the `Host` this daemon sees is not always the one the browser used — a wrong guess would break the
 * page for everyone behind that proxy. And it would not hold: the frame is same-origin with the dashboard, so a script
 * in it reaches the parent's own `fetch`, which the parent's policy governs. Keeping the gateway's code off the
 * daemon's API takes another origin, not a CSP.
 */
export const GATEWAY_SECURITY_HEADERS: Record<string, string> = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
  ].join("; "),
  "X-Frame-Options": "SAMEORIGIN",
};

/** Whether a path is the gateway's dashboard — the one place `GATEWAY_SECURITY_HEADERS` applies. */
function isGatewayPath(path: string): boolean {
  return path === LLM_GATEWAY_PREFIX || path.startsWith(`${LLM_GATEWAY_PREFIX}/`);
}

function createWebApp(ctx: DaemonContext, deps: WebDeps = {}): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    // Headers are mutated on the response in place. `c.header()` after `next()`
    // rebuilds the response and drops its Content-Type, which with `nosniff` means
    // the browser refuses to apply our CSS and to run our JS — a blank dashboard
    // with no error worth reading.
    const headers = isGatewayPath(c.req.path) ? GATEWAY_SECURITY_HEADERS : SECURITY_HEADERS;
    for (const [name, value] of Object.entries(headers)) {
      c.res.headers.set(name, value);
    }
  });

  const health = (c: Context) => {
    const { payload, httpStatus } = buildHealth(ctx);
    return c.json(payload satisfies HealthPayload, httpStatus);
  };

  app.get("/health", health);
  app.get("/api/health", health);

  // Until boot calls itself ready, nothing behind this is ready to be read. After the two above, which answer first.
  app.use("*", async (c, next) => (ctx.status === "starting" ? whileStarting(c.req.raw, buildHealth(ctx)) : await next()));

  // Registered before the /api/* catch-all below, which would otherwise swallow it.
  deps.mountControl?.(app);

  // Outside /api on purpose. The path a person pastes into GitHub is read by people, and
  // `/hooks/<token>` says what it is; it also keeps this route visibly outside the group that
  // carries the dashboard's session check.
  deps.mountHooks?.(app);
  deps.mountMcp?.(app);
  deps.mountLlmGateway?.(app);

  // Phase 3 fills this in. Until then an unknown /api path is a 404 with a shape
  // the dashboard can parse, not an HTML error page.
  app.all("/api/*", (c) => c.json({ error: "not_found", path: c.req.path, plain: "This page asked for something this server does not have. Reload the page; if it stays, the server may need an update." }, 404));

  app.get("/", (c) => c.redirect("/dashboard/"));
  app.get("/dashboard", (c) => c.redirect("/dashboard/"));
  app.get("/dashboard/*", serveDashboard);

  return app;
}

async function serveDashboard(c: Context): Promise<Response> {
  const dist = resolveDashboardDist();
  if (!dist) {
    // Both layouts named, because the two installs fail for different reasons and the fix differs:
    // a checkout has not run the build, a binary install did not copy the directory across.
    return new Response(
      "Dashboard assets not found. In a checkout run `bun run build:dashboard`; " +
        `for a binary install put the dashboard/ directory next to the executable ` +
        `(${join(dirname(process.execPath), "dashboard")}).`,
      { status: 503, headers: { "content-type": "text/plain" } },
    );
  }

  // What to send, and how long a browser may keep it — `dashboard-files.ts`.
  return await dashboardFile(dist, c.req.path, c.req.header("if-none-match"), c.req.header("accept-encoding"));
}

/** Where boot has got to, as `/health` says it: set by `index.ts` before each step that takes a while. */
export interface BootProgress {
  phase: string;
}

export interface WebServer {
  server: HttpServer;
  /** Hand the port the app, once boot has built everything it serves. */
  serve(ctx: DaemonContext, deps?: WebDeps): void;
}

/**
 * Take the port now, and answer from it before there is anything to serve (D1).
 *
 * Until `serve`, `/health` says the daemon is starting and what it is doing, an API path answers 503 in the
 * `{ error, note }` shape the CLI and the dashboard already print, and a page reloads itself until the dashboard
 * is there. A port that is taken fails boot here, before an hour of migrations, rather than after them.
 */
export function bindWebServer(config: GlobalConfig, startedAt: number, progress: BootProgress): WebServer {
  let app: Hono | undefined;
  const server = serveHttp({
    /**
     * The peer's address is handed to Hono as the environment, not as a header.
     *
     * The login limiter counts failures per address, and `x-forwarded-for` is written by whoever
     * sent the request — so trusting it means an attacker sets a fresh value per attempt and the
     * per-address rule counts to one forever. `c.env.clientAddress` is the socket, which they
     * cannot choose. Behind a reverse proxy on the same host it is the proxy's address for
     * everybody, which is why the *account* rule exists alongside it rather than instead of it.
     */
    port: config.dashboard.port,
    hostname: config.dashboard.host,
    fetch: (req, info) =>
      app
        ? app.fetch(req, { clientAddress: info.address, keepOpen: info.keepOpen })
        : whileStarting(req, startingHealth(config.daemon.dataDir, startedAt, progress.phase)),
  });
  log.info("http listening", {
    url: `http://${config.dashboard.host}:${server.port}`,
    dashboard: `http://localhost:${server.port}/dashboard/`,
  });
  return {
    server,
    serve: (ctx, deps = {}) => {
      app = createWebApp(ctx, deps);
    },
  };
}

/** Paths whose callers read JSON: everything but a page gets the `{ error, note }` a client knows how to print. */
const API_PATHS = /^\/(api|hooks|mcp)(\/|$)/;

/**
 * What a request gets while the daemon starts. `Retry-After` on all of it: each is a "not yet", never a "no".
 */
function whileStarting(request: Request, health: HealthResult): Response {
  const path = new URL(request.url).pathname;
  const phase = health.payload.phase ?? "starting";
  const headers = { ...SECURITY_HEADERS, "retry-after": "2" };
  if (path === "/health" || path === "/api/health") return Response.json(health.payload, { status: 503, headers });
  if (API_PATHS.test(path) || path.startsWith(LLM_GATEWAY_PREFIX)) {
    return Response.json(
      // `plain` for the dashboard (0.8.20): "nouride is starting: opening the database" is the command line's to read.
      { error: `nouride is starting: ${phase}`, note: "It answers once it is ready; try again in a few seconds.", plain: "Nouride is starting. Try again in a few seconds." },
      { status: 503, headers },
    );
  }
  return new Response(startingPage(phase), { status: 503, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}

/** A page for somebody who opened the dashboard a moment early: what is happening, and a reload until it is done. */
function startingPage(phase: string): string {
  const said = phase.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta http-equiv="refresh" content="2"><title>Nouride is starting</title><style>',
    "body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.6 Manrope,system-ui,sans-serif;background:#f6f4ee;color:#1f2b25}",
    "p{margin:0;max-width:32rem;padding:0 16px;text-align:center}small{display:block;margin-top:.5rem;color:#5d6b63;font-family:'DM Mono',ui-monospace,monospace}",
    "@media (prefers-color-scheme:dark){body{background:#151a17;color:#e7ece8}small{color:#9aa79f}}",
    `</style></head><body><p>Nouride is starting: ${said}.<small>This page reloads by itself.</small></p></body></html>`,
  ].join("");
}

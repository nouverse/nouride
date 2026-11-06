/**
 * The port is bound the moment boot has its config, and answers before there is anything to serve (D1).
 *
 * It was bound last, after migrations, the database check, the vault and every MCP server — on a Pi, tens of
 * seconds in which a daemon that was running looked like one that was not: `nouride status` asked whether it was,
 * a probe saw a refused connection, the dashboard gave up on a restart still under way. Each case here is what one
 * of those callers is told now, and that "starting" is never mistaken for "up".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { parseConfig } from "@/modules/config/global/index.ts";
import { installFingerprint } from "@/modules/web/health.ts";
import { bindWebServer, type BootProgress, type WebServer } from "@/modules/web/server.ts";

const servers: WebServer[] = [];
afterEach(async () => {
  for (const web of servers.splice(0)) await web.server.stop(true);
});

function bind(phase = "loading agents") {
  const config = parseConfig({});
  config.daemon.dataDir = "/srv/nouride/.nouride/data";
  config.dashboard.host = "127.0.0.1";
  // The OS picks: a test must not compete for 18254 with a daemon on the same machine.
  config.dashboard.port = 0;
  const progress: BootProgress = { phase };
  const web = bindWebServer(config, Date.now() - 4_000, progress);
  servers.push(web);
  const url = (path: string) => `http://127.0.0.1:${web.server.port}${path}`;
  return { config, progress, web, url };
}

/** The context the app reads once it is handed over: no gateways, no providers failing, an empty log. */
function context(config: ReturnType<typeof parseConfig>, status: "starting" | "ready") {
  return {
    config,
    db: { walSizeBytes: () => 0 },
    gateways: new Map(),
    startedAt: Date.now() - 4_000,
    configSource: null,
    status,
    agentCount: 2,
    providerErrors: new Map(),
    backgroundTimers: [],
  };
}

describe("while the daemon boots", () => {
  test("/health answers at once — starting, which step, and which install — and it is a 503", async () => {
    const { url, config } = bind("connecting MCP servers");

    for (const path of ["/health", "/api/health"]) {
      const res = await fetch(url(path));
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("2");
      expect(body).toMatchObject({ status: "starting", phase: "connecting MCP servers", gateways: {}, agents: 0 });
      // What the CLI compares to know it reached its own install, not a stranger's.
      expect(body.install).toBe(installFingerprint(config.daemon.dataDir));
      expect(body.uptime).toBeGreaterThanOrEqual(4);
    }
  });

  test("says where boot is now, not where it was when the port was bound", async () => {
    const { url, progress } = bind("opening the database");
    progress.phase = "connecting gateways";

    expect(((await (await fetch(url("/health"))).json()) as { phase: string }).phase).toBe("connecting gateways");
  });

  test("every API path is a 503 in the shape the CLI and the dashboard already print", async () => {
    const { url } = bind("checking the database");

    for (const path of ["/api/control/status", "/hooks/abc123", "/mcp"]) {
      const res = await fetch(url(path), { method: path === "/mcp" ? "POST" : "GET" });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "nouride is starting: checking the database",
        note: "It answers once it is ready; try again in a few seconds.",
        // The dashboard's words (0.8.20): what it is doing is the command line's to read.
        plain: "Nouride is starting. Try again in a few seconds.",
      });
    }
  });

  test("a page opened a moment early says so, and reloads itself until the dashboard is there", async () => {
    const { url } = bind("loading memory");

    const res = await fetch(url("/dashboard/chat"));
    const page = await res.text();

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(page).toContain('<meta http-equiv="refresh" content="2">');
    expect(page).toContain("Nouride is starting: loading memory.");
    // The same headers as everything else this port serves.
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });
});

describe("once the app is handed over", () => {
  test("still starting until boot calls itself ready — the app is in place a moment before that", async () => {
    const { url, config, web } = bind();
    const ctx = context(config, "starting");
    web.serve(ctx as never, { mountControl: (app) => app.get("/api/control/status", (c) => c.json({ agents: [] })) });

    expect((await fetch(url("/health"))).status).toBe(503);
    const early = await fetch(url("/api/control/status"));
    expect(early.status).toBe(503);
    expect(((await early.json()) as { error: string }).error).toStartWith("nouride is starting");

    ctx.status = "ready";
    const health = await fetch(url("/health"));
    expect(health.status).toBe(200);
    expect(((await health.json()) as { status: string }).status).toBe("ok");
    const status = await fetch(url("/api/control/status"));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ agents: [] });
    // A path the app has not: a 404 the dashboard reads, with its words beside the code's (0.8.20).
    const missing = await fetch(url("/api/nothing-here"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: "not_found",
      path: "/api/nothing-here",
      plain: "This page asked for something this server does not have. Reload the page; if it stays, the server may need an update.",
    });
  });
});

/**
 * The dashboard as an installable app: its manifest and its icons, as the daemon serves them.
 *
 * A browser fetches the manifest before anybody signs in, without a cookie, and refuses one served as anything but a
 * manifest or JSON; an icon has to come back as a PNG under `nosniff`. Against a dist of its own first, so this does
 * not depend on whether the checkout has built the dashboard; then through the whole app as boot builds it, the control
 * API's session check mounted beside it, where a build is there to serve.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRegistry } from "@nouride/persona";
import { parseConfig } from "@/modules/config/global/index.ts";
import { dashboardFile } from "@/modules/web/dashboard-files.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { bindWebServer, SECURITY_HEADERS, type WebServer } from "@/modules/web/server.ts";

const dist = mkdtempSync(join(tmpdir(), "nouride-dashboard-app-"));
mkdirSync(join(dist, "icons"));
writeFileSync(join(dist, "index.html"), "<!doctype html>");
writeFileSync(join(dist, "manifest.webmanifest"), JSON.stringify({ name: "Nouride", start_url: "/dashboard/chat" }));
writeFileSync(join(dist, "icons", "icon-512.png"), new Uint8Array([137, 80, 78, 71]));
afterAll(() => rmSync(dist, { recursive: true, force: true }));

describe("the manifest and the icons, from the dashboard's files", () => {
  test("the manifest is served as one, kept but asked about like every file that keeps its name", async () => {
    const response = await dashboardFile(dist, "/dashboard/manifest.webmanifest", undefined);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/manifest+json");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(((await response.json()) as { name: string }).name).toBe("Nouride");
  });

  test("an icon is a PNG, kept and asked about the same way", async () => {
    const icon = await dashboardFile(dist, "/dashboard/icons/icon-512.png", undefined);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("cache-control")).toBe("no-cache");
  });
});

/** The checkout's own build, which the daemon finds first (`DASHBOARD_CANDIDATES`). */
const BUILT = existsSync(join(import.meta.dir, "../../../dashboard/dist/manifest.webmanifest"));

describe("through the whole app", () => {
  let web: WebServer | undefined;
  afterAll(async () => {
    await web?.server.stop(true);
  });

  test.skipIf(!BUILT)("the manifest and its icons need no session, while the control API asks for one", async () => {
    const config = parseConfig({});
    config.dashboard.host = "127.0.0.1";
    config.dashboard.port = 0;
    web = bindWebServer(config, Date.now(), { phase: "ready" });
    const ctx = { config, db: { walSizeBytes: () => 0 }, gateways: new Map(), startedAt: Date.now(), configSource: null, status: "ready", agentCount: 0, providerErrors: new Map(), backgroundTimers: [] };
    web.serve(ctx as never, {
      mountControl: (app) =>
        mountControlRoutes(app, { ctx, token: "control-token-for-tests-0000000000", registry: { get: () => undefined } as unknown as AgentRegistry } as unknown as ControlDeps),
    });
    const get = (path: string) => fetch(`http://127.0.0.1:${web!.server.port}${path}`, { redirect: "manual" });

    // The guard is there: the same app refuses its API to a request with no session.
    expect((await get("/api/control/status")).status).toBe(401);

    const manifest = await get("/dashboard/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    // With the headers everything else on this port carries.
    expect(manifest.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]!);
    expect(manifest.headers.get("x-content-type-options")).toBe("nosniff");
    const icons = ((await manifest.json()) as { icons: { src: string }[] }).icons;
    expect(icons.length).toBeGreaterThan(0);
    for (const { src } of icons) {
      // Relative to the manifest, as a browser reads it.
      const icon = await get(new URL(src, "http://x/dashboard/manifest.webmanifest").pathname);
      expect({ src, status: icon.status, type: icon.headers.get("content-type") }).toEqual({ src, status: 200, type: "image/png" });
    }
    const apple = await get("/dashboard/icons/apple-touch-icon.png");
    expect({ status: apple.status, type: apple.headers.get("content-type") }).toEqual({ status: 200, type: "image/png" });
  });
});

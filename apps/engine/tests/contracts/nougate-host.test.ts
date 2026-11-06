/**
 * What Nouride relies on from the gateway it hosts, checked against the gateway itself.
 *
 * The router editions run nougate in this process and lean on it in two places: the LLM Gateway page
 * (the gateway vouches-for and prefix contract, `nougate/…/core/host.ts`) and the setup wizard's
 * "Use Nougate LLM Gateway" step, which lists the gateway's sign-ins from `/api/providers` and knows
 * no provider by name. Both sides have unit tests; neither can see the other change. This boots the
 * real gateway from the submodule and asks it what the engine and the wizard will ask.
 *
 * Skipped where the submodule is not checked out or not installed — a public clone, or CI without
 * the private repositories — because there is nothing to hold the contract against there.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BACKEND = join(import.meta.dir, "../../../../internals/nougate/apps/backend");
const BOOT = join(BACKEND, "src/boot.ts");
const AVAILABLE = existsSync(BOOT) && existsSync(join(BACKEND, "node_modules/drizzle-orm"));

/** The gateway's surface as the engine declares it (`nougate.d.ts`), restated for a path import. */
interface HostRequest {
  username: string;
  basePath: string;
  apiOrigin?: string;
}
interface Gateway {
  boot(options?: { host?: (req: Request) => HostRequest | null }): Promise<(req: Request) => Response | Promise<Response>>;
  ensureHostKey(name: string, current?: string | null): Promise<{ key: string; minted: boolean }>;
  connectedModels(): string[];
  dashboardEmbeddable(): boolean;
}

/** The fields the wizard reads off each provider (`apps/dashboard/src/modules/setup/gateway-api.ts`). */
interface ListedProvider {
  id: string;
  displayName: string;
  accountCount: number;
  accountLimit: number | null;
  isCustom: boolean;
  accountFlow: string | null;
  accountCopy: { label: string; hint: string; order: number; [key: string]: unknown } | null;
}

const SIGN_IN = new Set(["oauth-redirect", "device-code", "oauth-token"]);

describe.skipIf(!AVAILABLE)("the hosted gateway, as Nouride uses it", () => {
  let home = "";
  let gateway: Gateway;
  let handle: (req: Request) => Response | Promise<Response>;
  const vouched = new WeakMap<Request, HostRequest>();

  /** A request built here and vouched for, the way `serveAs` does it. */
  const asHost = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const request = new Request(`http://llm-gateway.internal${path}`, init);
    vouched.set(request, { username: "owner", basePath: "/llm-gateway" });
    return await handle(request);
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "nouride-nougate-contract-"));
    process.env.NOUGATE_HOME = home;
    process.env.SESSION_SECRET = "contract-test-session-secret-0123456789";
    // Named rather than generated, so no first-run password is printed into the test output.
    process.env.INITIAL_ADMIN_USERNAME = "contract-admin";
    process.env.INITIAL_ADMIN_PASSWORD = "contract-admin-password";
    // A variable specifier on purpose: the typechecker must not follow it into the submodule.
    const specifier = BOOT;
    gateway = (await import(specifier)) as Gateway;
    handle = await gateway.boot({ host: (req) => vouched.get(req) ?? null });
  });

  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  /**
   * Its database shares a Box's SD card with the daemon's, so a gateway booted with a host writes its usage rows and
   * key counters on one 30-second beat rather than every 5 s (E15), and writes what the beat holds when stopped.
   */
  test("booted with a host, it writes on the 30-second beat", async () => {
    const specifier = join(BACKEND, "src/core/db/heartbeat.ts");
    const heartbeat = (await import(specifier)) as { beatInterval(): number };
    expect(heartbeat.beatInterval()).toBe(30_000);
  });

  /**
   * The daemon stops the gateway from its own shutdown (`shutdown`), which only runs if the daemon's SIGTERM handler is
   * the one that runs: the gateway used to install one, as it loaded, that exited the process first.
   */
  test("loading it leaves the process's signals to the host: the daemon's own SIGTERM handler runs", () => {
    const script = [`await import(${JSON.stringify(BOOT)});`, `process.on("SIGTERM", () => process.exit(7));`, `process.kill(process.pid, "SIGTERM");`, `await new Promise((resolve) => setTimeout(resolve, 2000));`].join("\n");
    const run = spawnSync(process.execPath, ["-e", script], {
      cwd: BACKEND,
      env: { ...process.env, NOUGATE_HOME: home, NOUGATE_DB_PATH: join(home, "signals.db") },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status).toBe(7);
  });

  test("a request the host built is signed in as the host's person; one from the network is not", async () => {
    const me = (await (await asHost("/api/auth/me")).json()) as { user: { username: string } | null };
    expect(me.user?.username).toBe("owner");
    const stranger = await handle(new Request("http://box:18256/api/providers", { headers: { "x-forwarded-prefix": "/llm-gateway" } }));
    expect(stranger.status).toBe(401);
  });

  test("its redirects stay under the host's prefix", async () => {
    const res = await asHost("/");
    expect(res.headers.get("location")).toBe("/llm-gateway/frontend/");
  });

  test("/api/providers carries every field the wizard reads", async () => {
    const providers = (await (await asHost("/api/providers")).json()) as ListedProvider[];
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(typeof provider.id).toBe("string");
      expect(typeof provider.displayName).toBe("string");
      expect(typeof provider.accountCount).toBe("number");
      expect(provider.accountLimit === null || typeof provider.accountLimit === "number").toBe(true);
      expect(typeof provider.isCustom).toBe("boolean");
      expect("accountFlow" in provider).toBe(true);
      expect("accountCopy" in provider).toBe(true);
    }
  });

  test("every sign-in it offers names itself — the wizard knows none of them by name", async () => {
    const providers = (await (await asHost("/api/providers")).json()) as ListedProvider[];
    const signIns = providers.filter((p) => SIGN_IN.has(p.accountFlow ?? ""));
    expect(signIns.length).toBeGreaterThan(0);
    for (const provider of signIns) {
      expect({ id: provider.id, copy: Boolean(provider.accountCopy?.label && provider.accountCopy.hint) }).toEqual({ id: provider.id, copy: true });
      expect(Number.isFinite(provider.accountCopy!.order)).toBe(true);
    }
  });

  test("an OAuth sign-in starts with an address the wizard can open", async () => {
    // Device codes are left out: starting one asks the issuer for a code, over the network.
    const providers = (await (await asHost("/api/providers")).json()) as ListedProvider[];
    for (const provider of providers.filter((p) => p.accountFlow === "oauth-redirect")) {
      const res = await asHost(`/api/providers/${provider.id}/accounts/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await res.json()) as { redirectUrl?: string };
      // Absolute (the issuer's) or a path of the gateway's, which the wizard opens under the mount.
      expect({ id: provider.id, url: /^(https:\/\/|\/[^/])/.test(body.redirectUrl ?? "") }).toEqual({ id: provider.id, url: true });
    }
  });

  test("the host's own key: minted once, then handed back while it verifies", async () => {
    const first = await gateway.ensureHostKey("Nouride agents", null);
    expect(first.minted).toBe(true);
    expect(first.key.startsWith("sk-nou-")).toBe(true);
    expect(await gateway.ensureHostKey("Nouride agents", first.key)).toEqual({ key: first.key, minted: false });
  });

  test("models come only from signed-in accounts, and the bundle says whether it can be framed", () => {
    // A fresh gateway has no accounts, so there is nothing a first agent could call yet.
    expect(gateway.connectedModels()).toEqual([]);
    expect(typeof gateway.dashboardEmbeddable()).toBe("boolean");
  });
});

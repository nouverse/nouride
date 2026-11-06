/**
 * What the boot seam hands the appliance plugin (`boot/appliance.ts`), and the account reset it is handed.
 *
 * The plugin worked these out again — 18254 and 18256 written into four places, the install directory as two levels
 * above the data directory, musl by looking for its loaders — so an owner who moved the dashboard got an "Open
 * dashboard" link and two `.local` redirects that pointed at the old port. And the setup console's account reset
 * opened the engine's database itself, beside the daemon writing it.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@nouride/runtime";
import type { DaemonContext } from "@/commons/context.ts";
import { migrate } from "@/db/index.ts";
import { installTarget } from "@/modules/update/facts.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { targetFor } from "../../../../packages/update/src/edition.ts";

/** Everything `createAppliance` was called with. Null back, so the seam goes on as for an ordinary daemon. */
let handed: Record<string, unknown> | null = null;
// Process-wide, as `mock.module` is: only the seam ever imports this name, and it does so dynamically.
mock.module("nouride-appliance", () => ({
  verifyApplianceEdition: () => "appliance pairing and licensing active in this daemon process",
  createAppliance: (options: Record<string, unknown>) => {
    handed = options;
    return null;
  },
}));
const { startApplianceIfPresent } = await import("@/boot/appliance.ts");

const DIR = mkdtempSync(join(tmpdir(), "nouride-appliance-seam-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function context() {
  const db = openDatabase(":memory:");
  migrate(db);
  const dataDir = join(DIR, "install", ".nouride", "data");
  const ctx = {
    config: { daemon: { dataDir, timezone: "UTC" }, dashboard: { port: 19999 }, nougate: { port: 19001 } },
    db,
    gateways: new Map(),
    startedAt: Date.now(),
    backgroundTimers: [],
    providerErrors: new Map(),
  } as unknown as DaemonContext;
  return { ctx, db };
}

const deps = {
  pipeline: { stats: () => ({ running: 0, waiting: 0, completed: 0 }) },
  jobs: { listSnapshots: () => [] },
  requestRestart: () => {},
} as never;

describe("the appliance seam", () => {
  test("hands the plugin the engine's own facts: the ports it set, the install directory and the target", async () => {
    const { ctx } = context();
    await startApplianceIfPresent(ctx, "0.7.9", { resetAccounts: async () => 0 }, deps);
    for (const timer of (ctx as unknown as { backgroundTimers: ReturnType<typeof setInterval>[] }).backgroundTimers) clearInterval(timer);

    expect(handed).not.toBeNull();
    expect(handed!.dashboardPort).toBe(19999);
    expect(handed!.gatewayPort).toBe(19001);
    expect(handed!.installDir).toBe(join(DIR, "install"));
    expect(handed!.target).toBe(installTarget({ platform: process.platform, arch: process.arch, musl: false }) ?? null);
  });

  test("no gateway in this process is a null port, not the default one", async () => {
    const { ctx } = context();
    await startApplianceIfPresent(ctx, "0.7.9", null, deps);
    for (const timer of (ctx as unknown as { backgroundTimers: ReturnType<typeof setInterval>[] }).backgroundTimers) clearInterval(timer);
    expect(handed!.gatewayPort).toBeNull();
  });

  test("the account reset it is handed clears this daemon's accounts and sessions, in its own database", async () => {
    const { ctx, db } = context();
    await startApplianceIfPresent(ctx, "0.7.9", null, deps);
    for (const timer of (ctx as unknown as { backgroundTimers: ReturnType<typeof setInterval>[] }).backgroundTimers) clearInterval(timer);

    const users = new UserStore({ db });
    const admin = await users.create({ username: "owner", password: "correct horse battery", role: "admin", createdBy: "test" });
    users.startSession(admin.id);
    const reset = (handed!.accounts as { reset(): Promise<number> }).reset;

    expect(await reset()).toBe(1);
    expect(users.count()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM user_sessions").get()).toEqual({ n: 0 });
  });
});

describe("the install target", () => {
  test("is the update plugin's answer for every platform the releases name", () => {
    for (const platform of ["linux", "darwin", "win32", "freebsd"]) {
      for (const arch of ["x64", "arm64", "arm", "ia32"]) {
        for (const musl of [false, true]) {
          expect(installTarget({ platform, arch, musl })).toBe(targetFor({ platform, arch, musl }));
        }
      }
    }
  });
});

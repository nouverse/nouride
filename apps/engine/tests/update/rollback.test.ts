/**
 * Going back one version on purpose, and what a new version has to show before it stops being on probation.
 *
 * The rollback is run against real directories and a real database, because the two halves have to agree: a
 * build swapped without its snapshot is an old binary refusing a newer schema, and a snapshot restored without the
 * build is the same thing the other way round. The CLI is spawned, as `db restore`'s refusal is only real there.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase } from "@nouride/runtime";
import { VERSION } from "@/commons/version.ts";
import { restoreDatabase } from "@/db/backup.ts";
import { offBoxHealthy } from "@/boot/appliance.ts";
import type { DaemonContext } from "@/commons/context.ts";
import { provedHealthy, rolledBackFrom } from "@/modules/update/confirm.ts";
import { stagedSignatureUrl } from "@/modules/update/index.ts";
import { applyRollback, keptBuild, planRollback, readsPlainSecrets, recordKeptBuild, rollbackRefusal, swapBack, type KeptBuild } from "@/modules/update/rollback.ts";
import { SecretStore } from "@nouride/secrets";
import { commandKeyLayout } from "@/boot/secret-store.ts";
import { PENDING_FILE } from "@/service/update-guard.ts";
import { runCli } from "../cli-harness.ts";

const MINUTE = 60_000;

describe("a new version proving itself where no box service vouches for it", () => {
  const seen = (over: Partial<Parameters<typeof provedHealthy>[0]> = {}) => ({ status: "ok", gateways: ["connected"], handled: 1, upMs: 30_000, ...over });

  test("past boot, a gateway connected, and a message handled", () => {
    expect(provedHealthy(seen())).toBe(true);
    // A provider in trouble is the provider's: the build that reached it works.
    expect(provedHealthy(seen({ status: "degraded" }))).toBe(true);
    expect(provedHealthy(seen({ gateways: ["disconnected", "connected"] }))).toBe(true);
  });

  test("not while booting or stopping, and not with every gateway down", () => {
    expect(provedHealthy(seen({ status: "starting" }))).toBe(false);
    expect(provedHealthy(seen({ status: "shutting_down" }))).toBe(false);
    expect(provedHealthy(seen({ gateways: ["disconnected", "error"] }))).toBe(false);
  });

  test("nothing handled yet: five minutes up is proof enough, a first look is not", () => {
    expect(provedHealthy(seen({ handled: 0, upMs: 15_000 }))).toBe(false);
    expect(provedHealthy(seen({ handled: 0, upMs: 5 * MINUTE - 1 }))).toBe(false);
    expect(provedHealthy(seen({ handled: 0, upMs: 5 * MINUTE }))).toBe(true);
    // No chat gateway at all — the dashboard alone — is judged on the rest.
    expect(provedHealthy(seen({ gateways: [], handled: 0, upMs: 5 * MINUTE }))).toBe(true);
  });

  test("read off what `/health` reports and what the queue has finished", () => {
    const startedAt = Date.now();
    const gateway = { status: "connected" };
    const ctx = {
      gateways: new Map([["telegram:main", gateway]]),
      db: { walSizeBytes: () => 0 },
      config: { daemon: { dataDir: "/tmp/nr-proof" } },
      providerErrors: new Map(),
      status: "running",
      startedAt,
      agentCount: 1,
    } as unknown as DaemonContext;
    let completed = 0;
    const pipeline = { stats: () => ({ running: 0, waiting: 0, completed }) };

    expect(offBoxHealthy(ctx, pipeline, startedAt + 20_000)).toBe(false);
    completed = 1;
    expect(offBoxHealthy(ctx, pipeline, startedAt + 20_000)).toBe(true);
    gateway.status = "reconnecting";
    expect(offBoxHealthy(ctx, pipeline, startedAt + 20_000)).toBe(false);
    gateway.status = "connected";
    completed = 0;
    expect(offBoxHealthy(ctx, pipeline, startedAt + 5 * MINUTE)).toBe(true);
  });
});

describe("a public release's signature, installing without a fresh check", () => {
  const mod = {
    checksumName: (edition: string) => (edition === "basic" ? "SHA256SUMS" : `SHA256SUMS-${edition}`),
    // The plugin's rule decides; what this pins is that the engine hands it the tag to decide by.
    requiresSignature: (edition: string, tag?: string) => edition === "pro" || tag === "v0.7.6",
  } as unknown as Parameters<typeof stagedSignatureUrl>[0];
  const source = { signatureUrl: (tag: string, sums: string) => `https://get.test/${tag}/${sums}.sig` };

  test("asked for by every release that requires one — a public one from 0.7.4 too, which this path used to skip", () => {
    expect(stagedSignatureUrl(mod, source, { edition: "pro" }, "v0.7.4")).toBe("https://get.test/v0.7.4/SHA256SUMS-pro.sig");
    expect(stagedSignatureUrl(mod, source, { edition: "basic" }, "v0.7.6")).toBe("https://get.test/v0.7.6/SHA256SUMS.sig");
    expect(stagedSignatureUrl(mod, source, { edition: "basic" }, "v0.7.3")).toBeUndefined();
  });
});

/** A snapshot name as `db/backup.ts` stamps one, for `at`. */
const stamped = (at: number, suffix = "") => `nouride-${new Date(at).toISOString().slice(0, 19).replace(/[:T]/g, "-")}${suffix}.db`;

describe("which snapshot goes back with the build", () => {
  const putAsideAt = Date.UTC(2026, 9, 16, 10, 0, 0, 500);
  const kept: KeptBuild = { names: ["nouride", "dashboard"], version: "0.7.3", by: "0.7.4", putAsideAt };
  const snapshot = (at: number, suffix: string, mtime = at) => ({ name: stamped(at, suffix), path: `/b/${stamped(at, suffix)}`, at: mtime });

  test("the migration's, taken after the build was put aside — not one by hand, and not an older update's", () => {
    const plan = planRollback(kept, [
      snapshot(putAsideAt + 10 * MINUTE, ""), // by hand, newest
      snapshot(putAsideAt + 20_000, "-before-050"), // this update's migration
      snapshot(putAsideAt - 3 * 24 * 60 * MINUTE, "-before-049"), // an older update's
    ]);
    expect(plan.snapshot?.name).toBe(stamped(putAsideAt + 20_000, "-before-050"));
    expect(plan.version).toBe("0.7.3");
  });

  test("none when this update migrated nothing", () => {
    expect(planRollback(kept, [snapshot(putAsideAt - MINUTE, "-before-049"), snapshot(putAsideAt + MINUTE, "")]).snapshot).toBeNull();
  });

  test("by the stamp in its name, to the second — a restored filesystem's mtimes say nothing", () => {
    // Taken in the same second the build was put aside: the stamp has no milliseconds to be later with.
    expect(planRollback(kept, [snapshot(putAsideAt - 500, "-before-050")]).snapshot).not.toBeNull();
    // An old snapshot whose file was touched since is still old.
    expect(planRollback(kept, [snapshot(putAsideAt - MINUTE, "-before-049", putAsideAt + MINUTE)]).snapshot).toBeNull();
    // And a new one with an mtime from the past is still new — the plan carries its stamp.
    const plan = planRollback(kept, [snapshot(putAsideAt + MINUTE, "-before-050", 0)]);
    expect(plan.snapshot?.at).toBe(putAsideAt - 500 + MINUTE);
  });
});

describe("swapping the kept build back", () => {
  let install: string;
  beforeEach(() => {
    install = mkdtempSync(join(tmpdir(), "nouride-swap-"));
    for (const [dir, what] of [[install, "0.7.4"], [join(install, ".nouride-previous"), "0.7.3"]] as const) {
      mkdirSync(join(dir, "dashboard"), { recursive: true });
      writeFileSync(join(dir, "nouride"), what);
      writeFileSync(join(dir, "dashboard", "index.html"), what);
    }
  });
  afterEach(() => rmSync(install, { recursive: true, force: true }));
  const read = (...path: string[]) => readFileSync(join(install, ...path), "utf8");

  test("puts it back and keeps this one in its place, so the same call goes forward again", () => {
    expect(swapBack(install)).toEqual(["nouride", "dashboard"]);
    expect(read("nouride")).toBe("0.7.3");
    expect(read("dashboard", "index.html")).toBe("0.7.3");
    expect(read(".nouride-previous", "dashboard", "index.html")).toBe("0.7.4");
    expect(existsSync(join(install, ".nouride-swap-nouride"))).toBe(false);
    swapBack(install);
    expect(read("nouride")).toBe("0.7.4");
  });

  test("a failure part-way swaps back what it had swapped: never half on each version", () => {
    // The dashboard cannot go back: a directory does not rename over a link where the live one would be.
    rmSync(join(install, "dashboard"), { recursive: true });
    symlinkSync(join(install, "nowhere"), join(install, "dashboard"));
    expect(() => swapBack(install)).toThrow("its files were left as they were");
    expect(read("nouride")).toBe("0.7.4");
    expect(read(".nouride-previous", "nouride")).toBe("0.7.3");
  });

  test("nothing kept, nothing swapped", () => {
    rmSync(join(install, ".nouride-previous"), { recursive: true });
    expect(swapBack(install)).toEqual([]);
    expect(read("nouride")).toBe("0.7.4");
  });
});

describe("which builds read their secrets as secrets.json alone", () => {
  test("those before 0.8.19, with a v or without, and one whose version is not known", () => {
    for (const version of ["0.8.18", "v0.8.18", "0.7.29", "0.8.9", "0.0.1", null, "not a version"]) expect(`${version}: ${readsPlainSecrets(version)}`).toBe(`${version}: true`);
  });

  test("0.8.19 and every one after, which read the encrypted store", () => {
    for (const version of ["0.8.19", "v0.8.19", "0.8.20", "0.8.100", "0.9.0", "1.0.0", "1.0.0-rc.1"]) expect(`${version}: ${readsPlainSecrets(version)}`).toBe(`${version}: false`);
  });
});

describe("when the kept build is not the way back", () => {
  const kept = (over: Partial<KeptBuild>): KeptBuild => ({ names: ["nouride"], version: null, by: null, putAsideAt: 0, ...over });

  test("put aside by another version: this one came some other way, and the one before it was not kept", () => {
    expect(rollbackRefusal(kept({ version: "0.7.2", by: "0.7.3" }), "0.7.4")).toContain("put aside by v0.7.3, not by this version (v0.7.4)");
  });

  test("the same version: nothing older to go back to", () => {
    expect(rollbackRefusal(kept({ version: "v0.7.4" }), "0.7.4")).toContain("this same version");
  });

  test("put aside by this one — `v` or not — or by an install that did not say", () => {
    expect(rollbackRefusal(kept({ version: "0.7.3", by: "v0.7.4" }), "0.7.4")).toBeNull();
    expect(rollbackRefusal(kept({}), "0.7.4")).toBeNull();
  });
});

describe("rolling back", () => {
  let root: string;
  let install: string;
  let dbPath: string;
  let snapshotPath: string;

  /** An install updated from 0.7.3 to 0.7.4, whose migration took a snapshot, with two rows written since. */
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nouride-rollback-"));
    install = join(root, "srv");
    const previous = join(install, ".nouride-previous");
    mkdirSync(join(previous, "dashboard"), { recursive: true });
    mkdirSync(join(install, "dashboard"), { recursive: true });
    writeFileSync(join(install, "nouride"), "NEW");
    writeFileSync(join(install, "dashboard", "index.html"), "NEW");
    writeFileSync(join(previous, "nouride"), "#!/bin/sh\necho 0.7.3\n");
    chmodSync(join(previous, "nouride"), 0o755);
    writeFileSync(join(previous, "dashboard", "index.html"), "OLD");
    const putAsideAt = Date.now() - 10 * MINUTE;
    recordKeptBuild(previous, { version: "0.7.3", by: "v0.7.4" }, putAsideAt);
    writeFileSync(join(install, PENDING_FILE), "{}");

    const data = join(install, ".nouride", "data");
    mkdirSync(join(data, "backups", "db"), { recursive: true });
    dbPath = join(data, "nouride.db");
    snapshotPath = join(data, "backups", "db", stamped(putAsideAt + MINUTE, "-before-050"));
    const db = openDatabase(dbPath);
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    db.exec("INSERT INTO notes (body) VALUES ('before'), ('before')");
    db.backupTo(snapshotPath);
    db.exec("INSERT INTO notes (body) VALUES ('since'), ('since')");
    db.close();
    writeFileSync(join(install, ".nouride", "config.toml"), `[daemon]\ndata_dir = "${data}"\n`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const rows = (path: string) => {
    const db = openDatabase(path);
    try {
      return db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM notes").get()?.n ?? -1;
    } finally {
      db.close();
    }
  };
  const read = (...path: string[]) => readFileSync(join(install, ...path), "utf8");
  const plan = () => planRollback(keptBuild(install)!, [{ name: snapshotPath.split("/").at(-1)!, path: snapshotPath, at: 0 }]);
  test("the database first, then the build; the version left is kept, recorded and not taken again", () => {
    const done = applyRollback(plan(), { installDir: install, dbPath, currentVersion: "0.7.4", swapBack, restoreDatabase });

    expect(done.swapped).toEqual(["nouride", "dashboard"]);
    expect(read("dashboard", "index.html")).toBe("OLD");
    expect(read(".nouride-previous", "dashboard", "index.html")).toBe("NEW");
    expect(rows(dbPath)).toBe(2);
    // What it replaced is set aside whole, so the rollback itself can be undone.
    expect(done.restored?.ok && done.restored.replaced && rows(done.restored.replaced)).toBe(4);
    expect(keptBuild(install)).toMatchObject({ version: "0.7.4", by: "0.7.3" });
    expect(existsSync(join(install, PENDING_FILE))).toBe(false);
    expect(rolledBackFrom(install)).toBe("v0.7.4");
  });

  test("a snapshot that does not check out changes nothing — not the database, not the build", () => {
    writeFileSync(snapshotPath, "not a database");
    expect(() => applyRollback(plan(), { installDir: install, dbPath, currentVersion: "0.7.4", swapBack, restoreDatabase })).toThrow("nothing was changed");
    expect(read("nouride")).toBe("NEW");
    expect(rows(dbPath)).toBe(4);
    expect(rolledBackFrom(install)).toBeNull();
  });

  test("back to a build before 0.8.19: the secrets as it reads them, secrets.json at 0600, after the database and before the build", () => {
    const secretsJson = join(dirname(dbPath), "secrets.json");
    writeFileSync(secretsJson, '{"stale":"older than the store"}', { mode: 0o644 });
    const order: string[] = [];
    const done = applyRollback(plan(), {
      installDir: install,
      dbPath,
      currentVersion: "0.7.4",
      swapBack: (dir) => (order.push(existsSync(secretsJson) && readFileSync(secretsJson, "utf8").includes("stand-in") ? "secrets, then build" : "build first"), swapBack(dir)),
      restoreDatabase: (input) => (order.push("database"), restoreDatabase(input)),
      plainSecrets: { path: secretsJson, text: '{"telegram_bot":"stand-in"}' },
    });
    expect(order).toEqual(["database", "secrets, then build"]);
    expect(done.secrets).toBe(true);
    expect(JSON.parse(readFileSync(secretsJson, "utf8"))).toEqual({ telegram_bot: "stand-in" });
    expect(statSync(secretsJson).mode & 0o777).toBe(0o600);
    expect(existsSync(`${secretsJson}.rollback`)).toBe(false);
  });

  test("a snapshot that does not check out writes no secrets either", () => {
    writeFileSync(snapshotPath, "not a database");
    const secretsJson = join(dirname(dbPath), "secrets.json");
    expect(() => applyRollback(plan(), { installDir: install, dbPath, currentVersion: "0.7.4", swapBack, restoreDatabase, plainSecrets: { path: secretsJson, text: "{}" } })).toThrow("nothing was changed");
    expect(existsSync(secretsJson)).toBe(false);
  });

  test("a swap that fails after the database went back says where the one it replaced is", () => {
    const failing = () => {
      throw new Error("putting the previous build back failed, and its files were left as they were: EACCES");
    };
    expect(() => applyRollback(plan(), { installDir: install, dbPath, currentVersion: "0.7.4", swapBack: failing, restoreDatabase })).toThrow(/EACCES\. The database was put back; the one it replaced is at .*replaced-/);
  });

  test("a kept build's record: read back, and the directory's own time when an older install left none", () => {
    expect(keptBuild(install)).toMatchObject({ names: ["dashboard", "nouride"].sort(), version: "0.7.3", by: "v0.7.4" });
    rmSync(join(install, ".nouride-previous", "release.json"));
    utimesSync(join(install, ".nouride-previous"), new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 1)));
    expect(keptBuild(install)).toMatchObject({ version: null, by: null, putAsideAt: Date.UTC(2026, 9, 1) });
    // Something that is not a version is not taken for one.
    writeFileSync(join(install, ".nouride-previous", "release.json"), JSON.stringify({ version: "Note: …", by: "" }));
    expect(keptBuild(install)).toMatchObject({ version: null, by: null });
    rmSync(join(install, ".nouride-previous", "nouride"));
    expect(keptBuild(install)).toBeNull();
  });

  /** The CLI, spawned against this install, without what the checkout's `.env` put in this process. */
  async function cli(...args: string[]): Promise<{ code: number; out: string }> {
    const { code, out, err } = await runCli(["update", "--rollback", ...args], { cwd: root, config: join(install, ".nouride", "config.toml"), env: cliKey });
    return { code, out: out + err };
  }
  /** The store's key in the CLI's environment, as the launcher hands root's to it; none unless a test gives one. */
  let cliKey: Record<string, string> = {};
  afterEach(() => (cliKey = {}));

  /**
   * As `install.sh` leaves it: who put it aside, and not the old version, which it does not run as root. Put aside
   * by the version the spawned CLI is — written as "0.7.4", these broke on the bump to 0.7.5, where a build kept by
   * another version is rightly refused.
   */
  const keptByThisCli = () => recordKeptBuild(join(install, ".nouride-previous"), { version: null, by: VERSION }, Date.now() - 10 * MINUTE);

  test("`nouride update --rollback`: says what it would do and changes nothing; the kept binary names itself", async () => {
    keptByThisCli();
    const preview = await cli("--json");
    expect(preview.code).toBe(0);
    expect(JSON.parse(preview.out).data).toMatchObject({ to: "0.7.3", from: VERSION, applied: false, snapshot: { path: snapshotPath } });
    expect(read("nouride")).toBe("NEW");
    expect(rows(dbPath)).toBe(4);
  });

  test("`--apply` is refused while the daemon holds the database, and done once it does not", async () => {
    keptByThisCli();
    // A live process that calls itself a Nouride, holding the lock.
    const holder: ChildProcess = spawn("sh", ["-c", "sleep 30; :", "nouride-lock-holder"]);
    try {
      writeFileSync(join(dirname(dbPath), "nouride.lock"), `${holder.pid}\n`);
      const refused = await cli("--apply");
      expect(refused.code).toBe(1);
      expect(refused.out).toContain("The daemon is running");
      expect(read("nouride")).toBe("NEW");
    } finally {
      holder.kill();
    }

    const done = await cli("--apply");
    expect(done.code).toBe(0);
    expect(done.out).toContain("on v0.7.3");
    expect(read("dashboard", "index.html")).toBe("OLD");
    expect(rows(dbPath)).toBe(2);

    // The kept build is now the version left, put aside by 0.7.3 — which is not this CLI's version, so it is not its
    // way back.
    const again = await cli();
    expect(again.code).toBe(1);
    expect(again.out).toContain(`put aside by v0.7.3, not by this version (v${VERSION})`);
  }, 30_000);

  /** The store as 0.8.19 keeps it, encrypted under a key given in the environment and kept nowhere in the install. */
  async function encryptedStore(): Promise<string> {
    const key = "q3m4XK8pX0n0m2gYk1y1Yd8rS2c0Hc3o0W0J8n5s7Vw=";
    const data = dirname(dbPath);
    const store = await SecretStore.open(data, { NOURIDE_ENCRYPTION_KEY: key }, { layout: commandKeyLayout({ dataDir: data, configPath: join(install, ".nouride", "config.toml") }) });
    await store.set("telegram_bot", "stand-in-token");
    expect(existsSync(join(data, "secrets.enc"))).toBe(true);
    expect(existsSync(join(data, "secrets.json"))).toBe(false);
    return key;
  }

  test("`--apply` back to a build before 0.8.19 takes the secrets along as it reads them; the encrypted store stays", async () => {
    keptByThisCli();
    cliKey = { NOURIDE_ENCRYPTION_KEY: await encryptedStore() };
    const preview = await cli("--json");
    expect(JSON.parse(preview.out).data).toMatchObject({ to: "0.7.3", secrets: true, applied: false });
    expect(existsSync(join(dirname(dbPath), "secrets.json"))).toBe(false);

    const done = await cli("--apply");
    expect(done.code).toBe(0);
    expect(done.out).toContain("the secrets are in secrets.json for v0.7.3");
    expect(done.out).not.toContain("stand-in-token");
    const secretsJson = join(dirname(dbPath), "secrets.json");
    expect(JSON.parse(readFileSync(secretsJson, "utf8"))).toEqual({ telegram_bot: "stand-in-token" });
    expect(statSync(secretsJson).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dirname(dbPath), "secrets.enc"))).toBe(true);
  }, 30_000);

  test("with the store's key not here, refused before anything is done, naming where the key is", async () => {
    keptByThisCli();
    await encryptedStore();
    const refused = await cli("--apply");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("v0.7.3 reads the secrets only as secrets.json, and the store cannot be opened here");
    expect(refused.out).toContain("sudo nouride update --rollback");
    expect(read("dashboard", "index.html")).toBe("NEW");
    expect(rows(dbPath)).toBe(4);
    expect(existsSync(join(dirname(dbPath), "secrets.json"))).toBe(false);
  }, 30_000);

  test("nothing kept, nothing to do", async () => {
    rmSync(join(install, ".nouride-previous"), { recursive: true });
    const none = await cli();
    expect(none.code).toBe(1);
    expect(none.out).toContain("There is no previous build to go back to.");
  });
});

describe("install.sh keeps the build it replaces", () => {
  const script = readFileSync(join(import.meta.dir, "../../../../scripts/install.sh"), "utf8");
  // The block it sits in, between markers: the names it moves aside are the block's own `SWAPPED`.
  const fn = script.includes("# >>> swapped\n") ? script.slice(script.indexOf("# >>> swapped\n"), script.indexOf("# <<< swapped")) : undefined;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nouride-install-keep-"));
    for (const [where, what] of [["srv", "OLD"], ["stage", "NEW"]] as const) {
      mkdirSync(join(root, where, "dashboard"), { recursive: true });
      writeFileSync(join(root, where, "nouride"), what);
      writeFileSync(join(root, where, "dashboard", "index.html"), what);
    }
    // The LLM gateway's dashboard, from an older build, in a tarball that no longer carries it.
    mkdirSync(join(root, "srv", "frontend"));
    writeFileSync(join(root, "srv", ".nouride-pending-update"), "{}");
    mkdirSync(join(root, "srv", ".nouride-previous"));
    writeFileSync(join(root, "srv", ".nouride-previous", "nouride"), "OLDER");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The function as the script has it, run under `sh -e` the way the script runs. */
  const run = () =>
    new Promise<number>((resolve) => {
      const child = spawn("sh", ["-eu", "-c", `say() { :; }\nSERVICE_USER=nobody\nSERVICE_GROUP=nobody\nINSTALL_DIR="${root}/srv"\nSTAGE="${root}/stage"\n${fn}\nkeep_previous 0.7.4`]);
      child.on("close", (code) => resolve(code ?? -1));
    });

  test("what the tarball replaces, moved aside with who put it there — and the pending update it supersedes gone", async () => {
    expect(fn).toBeDefined();
    expect(await run()).toBe(0);
    const previous = join(root, "srv", ".nouride-previous");
    expect(readFileSync(join(previous, "nouride"), "utf8")).toBe("OLD");
    expect(readFileSync(join(previous, "dashboard", "index.html"), "utf8")).toBe("OLD");
    // What the tarball does not carry stays where it is: nothing would put it back.
    expect(existsSync(join(root, "srv", "frontend"))).toBe(true);
    expect(existsSync(join(previous, "frontend"))).toBe(false);
    expect(existsSync(join(root, "srv", ".nouride-pending-update"))).toBe(false);
    expect(keptBuild(join(root, "srv"))).toMatchObject({ version: null, by: "0.7.4", names: ["dashboard", "nouride"] });
  });

  test("another build of the version the kept one was put aside for keeps that one: the way back is still the version before", async () => {
    for (const by of ["0.7.4", "v0.7.4"]) {
      writeFileSync(join(root, "srv", ".nouride-previous", "release.json"), JSON.stringify({ version: null, by, at: "2026-10-16T00:00:00Z" }));
      expect(await run()).toBe(0);
      expect(readFileSync(join(root, "srv", ".nouride-previous", "nouride"), "utf8")).toBe("OLDER");
      expect(readFileSync(join(root, "srv", "nouride"), "utf8")).toBe("OLD");
    }
    // Put aside for another version, it is the build before this one no longer: replaced as usual.
    writeFileSync(join(root, "srv", ".nouride-previous", "release.json"), JSON.stringify({ version: null, by: "0.7.3" }));
    expect(await run()).toBe(0);
    expect(readFileSync(join(root, "srv", ".nouride-previous", "nouride"), "utf8")).toBe("OLD");
  });

  test("the same build again is a reinstall: what came before it stays the way back", async () => {
    writeFileSync(join(root, "stage", "nouride"), "OLD");
    expect(await run()).toBe(0);
    expect(readFileSync(join(root, "srv", ".nouride-previous", "nouride"), "utf8")).toBe("OLDER");
    expect(readFileSync(join(root, "srv", "nouride"), "utf8")).toBe("OLD");
  });
});

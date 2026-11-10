/**
 * The secret store in the snapshots, sealed to a passphrase (0.8.18).
 *
 * A snapshot held no secret, so a box rebuilt from one came back without a single credential; and a plain copy on a
 * backup drive would be every credential to whoever picks the drive up. `[daemon] backup_seal` now keeps the public half
 * of a key the passphrase derives, each config snapshot holds `secrets.sealed`, and only the passphrase opens it.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openWithPassphrase } from "@nouride/runtime";
import type { Client } from "@nouride/cli-kit";
import { secret } from "../../../cli/src/commands/secret.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { readConfigText } from "@/modules/config/global/index.ts";
import { backupSealFor, parseBackupSeal, sealedSecretsCopy } from "@/modules/config/sealed-secrets.ts";
import { backupConfig } from "@/modules/config/snapshot.ts";
import { setBackupSeal } from "@/modules/config/settings/backups.ts";
import type { SettingsDeps } from "@/modules/config/settings/types.ts";
import { registerSecretRoutes } from "@/modules/web/control/routes/secrets.ts";

const PASSPHRASE = "a long walk to the river";
// Stand-ins, never real credentials.
const STORE = `${JSON.stringify({ telegram_bot_token: "stand-in-token-one", default_api_key: "stand-in-key-two" }, null, 2)}\n`;

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** An install with a secret store, a config and its people. */
function install() {
  dir = mkdtempSync(join(tmpdir(), "backup-seal-"));
  const home = join(dir, ".nouride");
  const dataDir = join(home, "data");
  const agentsDir = join(home, "agents");
  for (const folder of [dataDir, agentsDir, join(home, "people")]) mkdirSync(folder, { recursive: true });
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, '[daemon]\nname = "home"\n');
  writeFileSync(join(home, "people", "ani.toml"), '[person]\nname = "Ani"\n');
  writeFileSync(join(dataDir, "secrets.json"), STORE, { mode: 0o600 });
  return { home, dataDir, agentsDir, configPath };
}

const open = (path: string, passphrase = PASSPHRASE) => new TextDecoder().decode(openWithPassphrase(passphrase, new Uint8Array(readFileSync(path))));

describe("the key [daemon] backup_seal keeps", () => {
  test("is the salt and the public half, never the passphrase; a fresh salt each time", () => {
    const value = backupSealFor(PASSPHRASE);
    expect(value).toMatch(/^nrseal1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/);
    expect(value).not.toContain("river");
    const key = parseBackupSeal(value)!;
    expect([key.salt.length, key.publicKey.length]).toEqual([16, 32]);
    expect(backupSealFor(PASSPHRASE)).not.toBe(value);
  });

  test("unset is no key; one set wrong is refused at load, naming the key", () => {
    expect(parseBackupSeal("")).toBeNull();
    for (const wrong of ["nrseal1:abc:def", "nrseal2:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "my passphrase"]) {
      expect(() => parseBackupSeal(wrong)).toThrow("[daemon] backup_seal");
      expect(() => readConfigText(`[daemon]\nbackup_seal = "${wrong}"\n`, "/c/config.toml")).toThrow("[daemon] backup_seal");
    }
    const value = backupSealFor(PASSPHRASE);
    expect(readConfigText(`[daemon]\nbackup_seal = "${value}"\n`, "/c/config.toml").daemon.backupSeal).toBe(value);
    expect(readConfigText("", "/c/config.toml").daemon.backupSeal).toBe("");
  });
});

describe("the config snapshot", () => {
  test("holds no secret without a passphrase, and a sealed copy left from one is removed", () => {
    const at = install();
    writeFileSync(join(at.dataDir, "secrets.sealed"), "left from an old passphrase");
    const taken = backupConfig({ configPath: at.configPath, agentsDir: at.agentsDir, dataDir: at.dataDir, keep: 4 });
    expect(readdirSync(taken.path!)).not.toContain("secrets.sealed");
    expect(existsSync(join(at.dataDir, "secrets.sealed"))).toBe(false);
  });

  test("with one, holds secrets.sealed: the store's text to the passphrase, nothing to another, nothing readable in it", () => {
    const at = install();
    const taken = backupConfig({ configPath: at.configPath, agentsDir: at.agentsDir, dataDir: at.dataDir, keep: 4, seal: backupSealFor(PASSPHRASE), secrets: () => STORE });
    const sealed = join(taken.path!, "secrets.sealed");
    expect(open(sealed)).toBe(STORE);
    expect(() => open(sealed, "a long walk to the rivers")).toThrow("the passphrase does not open it");
    const bytes = readFileSync(sealed, "latin1");
    for (const plain of ["stand-in-token-one", "telegram_bot_token", PASSPHRASE]) expect(bytes).not.toContain(plain);
    expect(statSync(join(at.dataDir, "secrets.sealed")).mode & 0o777).toBe(0o600);
  });

  test("is sealed again only when the store or the passphrase changed", () => {
    const at = install();
    const seal = backupSealFor(PASSPHRASE);
    const first = readFileSync(sealedSecretsCopy(at.dataDir, seal, STORE)!);
    // A seal is new bytes every time: the same bytes say it was not sealed again.
    expect(readFileSync(sealedSecretsCopy(at.dataDir, seal, STORE)!)).toEqual(first);
    const changed = STORE.replace("stand-in-key-two", "stand-in-key-three");
    const afterStore = sealedSecretsCopy(at.dataDir, seal, changed)!;
    expect(open(afterStore)).toContain("stand-in-key-three");
    const other = backupSealFor("another long passphrase");
    expect(() => open(sealedSecretsCopy(at.dataDir, other, changed)!)).toThrow();
    expect(open(join(at.dataDir, "secrets.sealed"), "another long passphrase")).toContain("stand-in-key-three");
  });

  test("a week with nothing changed is still no new snapshot, the seal included", () => {
    const at = install();
    const seal = backupSealFor(PASSPHRASE);
    sealedSecretsCopy(at.dataDir, seal, STORE);
    // An hour old: a file changed in the last two seconds is never believed the same by its size and time.
    const hourAgo = new Date(Date.now() - 3_600_000);
    for (const file of [at.configPath, join(at.home, "people", "ani.toml"), join(at.dataDir, "secrets.sealed")]) utimesSync(file, hourAgo, hourAgo);
    const opts = { configPath: at.configPath, agentsDir: at.agentsDir, dataDir: at.dataDir, keep: 4, skipUnchanged: true, seal, secrets: () => STORE };
    expect(readdirSync(backupConfig({ ...opts, now: () => Date.UTC(2026, 10, 1) }).path!)).toContain("secrets.sealed");
    expect(backupConfig({ ...opts, now: () => Date.UTC(2026, 10, 8) }).unchanged).toBe(true);
  });
});

function deps(): SettingsDeps & { audited: { action: string; details?: unknown }[] } {
  const at = install();
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = at.dataDir;
  config.daemon.agentsDir = at.agentsDir;
  const audited: { action: string; details?: unknown }[] = [];
  // The store as the daemon holds it: what the sealed copy seals (0.8.19), not the file, which is encrypted.
  const secrets = { sealedCopyText: () => STORE };
  return { config, configPath: at.configPath, secrets, audit: { record: (row: { action: string; details?: unknown }) => void audited.push(row) }, audited } as unknown as SettingsDeps & {
    audited: { action: string; details?: unknown }[];
  };
}

describe("setting the passphrase", () => {
  test("writes the key, not the passphrase, follows live, and takes a snapshot that opens with it", async () => {
    const d = deps();
    const saved = await setBackupSeal(d, { passphrase: PASSPHRASE, actor: "admin" });
    expect(saved).toMatchObject({ ok: true, restartRequired: false });
    const text = readFileSync(d.configPath, "utf8");
    expect(text).toMatch(/backup_seal = "nrseal1:/);
    expect(text).not.toContain(PASSPHRASE);
    expect(d.config.daemon.backupSeal).toStartWith("nrseal1:");
    const snapshot = (saved as { snapshot?: string }).snapshot!;
    expect(snapshot.startsWith(join(d.config.daemon.dataDir, "backups", "config"))).toBe(true);
    expect(open(join(snapshot, "secrets.sealed"))).toBe(STORE);
    expect(JSON.stringify(d.audited)).not.toContain(PASSPHRASE);
    expect(d.audited.map((row) => row.action)).toEqual(["backup_seal_set"]);
  });

  test("a short passphrase is refused and nothing is written", async () => {
    const d = deps();
    const before = readFileSync(d.configPath, "utf8");
    const saved = await setBackupSeal(d, { passphrase: "short one" });
    expect(saved).toMatchObject({ ok: false });
    expect((saved as { error: string }).error).toContain("at least 12 characters");
    expect(readFileSync(d.configPath, "utf8")).toBe(before);
  });

  test("off removes the key and the sealed copy beside the store; the snapshots taken keep theirs", async () => {
    const d = deps();
    const set = (await setBackupSeal(d, { passphrase: PASSPHRASE })) as { snapshot?: string };
    expect(await setBackupSeal(d, { passphrase: null })).toMatchObject({ ok: true });
    expect(readFileSync(d.configPath, "utf8")).not.toContain("backup_seal");
    expect(d.config.daemon.backupSeal).toBe("");
    expect(existsSync(join(d.config.daemon.dataDir, "secrets.sealed"))).toBe(false);
    expect(open(join(set.snapshot!, "secrets.sealed"))).toBe(STORE);
  });

  test("with the backup drive not mounted, it is set and says no snapshot was taken", async () => {
    const d = deps();
    d.config.daemon.backupDir = join(dir, "usb-not-mounted");
    const saved = await setBackupSeal(d, { passphrase: PASSPHRASE });
    expect(saved).toMatchObject({ ok: true });
    expect((saved as { skipped?: string }).skipped).toContain("is not there. Is the drive mounted?");
    expect(existsSync(join(dir, "usb-not-mounted"))).toBe(false);
  });
});

describe("the routes", () => {
  function app(role: "admin" | "operator", sealed = "") {
    const calls: { passphrase: string | null }[] = [];
    const control = new Hono<{ Variables: { principal: unknown } }>();
    control.use("*", async (c, next) => {
      c.set("principal", { kind: "user", actor: role, role, user: { username: role } });
      await next();
    });
    const config = structuredClone(DEFAULT_CONFIG);
    config.daemon.backupSeal = sealed;
    registerSecretRoutes(control as never, {
      ctx: { config },
      settings: {
        secretInventory: () => [],
        secretLock: () => ({ encrypted: true, key: { where: "/etc/nouride/nouride.env", level: "outside" } }),
        setBackupSeal: async (params: { passphrase: string | null }) => (calls.push(params), { ok: true, restartRequired: false, snapshot: "/b/config/2026" }),
      },
    } as never);
    const seal = (body: unknown) => control.request("/secrets/seal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { control, calls, seal };
  }

  test("the list says whether the snapshots hold the secrets", async () => {
    expect(await (await app("operator").control.request("/secrets")).json()).toEqual({
      secrets: [],
      sealedInSnapshots: false,
      lock: { encrypted: true, key: { where: "/etc/nouride/nouride.env", level: "outside" } },
    });
    expect(await (await app("operator", backupSealFor(PASSPHRASE)).control.request("/secrets")).json()).toMatchObject({ sealedInSnapshots: true });
  });

  test("an admin sets it or turns it off, and the answer never carries the passphrase", async () => {
    const admin = app("admin");
    const set = await admin.seal({ passphrase: PASSPHRASE });
    expect(set.status).toBe(200);
    const body = await set.text();
    expect(JSON.parse(body)).toEqual({ ok: true, sealedInSnapshots: true, snapshot: "/b/config/2026" });
    expect(body).not.toContain(PASSPHRASE);
    expect((await admin.seal({ off: true })).status).toBe(200);
    expect(admin.calls.map((call) => call.passphrase)).toEqual([PASSPHRASE, null]);
    expect((await admin.seal({})).status).toBe(400);
  });

  test("anyone else is refused before anything is set", async () => {
    const operator = app("operator");
    expect((await operator.seal({ passphrase: PASSPHRASE })).status).toBe(403);
    expect(operator.calls).toEqual([]);
  });
});

const engine = join(import.meta.dir, "..", "..");
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

/** A CLI action in a fresh process, `input` on its stdin: `readStdin` reads the process's own. */
function cli(script: string, input: string) {
  const run = spawnSync(process.execPath, ["-e", script], { cwd: engine, input, timeout: 20_000, encoding: "utf8" });
  return { status: run.status, out: plain(`${run.stdout}${run.stderr}`) };
}

describe("nouride secret unseal", () => {
  const unseal = (args: string[], input: string) =>
    cli(`import { unsealSecrets } from "../cli/src/commands/secret-unseal.ts"; await unsealSecrets(${JSON.stringify(args)});`, input);

  test("opens a snapshot's copy into a file at 0600 and shows none of it", () => {
    const at = install();
    const sealed = join(backupConfig({ configPath: at.configPath, agentsDir: at.agentsDir, dataDir: at.dataDir, keep: 4, seal: backupSealFor(PASSPHRASE), secrets: () => STORE }).path!, "secrets.sealed");
    const out = join(dir, "restored.json");
    const run = unseal([sealed, "--stdin", "--out", out], `${PASSPHRASE}\n`);
    expect(run.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(STORE);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(run.out).not.toContain("stand-in-token-one");
  });

  test("a wrong passphrase writes nothing; neither does a file already there; nor a missing --out", () => {
    const at = install();
    const sealed = join(backupConfig({ configPath: at.configPath, agentsDir: at.agentsDir, dataDir: at.dataDir, keep: 4, seal: backupSealFor(PASSPHRASE), secrets: () => STORE }).path!, "secrets.sealed");
    const out = join(dir, "restored.json");
    const wrong = unseal([sealed, "--stdin", "--out", out], "not the passphrase at all\n");
    expect(wrong.status).toBe(1);
    expect(wrong.out).toContain("did not open");
    expect(existsSync(out)).toBe(false);
    writeFileSync(out, "the live store");
    const over = unseal([sealed, "--stdin", "--out", out], `${PASSPHRASE}\n`);
    expect(over.status).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("the live store");
    expect(unseal([sealed, "--stdin"], `${PASSPHRASE}\n`).status).toBe(2);
  });
});

describe("nouride secret seal", () => {
  const seal = (args: string[], input = "") =>
    cli(
      `import { secret } from "../cli/src/commands/secret.ts";
       const client = { post: async (path, body) => { console.log("POST " + path + " " + JSON.stringify(body)); return { snapshot: "/b/config/2026" }; } };
       await secret(client, ${JSON.stringify(["seal", ...args])});`,
      input,
    );

  test("--stdin sends the passphrase it reads, --off turns it off, and one of the two is asked for", () => {
    const set = seal(["--stdin"], `${PASSPHRASE}\n`);
    expect(set.status).toBe(0);
    expect(set.out).toContain(`POST /secrets/seal {"passphrase":"${PASSPHRASE}"}`);
    expect(set.out).toContain("/b/config/2026/secrets.sealed");
    expect(seal(["--off"]).out).toContain('POST /secrets/seal {"off":true}');
    expect(seal([]).status).toBe(2);
    expect(seal(["--stdin", "--off"], PASSPHRASE).status).toBe(2);
  });
});

describe("nouride secret list", () => {
  async function list(sealedInSnapshots: boolean): Promise<string> {
    const client = { get: async <T>() => ({ secrets: [{ name: "telegram_bot_token", origin: "store", usedBy: [], shadowed: false }], sealedInSnapshots }) as T } as unknown as Client;
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(plain(String(line ?? ""))));
    try {
      await secret(client, ["list"]);
    } finally {
      log.mockRestore();
    }
    return lines.join("\n");
  }

  test("says whether the snapshots hold the secrets, and how to change that", async () => {
    expect(await list(true)).toContain("The config snapshots hold these, sealed to your backup passphrase");
    expect(await list(false)).toContain("The snapshots do not hold these, and a lost key means setting each again: nouride secret seal --stdin");
  });
});

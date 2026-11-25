/**
 * An import through the daemon, and what is held back after one (`modules/transfer/service.ts`, `held.ts`,
 * `boot/staged-import.ts`, `routes/transfer.ts`), on real installs on disk behind the real routes.
 *
 * The page's whole way: an export made and downloaded on one install; uploaded in pieces to another, checked with the
 * passphrase, confirmed by the word, left ready, and applied as that install next starts. Then held: no connection to
 * a chat app is made, and no automation runs by the clock, by hand or by a webhook, until "Go live".
 */

import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { createGateways } from "@nouride/gateways";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { SecretStore } from "@nouride/secrets";
import type { ExportPlan, ImportChecked, TransferState } from "@nouride/wire";
import { applyStagedImport } from "@/boot/staged-import.ts";
import { commandKeyLayout } from "@/boot/secret-store.ts";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import { VERSION } from "@/commons/version.ts";
import { openAndMigrate } from "@/db/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { loadGlobalConfig } from "@/modules/config/global/index.ts";
import { CronStore } from "@/modules/cron/cron.store.ts";
import { CronScheduler, type CronExecutors } from "@/modules/cron/scheduler.ts";
import { connectionsFor, heldBack, importedOf } from "@/modules/transfer/held.ts";
import { Transfer } from "@/modules/transfer/service.ts";
import { registerTransferRoutes } from "@/modules/web/control/routes/transfer.ts";
import { eventually } from "../wait.ts";

const PASSPHRASE = "a long walk to the river";
const NOW = 1_795_000_000_000;

let dir = "";
const open: SqliteDb[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  delete process.env.NOURIDE_CONFIG;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const put = (path: string, text: string | Uint8Array): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** An install on disk and the routes over it, as an admin or as `role` asks them. What it restarted for, and its scheduler's starts. */
async function daemon(name: string, how: { restarts?: boolean; role?: string } = {}) {
  if (!dir) dir = mkdtempSync(join(tmpdir(), "import-held-"));
  const root = join(dir, name);
  const home = join(root, ".nouride");
  const data = join(home, "data");
  mkdirSync(data, { recursive: true });
  const configPath = join(home, "config.toml");
  if (!existsSync(configPath)) put(configPath, `[daemon]\nname = "${name}"\n\n[gateways.telegram.${name}]\nenabled = true\ntoken = "telegram_${name}"\nagent = "${name}"\n`);
  if (!existsSync(join(home, "agents", name))) put(join(home, "agents", name, "config.toml"), `id = "${name}"\n`);
  const db = await openAndMigrate(join(data, "nouride.db"));
  open.push(db);
  const secrets = await SecretStore.open(data, {}, { layout: commandKeyLayout({ dataDir: data, configPath }) });
  const { config } = await loadGlobalConfig(root, { quiet: true });
  const restarted: string[] = [];
  const started: string[] = [];
  const state = new DaemonStateStore(db);
  const transfer = new Transfer({
    config: () => config, configPath, db, state, version: VERSION, secrets, credential: () => false, now: () => NOW,
    agents: () => readdirSync(join(home, "agents")).filter((entry) => entry !== "skills" && entry !== "mcp.toml"),
    restart: { can: () => how.restarts !== false, now: (reason) => void restarted.push(reason) },
    scheduler: { start: () => void started.push("scheduler") },
  });
  const app = new Hono<{ Variables: { principal: unknown } }>();
  const role = how.role ?? "admin";
  app.use("*", async (c, next) => {
    c.set("principal", { kind: "user", actor: "gading", role, user: { id: "u1", username: "gading", displayName: "", role } });
    await next();
  });
  const audited: string[] = [];
  registerTransferRoutes(app as never, { audit: { record: (row: { action: string }) => void audited.push(row.action) } } as never, transfer);
  const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; raw: { headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> } }> => {
    const raw = await app.request(path, {
      method,
      ...(body instanceof Uint8Array ? { body, headers: { "content-type": "application/octet-stream" } } : body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    const whole = raw.clone();
    return { status: raw.status, body: (await raw.json().catch(() => null)) as T, raw: whole };
  };
  return { root, home, data, configPath, db, state, secrets, config, call, restarted, started, audited, transfer };
}

/** An export made on the old machine through its routes, and its bytes as a browser would download them. */
async function exported(folders = false): Promise<{ old: Awaited<ReturnType<typeof daemon>>; file: Uint8Array }> {
  const old = await daemon("old");
  put(join(old.home, "memory/old/note.md"), "The durian is in the blue box.\n");
  await old.secrets.set("telegram_old", "stand-in-token-one");
  new CronStore({ db: old.db, config: DEFAULT_CONFIG.cron, timezone: "UTC", now: () => NOW }).create({ agentId: "old", name: "Morning note", trigger: { kind: "every", everyMs: 3_600_000 }, target: { gatewayId: "telegram:old", chatId: "8142" }, createdBy: "test", payload: { kind: "systemEvent", text: "good morning" } });
  expect((await old.call("POST", "/transfer/export", { passphrase: PASSPHRASE, folders })).status).toBe(202);
  let state: TransferState | null = null;
  await eventually(() => {
    void old.call<TransferState>("GET", "/transfer").then((answer) => (state = answer.body));
    return state?.export.state === "ready";
  }, 10_000, "the export");
  const download = await old.call("GET", "/transfer/export/download");
  expect(download.raw.headers.get("content-disposition")).toMatch(/^attachment; filename="nouride-export-.*\.tar\.gz"$/);
  return { old, file: new Uint8Array(await download.raw.arrayBuffer()) };
}

/** `file` sent to `to` in pieces of `size`, as the page sends it. */
async function upload(to: Awaited<ReturnType<typeof daemon>>, file: Uint8Array, size = 700): Promise<void> {
  for (let at = 0; at < file.length; at += size) {
    const sent = await to.call<{ bytes: number }>("POST", `/transfer/import/upload?at=${at}`, file.subarray(at, at + size));
    expect(sent.status).toBe(200);
    expect(sent.body.bytes).toBe(Math.min(file.length, at + size));
  }
}

/**
 * The count reads every file of the install for its size. It ran whole on the daemon's one thread, at each look at the
 * page and again as an export began: 26 seconds on a box whose agents' folders held 1.2 million files, with every chat
 * and the dashboard still for all of it.
 */
describe("the count of what an export will hold", () => {
  test("the daemon goes on with its other work while a large install is counted", async () => {
    const old = await daemon("old");
    for (let at = 0; at < 2_000; at += 1) put(join(old.home, `memory/old/day-${at}.md`), "x");
    // What the daemon would do next (a request to answer, a timer due) waits for a turn of its loop, as this does. A
    // second request made here would not show it: one already in hand goes on between a count's own steps, loop or no.
    let turns = 0;
    let counting = true;
    const turn = (): void => {
      turns += 1;
      if (counting) setImmediate(turn);
    };
    setImmediate(turn);
    const counted = await old.transfer.plan(false).then((plan) => ({ plan, turns }));
    counting = false;
    expect(counted.plan.parts.memory).toEqual({ files: 2_000, bytes: 2_000 });
    // Let go of every hundred files: twenty times in two thousand.
    expect(counted.turns).toBeGreaterThanOrEqual(20);
  });

  test("asked again while it runs, it is the same count, and a new one once that has ended", async () => {
    const old = await daemon("old");
    const first = old.transfer.plan(false);
    expect(old.transfer.plan(false)).toBe(first);
    // With the agents' folders it is another answer, and its own count.
    expect(old.transfer.plan(true)).not.toBe(first);
    await first;
    const later = old.transfer.plan(false);
    expect(later).not.toBe(first);
    // The same count of the install. The disk's free space is in the answer too and is the machine's, not the
    // install's: another program writing between the two counts changed it, and this failed once beside another suite.
    const counted = ({ freeBytes, ...install }: ExportPlan) => ({ install, free: typeof freeBytes });
    expect(counted(await later)).toEqual(counted(await first));
  });

  test("an export begins without one, and says its size once what goes in is counted", async () => {
    const old = await daemon("old");
    const large = 8 * 1024 * 1024;
    // Bytes that do not pack: the file is long enough in the making to be seen at work.
    put(join(old.home, "memory/old/large.bin"), randomBytes(large));
    const started = await old.call<TransferState>("POST", "/transfer/export", { secrets: false });
    expect(started.status).toBe(202);
    expect(started.body.export).toEqual({ state: "working", done: { files: 0, bytes: 0 } });
    const seen: TransferState["export"][] = [];
    await eventually(() => seen.push(old.transfer.state().export) > 0 && seen.at(-1)!.state === "ready", 20_000, "the export");
    const sized = seen.find((one) => one.state === "working" && one.total !== undefined);
    expect(sized?.total).toBeGreaterThan(large);
    expect(sized!.total!).toBeLessThan(large + 1024 * 1024);
  });
});

describe("the page's export", () => {
  test("says what the file will hold before it is made; a passphrase or a plain no is asked for; the file is an admin's alone", async () => {
    const old = await daemon("old");
    await old.secrets.set("telegram_old", "stand-in-token-one");
    const plan = await old.call<ExportPlan>("GET", "/transfer/plan");
    expect(plan.body).toMatchObject({ secrets: 1, parts: { config: { files: 1 }, agents: { files: 1 } } });
    expect(plan.body.bytes).toBeGreaterThan(0);
    // How many secrets there are is known without that count: the page asks for a password, or does not, as it opens.
    expect((await old.call<TransferState>("GET", "/transfer")).body.secrets).toBe(1);
    // Neither a passphrase nor the word that there is none; and one too short.
    expect((await old.call("POST", "/transfer/export", { folders: false })).status).toBe(400);
    const short = await old.call<{ plain: string }>("POST", "/transfer/export", { passphrase: "too short" });
    expect(short.status).toBe(400);
    expect(short.body.plain).toBe("The password needs at least 12 characters.");
    expect((await old.call("GET", "/transfer/export/download")).status).toBe(404);
    // With no secret kept there is nothing to seal: the file is made with none, whatever was typed.
    const bare = await daemon("bare");
    expect((await bare.call<TransferState>("GET", "/transfer")).body.secrets).toBe(0);
    expect((await bare.call("POST", "/transfer/export", { passphrase: "short" })).status).toBe(202);
    let made: TransferState | null = null;
    await eventually(() => {
      void bare.call<TransferState>("GET", "/transfer").then((answer) => (made = answer.body));
      return made?.export.state === "ready";
    }, 10_000, "the export");
    expect(made!.export).toMatchObject({ secrets: false });

    const operator = await daemon("other", { role: "operator" });
    for (const [method, path] of [["GET", "/transfer"], ["GET", "/transfer/plan"], ["POST", "/transfer/export"], ["GET", "/transfer/export/download"], ["POST", "/transfer/import/upload?at=0"], ["POST", "/transfer/import/check"], ["POST", "/transfer/import/apply"], ["POST", "/transfer/live"]] as const) {
      expect({ path, status: (await operator.call(method, path, method === "POST" ? { confirm: "replace", passphrase: PASSPHRASE } : undefined)).status }).toEqual({ path, status: 403 });
    }
  });
});

describe("an import from the page", () => {
  test("arrives in pieces, is refused for a wrong passphrase and without the word, and replaces nothing until the install next starts", async () => {
    const { file } = await exported();
    const fresh = await daemon("new");
    put(join(fresh.home, "memory/new/own.md"), "the new machine's own\n");
    await upload(fresh, file);
    // A piece out of turn is not written into the middle.
    const again = await fresh.call<{ bytes: number }>("POST", "/transfer/import/upload?at=700", file.subarray(700, 1400));
    expect(again.status).toBe(409);
    expect(again.body.bytes).toBe(file.length);

    const wrong = await fresh.call<{ plain: string; why: string }>("POST", "/transfer/import/check", { passphrase: "not the passphrase at all" });
    // Told apart by its status from a file that is refused for good: the page asks for the password then.
    expect(wrong.status).toBe(422);
    expect(wrong.body).toMatchObject({ why: "passphrase", plain: "That password does not open this file's secrets. It is the one typed when the file was made." });
    // Refused, so there is nothing to apply, whatever is typed.
    expect((await fresh.call("POST", "/transfer/import/apply", { confirm: "replace" })).status).toBe(409);

    const checked = await fresh.call<ImportChecked>("POST", "/transfer/import/check", { passphrase: PASSPHRASE });
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ version: VERSION, agents: ["old"], secrets: 1, folders: false, here: { agents: ["new"] } });
    for (const confirm of [undefined, "", "yes", "Replace"]) expect((await fresh.call("POST", "/transfer/import/apply", { confirm })).status).toBe(400);
    expect(fresh.restarted).toEqual([]);

    const asked = await fresh.call<{ restarting: boolean }>("POST", "/transfer/import/apply", { confirm: "replace" });
    expect(asked.body).toEqual({ restarting: true });
    expect(fresh.restarted).toEqual(["an import was asked for"]);
    expect(fresh.audited).toContain("install_import_asked");
    // Left ready, and nothing replaced: this daemon still runs on what it had.
    expect((await fresh.call<TransferState>("GET", "/transfer")).body).toMatchObject({ staged: true, held: false, imported: null });
    expect(readFileSync(join(fresh.home, "memory/new/own.md"), "utf8")).toBe("the new machine's own\n");
    expect(existsSync(join(fresh.home, "agents/old"))).toBe(false);
    // The secrets wait unreadable as they lie: neither file between here and the restart holds a value in the clear.
    for (const waiting of [join(fresh.home, "import-ready.json"), join(fresh.home, "import-staging", "secrets.staged")]) expect(readFileSync(waiting).includes("stand-in-token-one")).toBe(false);
  });

  test("goes in as the install next starts, and a start after that does not apply it again", async () => {
    const { file } = await exported();
    const fresh = await daemon("new");
    await upload(fresh, file);
    expect((await fresh.call("POST", "/transfer/import/check", { passphrase: PASSPHRASE })).status).toBe(200);
    expect((await fresh.call("POST", "/transfer/import/apply", { confirm: "replace" })).status).toBe(200);
    // The daemon stops, as a restart has it; the next `nouride start` begins.
    open.splice(open.indexOf(fresh.db), 1)[0]!.close();
    process.env.NOURIDE_CONFIG = fresh.configPath;
    expect(await applyStagedImport(() => NOW)).toBe("applied");
    expect(await applyStagedImport(() => NOW)).toBe("none");

    expect(readFileSync(join(fresh.home, "memory/old/note.md"), "utf8")).toBe("The durian is in the blue box.\n");
    expect(existsSync(join(fresh.home, "agents/new"))).toBe(false);
    expect(existsSync(join(fresh.home, "import-ready.json"))).toBe(false);
    expect(existsSync(join(fresh.home, "import-staging"))).toBe(false);
    expect(readdirSync(fresh.home).filter((entry) => entry.startsWith("before-import-"))).toHaveLength(1);
    const store = await SecretStore.open(fresh.data, {}, { layout: commandKeyLayout({ dataDir: fresh.data, configPath: fresh.configPath }) });
    expect(store.resolve("telegram_old")).toBe("stand-in-token-one");
    const db = openDatabase(join(fresh.data, "nouride.db"));
    open.push(db);
    expect(importedOf(new DaemonStateStore(db))).toMatchObject({ agents: ["old"], secrets: 1, held: { connections: ["telegram:old"], automations: 1 }, live: false });
  });

  test("one that cannot go in leaves the install as it was, with why for the page", async () => {
    const { file } = await exported();
    const fresh = await daemon("new");
    put(join(fresh.home, "memory/new/own.md"), "the new machine's own\n");
    await upload(fresh, file);
    expect((await fresh.call("POST", "/transfer/import/check", { passphrase: PASSPHRASE })).status).toBe(200);
    expect((await fresh.call("POST", "/transfer/import/apply", { confirm: "replace" })).status).toBe(200);
    // Between the request and the start, the database that was unpacked is lost.
    rmSync(join(fresh.home, "import-staging", "data", "nouride.db"));
    open.splice(open.indexOf(fresh.db), 1)[0]!.close();
    process.env.NOURIDE_CONFIG = fresh.configPath;
    expect(await applyStagedImport(() => NOW)).toBe("failed");

    expect(readFileSync(join(fresh.home, "memory/new/own.md"), "utf8")).toBe("the new machine's own\n");
    expect(existsSync(join(fresh.home, "agents/new/config.toml"))).toBe(true);
    expect(readdirSync(fresh.home).filter((entry) => entry.startsWith("before-import-"))).toEqual([]);
    const back = await daemon("new");
    const state = (await back.call<TransferState>("GET", "/transfer")).body;
    expect(state).toMatchObject({ staged: false, held: false, imported: null, failed: { at: NOW, restored: true } });
    expect(heldBack(back.state)).toBe(false);
  });

  test("where nothing starts Nouride again, it says so and waits for the person's restart", async () => {
    const { file } = await exported();
    const fresh = await daemon("new", { restarts: false });
    await upload(fresh, file, 64 * 1024);
    expect((await fresh.call("POST", "/transfer/import/check", { passphrase: PASSPHRASE })).status).toBe(200);
    expect((await fresh.call<{ restarting: boolean }>("POST", "/transfer/import/apply", { confirm: "replace" })).body).toEqual({ restarting: false });
    expect(fresh.restarted).toEqual([]);
    expect((await fresh.call<TransferState>("GET", "/transfer")).body).toMatchObject({ staged: true, restarts: false });
    // Taken back before the restart: nothing waits, and the file is gone.
    expect((await fresh.call<TransferState>("DELETE", "/transfer/import")).body).toMatchObject({ staged: false, upload: null });
    process.env.NOURIDE_CONFIG = fresh.configPath;
    open.splice(open.indexOf(fresh.db), 1)[0]!.close();
    expect(await applyStagedImport(() => NOW)).toBe("none");
  });
});

/** The new machine after an import, started again: held. */
async function imported() {
  const { file } = await exported();
  const first = await daemon("new");
  await upload(first, file, 64 * 1024);
  await first.call("POST", "/transfer/import/check", { passphrase: PASSPHRASE });
  await first.call("POST", "/transfer/import/apply", { confirm: "replace" });
  open.splice(open.indexOf(first.db), 1)[0]!.close();
  process.env.NOURIDE_CONFIG = first.configPath;
  expect(await applyStagedImport(() => NOW)).toBe("applied");
  return await daemon("new");
}

describe("before Go live", () => {
  test("no connection to a chat app is made: none exists to send through, and its token is never asked for", async () => {
    const fresh = await imported();
    expect(heldBack(fresh.state)).toBe(true);
    expect(fresh.config.gateways.map((gateway) => [gateway.id, gateway.enabled])).toEqual([["telegram:old", true]]);
    const asked: string[] = [];
    const held = await createGateways(connectionsFor(fresh.config.gateways, heldBack(fresh.state)), (name) => (asked.push(name), "stand-in-token-one"));
    expect([...held.keys()]).toEqual([]);
    expect(asked).toEqual([]);
    // The same config on an install that is not held makes it.
    const live = await createGateways(connectionsFor(fresh.config.gateways, false), (name) => (asked.push(name), "123456:stand-in-token-one"));
    expect([...live.keys()]).toEqual(["telegram:old"]);
  });

  test("no automation runs: not by the clock when it is due, not by hand, not by a webhook; after Go live it does", async () => {
    const fresh = await imported();
    // A second past its hour: due, and not so long ago that a start would skip to the next.
    const clock = () => NOW + 3_601_000;
    const store = new CronStore({ db: fresh.db, config: DEFAULT_CONFIG.cron, timezone: "UTC", now: clock });
    const [job] = store.list({ includeDisabled: true });
    expect(job).toMatchObject({ name: "Morning note", enabled: true });
    const delivered: string[] = [];
    const executors = { deliver: async (_target: unknown, text: string) => (delivered.push(text), { ok: true }), runTurn: async () => ({ text: "" }), dispatchTurn: () => true, commandSandbox: () => ({ cwd: dir, env: {} }) } as unknown as CronExecutors;
    // A scheduler that has started listens for a schedule that changes: one that is held has not, and does not.
    let listening = 0;
    const watched = Object.assign(Object.create(store) as CronStore, { onScheduleChange: (listener: () => void) => ((listening += 1), store.onScheduleChange(listener)) });
    const make = () => new CronScheduler({ store: watched, config: { ...DEFAULT_CONFIG.cron, enabled: true }, executors, now: clock, maxSleepMs: 5, held: () => heldBack(fresh.state) });
    const scheduler = make();
    const after = make();
    try {
      scheduler.start();
      expect(listening).toBe(0);
      expect(await scheduler.runNow(job!.id, "gading")).toEqual({ status: "unavailable", result: "this install was imported and has not gone live: automations wait for Go live" });
      expect(await scheduler.runNow(job!.id, "webhook", { body: "{}" } as never)).toMatchObject({ status: "unavailable" });
      await scheduler.stop();
      expect(delivered).toEqual([]);
      expect(store.get(job!.id)!.runCount).toBe(0);

      const live = await fresh.call<{ restarting: boolean; restart: boolean; report: { live: boolean } }>("POST", "/transfer/live");
      expect(live.body).toMatchObject({ restarting: true, restart: true, report: { live: true } });
      expect(fresh.started).toEqual(["scheduler"]);
      expect(fresh.restarted).toEqual(["an imported install went live"]);
      expect(fresh.audited).toContain("install_went_live");
      expect(heldBack(fresh.state)).toBe(false);
      // The same job, due the same second: a scheduler started now runs it.
      after.start();
      expect(listening).toBe(1);
      await eventually(() => delivered.length === 1, 5_000, "the automation's run");
      expect(delivered).toEqual(["good morning"]);
    } finally {
      await scheduler.stop();
      await after.stop();
    }
    // Said once: a second press changes nothing and restarts nothing.
    expect((await fresh.call<{ restarting: boolean }>("POST", "/transfer/live")).body).toMatchObject({ restarting: false });
    expect(fresh.restarted).toHaveLength(1);
    // The note of the import stays until it is put away, which it can be once live.
    expect((await fresh.call<TransferState>("DELETE", "/transfer/imported")).body).toMatchObject({ imported: null, held: false });
  });

  test("an install that was never imported has nothing to go live, and its note cannot be put away before it is", async () => {
    const plain = await daemon("old");
    expect((await plain.call("POST", "/transfer/live")).status).toBe(409);
    const fresh = await imported();
    expect((await fresh.call("DELETE", "/transfer/imported")).status).toBe(409);
    expect(heldBack(fresh.state)).toBe(true);
  });
});

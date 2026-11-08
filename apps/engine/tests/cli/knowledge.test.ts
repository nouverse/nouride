/**
 * `nouride knowledge` against the daemon's own knowledge routes (0.8.20, KNOWLEDGE_BASE §13): the real command, the real
 * routes over a real memory, served the way the daemon serves them under `/api/control`. A file added and found, its
 * collection archived, a document removed; misuse exits 2.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveHttp, type HttpServer } from "@nouride/runtime";
import { installFingerprint } from "@/modules/web/health.ts";
import { registerKnowledgeRoutes } from "@/modules/web/control/routes/knowledge.ts";
import { runCli } from "../cli-harness.ts";
import { household, type Household } from "../memory/fixture.ts";

let h: Household;
let server: HttpServer;
let dir: string;

beforeAll(async () => {
  h = await household();
  dir = h.dir;
  const data = join(dir, "cli-data");
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "token", actor: "cli", role: "admin" });
    await next();
  });
  registerKnowledgeRoutes(control as never, {
    ctx: { config: { ...h.config, attachments: { maxSizeMb: 5 } } },
    memory: h.memory,
    registry: { get: () => undefined },
    audit: { record: () => undefined },
  } as never);
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok", version: "0.8.20", uptime: 5, install: installFingerprint(data) }));
  app.get("/api/control/status", (c) => c.json({ uptime: 5, providers: [], failures: [], agents: [], gateways: [], pendingApprovals: 0, queue: { waiting: 0 } }));
  app.route("/api/control", control);
  server = serveHttp({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, ".control-token"), "token\n", { mode: 0o640 });
  writeFileSync(join(dir, "config.toml"), `[daemon]\ndata_dir = "${data}"\n\n[dashboard]\nport = ${server.port}\n`);
  mkdirSync(join(h.knowledgeRoot, "ops"), { recursive: true });
  writeFileSync(join(h.knowledgeRoot, "ops", "knowledge.toml"), 'name = "Ops"\nreaders = "everyone"\n');
  writeFileSync(join(dir, "runbook.md"), "# Runbook\n## Backups\nVzdump runs at 02:00.\n");
});

afterAll(() => {
  server.stop(true);
  h.close();
});

const cli = (...args: string[]) => runCli(args, { cwd: dir, config: join(dir, "config.toml") });

describe("nouride knowledge", () => {
  test("a file added, found by its words, listed with its collection, then removed", async () => {
    const added = await cli("knowledge", "add", join(dir, "runbook.md"), "--to", "ops");
    expect(added.code).toBe(0);
    expect(added.out).toContain("✓ ops/runbook.md");

    const found = await cli("knowledge", "search", "vzdump", "--json");
    expect(found.code).toBe(0);
    expect(JSON.parse(found.out).data.hits.map((hit: { item: string }) => hit.item)).toEqual(["knowledge:ops/runbook.md#0"]);

    const listed = await cli("knowledge");
    expect(listed.out).toContain("Ops (ops) · 1 document(s), 1 section(s) · for everyone");

    expect((await cli("knowledge", "archive", "ops")).out).toContain("✓ ops is kept, and no longer searched");
    expect((await cli("knowledge", "list")).out).toContain("archived");
    await cli("knowledge", "unarchive", "ops");

    const removed = await cli("knowledge", "rm", "ops/runbook.md");
    expect(removed.code).toBe(0);
    expect(JSON.parse((await cli("knowledge", "search", "vzdump", "--json")).out).data.hits).toEqual([]);
  }, 60_000);

  test("a collection named as the dashboard and the list show it, not only by its id", async () => {
    mkdirSync(join(h.knowledgeRoot, "lab-results"), { recursive: true });
    writeFileSync(join(h.knowledgeRoot, "lab-results", "knowledge.toml"), 'name = "Lab results"\nreaders = "admins"\n');
    writeFileSync(join(dir, "october.md"), "# October\nHaemoglobin 13.9, all within range.\n");

    const added = await cli("knowledge", "add", join(dir, "october.md"), "--to", "Lab results");
    expect(added.code).toBe(0);
    expect(added.out).toContain("✓ lab-results/october.md");
    const found = await cli("knowledge", "search", "haemoglobin", "--in", "lab RESULTS", "--json");
    expect(JSON.parse(found.out).data.hits.map((hit: { item: string }) => hit.item)).toEqual(["knowledge:lab-results/october.md#0"]);
    expect((await cli("knowledge", "archive", "Lab results")).out).toContain("✓ lab-results is kept, and no longer searched");
    await cli("knowledge", "unarchive", "Lab results");
    expect((await cli("knowledge", "rm", "Lab results/october.md")).code).toBe(0);
    expect(JSON.parse((await cli("knowledge", "search", "haemoglobin", "--json")).out).data.hits).toEqual([]);
  }, 60_000);

  // On a server `nouride` run as root runs as the service's account, which cannot read a file in root's home: it said
  // "is not a file here" of a file that was (0.8.20's check on the box, 2026-11-06). The shell can open it and hand it over.
  test("a file handed over on standard input is kept under the name given", async () => {
    const added = await runCli(["knowledge", "add", "-", "--name", "Gate notes.md", "--to", "Ops"], {
      cwd: dir,
      config: join(dir, "config.toml"),
      stdin: "# Gate notes\nThe side gate's code is kumquat-7.\n",
    });
    expect(added.code).toBe(0);
    expect(added.out).toContain("✓ ops/Gate notes.md");
    const found = await cli("knowledge", "search", "kumquat", "--json");
    expect(JSON.parse(found.out).data.hits.map((hit: { item: string }) => hit.item)).toEqual(["knowledge:ops/Gate notes.md#0"]);
    expect((await cli("knowledge", "rm", "ops/Gate notes.md")).code).toBe(0);
  }, 60_000);

  test.skipIf(process.getuid?.() === 0)("a file this account may not read says so, and how to hand it over, not that it is missing", async () => {
    const locked = join(dir, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "pay slips.md"), "# Pay slips\n");
    chmodSync(locked, 0o000);
    try {
      const refused = await cli("knowledge", "add", join(locked, "pay slips.md"), "--to", "Ops");
      expect(refused.code).toBe(1);
      const said = refused.out + refused.err;
      expect(said).toContain(`Cannot read ${join(locked, "pay slips.md")}: permission denied`);
      expect(said).toContain("the account this command runs as");
      expect(said).toContain(`nouride knowledge add - --name 'pay slips.md' --to Ops < '${join(locked, "pay slips.md")}'`);
      expect(said).not.toContain("is not a file here");
    } finally {
      chmodSync(locked, 0o700);
    }
    const missing = await cli("knowledge", "add", join(dir, "nowhere.md"), "--to", "Ops");
    expect(missing.code).toBe(1);
    expect(missing.out + missing.err).toContain(`${join(dir, "nowhere.md")} is not a file here.`);
  }, 60_000);

  // 0.8.23: the words search finds a document by, beside its file's name, so English finds one in another language.
  test("a document titled, found by its title's words, its own title back when taken off", async () => {
    writeFileSync(join(dir, "izin.md"), "Izin usaha diterbitkan pemerintah.\n");
    expect((await cli("knowledge", "add", join(dir, "izin.md"), "--to", "ops")).code).toBe(0);
    const titled = await cli("knowledge", "title", "Ops/izin.md", "Business", "licence", "(izin", "usaha)");
    expect(titled.code).toBe(0);
    expect(titled.out).toContain('✓ ops/izin.md is titled "Business licence (izin usaha)"');
    expect((await cli("knowledge", "search", "business licence", "--in", "ops")).out).toContain("Business licence (izin usaha)");
    const off = await cli("knowledge", "title", "ops/izin.md", "");
    expect(off.code).toBe(0);
    expect(off.out).toContain("✓ ops/izin.md has its own title again: izin");
    expect((await cli("knowledge", "title", "ops/gone.md", "Gone")).code).toBe(1);
    expect((await cli("knowledge", "title", "ops/izin.md")).code).toBe(2);
    expect((await cli("knowledge", "rm", "ops/izin.md")).code).toBe(0);
  }, 60_000);

  test("misuse exits 2, saying how; a collection that is not there exits 1", async () => {
    expect((await cli("knowledge", "add", "-", "--to", "ops")).code).toBe(2);
    expect((await cli("knowledge", "add", join(dir, "runbook.md"))).code).toBe(2);
    expect((await cli("knowledge", "rm", "ops")).code).toBe(2);
    expect((await cli("knowledge", "search")).code).toBe(2);
    expect((await cli("knowledge", "bogus")).code).toBe(2);
    const nowhere = await cli("knowledge", "add", join(dir, "runbook.md"), "--to", "nowhere");
    expect(nowhere.code).toBe(1);
    expect(nowhere.out + nowhere.err).toContain('no collection "nowhere"');
  }, 60_000);
});

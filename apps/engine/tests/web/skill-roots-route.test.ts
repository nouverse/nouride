/**
 * An agent's skill roots from its Skills page and `nouride agent skill-root add|rm` (0.8.24, `setup/skill-roots.ts`):
 * listed with the skills each brings, added and removed by an admin, each change written as the Files tab's save writes
 * it — the version before kept, the agent reloaded with it, audited. A folder that is not there, a file, a path that is
 * not a full one, a folder holding the credentials folder, a root already there: refused, the file as it was. Over a
 * real registry, file writer and audit log, so what the agent loads after a change is what the test reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import { AgentRegistry, ProjectSkills } from "@nouride/persona";
import { migrate } from "@/db/index.ts";
import { AuditLog } from "@/commons/audit.store.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { FileService } from "@/modules/setup/files.ts";
import { SkillRoots } from "@/modules/setup/skill-roots.ts";
import { mountControlRoutes } from "@/modules/web/control/index.ts";
import type { ControlDeps } from "@/modules/web/control/types.ts";
import { cheapPasswords, tempDir } from "../helpers.ts";

const TOKEN = "control-token-for-tests-0000000000";
const PACK = '[llm]\nprovider = "test"\n\n# the folders it works in\n[workspace]\nroots = ["/srv/work"]\n';

let dir = "";
let db: SqliteDb;
let app: Hono;
let registry: AgentRegistry;
let audit: AuditLog;
let project = "";
let credentials = "";

beforeEach(async () => {
  dir = tempDir("skill-roots-route");
  const agentsDir = join(dir, "agents");
  mkdirSync(join(agentsDir, "nix"), { recursive: true });
  writeFileSync(join(agentsDir, "nix", "IDENTITY.md"), "# IDENTITY\n- Name: Nix\n");
  writeFileSync(join(agentsDir, "nix", "config.toml"), PACK);
  project = join(dir, "home-app");
  mkdirSync(join(project, ".agents", "skills", "android-ui"), { recursive: true });
  writeFileSync(join(project, ".agents", "skills", "android-ui", "SKILL.md"), "---\nname: android-ui\ndescription: How the app's screens are built.\n---\n\nBody.\n");
  credentials = join(dir, "install", "credentials");
  mkdirSync(credentials, { recursive: true });
  db = openDatabase(join(dir, "t.db"));
  await migrate(db);
  const users = new UserStore({ db, passwords: cheapPasswords });
  await users.create({ username: "oli", password: "operator-password-1", role: "operator", createdBy: "test" });
  audit = new AuditLog(db);
  registry = await AgentRegistry.create({ agentsDir, llmDefaults: { provider: "test", model: "m", maxTokens: 1000, temperature: 0.5 }, knownProviders: ["test"] });
  const config = structuredClone(DEFAULT_CONFIG);
  const files = new FileService({ agentsDir, configPath: join(dir, "config.toml"), registry, config, audit });
  app = new Hono();
  mountControlRoutes(app, {
    ctx: { config, db, gateways: new Map(), startedAt: Date.now(), status: "ready", agentCount: 1, providerErrors: new Map() },
    token: TOKEN,
    audit,
    users,
    registry,
    skillRoots: new SkillRoots({ registry, files, credentialsDir: credentials, projectSkills: new ProjectSkills() }),
  } as unknown as ControlDeps);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method: string, path: string, body?: unknown, cookie?: string) =>
  app.request(
    `/api/control${path}`,
    {
      method,
      headers: { ...(cookie ? { cookie } : { "x-nouride-token": TOKEN }), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { clientAddress: "203.0.113.10" },
  );
const packText = () => readFileSync(join(dir, "agents", "nix", "config.toml"), "utf8");
const loaded = () => registry.get("nix")?.config.skillRoots;
const edits = () => audit.ofActions(["agent_file_edited"]).reverse().map((row) => row.details);
const add = (path: string, cookie?: string) => call("POST", "/agents/nix/skill-roots", { path }, cookie);
const remove = (path: string, cookie?: string) => call("DELETE", `/agents/nix/skill-roots?path=${encodeURIComponent(path)}`, undefined, cookie);

describe("an agent's skill roots, from its Skills page and the CLI", () => {
  test("added: written as the Files tab writes, the version before kept, the agent reloaded with it, audited", async () => {
    const res = await add(`${project}/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: project, skills: ["android-ui"] });
    expect(packText()).toBe(`${PACK.trimEnd()}\nskill_roots = ["${project}"]\n`);
    expect(readFileSync(join(dir, "agents", "nix", "config.toml.bak.1"), "utf8")).toBe(PACK);
    expect(loaded()).toEqual([project]);
    expect(edits()).toEqual([{ file: "config.toml", bytes: packText().length, via: "skill_roots", added: project }]);
  });

  test("listed with the skills each root brings, and whether the person may change them", async () => {
    await add(project);
    const res = await call("GET", "/agents/nix/skill-roots");
    expect(await res.json()).toEqual({
      roots: [{ path: project, readable: true, skills: [{ name: "android-ui", description: "How the app's screens are built." }] }],
      editable: true,
    });
  });

  test("removed by the path the page lists, the key taken away with the last one, reloaded, audited", async () => {
    await add(project);
    const res = await remove(project);
    expect(res.status).toBe(200);
    expect(packText()).toBe(PACK);
    expect(loaded()).toEqual([]);
    expect(edits()).toContainEqual({ file: "config.toml", bytes: PACK.length, via: "skill_roots", removed: project });
  });

  test("a root written by hand as relative to the pack is removed by its full path, as the loader reads it", async () => {
    writeFileSync(join(dir, "agents", "nix", "config.toml"), `${PACK}skill_roots = ["../../home-app", "/srv/other"]\n`);
    await registry.reload("nix");
    expect(loaded()).toEqual([project, "/srv/other"]);
    expect((await remove(project)).status).toBe(200);
    expect(packText()).toBe(`${PACK}skill_roots = ["/srv/other"]\n`);
  });

  test("refused, the file as it was and nothing reloaded: a missing folder, a file, a path that is not full, the credentials folder's, one already there", async () => {
    await add(project);
    const before = packText();
    writeFileSync(join(dir, "notes.txt"), "a file\n");
    const cases: [string, number, string][] = [
      [join(dir, "not-cloned-yet"), 400, "There is no folder there on this server. Nothing was saved."],
      [join(dir, "notes.txt"), 400, "That is a file. Name the project's folder instead. Nothing was saved."],
      ["home-app", 400, "Nothing was saved. Check the folder: give its full path, starting with /, and try again."],
      // The folder that holds it, not only the folder itself: every agent with that root could read the keys.
      [join(dir, "install"), 400, "That folder holds the keys Nouride keeps, so no agent may take skills from it. Nothing was saved."],
      [credentials, 400, "That folder holds the keys Nouride keeps, so no agent may take skills from it. Nothing was saved."],
      [project, 409, "This agent already takes skills from that folder."],
    ];
    for (const [path, status, plain] of cases) {
      const res = await add(path);
      expect({ path, status: res.status, plain: ((await res.json()) as { plain: string }).plain }).toEqual({ path, status, plain });
    }
    expect(packText()).toBe(before);
    expect(loaded()).toEqual([project]);
    expect(edits()).toHaveLength(1);
  });

  // Root reads every folder, so only a test run as another user can see this refusal.
  test.skipIf(process.getuid?.() === 0)("a folder the daemon's user is not let into: refused, nothing written", async () => {
    const closed = join(dir, "closed");
    mkdirSync(closed);
    chmodSync(closed, 0o300);
    const res = await add(closed);
    chmodSync(closed, 0o755);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { plain: string }).plain).toBe("Nouride is not allowed to open that folder on this server. Nothing was saved.");
    expect(packText()).toBe(PACK);
  });

  test("a root that is not one of its own is not removed, and nothing is written", async () => {
    const res = await remove(join(dir, "elsewhere"));
    expect(res.status).toBe(404);
    expect(packText()).toBe(PACK);
    expect(existsSync(join(dir, "agents", "nix", "config.toml.bak.1"))).toBe(false);
    expect(edits()).toEqual([]);
  });

  test("an admin's to change: an operator sees them, and is refused a change", async () => {
    const login = await call("POST", "/auth/login", { username: "oli", password: "operator-password-1" });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(((await (await call("GET", "/agents/nix/skill-roots", undefined, cookie)).json()) as { editable: boolean }).editable).toBe(false);
    expect((await add(project, cookie)).status).toBe(403);
    expect((await remove("/srv/work", cookie)).status).toBe(403);
    expect(packText()).toBe(PACK);
  });

  test("an agent that is not there: refused", async () => {
    expect((await call("GET", "/agents/ghost/skill-roots")).status).toBe(404);
    expect((await call("POST", "/agents/ghost/skill-roots", { path: project })).status).toBe(404);
  });
});

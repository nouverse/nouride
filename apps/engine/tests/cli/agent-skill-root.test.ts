/**
 * `nouride agent skill-root add|rm <id> <path>` (0.8.24) against the daemon's own skill-root routes, served the way the
 * daemon serves them under `/api/control`, over a real registry and the Files tab's writer: a relative path is the one
 * the command runs in, a folder added says the skills it brings, a refusal exits 1 with the daemon's reason, misuse exits 2.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveHttp, type HttpServer } from "@nouride/runtime";
import { AgentRegistry, ProjectSkills } from "@nouride/persona";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { FileService } from "@/modules/setup/files.ts";
import { SkillRoots } from "@/modules/setup/skill-roots.ts";
import { installFingerprint } from "@/modules/web/health.ts";
import { registerSkillRootRoutes } from "@/modules/web/control/routes/skill-roots.ts";
import { runCli } from "../cli-harness.ts";
import { tempDir } from "../helpers.ts";

let server: HttpServer;
let dir = "";
let project = "";

beforeAll(async () => {
  // Its real path: the command resolves `.` from the folder it runs in, which on macOS is `/private/var/…` where the
  // temp folder's name says `/var/…`, and a root is written as the folder resolves.
  dir = realpathSync(tempDir("cli-skill-root"));
  const agentsDir = join(dir, "agents");
  mkdirSync(join(agentsDir, "nix"), { recursive: true });
  writeFileSync(join(agentsDir, "nix", "IDENTITY.md"), "# IDENTITY\n- Name: Nix\n");
  writeFileSync(join(agentsDir, "nix", "config.toml"), '[llm]\nprovider = "test"\n');
  project = join(dir, "home-app");
  mkdirSync(join(project, ".agents", "skills", "android-ui"), { recursive: true });
  writeFileSync(join(project, ".agents", "skills", "android-ui", "SKILL.md"), "---\nname: android-ui\ndescription: How the app's screens are built.\n---\n");
  const registry = await AgentRegistry.create({ agentsDir, llmDefaults: { provider: "test", model: "m", maxTokens: 1000, temperature: 0.5 }, knownProviders: ["test"] });
  const files = new FileService({ agentsDir, configPath: join(dir, "config.toml"), registry, config: structuredClone(DEFAULT_CONFIG) });
  const control = new Hono<{ Variables: { principal: unknown } }>();
  control.use("*", async (c, next) => {
    c.set("principal", { kind: "token", actor: "cli", role: "admin" });
    await next();
  });
  registerSkillRootRoutes(control as never, { skillRoots: new SkillRoots({ registry, files, credentialsDir: join(dir, "credentials"), projectSkills: new ProjectSkills() }) } as never);
  const data = join(dir, "data");
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok", version: "0.8.24", uptime: 5, install: installFingerprint(data) }));
  app.route("/api/control", control);
  server = serveHttp({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, ".control-token"), "token\n", { mode: 0o640 });
  writeFileSync(join(dir, "config.toml"), `[daemon]\ndata_dir = "${data}"\n\n[dashboard]\nport = ${server.port}\n`);
});

afterAll(() => server.stop(true));

const cli = (cwd: string, ...args: string[]) => runCli(args, { cwd, config: join(dir, "config.toml") });
const pack = () => readFileSync(join(dir, "agents", "nix", "config.toml"), "utf8");

describe("nouride agent skill-root", () => {
  test("add: the folder it runs in, by its full path, with the skills it brings; --json the same", async () => {
    const added = await cli(project, "agent", "skill-root", "add", "nix", ".", "--json");
    expect(added.code).toBe(0);
    expect(JSON.parse(added.out)).toMatchObject({ ok: true, data: { ok: true, path: project, skills: ["android-ui"] } });
    expect(pack()).toContain(`skill_roots = ["${project}"]`);
  });

  test("refused by the daemon: exit 1 with its reason, the file as it was", async () => {
    const before = pack();
    const again = await cli(dir, "agent", "skill-root", "add", "nix", project);
    expect(again.code).toBe(1);
    expect(again.err).toContain(`${project} is already one of nix's skill roots.`);
    const missing = await cli(dir, "agent", "skill-root", "add", "nix", "not-cloned-yet");
    expect(missing.code).toBe(1);
    expect(missing.err).toContain(`There is no folder at ${join(dir, "not-cloned-yet")}.`);
    expect(pack()).toBe(before);
  });

  test("rm: taken away, said as applied; one that is not there exits 1", async () => {
    const removed = await cli(dir, "agent", "skill-root", "rm", "nix", "home-app");
    expect(removed.code).toBe(0);
    expect(removed.out).toContain(`✓ ${project} is no longer a skill root of nix: applied`);
    expect(pack()).toBe('[llm]\nprovider = "test"\n');
    expect((await cli(dir, "agent", "skill-root", "rm", "nix", "home-app")).code).toBe(1);
  });

  test("misuse exits 2 with its usage: no folder, a verb it does not have", async () => {
    for (const args of [["add", "nix"], ["move", "nix", "."], []]) {
      const run = await cli(dir, "agent", "skill-root", ...args);
      expect({ args, code: run.code }).toEqual({ args, code: 2 });
      expect(run.err).toContain("nouride agent skill-root <add|rm> <id> <path>");
    }
  });
});

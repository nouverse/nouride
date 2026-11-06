/**
 * Skills from elsewhere: references, the "auto adjust" into Nouride's frontmatter, installing from
 * each hub into the pending queue, and approval writing what the installer kept.
 *
 * Mocked at the network only. Tarballs and ZIPs are made by the real `tar` and `zip`, so what is
 * parsed is what those tools write; the live hubs were probed by hand (see `sources.ts`).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@nouride/runtime";
import type { SkillLearningSection } from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import { migrate } from "@/db/index.ts";
import { DraftStore, ReflectionEngine, ToolMemory } from "@/modules/reflection/index.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import { SkillHub } from "@/modules/skills-hub/index.ts";
import { Hono } from "hono";
import { registerSkillHubRoutes } from "@/modules/web/control/routes/skills-hub.ts";
import { normalizeSkill } from "@/modules/skills-hub/normalize.ts";
import { parseRef, type FetchedSkill } from "@/modules/skills-hub/sources.ts";

const LEARNING: SkillLearningSection = { mode: "ask", model: "", notifyChat: false };
// Two pending at most, so a hub install past it is refused here — the pass's own dial, set for this test.
const TUNING = { maxPending: 2 };
const SHA = "a".repeat(40);
const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-hub-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const enc = (text: string) => new TextEncoder().encode(text);
const fetched = (files: Record<string, string | Uint8Array>, dirName = "my-skill"): FetchedSkill => ({
  dirName,
  files: Object.entries(files).map(([path, content]) => ({ path, bytes: typeof content === "string" ? enc(content) : content })),
  source: "github:o/r@sha/my-skill",
  url: "https://github.com/o/r",
  warnings: [],
});

describe("references", () => {
  test("every way to name a skill", () => {
    expect(parseRef("anthropics/skills/skills/pdf")).toEqual({ kind: "github", owner: "anthropics", repo: "skills", path: "skills/pdf" });
    expect(parseRef("github:o/r@v1.2")).toEqual({ kind: "github", owner: "o", repo: "r", path: "", ref: "v1.2" });
    expect(parseRef("https://github.com/o/r/tree/main/skills/x")).toEqual({ kind: "github", owner: "o", repo: "r", path: "skills/x", ref: "main" });
    expect(parseRef("https://github.com/o/r/blob/dev/skills/x/SKILL.md")).toEqual({ kind: "github", owner: "o", repo: "r", path: "skills/x", ref: "dev" });
    expect(parseRef("skills.sh:anthropics/skills/pdf")).toEqual({ kind: "skills.sh", owner: "anthropics", repo: "skills", skill: "pdf" });
    expect(parseRef("https://skills.sh/anthropics/skills/pdf")).toEqual({ kind: "skills.sh", owner: "anthropics", repo: "skills", skill: "pdf" });
    expect(parseRef("clawhub:tenequm/rust-dev@0.8.0")).toEqual({ kind: "clawhub", owner: "tenequm", slug: "rust-dev", version: "0.8.0" });
    expect(parseRef("well-known:https://agentskills.io")).toEqual({ kind: "well-known", origin: "https://agentskills.io" });
    expect(parseRef("https://agentskills.io/.well-known/skills/agent/SKILL.md")).toEqual({ kind: "well-known", origin: "https://agentskills.io", name: "agent" });
    expect(parseRef("well-known:http://insecure.example")).toContain("Name a source");
    expect(parseRef("justaword")).toContain("Name a source");
  });
});

describe("the auto adjust", () => {
  test("YAML frontmatter, allowed-tools and scripts become Nouride's fields", () => {
    const candidate = normalizeSkill(
      fetched({
        "SKILL.md": "---\nname: PDF Tools\ndescription: >\n  Work with PDFs,\n  every way.\nallowed-tools: [Bash(git:*), Read, NotebookEdit]\n---\n\n# PDF\n\nSee reference.md.\n",
        "reference.md": "# Reference",
        "scripts/lib/fill.py": "#!/usr/bin/env python3\nprint(1)\n",
        "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
        ".hidden/x.md": "secret",
      }),
    );
    if ("error" in candidate) throw new Error(candidate.error);
    expect(candidate.name).toBe("pdf-tools");
    expect(candidate.description).toBe("Work with PDFs, every way.");
    expect(candidate.needsTools).toBe("exec, read");
    expect(candidate.requires).toBe("python3");
    expect(candidate.files.map((f) => f.path).sort()).toEqual(["reference.md", "scripts/lib/fill.py"]);
    const notes = candidate.notes.join("\n");
    expect(notes).toContain('Named "pdf-tools" (was "PDF Tools")');
    expect(notes).toContain("no counterpart here: NotebookEdit");
    expect(notes).toContain("assets/logo.png (binary)");
    expect(notes).toContain(".hidden/x.md (path)");
  });

  test("ClawHub's requires.bins, and a skill with nothing declared", () => {
    const clawhub = normalizeSkill(
      fetched({ "SKILL.md": '---\nname: gh-ops\ndescription: GitHub chores\nmetadata: {"openclaw": {"requires": {"bins": ["gh", "jq"]}}}\n---\nRun `gh`.\n' }),
    );
    if ("error" in clawhub) throw new Error(clawhub.error);
    expect(clawhub.requires).toBe("gh, jq");
    expect(clawhub.needsTools).toBe("read");

    const bare = normalizeSkill(fetched({ "SKILL.md": "# Notes\n\nA short procedure.\n\n```bash\nls\n```\n" }, "Bare Notes"));
    if ("error" in bare) throw new Error(bare.error);
    expect(bare.name).toBe("bare-notes");
    expect(bare.description).toBe("A short procedure.");
    expect(bare.needsTools).toBe("read, exec");
  });

  test("what cannot be a skill is said so", () => {
    expect(normalizeSkill(fetched({ "README.md": "x" }))).toEqual({ error: "it has no SKILL.md" });
    expect(normalizeSkill(fetched({ "SKILL.md": "---\nname: x\n---\n" }))).toEqual({ error: "its SKILL.md has no instructions after the frontmatter" });
  });
});

/** A hub on the far side of a fake `fetch`: GitHub, ClawHub and a well-known site. */
function hub(options: { pool?: string[]; builtin?: string[]; malicious?: boolean; popular?: { down: boolean } } = {}) {
  const root = temp();
  const agentsDir = join(root, "agents");
  const builtinDir = join(root, "builtin");
  for (const name of options.pool ?? []) {
    mkdirSync(join(agentsDir, "skills", name), { recursive: true });
    writeFileSync(join(agentsDir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: d\nauthor: x\n---\nbody\n`);
  }
  mkdirSync(builtinDir, { recursive: true });
  for (const name of options.builtin ?? []) {
    mkdirSync(join(builtinDir, name), { recursive: true });
    writeFileSync(join(builtinDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  }

  // A repository with two skills, tarred the way codeload does: one `repo-sha/` directory on top.
  const repo = join(root, "src", `r-${SHA}`);
  for (const [path, content] of Object.entries({
    "skills/pdf/SKILL.md": "---\nname: pdf\ndescription: PDFs\nallowed-tools: Bash Read\n---\nUse scripts/fill.py.\n",
    "skills/pdf/scripts/fill.py": "#!/usr/bin/env python3\nprint('fill')\n",
    "skills/pdf/docs/deep/nested/guide.md": "# Guide",
    "skills/notes/SKILL.md": "---\nname: notes\ndescription: Notes\n---\nTake notes.\n",
    "README.md": "repo",
  })) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  const tarball = join(root, "repo.tar.gz");
  expect(spawnSync("tar", ["-czf", tarball, "-C", join(root, "src"), `r-${SHA}`], { env: { ...process.env, COPYFILE_DISABLE: "1" } }).status).toBe(0);

  const zipDir = join(root, "zip");
  mkdirSync(join(zipDir, "references"), { recursive: true });
  writeFileSync(join(zipDir, "SKILL.md"), "---\nname: rust-dev\ndescription: Rust\n---\nWrite Rust.\n");
  writeFileSync(join(zipDir, "references", "async.md"), "async");
  writeFileSync(join(zipDir, "_meta.json"), "{}");
  const zip = join(root, "s.zip");
  expect(spawnSync("zip", ["-qr", zip, "."], { cwd: zipDir }).status).toBe(0);

  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const ok = (body: string | Uint8Array) => new Response(body, { status: 200 });
    if (url.startsWith("https://api.github.com/repos/o/r/commits/")) return ok(SHA);
    if (url === `https://codeload.github.com/o/r/tar.gz/${SHA}`) return ok(readFileSync(tarball));
    if (url.startsWith("https://clawhub.ai/api/v1/skills?sort=downloads")) {
      if (options.popular?.down) return new Response("busy", { status: 503 });
      return ok(JSON.stringify({ items: [{ slug: "self-improving-agent", ownerHandle: "p", displayName: "self-improving agent", summary: "Keeps learnings", stats: { downloads: 486325, stars: 4002 } }, { slug: "github", ownerHandle: "s", summary: "GitHub" }] }));
    }
    if (url === "https://clawhub.ai/api/v1/skills/rust-dev") return ok(JSON.stringify({ skill: { tags: { latest: "0.8.0" }, ownerHandle: "t" } }));
    if (url.startsWith("https://clawhub.ai/api/v1/skills/rust-dev/versions/0.8.0")) {
      return ok(JSON.stringify({ version: { security: { status: options.malicious ? "malicious" : "clean", scanners: { skillspector: { status: "suspicious", severity: "CRITICAL" } } } } }));
    }
    if (url.startsWith("https://clawhub.ai/api/v1/download?slug=rust-dev&version=0.8.0")) return ok(readFileSync(zip));
    if (url === "https://site.example/.well-known/skills/index.json") return ok(JSON.stringify({ skills: [{ name: "agent", description: "d", files: ["SKILL.md", "refs/a.md"] }] }));
    if (url === "https://site.example/.well-known/skills/agent/SKILL.md") return ok("---\nname: Agent\ndescription: Skills about skills\n---\nBody.\n");
    if (url === "https://site.example/.well-known/skills/agent/refs/a.md") return ok("ref");
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;

  const db = openDatabase(join(root, "t.db"));
  migrate(db);
  const drafts = new DraftStore(db, () => 1000);
  const engine = new ReflectionEngine({
    config: LEARNING,
    tuning: TUNING,
    drafts,
    toolMemory: new ToolMemory(db, () => 1000),
    registry: { get: () => undefined, reloadAll: async () => {} } as unknown as AgentRegistry,
    providers: { get: () => undefined } as unknown as ProviderRegistry,
    agentsDir,
    builtinSkillsDir: builtinDir,
    now: () => Date.UTC(2026, 9, 6),
  });
  const skillHub = new SkillHub({
    scratchDir: root,
    agentsDir,
    builtinSkillsDir: builtinDir,
    reflection: engine,
    fetchImpl,
    checkUrlImpl: async () => ({ allowed: true }),
  });
  return { skillHub, engine, drafts, agentsDir, seen };
}

describe("installing", () => {
  test("a GitHub repository: every skill in it, pinned to the commit, as pending drafts — nothing in the pool", async () => {
    const { skillHub, agentsDir } = hub();
    const result = await skillHub.install("o/r", { agentId: "gading", byAgent: false });
    expect(result.drafts.map((d) => d.name)).toEqual(["notes", "pdf"]);
    expect(result.drafts.find((d) => d.name === "pdf")!.source).toBe(`github:o/r@${SHA}/skills/pdf`);
    expect(existsSync(join(agentsDir, "skills", "pdf"))).toBe(false);
  });

  test("approval writes it — nested files, the source line, scripts executable", async () => {
    const { skillHub, engine, agentsDir } = hub();
    const { drafts } = await skillHub.install("o/r/skills/pdf", { agentId: "gading", byAgent: false });
    expect(drafts).toHaveLength(1);
    const approved = await engine.approve(drafts[0]!.id, "gading");
    expect(approved.ok).toBe(true);
    const md = readFileSync(join(agentsDir, "skills", "pdf", "SKILL.md"), "utf8");
    expect(md).toContain(`source: github:o/r@${SHA}/skills/pdf`);
    expect(md).toContain("needs_tools: exec, read");
    expect(md).toContain("requires: python3");
    expect(md).toContain("author: gading");
    expect(readFileSync(join(agentsDir, "skills", "pdf", "docs", "deep", "nested", "guide.md"), "utf8")).toBe("# Guide");
    expect(statSync(join(agentsDir, "skills", "pdf", "scripts", "fill.py")).mode & 0o111).not.toBe(0);
  });

  test("skills.sh: the one skill it names, out of its GitHub repository", async () => {
    const { skillHub } = hub();
    const result = await skillHub.install("skills.sh:o/r/notes", { agentId: "gading", byAgent: false });
    expect(result.drafts.map((d) => d.name)).toEqual(["notes"]);
  });

  test("ClawHub: the ZIP, its own bookkeeping left out, its scan shown — and a malicious verdict refused", async () => {
    const { skillHub, drafts } = hub();
    const result = await skillHub.install("clawhub:rust-dev", { agentId: "gading", byAgent: false });
    expect(result.drafts[0]!.source).toBe("clawhub:t/rust-dev@0.8.0");
    expect(result.drafts[0]!.warnings.join()).toContain("skillspector: suspicious (CRITICAL)");
    const draft = drafts.get(result.drafts[0]!.id)!;
    expect(draft.files.map((f) => f.path)).toEqual(["references/async.md"]);
    expect(draft.transcript).toContain("skillspector: suspicious");

    await expect(hub({ malicious: true }).skillHub.install("clawhub:rust-dev", { agentId: "gading", byAgent: false })).rejects.toThrow("malicious");
  });

  test("a well-known index", async () => {
    const { skillHub, drafts } = hub();
    const result = await skillHub.install("well-known:https://site.example", { agentId: "gading", byAgent: false });
    expect(result.drafts.map((d) => d.name)).toEqual(["agent"]);
    expect(drafts.get(result.drafts[0]!.id)!.files.map((f) => f.path)).toEqual(["refs/a.md"]);
  });

  test("a name already taken — installed, shipped, or waiting — is refused, saying which", async () => {
    const { skillHub } = hub({ pool: ["notes"], builtin: ["pdf"] });
    const result = await skillHub.install("o/r", { agentId: "gading", byAgent: false });
    expect(result.drafts).toEqual([]);
    expect(result.refused).toEqual([
      { name: "notes", reason: 'a skill called "notes" is already installed' },
      { name: "pdf", reason: 'Nouride ships a skill called "pdf" already' },
    ]);

    const again = hub();
    await again.skillHub.install("o/r/skills/notes", { agentId: "gading", byAgent: false });
    expect((await again.skillHub.install("o/r/skills/notes", { agentId: "gading", byAgent: false })).refused[0]!.reason).toContain("already waiting");
  });

  test("an agent is held to the pending cap; a person is not", async () => {
    const { skillHub } = hub();
    const byAgent = await skillHub.install("o/r", { agentId: "nouva", byAgent: true });
    expect(byAgent.drafts).toHaveLength(2);
    const third = await skillHub.install("well-known:https://site.example", { agentId: "nouva", byAgent: true });
    expect(third.refused[0]!.reason).toContain("already waiting for a decision");
    const person = await skillHub.install("well-known:https://site.example", { agentId: "gading", byAgent: false });
    expect(person.drafts).toHaveLength(1);
  });
});

describe("approval guards every new skill", () => {
  test("a draft named like a built-in is refused rather than allowed to shadow it", async () => {
    const { engine, drafts } = hub({ builtin: ["pdf"] });
    const draft = drafts.create({ agentId: "nouva", triggerKind: "user_request", triggerReason: "r", name: "pdf", description: "d", requires: "", body: "b" });
    const outcome = await engine.approve(draft.id, "gading");
    expect(outcome).toEqual({ ok: false, error: '"pdf" is the name of a skill Nouride ships with. Rename this one before approving it.' });
  });
});

describe("the install route", () => {
  const app = (skillHub: SkillHub) => {
    const hono = new Hono();
    hono.use("*", async (c, next) => {
      c.set("principal" as never, { kind: "token", actor: "cli", role: "admin" } as never);
      await next();
    });
    registerSkillHubRoutes(hono as never, { skillHub, registry: { get: (id: string) => (id === "nouva" ? {} : undefined) } } as never);
    return hono;
  };
  const install = (hono: Hono, body: unknown) =>
    hono.request("/skills/hub/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("an agent installing through its `nouride` tool is credited and held to the cap; an unknown name is not trusted", async () => {
    const { skillHub, drafts } = hub();
    const hono = app(skillHub);
    const byAgent = (await (await install(hono, { ref: "o/r/skills/pdf", agentId: "nouva", gatewayId: "telegram:nouva", chatId: "1" })).json()) as { drafts: { id: string }[] };
    expect(drafts.get(byAgent.drafts[0]!.id)).toMatchObject({ agentId: "nouva", gatewayId: "telegram:nouva", chatId: "1" });

    const spoofed = (await (await install(hono, { ref: "o/r/skills/notes", agentId: "ghost" })).json()) as { drafts: { id: string }[] };
    expect(drafts.get(spoofed.drafts[0]!.id)!.agentId).toBe("cli");
  });
});

describe("agents know where to look", () => {
  test("an agent that may write a skill may look for one, with no edit to its pack", async () => {
    const { resolveToolset } = await import("@/modules/tools/registry.ts");
    const { fakeAgent } = await import("../helpers.ts");
    const stub = (name: string) => [name, { definition: { name, description: "", parameters: { type: "object", properties: {} } }, requiresApproval: false, execute: async () => ({ content: "", isError: false }) }] as const;
    const registry = new Map([stub("read"), stub("skill_create"), stub("skill_search"), stub("skill_install")]) as never;
    const security = { toolTimeoutMs: 1, toolMaxOutputBytes: 1, exec: { mode: "full", ask: "off", allowed: [], blocked: [], ceiling: "full" } } as never;
    const pack = (enabled: string[]) => fakeAgent({ config: { tools: { enabled, approvalRequired: [], blocked: [] } } as never });

    const writer = resolveToolset(pack(["read", "skill_create"]), registry, security).definitions.map((d) => d.name);
    expect(writer).toEqual(expect.arrayContaining(["skill_search", "skill_install"]));
    const reader = resolveToolset(pack(["read"]), registry, security).definitions.map((d) => d.name);
    expect(reader).not.toContain("skill_search");
  });

  test("the prompt says to look on the hubs first, in the words for the tools the agent has", async () => {
    const { renderSkillPolicy } = await import("@/modules/llm/prompt/harness-skills.ts");
    const { fakeAgent } = await import("../helpers.ts");
    const ctx = (tools: string[]) => ({ ctx: { agent: { ...fakeAgent(), skills: [] }, gateway: "web", tools: tools.map((name) => ({ name })) } }) as never;
    expect(renderSkillPolicy(ctx(["skill_search", "skill_install"])).join("\n")).toContain("`skill_search`, then `skill_install`");
    expect(renderSkillPolicy(ctx(["nouride"])).join("\n")).toContain("`nouride skills search <words>`");
    expect(renderSkillPolicy(ctx(["read"]))).toEqual([]);
  });
});

describe("Explore before a search", () => {
  test("the most downloaded skills on ClawHub, kept an hour — opening the tab again asks nobody", async () => {
    const { skillHub, seen } = hub();
    const hits = await skillHub.popular();
    expect(hits.map((hit) => [hit.ref, hit.installs])).toEqual([["clawhub:p/self-improving-agent", 486325], ["clawhub:s/github", undefined]]);
    await skillHub.popular();
    expect(seen.filter((url) => url.includes("sort=downloads"))).toHaveLength(1);
  });

  test("a hub that does not answer is not kept: the next open asks again", async () => {
    const popular = { down: true };
    const { skillHub, seen } = hub({ popular });
    await expect(skillHub.popular()).rejects.toThrow();
    popular.down = false;
    expect(await skillHub.popular()).toHaveLength(2);
    expect(seen.filter((url) => url.includes("sort=downloads"))).toHaveLength(2);
  });
});

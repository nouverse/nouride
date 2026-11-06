/**
 * An external agent's Nouride skills reach its CLI (0.8.1): copied into the CLI's skills folder in the agent's own
 * folder, so the Skills tab means the same for it as for any agent. Written only when they changed; a skill switched off
 * is taken out; a skill the person put there themselves is never touched.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import type { LoadedAgent } from "@nouride/shared";
import { runCommand } from "@nouride/runtime";
import { privateWorkspace } from "@nouride/persona";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { syncSkills } from "@/modules/external-agents/skills.ts";
import { eventually } from "../wait.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ROW = { id: "fake", name: "Fake CLI", skillsDir: ".claude/skills" } as CliRow;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "external-skills-"));
  dirs.push(dir);
  const skill = (name: string) => {
    mkdirSync(join(dir, "pool", name, "references"), { recursive: true });
    writeFileSync(join(dir, "pool", name, "SKILL.md"), `---\nname: ${name}\n---\nDo ${name}.\n`);
    writeFileSync(join(dir, "pool", name, "references", "more.md"), `More on ${name}.\n`);
    return { name, description: name, path: join(dir, "pool", name, "SKILL.md") };
  };
  const folder = join(dir, "private");
  mkdirSync(join(folder, ".claude", "skills", "mine"), { recursive: true });
  writeFileSync(join(folder, ".claude", "skills", "mine", "SKILL.md"), "The person's own.\n");
  const runs: string[][] = [];
  const run: typeof runCommand = (cmd, opts) => (runs.push(cmd), runCommand(cmd, { ...opts, agent: undefined }));
  // Its Nouride tools: `send_file` is one a CLI is lent; `nouride` one it is not.
  const agent = (skills: ReturnType<typeof skill>[]) => ({ config: { id: "coder", tools: { enabled: ["send_file", "nouride"] } }, skills }) as unknown as LoadedAgent;
  return { folder, skill, run, runs, agent };
}

describe("an external agent's skills in its CLI", () => {
  test("are copied whole where the CLI reads a project's, once, and the person's own are left alone", async () => {
    const { folder, skill, run, runs, agent } = setup();
    const skills = [skill("deploy"), skill("review")];
    await syncSkills(agent(skills), ROW, folder, run);
    expect(readFileSync(join(folder, ".claude/skills/deploy/SKILL.md"), "utf8")).toContain("Do deploy.");
    expect(readFileSync(join(folder, ".claude/skills/review/references/more.md"), "utf8")).toBe("More on review.\n");
    const writes = runs.length;
    await syncSkills(agent(skills), ROW, folder, run);
    expect(runs.length).toBe(writes);
    // Switched off: taken out, and only it — a skill that did not change is not taken out and written again, which a
    // CLI watching the folder saw as gone meanwhile (the full suite caught the deploy skill missing). The person's own: kept.
    const unchanged = statSync(join(folder, ".claude/skills/deploy/SKILL.md")).ino;
    await syncSkills(agent([skills[0]!]), ROW, folder, run);
    expect(statSync(join(folder, ".claude/skills/deploy/SKILL.md")).ino).toBe(unchanged);
    expect(existsSync(join(folder, ".claude/skills/review"))).toBe(false);
    expect(existsSync(join(folder, ".claude/skills/deploy/SKILL.md"))).toBe(true);
    expect(readFileSync(join(folder, ".claude/skills/mine/SKILL.md"), "utf8")).toBe("The person's own.\n");
  });

  test("a file edited inside a skill — not its SKILL.md — is copied again", async () => {
    // Its folder's and its SKILL.md's ages were what said it changed: an edit in references/ never reached the CLI.
    const { folder, skill, run, agent } = setup();
    const review = skill("review");
    await syncSkills(agent([review]), ROW, folder, run);
    writeFileSync(join(review.path, "..", "references", "more.md"), "More on review, edited.\n");
    await syncSkills(agent([review]), ROW, folder, run);
    expect(readFileSync(join(folder, ".claude/skills/review/references/more.md"), "utf8")).toBe("More on review, edited.\n");
  });

  test("not a skill that needs a tool the CLI neither has nor is lent (0.8.1, the live box)", async () => {
    // Nix was given the nouride skill, which sends it to the `nouride` tool — not one a CLI has, nor is lent.
    const { folder, skill, run, agent } = setup();
    const cli = { ...skill("nouride"), needsTools: ["exec", "nouride"] };
    const deploy = { ...skill("deploy"), needsTools: ["exec", "read", "send_file"] };
    await syncSkills(agent([cli, deploy]), ROW, folder, run);
    expect(existsSync(join(folder, ".claude/skills/nouride"))).toBe(false);
    expect(existsSync(join(folder, ".claude/skills/deploy/SKILL.md"))).toBe(true);
  });

  test("a link in a skill is copied as a link, not read as a file — and the skill not left out (0.8.1, the live box)", async () => {
    // x-twitter-poster links node_modules/playwright to the box's own; read as a file it was a folder, and the whole
    // skill was skipped as unreadable.
    const { folder, skill, run, agent } = setup();
    const poster = skill("poster");
    const shared = join(folder, "..", "global-playwright");
    mkdirSync(shared, { recursive: true });
    mkdirSync(join(poster.path, "..", "tools", "node_modules"), { recursive: true });
    symlinkSync(shared, join(poster.path, "..", "tools", "node_modules", "playwright"));
    expect(await syncSkills(agent([poster]), ROW, folder, run)).toEqual([]);
    expect(readlinkSync(join(folder, ".claude/skills/poster/tools/node_modules/playwright"))).toBe(shared);
    expect(readFileSync(join(folder, ".claude/skills/poster/SKILL.md"), "utf8")).toContain("Do poster.");
  });

  test("its list of what Nouride copied, made a link, is not read through: the copy is refused, nothing else read (0.8.1)", async () => {
    const { folder, skill, run, agent } = setup();
    const elsewhere = join(folder, "..", "elsewhere.txt");
    writeFileSync(elsewhere, "not the agent's\n");
    symlinkSync(elsewhere, join(folder, ".claude/skills/.nouride-skills"));
    await expect(syncSkills(agent([skill("deploy")]), ROW, folder, run)).rejects.toThrow("is a link");
    expect(readFileSync(elsewhere, "utf8")).toBe("not the agent's\n");
  });

  test("a CLI that reads no project skills gets none", async () => {
    const { folder, skill, run, runs, agent } = setup();
    await syncSkills(agent([skill("deploy")]), { ...ROW, skillsDir: undefined } as CliRow, folder, run);
    expect(runs).toEqual([]);
  });

  test("a skill it cannot read is left out and named; the others are still copied (0.8.1, the live box)", async () => {
    // A skill an agent made was the daemon's alone to read (750): copying as the agent stopped every other skill too.
    const { folder, skill, run, agent } = setup();
    const locked = skill("locked");
    chmodSync(join(locked.path, ".."), 0o000);
    try {
      expect(await syncSkills(agent([locked, skill("deploy")]), ROW, folder, run)).toEqual(["locked"]);
      expect(readFileSync(join(folder, ".claude/skills/deploy/SKILL.md"), "utf8")).toContain("Do deploy.");
    } finally {
      chmodSync(join(locked.path, ".."), 0o755);
    }
  });

  test("a skill whose folder went since the agent loaded is taken out, not named as one it could not read (0.8.8, the live box)", async () => {
    // Three skill drafts approved one after another: each reloaded every pack, and a reload's copy that waited behind the
    // one before still held github-pr, archived by a merge meanwhile — "could not read some skills" for each CLI agent.
    const { folder, skill, run, agent } = setup();
    const [deploy, merged] = [skill("deploy"), skill("github-pr")];
    await syncSkills(agent([deploy, merged]), ROW, folder, run);
    expect(existsSync(join(folder, ".claude/skills/github-pr/SKILL.md"))).toBe(true);
    renameSync(join(merged.path, ".."), join(folder, "..", "archived-github-pr"));
    expect(await syncSkills(agent([deploy, merged]), ROW, folder, run)).toEqual([]);
    expect(existsSync(join(folder, ".claude/skills/github-pr"))).toBe(false);
    expect(readFileSync(join(folder, ".claude/skills/.nouride-skills"), "utf8")).not.toContain("github-pr");
    expect(readFileSync(join(folder, ".claude/skills/deploy/SKILL.md"), "utf8")).toContain("Do deploy.");
  });

  test("a project's skills from its skill_roots reach the CLI too, and one named like the agent's own stays the agent's (0.8.9)", async () => {
    // A CLI works in its own folder, not the repository: Nix's pack could name /opt/projects/nouride and the repo's
    // testing skill still never reached it.
    const { folder, skill, run, agent } = setup();
    const repo = join(folder, "..", "repo", ".agents", "skills");
    const project = (name: string, body: string) => {
      mkdirSync(join(repo, name), { recursive: true });
      writeFileSync(join(repo, name, "SKILL.md"), `---\nname: ${name}\n---\n${body}\n`);
      return { name, description: name, path: join(repo, name, "SKILL.md"), scope: "project" as const };
    };
    const own = skill("deploy");
    await syncSkills(agent([own]), ROW, folder, run, [project("repo-testing", "The repo's testing."), project("deploy", "Deploy however the repository says.")]);
    expect(readFileSync(join(folder, ".claude/skills/repo-testing/SKILL.md"), "utf8")).toContain("The repo's testing.");
    expect(readFileSync(join(folder, ".claude/skills/deploy/SKILL.md"), "utf8")).toContain("Do deploy.");
    // Gone from the project, gone from the CLI, at the next copy.
    await syncSkills(agent([own]), ROW, folder, run, []);
    expect(existsSync(join(folder, ".claude/skills/repo-testing"))).toBe(false);
  });
});

describe("an external agent's skills when its pack reloads", () => {
  test("are copied as it reloads, into its CLI's profile — a skill switched off is out before the next message", async () => {
    // The Skills tab reloads the pack; the copy waited for the next message, and Claude Code, which watches its skills
    // folder, could take that message with the list from before. And they went to the agent's folder's .claude/skills,
    // which Claude Code never read: that folder is the agent's HOME, where it reads no project skills (on the live box,
    // its log said `project=[]`). Its profile's skills folder is read wherever it works.
    const { skill } = setup();
    const dir = mkdtempSync(join(tmpdir(), "external-skills-host-"));
    dirs.push(dir);
    const folder = privateWorkspace(dir, "coder");
    const profile = join(folder, ".cli", "fake", "work");
    mkdirSync(profile, { recursive: true });
    const row = { ...ROW, skillsDir: "skills", profileEnv: "FAKE_HOME" } as CliRow;
    const service = new ExternalAgents({ rows: () => [row], workspaceDir: () => dir, secretsFor: () => ({}), sessions: { load: () => ({}), save: () => {} } });
    const agent = (skills: ReturnType<typeof skill>[]) => ({ config: { id: "coder", external: { cli: "fake", profile: "work" }, tools: { enabled: [] } }, skills }) as unknown as LoadedAgent;
    const [deploy, review] = [skill("deploy"), skill("review")];
    service.reloaded(agent([deploy, review]));
    await eventually(() => existsSync(join(profile, "skills/review/SKILL.md")), 4_000, "the skills copied into the profile");
    service.reloaded(agent([deploy]));
    await eventually(() => !existsSync(join(profile, "skills/review")), 4_000, "the skill switched off taken out");
    expect(readFileSync(join(profile, "skills/deploy/SKILL.md"), "utf8")).toContain("Do deploy.");
    expect(existsSync(join(folder, ".claude"))).toBe(false);
  });

  test("with the skills its skill_roots bring, read at each copy", async () => {
    const { skill } = setup();
    const dir = mkdtempSync(join(tmpdir(), "external-skills-host-"));
    dirs.push(dir);
    const folder = privateWorkspace(dir, "coder");
    const profile = join(folder, ".cli", "fake", "work");
    mkdirSync(profile, { recursive: true });
    const row = { ...ROW, skillsDir: "skills", profileEnv: "FAKE_HOME" } as CliRow;
    let project = [{ ...skill("repo-testing"), scope: "project" as const }];
    const service = new ExternalAgents({
      rows: () => [row], workspaceDir: () => dir, secretsFor: () => ({}), sessions: { load: () => ({}), save: () => {} },
      projectSkills: async () => project,
    });
    const agent = { config: { id: "coder", external: { cli: "fake", profile: "work" }, tools: { enabled: [] } }, skills: [skill("deploy")] } as unknown as LoadedAgent;
    service.reloaded(agent);
    await eventually(() => existsSync(join(profile, "skills/repo-testing/SKILL.md")), 4_000, "the project's skill copied into the profile");
    expect(existsSync(join(profile, "skills/deploy/SKILL.md"))).toBe(true);
    project = [];
    await service.syncSkills(agent, row);
    expect(existsSync(join(profile, "skills/repo-testing"))).toBe(false);
  });
});

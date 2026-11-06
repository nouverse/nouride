/**
 * The weekly review of the skill library (`reflection/curator.ts`): what grew or names this environment is tightened,
 * what covers one subject is merged, what nobody reads is archived — each a draft that waits, and approving one does
 * what it says.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { LLMProvider, SkillLearningSection } from "@nouride/shared";
import { skillsDirFor, writeNewSkill, type AgentRegistry } from "@nouride/persona";
import { migrate } from "@/db/index.ts";
import type { AuditEntry, AuditPort } from "@/commons/audit.store.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import { DraftStore, ReflectionEngine, ReviewStore, ToolMemory } from "@/modules/reflection/index.ts";
import { fakeAgent } from "../helpers.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-review-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.UTC(2026, 9, 23);
const DAY = 86_400_000;
const LEARNING: SkillLearningSection = { mode: "ask", model: "", notifyChat: false };
const procedure = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. Step ${i + 1}: check the service and restart it when it is stuck.`).join("\n");

/** An engine over a pool, a provider that answers the merge question with `merge` and every rewrite with a short body. */
/** `watchedSince`: when the skills' reads began to be kept — long ago unless a test says otherwise. */
async function library(options: { merge?: unknown; rewritten?: string; read?: Record<string, number>; watchedSince?: number } = {}) {
  const db: SqliteDb = openDatabase(join(tempDir(), "nouride.db"));
  migrate(db);
  const agentsDir = tempDir();
  const drafts = new DraftStore(db, () => NOW);
  const reviews = new ReviewStore(db, () => clock.now);
  const clock = { now: NOW };
  const asked = { merge: 0, rewrite: 0 };
  const provider = {
    async chat(request: { messages: { content: string }[] }) {
      const instruction = request.messages[0]?.content ?? "";
      const merge = instruction.includes("You review a library of skills");
      if (merge) asked.merge += 1;
      else asked.rewrite += 1;
      const text = merge
        ? JSON.stringify({ merge: options.merge ?? [] })
        : JSON.stringify({ description: "", requires: "", body: options.rewritten ?? "## Procedure\n1. Check the service.\n2. Restart it when it is stuck." });
      return { text, toolCalls: [], stopReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;
  const agent = fakeAgent();
  const config = { ...LEARNING };
  const audited: AuditEntry[] = [];
  const engine = new ReflectionEngine({
    config,
    drafts,
    toolMemory: new ToolMemory(db, () => NOW),
    reviews,
    lastRead: (paths) =>
      new Map(
        paths.map((path) => {
          const read = Object.entries(options.read ?? {}).find(([name]) => path.includes(`/${name}/`));
          return [path, { readAt: read?.[1] ?? null, since: options.watchedSince ?? Date.UTC(2026, 0, 1) }] as const;
        }),
      ),
    registry: { get: (id: string) => (id === agent.config.id ? agent : undefined), enabled: () => [agent], reloadAll: async () => {} } as unknown as AgentRegistry,
    providers: { get: () => provider } as unknown as ProviderRegistry,
    agentsDir,
    audit: { record: (entry: AuditEntry) => void audited.push(entry) } as unknown as AuditPort,
    now: () => clock.now,
  });
  const skill = (name: string, body: string, extra: { author?: string; created?: string; description?: string } = {}) =>
    writeNewSkill(agentsDir, { name, description: extra.description ?? `Use when ${name} is needed.`, body, ...(extra.author === undefined ? { author: "nouva" } : extra.author ? { author: extra.author } : {}), created: extra.created ?? "2026-10-20" });
  return { engine, config, drafts, reviews, agentsDir, asked, clock, audited, skill, path: (name: string) => join(skillsDirFor(agentsDir), name, "SKILL.md") };
}

describe("what the review proposes", () => {
  test("a body past the limit is tightened — shorter, and waiting for a person", async () => {
    const h = await library();
    await h.skill("home-pc-ops", procedure(300));
    const report = await h.engine.library.run();
    expect(report).toMatchObject({ tighten: ["home-pc-ops"], merge: [], archive: [] });
    const [draft] = h.drafts.pending();
    expect(draft).toMatchObject({ name: "home-pc-ops", target: "home-pc-ops", triggerKind: "curation", retire: [] });
    expect(draft!.body.length).toBeLessThan(procedure(300).length);
  });

  test("a skill naming a machine's address is tightened too, whatever its size", async () => {
    const h = await library();
    await h.skill("pc-streaming", "1. ssh to 172.16.42.7 and start the streaming service");
    expect((await h.engine.library.run() as { tighten: string[] }).tighten).toEqual(["pc-streaming"]);
  });

  test("skills covering one subject are merged into one, the others named to archive on approval", async () => {
    const h = await library({ merge: [{ into: "deployment", skills: ["deployment-docker", "deployment-k8s"], why: "one subject" }] });
    for (const name of ["deployment", "deployment-docker", "deployment-k8s"]) await h.skill(name, procedure(3));
    const report = await h.engine.library.run();
    expect(report).toMatchObject({ merge: [{ into: "deployment", retire: ["deployment-docker", "deployment-k8s"] }] });
    expect(h.drafts.pending()[0]).toMatchObject({ name: "deployment", target: "deployment", retire: ["deployment-docker", "deployment-k8s"] });
  });

  test("a skill nobody read in 45 days, and older than that, is proposed for the archive — with no model call", async () => {
    const h = await library({ read: { "fresh-and-read": NOW - DAY } });
    await h.skill("audit-one-workbook", procedure(3), { created: "2026-08-01" });
    await h.skill("fresh-and-read", procedure(3), { created: "2026-08-01" });
    await h.skill("new-this-week", procedure(3), { created: "2026-10-20" });
    const report = await h.engine.library.run();
    expect(report).toMatchObject({ archive: ["audit-one-workbook"], tighten: [] });
    expect(h.asked.rewrite).toBe(0);
    expect(h.drafts.pending()[0]).toMatchObject({ name: "audit-one-workbook", retire: ["audit-one-workbook"] });
  });

  test("a skill whose reads have been kept for less than 45 days is not archived, however old it is", async () => {
    // The first review on a live box: the audit log kept 14 days, and "no read in it" was taken for "none in 45".
    const h = await library({ watchedSince: NOW - 14 * DAY });
    await h.skill("monthly-report", procedure(3), { created: "2026-06-01" });
    expect(await h.engine.library.run()).toMatchObject({ archive: [] });
    h.clock.now = NOW + 32 * DAY;
    expect(await h.engine.library.run()).toMatchObject({ archive: ["monthly-report"] });
    expect(h.drafts.pending()[0]?.triggerReason).toContain("not read since 2026-10-09");
  });

  test("a person's skill is theirs: never tightened, merged or archived", async () => {
    const h = await library();
    await h.skill("hand-written", procedure(300), { author: "", created: "2026-01-01" });
    expect(await h.engine.library.run()).toEqual({ tighten: [], merge: [], archive: [], declined: [] });
  });

  test("a rewrite that is not shorter is refused, and nothing waits", async () => {
    const h = await library({ rewritten: procedure(400) });
    await h.skill("home-pc-ops", procedure(300));
    const report = await h.engine.library.run();
    expect(report).toMatchObject({ tighten: [], declined: [{ skill: "home-pc-ops" }] });
    expect(h.drafts.pending()).toEqual([]);
  });
});

describe("approving what it proposed", () => {
  test("an archive moves the skill out of the pool and writes nothing", async () => {
    const h = await library();
    await h.skill("audit-one-workbook", procedure(3), { created: "2026-08-01" });
    await h.engine.library.run();
    const outcome = await h.engine.approve(h.drafts.pending()[0]!.id, "gading");
    expect(outcome.ok).toBe(true);
    expect(existsSync(h.path("audit-one-workbook"))).toBe(false);
    expect(existsSync(join(skillsDirFor(h.agentsDir), ".archive", "audit-one-workbook", "SKILL.md"))).toBe(true);
    // The audit row says what left the pool, not a skill name beside an empty path.
    expect(h.audited.find((entry) => entry.action === "skill_draft_updated")?.details).toMatchObject({ archived: ["audit-one-workbook"] });
  });

  test("a merge rewrites the one kept and archives the others", async () => {
    const h = await library({ merge: [{ into: "deployment", skills: ["deployment-docker"], why: "one subject" }] });
    for (const name of ["deployment", "deployment-docker"]) await h.skill(name, procedure(3));
    await h.engine.library.run();
    expect((await h.engine.approve(h.drafts.pending()[0]!.id, "gading")).ok).toBe(true);
    expect(readFileSync(h.path("deployment"), "utf8")).toContain("Restart it when it is stuck");
    expect(existsSync(h.path("deployment-docker"))).toBe(false);
    expect(existsSync(join(skillsDirFor(h.agentsDir), ".archive", "deployment-docker"))).toBe(true);
    expect(h.audited.find((entry) => entry.action === "skill_draft_updated")?.details).toMatchObject({ skill: "deployment", archived: ["deployment-docker"] });
  });
});

describe("when it runs", () => {
  test("once a week, and never while learning is off", async () => {
    const h = await library();
    await h.skill("home-pc-ops", procedure(300));
    expect(await h.engine.library.reviewIfDue()).not.toBeNull();
    h.clock.now += 6 * DAY;
    expect(await h.engine.library.reviewIfDue()).toBeNull();
    h.clock.now += 2 * DAY;
    expect(await h.engine.library.reviewIfDue()).not.toBeNull();
    expect(h.reviews.last()?.ranAt).toBe(h.clock.now);
    h.config.mode = "off";
    h.clock.now += 8 * DAY;
    expect(await h.engine.library.reviewIfDue()).toBeNull();
  });
});

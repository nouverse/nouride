/**
 * What the reflection pass may write, checked in code (0.7.28): a new kind of work waits for a second conversation, a
 * draft that names this environment or tells a session is refused, a body past its size is tightened rather than
 * grown, and a new skill is on for the agent whose work it came from.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { LLMProvider, SkillLearningSection } from "@nouride/shared";
import { agentSkillPool, skillsDirFor, writeNewSkill, type AgentRegistry } from "@nouride/persona";
import { migrate } from "@/db/index.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import { CandidateStore, DraftStore, ReflectionEngine, ToolMemory } from "@/modules/reflection/index.ts";
import { BODY_CHARS, draftRefusal, NEW_BODY_CHARS } from "@/modules/reflection/draft-lint.ts";
import { fakeAgent } from "../helpers.ts";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-gates-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): SqliteDb {
  const db = openDatabase(join(tempDir(), "nouride.db"));
  migrate(db);
  return db;
}

const LEARNING: SkillLearningSection = { mode: "ask", model: "", notifyChat: false };
// No cooldown: these tests look twice in a row on purpose.
const TUNING = { minToolFailures: 2, cooldownMs: 0, maxPending: 5 };

const create = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ decision: "create", name: "restart-stuck-ingress", description: "Use when the ingress answers 502 after a node reboot.", closest: "none", why_not_update: "n/a", why: "a fix that worked", ...extra });
const SKILL = JSON.stringify({ name: "restart-stuck-ingress", description: "Use when the ingress answers 502 after a node reboot.", requires: "kubectl", body: "## When to Use\n- 502 after a reboot\n\n## Procedure\n1. `kubectl rollout restart deploy/<ingress>`" });

/** An engine whose triage answers `triage` and whose writing call answers `written`, counting each. */
function engine(options: { triage?: string; written?: string } = {}) {
  const db = freshDb();
  const agentsDir = tempDir();
  const drafts = new DraftStore(db, () => 1000);
  let clock = Date.UTC(2026, 9, 22);
  const candidates = new CandidateStore(db, () => clock);
  const asked = { triage: 0, written: 0, prompts: [] as string[] };
  const provider = {
    async chat(request: { messages: { content: string }[] }) {
      const triage = (request.messages[0]?.content ?? "").includes("what should happen to the skill");
      asked.prompts.push(request.messages.map((message) => message.content).join("\n"));
      if (triage) asked.triage += 1;
      else asked.written += 1;
      return { text: triage ? (options.triage ?? create()) : (options.written ?? SKILL), toolCalls: [], stopReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;
  const agent = fakeAgent();
  const reflection = new ReflectionEngine({
    config: LEARNING,
    tuning: TUNING,
    drafts,
    toolMemory: new ToolMemory(db, () => 1000),
    candidates,
    registry: { get: (id: string) => (id === agent.config.id ? agent : undefined), reloadAll: async () => {} } as unknown as AgentRegistry,
    providers: { get: () => provider } as unknown as ProviderRegistry,
    agentsDir,
  });
  return { reflection, drafts, candidates, asked, agentsDir, later: (days: number) => void (clock += days * 86_400_000) };
}

/** Two failed steps and one that worked: a recovery, in conversation `session`. */
const turn = (session: string, userText = "kenapa ingress-nya 502") => ({
  agentId: "nouva",
  gatewayId: "telegram:nouva",
  chatId: "123",
  sessionId: session,
  userText,
  messages: [{ role: "user" as const, content: userText }, { role: "assistant" as const, content: "fixed" }],
  chain: [{ role: "user" as const, content: userText }, { role: "assistant" as const, content: "fixed" }],
  iterations: 2,
  steps: [{ name: "exec", ok: false }, { name: "exec", ok: false }, { name: "exec", ok: true }],
});

describe("a new kind of work waits for a second conversation", () => {
  test("seen once: held as a candidate, and nothing written — not even the body", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    expect(h.drafts.pending()).toEqual([]);
    expect(h.asked).toMatchObject({ triage: 1, written: 0 });
    expect(h.candidates.list().map((held) => held.name)).toEqual(["restart-stuck-ingress"]);
  });

  test("seen in another conversation: the skill is drafted, and the candidate is done with", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    await h.reflection.observe(turn("ses_2"));
    expect(h.drafts.pending().map((draft) => draft.name)).toEqual(["restart-stuck-ingress"]);
    expect(h.candidates.list()).toEqual([]);
    // The second triage was shown what waits, so it could say it was the same work.
    expect(h.asked.prompts.find((prompt) => prompt.includes("Seen once, not skills yet"))).toContain("restart-stuck-ingress");
  });

  test("the same conversation going on is not the work coming back", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    await h.reflection.observe(turn("ses_1"));
    expect(h.drafts.pending()).toEqual([]);
    expect(h.asked.written).toBe(0);
  });

  test("a second sighting under another name counts when the pass says which candidate it is", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    const again = engine({ triage: create({ name: "fix-ingress-after-reboot", recurs: "restart-stuck-ingress" }) });
    // The same database's candidate, through a second engine: what the store holds is what decides.
    again.candidates.hold(h.candidates.list()[0]!);
    await again.reflection.observe(turn("ses_2"));
    expect(again.drafts.pending()).toHaveLength(1);
    expect(again.candidates.list()).toEqual([]);
  });

  test("a person asking for a skill skips the wait", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1", "simpan jadi skill ya cara restart ingress ini"));
    expect(h.drafts.pending()).toHaveLength(1);
    expect(h.candidates.list()).toEqual([]);
  });

  test("a candidate that does not come back in 30 days lapses", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    h.later(31);
    expect(h.candidates.list()).toEqual([]);
  });
});

describe("what a drafted skill may not be", () => {
  const ok = { description: "Use when the ingress answers 502.", body: "## Procedure\n1. restart it", descriptionChanged: true };

  test("a procedure passes", () => {
    expect(draftRefusal(ok)).toBeNull();
  });

  test("a machine's address, a hardware address or an account is this environment's, not a skill's", () => {
    expect(draftRefusal({ ...ok, body: "ssh to 172.16.42.7 first" })).toContain("172.16.42.7");
    expect(draftRefusal({ ...ok, body: "the MAC is 9C:6B:00:8C:1D:13" })).toContain("hardware address");
    expect(draftRefusal({ ...ok, body: "log in as nouva@nouverse.tech" })).toContain("nouva@nouverse.tech");
  });

  test("loopback, documentation ranges and example.com are placeholders, not anybody's machine", () => {
    expect(draftRefusal({ ...ok, body: "curl http://127.0.0.1:18254/health and 192.0.2.10; mail ops@example.com" })).toBeNull();
  });

  test("a session told rather than a procedure written", () => {
    expect(draftRefusal({ ...ok, body: "In this session the restart fixed it." })).toContain("tells a session");
    expect(draftRefusal({ ...ok, body: "The user said to keep stream out of Administrators." })).toContain("tells a session");
  });

  test("a description that says what was changed matches no future task — refused when it is new", () => {
    expect(draftRefusal({ ...ok, description: "Update deployment-docker to target the hub host." })).toContain("what was changed");
    expect(draftRefusal({ ...ok, description: "Document that caffeinate -s only works on AC power." })).toContain("what was changed");
    // An existing skill's description, left as it was, is not this revision's to answer for.
    expect(draftRefusal({ ...ok, description: "Update the thing.", descriptionChanged: false })).toBeNull();
  });

  test("a new body past its size belongs in references/; a revision may grow to the limit", () => {
    expect(draftRefusal({ ...ok, body: "x".repeat(NEW_BODY_CHARS + 1) })).toContain("references/");
    expect(draftRefusal({ ...ok, body: "x".repeat(BODY_CHARS), previousBody: "x".repeat(4_000) })).toBeNull();
    expect(draftRefusal({ ...ok, body: "x".repeat(BODY_CHARS + 1), previousBody: "x".repeat(4_000) })).toContain("references/");
  });

  test("a body already past the limit may only be tightened", () => {
    expect(draftRefusal({ ...ok, body: "x".repeat(20_001), previousBody: "x".repeat(20_000) })).toContain("must tighten it");
    expect(draftRefusal({ ...ok, body: "x".repeat(15_000), previousBody: "x".repeat(20_000) })).toBeNull();
  });
});

describe("a refused draft is not kept", () => {
  test("the pass wrote a host's address: no draft, and the candidate it came from is still done with", async () => {
    const leaky = JSON.stringify({ name: "restart-stuck-ingress", description: "Use when the ingress answers 502.", requires: "", body: "## Procedure\n1. ssh root@172.16.42.8 and restart" });
    const h = engine({ triage: create(), written: leaky });
    await h.reflection.observe(turn("ses_1", "jadiin skill ya"));
    expect(h.drafts.pending()).toEqual([]);
    expect(h.asked.written).toBe(1);
  });
});

describe("a new skill is on for the agent whose work it came from", () => {
  test("approved, it says so in its frontmatter", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1", "simpan jadi skill"));
    const draft = h.drafts.pending()[0]!;
    const outcome = await h.reflection.approve(draft.id, "gading");
    expect(outcome.ok).toBe(true);
    expect(readFileSync(join(skillsDirFor(h.agentsDir), "restart-stuck-ingress", "SKILL.md"), "utf8")).toContain("\nagents: nouva\n");
  });

  test("off for another agent, unless that agent's skills.toml turns it on", async () => {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, { name: "restart-stuck-ingress", description: "Use when the ingress answers 502.", body: "1. restart", author: "nouva", agents: "nouva" });
    await writeNewSkill(agentsDir, { name: "everyones", description: "Use when anybody needs it.", body: "1. do it" });
    const on = async (agent: string, states: Record<string, boolean> = {}) =>
      (await agentSkillPool({ poolDir: skillsDirFor(agentsDir), states, agent })).filter((skill) => skill.enabled).map((skill) => skill.name);
    expect(await on("nouva")).toEqual(["everyones", "restart-stuck-ingress"]);
    expect(await on("nix")).toEqual(["everyones"]);
    expect(await on("nix", { "restart-stuck-ingress": true })).toEqual(["everyones", "restart-stuck-ingress"]);
    // And its own author can still switch it off.
    expect(await on("nouva", { "restart-stuck-ingress": false })).toEqual(["everyones"]);
  });
});

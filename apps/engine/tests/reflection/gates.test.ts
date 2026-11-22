/**
 * What the reflection pass may write, checked in code (0.7.28): a new kind of work waits until it comes back (in
 * another conversation, in the same chat after a break, or at its third sighting), a draft that names this
 * environment or tells a session is refused, a body past its size is tightened rather than grown, and a new skill is on for the agent whose work it
 * came from. A refused draft goes back to its writer once, a revision answers for what it adds, and a skill refused
 * twice is left alone a while.
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
import { refusedNote } from "@/modules/reflection/synthesis.ts";
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

/**
 * An engine whose triage answers `triage` and whose writing call answers `written`, counting each. `written` as a
 * list answers one writing call after another, its last entry from then on. `agentsDir` is a pool made beforehand.
 */
function engine(options: { triage?: string; written?: string | string[]; agentsDir?: string; refusedRestMs?: number } = {}) {
  const db = freshDb();
  const agentsDir = options.agentsDir ?? tempDir();
  const drafts = new DraftStore(db, () => 1000);
  let clock = Date.UTC(2026, 9, 22);
  const candidates = new CandidateStore(db, () => clock);
  const asked = { triage: 0, written: 0, prompts: [] as string[] };
  const answers = Array.isArray(options.written) ? options.written : [options.written ?? SKILL];
  const provider = {
    async chat(request: { messages: { content: string }[] }) {
      const triage = (request.messages[0]?.content ?? "").includes("what should happen to the skill");
      asked.prompts.push(request.messages.map((message) => message.content).join("\n"));
      if (triage) asked.triage += 1;
      else asked.written += 1;
      return { text: triage ? (options.triage ?? create()) : answers[Math.min(asked.written, answers.length) - 1]!, toolCalls: [], stopReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;
  const agent = fakeAgent();
  const reflection = new ReflectionEngine({
    config: LEARNING,
    tuning: { ...TUNING, ...(options.refusedRestMs !== undefined ? { refusedRestMs: options.refusedRestMs } : {}) },
    drafts,
    now: () => clock,
    toolMemory: new ToolMemory(db, () => 1000),
    candidates,
    registry: { get: (id: string) => (id === agent.config.id ? agent : undefined), reloadAll: async () => {} } as unknown as AgentRegistry,
    providers: { get: () => provider } as unknown as ProviderRegistry,
    agentsDir,
  });
  return { reflection, drafts, candidates, asked, agentsDir, later: (days: number) => void (clock += days * 86_400_000), hours: (hours: number) => void (clock += hours * 3_600_000) };
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

describe("a new kind of work waits until it comes back", () => {
  test("seen once: held as a candidate, and nothing written — not even the body", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    expect(h.drafts.pending()).toEqual([]);
    expect(h.asked).toMatchObject({ triage: 1, written: 0 });
    expect(h.candidates.list().map((held) => held.name)).toEqual(["restart-stuck-ingress"]);
    // What the page is told of it: seen once, so its next sighting writes nothing unless the work came back.
    expect(h.reflection.candidates().map((held) => held.next)).toEqual([false]);
  });

  test("seen in another conversation: the skill is drafted, and the candidate is done with", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    await h.reflection.observe(turn("ses_2"));
    expect(h.drafts.pending().map((draft) => draft.name)).toEqual(["restart-stuck-ingress"]);
    expect(h.candidates.list()).toEqual([]);
    // The second triage was shown what waits, so it could say it was the same work.
    expect(h.asked.prompts.find((prompt) => prompt.includes("Seen before, not skills yet"))).toContain("restart-stuck-ingress");
  });

  test("the same sitting going on is not the work coming back", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    h.hours(5);
    await h.reflection.observe(turn("ses_1"));
    expect(h.drafts.pending()).toEqual([]);
    expect(h.asked.written).toBe(0);
  });

  // A chat is one conversation for as long as the install lives: on a live box one class of work was held twelve
  // times in a week of one chat, and no skill came of it.
  test("the same chat after a break is the work coming back: the skill is drafted", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    h.hours(7);
    await h.reflection.observe(turn("ses_1"));
    expect(h.drafts.pending().map((draft) => draft.name)).toEqual(["restart-stuck-ingress"]);
    expect(h.candidates.list()).toEqual([]);
  });

  test("the break is counted from when the work was last seen, not first", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    h.hours(4);
    await h.reflection.observe(turn("ses_1"));
    // Eight hours after the first sighting and four after the last: no break yet, and only the second sighting.
    expect(h.drafts.pending()).toEqual([]);
    expect(h.candidates.list().map((held) => held.sightings)).toEqual([2]);
    // Seen twice: the page says its next sighting writes the skill.
    expect(h.reflection.candidates().map((held) => held.next)).toEqual([true]);
  });

  // The day the break rule shipped: one class of work seen five times in one chat, the widest gap five hours forty, and
  // held five times. Each sighting moved the clock, so a person who works in one chat all day never got the skill.
  test("the third sighting is written, break or none: three looks naming one class are the work coming back", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    h.hours(1);
    await h.reflection.observe(turn("ses_1"));
    expect(h.drafts.pending()).toEqual([]);
    expect(h.asked.written).toBe(0);
    h.hours(1);
    await h.reflection.observe(turn("ses_1"));
    expect(h.drafts.pending().map((draft) => draft.name)).toEqual(["restart-stuck-ingress"]);
    expect(h.candidates.list()).toEqual([]);
  });

  test("the pass is told the rule in those words", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1"));
    await h.reflection.observe(turn("ses_1"));
    expect(h.asked.prompts[0]).toContain("in another conversation or in this one after a break, or is seen a");
    expect(h.asked.prompts[0]).toContain("third time, and is written then");
    expect(h.asked.prompts[1]).toContain("Seen before, not skills yet (each is written when the same kind of work comes back)");
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

const LEAKY = JSON.stringify({ name: "restart-stuck-ingress", description: "Use when the ingress answers 502.", requires: "", body: "## Procedure\n1. ssh root@172.16.42.8 and restart" });

describe("a refused draft goes back to its writer once", () => {
  test("told why, the writer puts it right: the second draft is kept", async () => {
    const h = engine({ written: [LEAKY, SKILL] });
    await h.reflection.observe(turn("ses_1", "jadiin skill ya"));
    expect(h.drafts.pending().map((draft) => draft.body)).toEqual([JSON.parse(SKILL).body]);
    expect(h.asked.written).toBe(2);
    // The second call carries the refused answer and the reason, and asks for that one thing.
    const second = h.asked.prompts.at(-1)!;
    expect(second).toContain("The daemon refused the draft you wrote for this: it names a machine's address (172.16.42.8)");
    expect(second).toContain("ssh root@172.16.42.8 and restart");
    expect(second).toContain("with that put right and everything else kept");
  });

  test("a draft that passes is not asked for twice", async () => {
    const h = engine();
    await h.reflection.observe(turn("ses_1", "jadiin skill ya"));
    expect(h.asked.written).toBe(1);
    expect(h.drafts.pending()).toHaveLength(1);
  });

  test("refused again: no draft, and no third call", async () => {
    const h = engine({ written: LEAKY });
    await h.reflection.observe(turn("ses_1", "jadiin skill ya"));
    expect(h.drafts.pending()).toEqual([]);
    expect(h.asked.written).toBe(2);
  });

  test("a second answer that is not a skill at all leaves the first refusal standing", async () => {
    const h = engine({ written: [LEAKY, "sorry, I cannot"] });
    await h.reflection.observe(turn("ses_1", "jadiin skill ya"));
    expect(h.drafts.pending()).toEqual([]);
    expect(h.asked.written).toBe(2);
  });

  test("the note names a placeholder for a fact and references/ for a long body", () => {
    const note = refusedNote("{}", "its body is 12,838 characters, past 12,000");
    expect(note).toContain("its body is 12,838 characters, past 12,000");
    expect(note).toContain("becomes a placeholder");
    expect(note).toContain("gives its detail to a file under `references/`");
  });
});

describe("a class whose draft was refused is still a candidate", () => {
  test("seen again and refused twice: the candidate stays, and the next sighting writes it", async () => {
    const h = engine({ written: [LEAKY, LEAKY, SKILL], refusedRestMs: 0 });
    await h.reflection.observe(turn("ses_1"));
    await h.reflection.observe(turn("ses_2"));
    expect(h.drafts.pending()).toEqual([]);
    expect(h.candidates.list().map((held) => held.name)).toEqual(["restart-stuck-ingress"]);
    await h.reflection.observe(turn("ses_3"));
    expect(h.drafts.pending()).toHaveLength(1);
    expect(h.candidates.list()).toEqual([]);
  });
});

describe("a skill whose draft was refused is left alone a while", () => {
  test("no writing call is paid for it inside the rest, and one is after it", async () => {
    const h = engine({ written: [LEAKY, LEAKY, SKILL] });
    await h.reflection.observe(turn("ses_1"));
    await h.reflection.observe(turn("ses_2"));
    expect(h.asked.written).toBe(2);
    h.hours(1);
    await h.reflection.observe(turn("ses_3"));
    expect(h.asked).toMatchObject({ triage: 3, written: 2 });
    h.hours(6);
    await h.reflection.observe(turn("ses_4"));
    expect(h.asked.written).toBe(3);
    expect(h.drafts.pending()).toHaveLength(1);
  });

  test("a revision of it is not paid for inside the rest either", async () => {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, { name: "site-contributing", description: "Use when changing the site.", body: "1. Run the build.", author: "nouva" });
    const leaky = JSON.stringify({ description: "Use when changing the site.", requires: "", body: "1. Run the build.\n2. ssh root@172.16.42.8" });
    const h = engine({ agentsDir, triage: JSON.stringify({ decision: "update", target: "site-contributing", why: "a step was missing" }), written: leaky });
    await h.reflection.observe(turn("ses_1"));
    expect(h.asked.written).toBe(2);
    h.hours(1);
    await h.reflection.observe(turn("ses_1"));
    expect(h.asked).toMatchObject({ triage: 2, written: 2 });
    h.hours(6);
    await h.reflection.observe(turn("ses_1"));
    expect(h.asked.written).toBe(4);
  });

  test("a person asking for it is not held", async () => {
    const h = engine({ written: [LEAKY, LEAKY, SKILL] });
    await h.reflection.observe(turn("ses_1"));
    await h.reflection.observe(turn("ses_2"));
    await h.reflection.observe(turn("ses_3", "simpan jadi skill ya"));
    expect(h.drafts.pending()).toHaveLength(1);
  });
});

describe("a revision answers for what it adds", () => {
  const kept = "## Procedure\n1. commit as dev@nouverse.tech from 172.16.42.8\n2. In this session we pushed.";
  const revision = (body: string, whole = false) => draftRefusal({ description: "Use when committing.", body, previousBody: kept, descriptionChanged: false, ...(whole ? { whole } : {}) });

  test("an address, an account or a story the skill already held does not refuse its revision", () => {
    expect(revision(`${kept}\n3. push with --force-with-lease`)).toBeNull();
  });

  test("one the revision adds still does", () => {
    expect(revision(`${kept}\n3. mail ops@nouverse.tech`)).toContain("ops@nouverse.tech");
    expect(revision(`${kept}\n3. ssh to 172.16.42.9`)).toContain("172.16.42.9");
    expect(revision(`${kept}\n3. the MAC is 9C:6B:00:8C:1D:13`)).toContain("hardware address");
    expect(revision(`${kept}\n3. The user said to squash.`)).toContain("tells a session");
  });

  test("a new skill has nothing it already held", () => {
    expect(draftRefusal({ description: "Use when committing.", body: kept, descriptionChanged: true })).toContain("172.16.42.8");
  });

  test("the weekly review's revision is judged whole: taking those out is what it was asked for", () => {
    expect(revision(`${kept}\n3. push`, true)).toContain("172.16.42.8");
  });

  // On a live box a skill whose body held an account's address was revised and refused nineteen times in a week.
  test("through the pass: a skill that names an account is revised, where it was refused every time", async () => {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, { name: "site-contributing", description: "Use when changing the site.", body: kept, author: "nouva" });
    const better = JSON.stringify({ description: "Use when changing the site.", requires: "", body: `${kept}\n3. Run the build before pushing.` });
    const h = engine({ agentsDir, triage: JSON.stringify({ decision: "update", target: "site-contributing", why: "the build step was missing" }), written: better });
    await h.reflection.observe(turn("ses_1"));
    expect(h.drafts.pending().map((draft) => draft.target)).toEqual(["site-contributing"]);
    expect(h.asked.written).toBe(1);
    // The reviser is told the size as numbers.
    expect(h.asked.prompts.at(-1)).toContain(`Its body is ${kept.length} characters now. Your revision's body may be at most 12,000.`);
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

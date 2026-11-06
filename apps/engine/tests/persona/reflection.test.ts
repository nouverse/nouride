/**
 * The RSI loop, from the four angles that can each break it silently.
 *
 * - **The trigger fires on the wrong things.** Then every turn costs a provider call and the drafts
 *   queue fills with nothing, which is how the feature gets switched off.
 * - **The redaction misses.** Then a key ends up in a markdown file every agent reads on every turn.
 * - **A malformed answer becomes a draft.** A model that replies with prose, a fenced block or a
 *   name with spaces in it has to end as nothing, not as a broken row somebody clicks approve on.
 * - **The gate leaks.** Nothing may reach `agents/skills/` except through `approve`, and a discard
 *   has to actually delete.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { ChatMessage, LLMProvider, LoadedAgent, SkillLearningSection } from "@nouride/shared";
import type { Tuning } from "@/modules/reflection/tuning.ts";
import { listSkills, parseFrontmatter } from "@nouride/persona";
import { listDir } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { DraftStore, ReflectionEngine, ToolMemory } from "@/modules/reflection/index.ts";
import { detectTrigger, isExplicitRequest } from "@/modules/reflection/trigger.ts";
import { buildTranscript, parseTriage } from "@/modules/reflection/synthesis.ts";
import { AUTHOR_INSTRUCTION, REVISE_INSTRUCTION, renderSkillList, TRIAGE_INSTRUCTION } from "@/modules/reflection/prompts.ts";
import { redact } from "@nouride/secrets";
import {
  deletePoolSkill,
  skillBodyIsEnglish,
  renderSkillMarkdown,
  updateExistingSkill,
  validateSupportFiles,
  writeNewSkill,
} from "@nouride/persona";
import { readPool } from "@/modules/reflection/pool.ts";
import { draftHooks } from "@/modules/hooks/builtins/drafts.ts";
import type { HookContext } from "@/modules/hooks/registry.ts";
import type { AgentRegistry } from "@nouride/persona";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import { UsageStore, type UsagePort } from "@/modules/llm/usage.store.ts";
import type { BudgetVerdict } from "@/modules/llm/budget.ts";
import { renderSkills } from "@/modules/llm/prompt/sections.ts";
import { renderSkillPolicy } from "@/modules/llm/prompt/harness-skills.ts";
import type { Skill } from "@nouride/shared";
import { fakeAgent, sleep } from "../helpers.ts";

/** `[skills.learning]` and the pass's own dials, as one fixture: the dials set for a test, the rest as a box has them. */
const RSI: SkillLearningSection & Tuning = {
  mode: "ask",
  minToolFailures: 2,
  reflectAfter: 10,
  rapidFollowUpMs: 3 * 60_000,
  model: "",
  cooldownMs: 60_000,
  maxPending: 5,
  notifyChat: false,
};

const skillMd = (agentsDir: string, name: string) => join(agentsDir, "skills", name, "SKILL.md");

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nouride-rsi-"));
  dirs.push(dir);
  return dir;
}

function freshDb(): SqliteDb {
  const db = openDatabase(join(tempDir(), "nouride.db"));
  migrate(db);
  return db;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── the trigger ───────────────────────────────────────────────────────────────

describe("trigger detection", () => {
  test("a person asking, in either language", () => {
    for (const text of [
      "catet jadi skill ya",
      "catat ilmunya jadi skill dong",
      "simpen ini jadi skill",
      "jadiin skill aja biar ga lupa",
      "save this as a skill please",
      "turn that into a skill",
      "remember this as a skill",
    ]) {
      expect(isExplicitRequest(text)).toBe(true);
    }
  });

  test("but not a question about the feature", () => {
    // The most common sentence containing the word, and the one a naive matcher fires on. A trigger
    // that produces a draft when somebody asks what skills exist discredits the whole surface.
    for (const text of [
      "skill apa aja yang kamu punya?",
      "which skills do you have",
      "is that skill switched on for nox",
      "the skill failed halfway",
    ]) {
      expect(isExplicitRequest(text)).toBe(false);
    }
  });

  test("two failures then a success is worth writing down", () => {
    const trigger = detectTrigger({
      userText: "kenapa deploy-nya gagal",
      steps: [
        { name: "exec", ok: false },
        { name: "exec", ok: false },
        { name: "exec", ok: true },
      ],
      minToolFailures: 2,
      effort: 0,
      reflectAfter: 10,
    });
    expect(trigger?.kind).toBe("error_recovery");
    expect(trigger?.reason).toContain("2 tool failures");
  });

  test("a turn that ended broken is not", () => {
    // The rule that keeps a procedure that does not work out of the pool: the success has to come
    // *after* the last failure, not merely somewhere in the turn.
    expect(
      detectTrigger({
        userText: "coba deploy",
        steps: [
          { name: "exec", ok: true },
          { name: "exec", ok: false },
          { name: "exec", ok: false },
        ],
        minToolFailures: 2,
        effort: 0,
        reflectAfter: 10,
      }),
    ).toBeNull();
  });

  test("one failure is a typo, not a lesson", () => {
    expect(
      detectTrigger({
        userText: "baca file itu",
        steps: [
          { name: "read", ok: false },
          { name: "read", ok: true },
        ],
        minToolFailures: 2,
        effort: 0,
        reflectAfter: 10,
      }),
    ).toBeNull();
  });

  test("an ordinary successful turn triggers nothing", () => {
    expect(
      detectTrigger({
        userText: "apa kabar",
        steps: [{ name: "read", ok: true }],
        minToolFailures: 2,
        effort: 0,
        reflectAfter: 10,
      }),
    ).toBeNull();
  });
});

/**
 * The counter that replaced a table of regexes.
 *
 * The case the loop was designed around — a long conversation where every command succeeds and the person
 * still has to steer three times — produces no tool failures at all. Two earlier versions tried to
 * read that from the person's phrasing; this one just counts and lets the model read. These tests
 * are about the counting being cheap and correct, because everything downstream of it is a judgement
 * no test here can make.
 */
describe("sustained effort", () => {
  const base = { minToolFailures: 2, reflectAfter: 10 };

  test("a long conversation with nothing failing still gets looked at", () => {
    const trigger = detectTrigger({
      ...base,
      userText: "nah gitu, udah bener sekarang",
      steps: [{ name: "write", ok: true }],
      effort: 10,
    });
    expect(trigger?.kind).toBe("sustained_effort");
    expect(trigger?.reason).toContain("10 rounds");
  });

  test("a short exchange never pays for a reflection", () => {
    expect(
      detectTrigger({ ...base, userText: "makasih", steps: [], effort: 3 }),
    ).toBeNull();
  });

  test("a precise single-turn recovery still wins over the counter", () => {
    // Both would fire. `error_recovery` is checked first because it can say *what* failed, and the
    // reason column is the thing a person reads before deciding.
    const trigger = detectTrigger({
      ...base,
      userText: "coba deploy",
      steps: [
        { name: "exec", ok: false },
        { name: "exec", ok: false },
        { name: "exec", ok: true },
      ],
      effort: 40,
    });
    expect(trigger?.kind).toBe("error_recovery");
  });

  test("and an explicit request wins over both", () => {
    const trigger = detectTrigger({
      ...base,
      userText: "catet jadi skill ya",
      steps: [{ name: "exec", ok: false }, { name: "exec", ok: false }, { name: "exec", ok: true }],
      effort: 40,
    });
    expect(trigger?.kind).toBe("user_request");
  });
});

describe("ToolMemory", () => {
  test("says nothing until it knows what the agent's ordinary tools are", () => {
    const memory = new ToolMemory(freshDb(), () => 1000);

    // The warmup. Without it the first turn after every restart looks like a first integration and
    // the trigger fires on `read` — the exact reason this lives in the database.
    expect(memory.observe("nouva", ["read", "write", "exec"], 5)).toEqual([]);
    expect(memory.observe("nouva", ["web_search", "memory_read"], 5)).toEqual([]);
    // Six distinct tools on record now, so the seventh is genuinely new.
    expect(memory.observe("nouva", ["home_assistant_call"], 5)).toEqual(["home_assistant_call"]);
    // And only once.
    expect(memory.observe("nouva", ["home_assistant_call"], 5)).toEqual([]);
  });

  test("one agent's history is not another's", () => {
    const memory = new ToolMemory(freshDb(), () => 1000);
    memory.observe("nouva", ["a", "b", "c", "d", "e"], 5);
    expect(memory.observe("nox", ["a"], 5)).toEqual([]);
  });
});

// ── redaction ─────────────────────────────────────────────────────────────────

describe("redaction", () => {
  test("vendor tokens, JWTs and private keys go", () => {
    const out = redact(
      [
        "export ANTHROPIC_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
        "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx'",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nzzzz\n-----END OPENSSH PRIVATE KEY-----",
      ].join("\n"),
    );
    expect(out.text).not.toContain("sk-ant-api03");
    expect(out.text).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(out.text).not.toContain("BEGIN OPENSSH");
    expect(out.hits.length).toBeGreaterThan(0);
  });

  test("the name of a secret survives; only the value goes", () => {
    // The half that matters for a skill: "set `DB_PASSWORD` in the environment" is the instruction
    // worth keeping, and masking the key as well would turn the procedure into noise.
    const out = redact('DB_PASSWORD="hunter2hunter2"');
    expect(out.text).toContain("DB_PASSWORD");
    expect(out.text).not.toContain("hunter2hunter2");
  });

  test("a URL keeps its host and loses its credentials", () => {
    const out = redact("git clone https://gading:s3cr3tpw@git.example.com/repo.git");
    expect(out.text).toContain("git.example.com/repo.git");
    expect(out.text).not.toContain("s3cr3tpw");
  });

  test("ordinary prose is left alone", () => {
    const out = redact("Run `kubectl rollout restart deployment/api` and wait for the pods.");
    expect(out.hits).toEqual([]);
  });

  test("a transcript is scrubbed on the way out, not at the call site", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "deploy pakai token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { role: "assistant", content: "done" },
    ];
    const { text, redactions } = buildTranscript(messages);
    expect(text).not.toContain("ghp_aaaa");
    expect(redactions).toContain("api-key");
  });
});

// ── what the model answered ───────────────────────────────────────────────────

/**
 * What the pass actually reads.
 *
 * The transcript used to keep the last 24,000 characters and drop the head. Watched live on
 * 2026-09-02: a 22-turn session scaffolding a video project ran 35,680 characters of prompts and
 * replies *before* counting tool results, so the eight turns where the work was decided and two
 * rounds of failures happened were outside the window. The pass declined eight times, and its own
 * reasons described only the tail — `/status`, "how many turns are we" — as routine.
 *
 * The head is the half that carries the reason a lesson is worth keeping: this failed, then this
 * failed, then *this* worked. So older messages are now compressed to fit rather than dropped.
 */
describe("the transcript keeps the whole arc", () => {
  const msg = (role: "user" | "assistant" | "tool", content: string) => ({ role, content }) as never;

  test("a long session keeps its opening, not just its end", () => {
    const messages = [
      msg("user", "OPENING-REQUEST scaffold the video project"),
      msg("tool", "FIRST-FAILURE bun install exited 1\n".repeat(400)),
      msg("tool", "SECOND-FAILURE BUN_TMPDIR=/tmp bun install exited 1\n".repeat(400)),
      msg("tool", "THE-FIX TMPDIR=/tmp/bun-tmp bun install ok\n".repeat(400)),
      ...Array.from({ length: 40 }, (_, i) => msg("assistant", `filler turn ${i} `.repeat(200))),
      msg("user", "CLOSING-QUESTION how many turns are we"),
    ];

    const { text } = buildTranscript(messages);

    // Both ends present, which is the whole point: the tail holds the method, the head holds why it
    // is worth writing down.
    expect(text).toContain("OPENING-REQUEST");
    expect(text).toContain("CLOSING-QUESTION");
    // And the failures that make it a lesson rather than a routine success.
    expect(text).toContain("FIRST-FAILURE");
    expect(text).toContain("THE-FIX");
  });

  test("it still fits in the budget", () => {
    const messages = Array.from({ length: 400 }, (_, i) => msg("tool", `result ${i} `.repeat(500)));
    const { text } = buildTranscript(messages);
    // A ceiling still exists — this is a budget, not an invitation to send everything.
    expect(text.length).toBeLessThanOrEqual(70_000);
  });

  test("the oldest go first when even the floor will not fit", () => {
    // Dropping has to remain possible, and from the oldest end only: a 2000-message conversation
    // cannot be represented, and the end is the part that must survive.
    const messages = Array.from({ length: 2000 }, (_, i) =>
      msg("assistant", `${i === 0 ? "VERY-FIRST " : ""}message ${i} `.repeat(60)),
    );
    const { text } = buildTranscript(messages);
    expect(text).toContain("earlier message(s) dropped");
    expect(text).not.toContain("VERY-FIRST");
    expect(text).toContain("message 1999");
  });
});

describe("triage — the decision the whole feature turns on", () => {
  test("update names its target", () => {
    const t = parseTriage('{"decision":"update","target":"send-file-fallbacks","why":"you corrected it"}');
    expect(t).toEqual({ decision: "update", target: "send-file-fallbacks", why: "you corrected it" });
  });

  test("a fenced block whose content contains its own code fences", () => {
    /**
     * The live box found this shape on the first real answer the pass ever produced. A skill body is
     * markdown and markdown is full of ```bash fences, so a non-greedy match on the *outer* fence
     * stops at the first fence inside the JSON string and hands back a fragment with no closing
     * brace. The daemon logged "did not answer with JSON" about a well-formed reply.
     */
    const payload = { decision: "create", name: "fetch-with-curl", description: "Use when a page must be fetched.", why: "run it:\n```bash\ncurl -s x\n```\ndone" };
    expect(parseTriage(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``)?.decision).toBe("create");
  });

  test("skip is nothing, not an empty skill", () => {
    expect(parseTriage('{"decision":"skip","reason":"one-off lookup"}')).toBeNull();
  });

  test("an update naming an unusable skill is refused, not guessed at", () => {
    // Falling through to a create here would silently turn "improve this" into "add another one" —
    // the exact outcome triage exists to prevent.
    expect(parseTriage('{"decision":"update","target":"Send File Fallbacks"}')).toBeNull();
  });

  test("an answer with no decision at all", () => {
    expect(parseTriage('{"reason":"hmm"}')).toBeNull();
    expect(parseTriage("I could not find anything worth keeping.")).toBeNull();
    expect(parseTriage(null)).toBeNull();
  });
});

// ── the draft store ───────────────────────────────────────────────────────────

/**
 * The rung between "make the body longer" and "start another skill".
 *
 * Both of those are worse than a file beside the skill, and the second is the failure this pass
 * guards hardest against — two skills for one subject means the agent loads one and the lesson is in
 * the other. Hermes reaches for a support file before creating anything, and its library stays
 * class-level as a result; ours had no way to express it.
 */
describe("triage — attaching a support file to an existing skill", () => {
  test("is parsed like an update, because it is one", () => {
    const triage = parseTriage(
      JSON.stringify({
        decision: "attach",
        target: "deployment",
        why: "the working render command, with the concurrency that fits 2 vCPU",
      }),
    );
    expect(triage).toEqual({
      decision: "attach",
      target: "deployment",
      why: "the working render command, with the concurrency that fits 2 vCPU",
    });
  });

  test("still refuses a target that is not a usable skill name", () => {
    // Same guard as `update`: a name the pool cannot contain is a name that resolves to nothing, and
    // a draft against nothing is worse than no draft.
    expect(parseTriage(JSON.stringify({ decision: "attach", target: "../etc/passwd" }))).toBeNull();
    expect(parseTriage(JSON.stringify({ decision: "attach", why: "no target at all" }))).toBeNull();
  });

  test("the prompt offers it before create, and says why", () => {
    // Order is the mechanism here — the pass takes the first answer that applies, so `attach` has to
    // come before `create` or it will never be reached for a subject that already has a skill.
    const attachAt = TRIAGE_INSTRUCTION.indexOf("**attach**");
    const createAt = TRIAGE_INSTRUCTION.indexOf("**create**");
    expect({ attachFound: attachAt >= 0, beforeCreate: attachAt < createAt }).toEqual({
      attachFound: true,
      beforeCreate: true,
    });
  });
});

/**
 * The bias the prompt carries, asserted because it is the thing that changed the outcome.
 *
 * Eight declines in one session, every one of them reaching for the same two words. The prompt had
 * told the model that skipping is "a normal and common answer", then given it five concrete reasons
 * to skip against three abstract reasons to keep. Hermes says the opposite — "a pass that does
 * nothing is a missed learning opportunity, not a neutral outcome" — and that is the difference.
 */
/**
 * The bias the prompt carries, asserted because it is the thing that decides the outcome — and it
 * has now failed in both directions, so both are pinned here.
 *
 * First it declined everything: eight declines in one session, the prompt calling skip "a normal and
 * common answer" and giving five concrete reasons to skip against three abstract reasons to keep.
 *
 * Then, correcting that, I added "Not on its own" and "When a skill is full" on top of the existing
 * skip list, and it declined everything again — fourteen turns on 2026-09-05, zero drafts, against
 * five and six drafts on the two days before. The prompt had reached 12 lines of reasons to act
 * against 39 telling it not to.
 */
describe("the prompt gives more reasons to act than to decline", () => {
  function section(name: string): string[] {
    const lines = TRIAGE_INSTRUCTION.split("\n");
    const at = lines.findIndex((l) => l.startsWith(`## ${name}`));
    expect(at).toBeGreaterThanOrEqual(0);
    const out: string[] = [];
    for (let i = at + 1; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.startsWith("## ")) break;
      if (line.trim()) out.push(line);
    }
    return out;
  }

  test("the two lists stay in that order of weight", () => {
    /**
     * A ratio rather than a wording check, because wording is what I kept fixing while the balance
     * quietly inverted. 12:39 was the state that produced a whole day of declines; anything at or
     * below parity is the same failure wearing different sentences.
     */
    const act = section("Signals: any one of these warrants action").length;
    const decline = section("Do not capture").length;
    expect({ act, moreThanDecline: act > decline }).toEqual({ act, moreThanDecline: true });
  });

  test("the product's own surface is a decline, and it fits in two lines", () => {
    /**
     * Added after a pass drafted `nouride-daemon-update` — half of it copied out of the system
     * prompt it was reading, half out of `nouride update --help`. The listing marks a shipped skill
     * so its territory is not duplicated; this covers the other case, where nothing ships for it and
     * the lesson is still a flag that the next release may change.
     *
     * Asserted here rather than left to the ratio test above, which only counts. That test is why
     * the rule is two lines and not seven: the last time this list grew, the pass declined for a
     * whole day.
     */
    expect(TRIAGE_INSTRUCTION).toContain("Nouride's own flags, commands and config keys");
    expect(TRIAGE_INSTRUCTION).toContain("this daemon upgrades itself");
  });

  test("it does not tell the model that skipping is normal", () => {
    expect(TRIAGE_INSTRUCTION).not.toContain("normal and common");
    expect(TRIAGE_INSTRUCTION).toContain("Be active");
  });

  test("it refuses the words every decline actually used, and says so early", () => {
    /**
     * Six of fourteen declines on 2026-09-05 contained "Standard", "routine" or "feature
     * development" — "Standard git operational errors", "Routine feature development, testing and
     * release tagging". The prohibition existed and sat below five bullets of skip reasons, where it
     * did nothing. Position is the fix, so position is what is asserted: before the first list.
     */
    expect(TRIAGE_INSTRUCTION).toContain('"Standard" and "routine" are not reasons to skip');
    expect(TRIAGE_INSTRUCTION).toContain("feature development");
    const ban = TRIAGE_INSTRUCTION.indexOf('"Standard" and "routine"');
    const firstList = TRIAGE_INSTRUCTION.indexOf("## Signals");
    expect(ban).toBeLessThan(firstList);
  });

  test("setup work that now works is named as worth keeping", () => {
    expect(TRIAGE_INSTRUCTION).toContain("A setup or integration that now works");
    expect(TRIAGE_INSTRUCTION).toContain("The *instance* is one-off; the *procedure* is");
  });

  test("the environment-state exclusion does not swallow tool behaviour", () => {
    // The bullet that caught the TMPDIR fix. It read "a path that exists only on this box", and the
    // model filed "the container's /tmp is too small for bun install" under it — but that is how the
    // tool behaves on every box of that shape, and it cost the same afternoon twice.
    expect(TRIAGE_INSTRUCTION).toContain("Only this box's state");
    expect(TRIAGE_INSTRUCTION).toContain("*class* of environment belongs above");
  });

  test("a measurement is excluded without banning numbers", () => {
    /**
     * The draft that prompted the rule: an update to `home-pc-ops` whose whole content was that the
     * voice service idles at ~59 MB RAM and 0% VRAM. The near miss was writing it as "leave out the
     * numbers" — "boot to SSH is ~12-16 seconds" and the concurrency that saturated the GPU are
     * numbers too, and the most reusable lines in that skill.
     */
    expect(TRIAGE_INSTRUCTION).toContain("A measurement of how things happen to be running");
    expect(TRIAGE_INSTRUCTION).toContain("what to expect or what to set");
  });
});

/**
 * What the library is supposed to look like, which I had backwards for one commit.
 *
 * Seeing one create against fifteen improvements, I read it as `create` being unreachable and made
 * a large skill a reason to start a new one. Hermes says the opposite in as many words: class-level
 * skills with a rich body and a `references/` directory, *not* a long flat list of
 * one-session-one-subject entries. A big skill is usually working. What it needs is somewhere to put
 * the detail, and that is `attach`.
 */
describe("a long skill is told to grow sideways, not to split", () => {
  // `github-pr` on the live box: one procedure in several steps, and the skill that must not be
  // marked. A heading count would have marked it; size does not.
  const stepwise = { name: "github-pr", description: "Open a PR.", owner: "agent" as const, bytes: 3_660 };
  const focused = { name: "deployment", description: "Ship a binary.", owner: "agent" as const, bytes: 1_200 };
  // `domain-management` as it actually was: four `##`, twenty-three kilobytes, and everything from
  // object storage to web analytics inside it.
  const large = {
    name: "domain-management",
    description: "DNS, R2 custom domains, IPFS, Arweave, Umami.",
    owner: "agent" as const,
    bytes: 23_331,
  };

  test("only the large ones are marked, and the mark points at references/", () => {
    const lines = renderSkillList([focused, large]).split("\n");
    expect(lines.find((l) => l.startsWith("- deployment"))).toBe("- deployment: Ship a binary.");
    const marked = lines.find((l) => l.startsWith("- domain-management")) ?? "";
    expect(marked).toContain("references/");
    // The half that matters: it must not read as "this skill is wrong". It is the right skill.
    expect(marked).toContain("still the right skill");
  });

  test("five short sections is a procedure, not a warehouse", () => {
    /**
     * The false positive that made the section-count threshold wrong, kept because it is the
     * expensive direction: telling the pass a focused skill is full pushes it to start a second one
     * covering the same subject.
     */
    expect(renderSkillList([stepwise])).toBe("Skills that already exist:\n- github-pr: Open a PR.");
  });

  test("a hand-written skill gets the ownership note and nothing else", () => {
    /**
     * Both notes fired together on the live pool, and they contradict each other: one says the pass
     * may not name this skill at all, the other tells it where to put new detail *in* it. Read
     * together the second looks like permission, which is the one reading that must not be
     * available.
     *
     * The ownership note is the one that must never be dropped — naming a person's skill for an
     * update overwrites their file.
     */
    const line = renderSkillList([{ ...large, owner: "person" }]);
    expect(line).toContain("written by a person");
    expect(line).not.toContain("references/");
  });

  test("a skill that ships with Nouride claims its territory, not just its file", () => {
    /**
     * The live failure this field exists for. An agent upgraded the daemon it runs inside and
     * drafted `nouride-daemon-update`, "capturing the procedure and flag requirements (--start,
     * --then, --agent, --gateway, --chat)" — two of which were in the system prompt it had been
     * reading all turn, word for word, and the rest of which was `nouride update --help`.
     *
     * Marking it merely uneditable would not have stopped that. A pass with a lesson about a
     * territory it may not write to does the obvious thing and writes its own skill next to it, and
     * now the pool holds a stale copy of the product nobody maintains. So the note has to refuse
     * both moves, and the test asserts both halves rather than the sentence.
     */
    const line = renderSkillList([{ ...large, name: "nouride", owner: "nouride" }]);
    expect(line).toContain("ships with Nouride");
    expect(line).toContain("do not name it in update or attach");
    expect(line).toContain("do not write your own version");
    // And not the size note, for the same reason a person's skill does not get it: "put new detail
    // in references/" reads as permission to write into a file this pass may not touch.
    expect(line).not.toContain("references/");
  });

  test("length and subject are separated, and length never decides where a lesson goes", () => {
    /**
     * The contradiction that let one skill own three subjects. "When a skill is getting long, the
     * answer is `attach`, not a second skill" sat before the decision list, unconditional, so it
     * framed everything below it: long skill, therefore attach. That is how object storage and web
     * analytics ended up in the references of a DNS skill.
     *
     * Both halves have to be present — the gate on `attach`, and the sentence saying size only
     * decides *where detail goes* once the subject question is settled.
     */
    expect(TRIAGE_INSTRUCTION).toContain("Length and subject are two different questions");
    expect(TRIAGE_INSTRUCTION).toContain("Length is never a reason to file a *different* subject");
    expect(TRIAGE_INSTRUCTION).toContain("a long body is where detail goes, never where a different subject goes");
  });

  test("the ownership question is settled before the decision list, not after it", () => {
    /**
     * Order is the mechanism: the pass takes the first rule that applies, so a test for *which*
     * skill owns the lesson has to be readable before rule 1 rather than eleven lines below rule 4.
     * The same lesson as the "standard is not a reason to skip" line, which did nothing until it
     * moved above the list it was qualifying.
     */
    const owns = TRIAGE_INSTRUCTION.indexOf("## Which skill owns this");
    const list = TRIAGE_INSTRUCTION.indexOf("## Take the first of these that fits");
    expect({ found: owns >= 0, beforeList: owns < list }).toEqual({ found: true, beforeList: true });
  });

  test("a shared noun is not a shared subject, and the prompt says which mistake that is", () => {
    /**
     * The failure that produced this rule, watched live over three hours: `domain-management` —
     * configure DNS for a service — absorbed Cloudflare R2 object storage, IPFS and Arweave hosting,
     * and Umami web analytics. Twelve improvements, 5KB to 23KB, every one of them landing there
     * because the thing being set up had a domain pointed at it.
     *
     * `create` was never reached once, and the description ended up an inventory rather than a
     * trigger — which made the next match more certain than the last.
     */
    expect(TRIAGE_INSTRUCTION).toContain("A shared noun is not a shared subject");
    expect(TRIAGE_INSTRUCTION).toContain("what the *task* was, not what the task happened to touch");

    /**
     * And it says it *generically*. The first version of this rule named the real skill, the four
     * real services it had swallowed, and the byte counts — in a string that ships in every binary
     * and is sent to a model on every reflection. Useless to any other install, and somebody else's
     * infrastructure inventory in a released artefact.
     *
     * The case belongs in the comment above the constant, where it explains the rule to whoever
     * edits it next. The rule itself has to work for a pool it has never seen.
     */
    for (const leak of ["domain-management", "Cloudflare", "IPFS", "Arweave", "Umami", "23KB"]) {
      expect(TRIAGE_INSTRUCTION).not.toContain(leak);
      expect(REVISE_INSTRUCTION).not.toContain(leak);
      expect(AUTHOR_INSTRUCTION).not.toContain(leak);
    }
  });

  test("the revise pass is told not to widen the description", () => {
    // The vector. Triage matches on descriptions, so a description that grows a clause per
    // improvement is a skill that becomes more attractive to the next lesson every round —
    // a loop that ran twelve times before anybody looked.
    expect(REVISE_INSTRUCTION).toContain("Leave the description alone unless it is now wrong");
    expect(REVISE_INSTRUCTION).toContain("return the description you were given, unchanged");
  });

  test("a large skill is still the right skill, and is tightened rather than extended", () => {
    // Without the first half the marker reads as a complaint, and the pass answers it by splitting. The second is
    // 0.7.28's: "a large skill is usually working as intended" let `home-pc-ops` grow to 306 lines of incidents.
    expect(TRIAGE_INSTRUCTION).toContain("not a long flat list");
    expect(TRIAGE_INSTRUCTION).toContain("A skill is not a history either");
    expect(renderSkillList([{ name: "big", description: "Big.", owner: "agent", bytes: 20_000 }])).toContain("tighten it when you touch it");
  });

  test("both deciding passes are told the reader exists", () => {
    /**
     * A tool nothing mentions is a tool the model does not use. Both instructions have to name it,
     * and they have to name it where the decision is made — triage at the point of matching a lesson
     * to a skill, author at the point of arguing that no skill covers it.
     */
    expect(TRIAGE_INSTRUCTION).toContain("`read_skill` returns any of");
    expect(TRIAGE_INSTRUCTION).toContain("Check before");
    expect(AUTHOR_INSTRUCTION).toContain("Read the nearest skill before you argue against it");
  });

  test("attach is offered before create, and says why", () => {
    // Order is the mechanism: the pass takes the first answer that applies, so `attach` has to come
    // before `create` or it will never be reached for a subject that already has a skill.
    const attachAt = TRIAGE_INSTRUCTION.indexOf("**attach**");
    const createAt = TRIAGE_INSTRUCTION.indexOf("**create**");
    expect({ found: attachAt >= 0, beforeCreate: attachAt < createAt }).toEqual({
      found: true,
      beforeCreate: true,
    });
  });
});

describe("DraftStore", () => {
  function seed(store: DraftStore, name: string) {
    return store.create({
      agentId: "nouva",
      triggerKind: "error_recovery",
      triggerReason: "two failures, then it worked",
      name,
      description: "when the thing breaks",
      requires: "",
      body: "## Procedure\n1. do it",
    });
  }

  test("a draft can be named instead of typed as an id", () => {
    const store = new DraftStore(freshDb(), () => 1000);
    const draft = seed(store, "fix-the-thing");
    expect(store.resolve("fix-the-thing")?.id).toBe(draft.id);
    expect(store.resolve(draft.id)?.name).toBe("fix-the-thing");
    expect(store.resolve("nothing-like-this")).toBeNull();
  });

  test("a discard leaves no row", () => {
    const store = new DraftStore(freshDb(), () => 1000);
    const draft = seed(store, "fix-the-thing");
    expect(store.deny(draft.id)).toBe(true);
    expect(store.get(draft.id)).toBeNull();
    expect(store.pending()).toHaveLength(0);
  });

  test("the sweep never touches a pending draft, however old", () => {
    // The one property the whole gate depends on: a proposal that expired overnight is invisible
    // from every surface, which is worse than one nobody got round to.
    let clock = 0;
    const store = new DraftStore(freshDb(), () => clock);
    const pending = seed(store, "still-waiting");
    const decided = seed(store, "already-kept");
    store.markApproved(decided.id, "gading", "/tmp/x/SKILL.md");

    clock = 400 * 24 * 60 * 60_000;
    expect(store.sweep(30, clock)).toBe(1);
    expect(store.get(pending.id)?.status).toBe("pending");
    expect(store.get(decided.id)).toBeNull();
  });
});

// ── the loop, end to end ──────────────────────────────────────────────────────

interface Harness {
  engine: ReflectionEngine;
  /** Chat messages the pass sent, in order. */
  notices: string[];
  /** Everything the provider was handed, in order — see the note in `harness`. */
  prompts: string[];
  drafts: DraftStore;
  agentsDir: string;
  reloads: number;
  calls: number;
}

/**
 * `answers` is a list because the pass is called once per draft, and the tests that matter most —
 * the cooldown, and a duplicate name — need the second call to answer differently. The last entry
 * repeats, so a single answer covers every call.
 */
function harness(
  answers: string | string[],
  config: Partial<SkillLearningSection & Tuning> = {},
  poolDir?: string,
  now: () => number = () => 1000,
  /**
   * What triage answers, when a test needs a decision other than "create a new skill".
   *
   * One entry per reflection, the last repeating. Added for the update path: `TRIAGE_CREATE` is the
   * right default for most tests, but the collision rules — a session replacing its own draft,
   * another session standing beside it — only exist on the `update` branch.
   */
  triage: string | string[] = TRIAGE_CREATE,
  /** Where the daemon's own skills live, for the tests that are about them. */
  builtinSkillsDir?: string,
  /** Where the pass's calls are metered, for the tests that are about what it costs. */
  usage?: Pick<UsagePort, "record">,
  /** Today's spend against the caps, for the test of a pass past them. */
  spend?: () => BudgetVerdict,
): Harness {
  const agentsDir = poolDir ?? tempDir();
  const scripted = Array.isArray(answers) ? answers : [answers];
  const triage_ = triage;
  const db = freshDb();
  const drafts = new DraftStore(db, now);
  const state = { reloads: 0, calls: 0, authored: 0 };

  /**
   * Answers by *what it was asked*, not by call order.
   *
   * The pass makes two calls — triage, then author or revise — and a double keyed on order breaks
   * the moment a test drives two reflections. Keying on the instruction is also what a real provider
   * effectively does, and it keeps `calls` meaning "reflections" rather than "round-trips".
   */
  /**
   * What the pass was *sent*, not only what it answered.
   *
   * Needed once the second revision started building on the first draft rather than on disk: an
   * assertion about the output would also pass if the model merely repeated itself, so the property
   * worth pinning is that the input changed.
   */
  const prompts: string[] = [];
  const provider = {
    async chat(request: { messages: { content: string }[] }) {
      const instruction = request.messages[0]?.content ?? "";
      prompts.push(request.messages.map((m) => m.content).join("\n"));
      const triage = instruction.includes("what should happen to the skill");
      const triaged = Array.isArray(triage_) ? triage_ : [triage_];
      const text = triage
        ? triaged[Math.min(state.calls++, triaged.length - 1)]!
        : scripted[Math.min(state.authored++, scripted.length - 1)]!;
      return { text, toolCalls: [], stopReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;

  const agent: LoadedAgent = fakeAgent();
  const registry = {
    get: (id: string) => (id === agent.config.id ? agent : undefined),
    reloadAll: async () => {
      state.reloads += 1;
    },
  } as unknown as AgentRegistry;

  /**
   * Every chat message the pass sends, captured.
   *
   * There was no notifier here at all, so `announce` returned on its first guard and the whole
   * notification path went untested — including the case an operator actually complained about: a
   * draft rewritten mid-session with nothing said about it.
   */
  const notices: string[] = [];

  const engine = new ReflectionEngine({
    ...(() => {
      const { mode, model, notifyChat, ...tuning } = { ...RSI, ...config };
      return { config: { mode, model, notifyChat }, tuning };
    })(),
    drafts,
    toolMemory: new ToolMemory(db, () => 1000),
    registry,
    providers: { get: () => provider } as unknown as ProviderRegistry,
    agentsDir,
    ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
    ...(usage ? { usage } : {}),
    ...(spend ? { spend } : {}),
    notifier: { toChat: async (_to: unknown, text: string) => void notices.push(text) } as never,
    now,
  });

  return {
    engine,
    notices,
    prompts,
    drafts,
    agentsDir,
    get reloads() {
      return state.reloads;
    },
    get calls() {
      return state.calls;
    },
  };
}

/**
 * An engine whose revise pass asks to read a file before it answers.
 *
 * The revise pass is a tool loop now, and nothing exercised that: every other harness returns text
 * on the first call, which is the path where the loop does nothing. This one answers the first
 * revise call with a `read_skill_file` request and the second with the draft, so the assertions can
 * be about what the model was handed back.
 */
function engineThatReads(
  agentsDir: string,
  script: { triage: string; revise: string; wants: string },
): { loop: ReflectionEngine; served: string[]; toolsOffered: boolean[] } {
  const db = freshDb();
  const served: string[] = [];
  const toolsOffered: boolean[] = [];
  let asked = false;

  const provider = {
    async chat(request: { messages: { content: string; role: string }[]; tools?: unknown[] }) {
      const instruction = request.messages[0]?.content ?? "";
      if (instruction.includes("what should happen to the skill")) {
        return { text: script.triage, toolCalls: [], stopReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } };
      }
      toolsOffered.push(Array.isArray(request.tools) && request.tools.length > 0);
      // Whatever came back from the read, captured for the assertions.
      for (const message of request.messages) if (message.role === "tool") served.push(message.content);
      if (!asked) {
        asked = true;
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "read_skill_file", arguments: { path: script.wants } }],
          stopReason: "tool_calls" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
      return { text: script.revise, toolCalls: [], stopReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;

  const loop = new ReflectionEngine({
    config: RSI,
    drafts: new DraftStore(db, () => 1000),
    toolMemory: new ToolMemory(db, () => 1000),
    registry: { get: () => fakeAgent(), reloadAll: async () => {} } as unknown as AgentRegistry,
    providers: { get: () => provider } as unknown as ProviderRegistry,
    agentsDir,
    now: () => 1000,
  });
  return { loop, served, toolsOffered };
}

/**
 * An engine over an existing pool, with both calls scripted separately.
 *
 * The plain `harness` always triages as *create*, which is what most tests want. This one is for the
 * update path, where the two calls say different things and both matter.
 */
function enginePointedAt(
  agentsDir: string,
  script: { triage: string; revise: string },
  /** The skills that ship with the daemon, for the tests that are about them. */
  builtinSkillsDir?: string,
) {
  const db = freshDb();
  const calls = { revise: 0 };
  const provider = {
    async chat(request: { messages: { content: string }[] }) {
      const instruction = request.messages[0]?.content ?? "";
      const triage = instruction.includes("what should happen to the skill");
      if (!triage) calls.revise += 1;
      const text = triage ? script.triage : script.revise;
      return { text, toolCalls: [], stopReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;

  const drafts = new DraftStore(db, () => 1000);
  const loop = new ReflectionEngine({
    config: RSI,
    drafts,
    toolMemory: new ToolMemory(db, () => 1000),
    registry: { get: () => fakeAgent(), reloadAll: async () => {} } as unknown as AgentRegistry,
    providers: { get: () => provider } as unknown as ProviderRegistry,
    agentsDir,
    ...(builtinSkillsDir ? { builtinSkillsDir } : {}),
    now: () => 1000,
  });
  return { loop, drafts, calls };
}

/** The triage half. Every engine-level test goes through it before the answer under test. */
const TRIAGE_CREATE = JSON.stringify({ decision: "create", name: "restart-stuck-ingress", description: "Use when the ingress controller answers 502 after a node reboot.", closest: "none", why_not_update: "n/a", why: "" });

const ANSWER = JSON.stringify({
  name: "restart-stuck-ingress",
  description: "Use when the ingress controller answers 502 after a node reboot.",
  requires: "kubectl",
  body: "## When to Use\n- 502 after reboot\n\n## Procedure\n1. `kubectl rollout restart`",
});

const turnMessages: ChatMessage[] = [
  { role: "user", content: "kenapa ingress-nya 502" },
  { role: "tool", content: "error: connection refused" },
  { role: "assistant", content: "fixed" },
];

function recoveryTurn() {
  return {
    agentId: "nouva",
    gatewayId: "telegram:nouva",
    chatId: "123",
    sessionId: "ses_1",
    userText: "kenapa ingress-nya 502",
    messages: turnMessages,
    // Only this turn's messages, so a fixture is not accidentally a chain. The correction tests
    // build their own.
    chain: turnMessages,
    iterations: 2,
    steps: [
      { name: "exec", ok: false },
      { name: "exec", ok: false },
      { name: "exec", ok: true },
    ],
  };
}

describe("what a pass costs", () => {
  test("every call it makes is a row, metered as a reflection under the turn it looked at — not the session's", async () => {
    const db = freshDb();
    const usage = new UsageStore(db);
    const h = harness(ANSWER, {}, undefined, () => 1000, TRIAGE_CREATE, undefined, usage);
    await h.engine.observe({ ...recoveryTurn(), turnId: "turn_1" });

    const rows = db.prepare<{ purpose: string; turn_id: string | null; session_id: string | null }>("SELECT purpose, turn_id, session_id FROM llm_usage").all();
    expect(h.prompts.length).toBeGreaterThan(1);
    expect(rows).toEqual(h.prompts.map(() => ({ purpose: "reflection", turn_id: "turn_1", session_id: null })));
  });

  test("past today's cap no pass is made — nobody is waiting on one", async () => {
    const h = harness(ANSWER, {}, undefined, () => 1000, TRIAGE_CREATE, undefined, undefined, () => ({ action: "refuse", message: "over the cap" }));
    await h.engine.observe(recoveryTurn());
    expect(h.prompts).toEqual([]);
    expect(h.engine.pending()).toEqual([]);
  });
});

describe("the loop", () => {
  test("a recovered turn becomes a draft and nothing else", async () => {
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());

    const pending = h.engine.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.name).toBe("restart-stuck-ingress");
    expect(pending[0]?.triggerKind).toBe("error_recovery");
    // The whole point of the gate: proposing writes nothing and reloads nobody.
    expect(existsSync(join(h.agentsDir, "skills", "restart-stuck-ingress", "SKILL.md"))).toBe(false);
    expect(h.reloads).toBe(0);
  });

  test("an ordinary turn never reaches the provider", async () => {
    const h = harness(ANSWER);
    await h.engine.observe({ ...recoveryTurn(), userText: "makasih", steps: [{ name: "read", ok: true }] });
    expect(h.calls).toBe(0);
    expect(h.engine.pending()).toHaveLength(0);
  });

  test("one reflection per agent at a time: a turn that looked at nothing does not end another's", async () => {
    // The provider holds every call until released, so the first reflection is still waiting on its
    // model when the next two turns end. The second only said thanks; the third asks for a skill, which
    // skips the cooldown — so only the marker stands between it and a second synthesis.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let running = 0;
    let peak = 0;
    let calls = 0;
    const provider = {
      async chat(request: { messages: { content: string }[] }) {
        calls += 1;
        running += 1;
        peak = Math.max(peak, running);
        await held;
        running -= 1;
        const triage = (request.messages[0]?.content ?? "").includes("what should happen to the skill");
        return { text: triage ? TRIAGE_CREATE : ANSWER, toolCalls: [], stopReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    } as unknown as LLMProvider;
    const db = freshDb();
    const engine = new ReflectionEngine({
      config: RSI,
      drafts: new DraftStore(db, () => 1000),
      toolMemory: new ToolMemory(db, () => 1000),
      registry: { get: () => fakeAgent(), reloadAll: async () => {} } as unknown as AgentRegistry,
      providers: { get: () => provider } as unknown as ProviderRegistry,
      agentsDir: tempDir(),
      now: () => 1000,
    });
    const asks = (text: string) => ({ ...recoveryTurn(), userText: text, steps: [] });

    const first = engine.observe(asks("save this as a skill please"));
    for (let waited = 0; calls === 0 && waited < 2_000; waited += 5) await sleep(5);
    expect(calls).toBe(1);
    await engine.observe(asks("thanks"));
    const third = engine.observe(asks("turn that into a skill"));
    // Long enough for a second synthesis to reach the provider, if one was started.
    await sleep(50);

    release();
    await Promise.all([first, third]);
    // One reflection: its triage and its draft. A second would have made two more calls.
    expect(calls).toBe(2);
    expect(peak).toBe(1);
    expect(engine.pending()).toHaveLength(1);
  });

  test("it yields when the agent wrote the skill itself this turn", async () => {
    // Live, 2026-09-01: an agent holding `skill_create` hears "catet jadi skill ya" and calls the
    // tool. Two proposals for one skill, in two queues with two lifecycles, is a review surface
    // nobody trusts — so the loop stands down, and does not even pay for the provider call.
    const h = harness(ANSWER);
    await h.engine.observe({
      ...recoveryTurn(),
      userText: "catet jadi skill ya",
      steps: [
        { name: "exec", ok: true },
        { name: "skill_create", ok: true },
      ],
    });
    expect(h.calls).toBe(0);
    expect(h.engine.pending()).toHaveLength(0);
  });

  test("but a skill_create that failed is exactly what to reflect on", async () => {
    const h = harness(ANSWER);
    await h.engine.observe({
      ...recoveryTurn(),
      userText: "catet jadi skill ya",
      steps: [
        { name: "skill_create", ok: false },
        { name: "exec", ok: true },
      ],
    });
    expect(h.engine.pending()).toHaveLength(1);
  });

  test("a long chat where nothing ever failed still produces a draft", async () => {
    /**
     * The question that prompted the counter: *"bakal tetap berfungsi gak kalau turnnya panjang dan
     * user minta agent perbaiki terus? bukan masalah tool call gagal doang"*.
     *
     * Every tool call here succeeds. There is nothing for the failure counter to see, and no phrase
     * table is consulted — the loop looks because enough work has accumulated, and what it makes of
     * the conversation is the model's problem, not this file's.
     */
    const h = harness(ANSWER);
    const conversation: ChatMessage[] = [
      { role: "user", content: "bikinin script backup harian", timestamp: 1000 },
      { role: "assistant", content: "ini scriptnya", timestamp: 1000 },
      { role: "user", content: "bukan gitu, harusnya pakai cron", timestamp: 1000 },
      { role: "assistant", content: "oke", timestamp: 1000 },
      { role: "user", content: "nah gitu, udah jalan sekarang", timestamp: 1000 },
    ];

    // Enough rounds to reach the threshold, arriving as short turns that each did one thing. The
    // fixture's messages all carry the same timestamp, so every one of them counts as prompt — which
    // is what a person working through something looks like.
    for (let turn = 0; turn < 5; turn += 1) {
      await h.engine.observe({
        ...recoveryTurn(),
        userText: "lanjut",
        steps: [],
        iterations: 1,
        messages: conversation.slice(-2),
        chain: conversation,
      });
    }
    expect(h.engine.pending()).toHaveLength(0);

    await h.engine.observe({
      ...recoveryTurn(),
      userText: "nah gitu, udah jalan sekarang",
      steps: [{ name: "write", ok: true }],
      iterations: 1,
      messages: conversation.slice(-2),
      chain: conversation,
    });

    const draft = h.engine.pending()[0];
    expect(draft?.triggerKind).toBe("sustained_effort");
    // The transcript is the *chain*, not the last turn: the reasoning that found the answer is in
    // the turns that were wrong, and a draft synthesised from "nah gitu" alone would be empty.
    expect(h.engine.get(draft!.id)?.transcript).toContain("bikinin script backup harian");
  });

  test("a prompt back-and-forth reaches the threshold in far fewer turns", async () => {
    /**
     * Correction density, counted without reading a word of it.
     *
     * Ten exchanges spread over a day is a conversation; ten in fifteen minutes is somebody
     * steering. A turn that lands within three minutes of the agent's last word is worth an extra
     * round, so a dense chain reaches the threshold in six turns instead of ten — the first turn has
     * nothing to be prompt *after*, so it is 1 + 2(n-1). That is the tool-free chain that missed on
     * the live box.
     */
    let clock = 1_000_000;
    const h = harness(ANSWER, {}, undefined, () => clock);

    const exchange = (gapMs: number) => {
      clock += gapMs;
      const asked = clock;
      clock += 1000;
      return h.engine.observe({
        ...recoveryTurn(),
        userText: "lanjut",
        steps: [],
        iterations: 1,
        messages: [
          { role: "user" as const, content: "lanjut", timestamp: asked },
          { role: "assistant" as const, content: "ini", timestamp: clock },
        ],
      });
    };

    // 1 + 2×4 = 9 after five: not yet.
    for (let turn = 0; turn < 5; turn += 1) await exchange(20_000);
    expect(h.engine.pending()).toHaveLength(0);
    // The sixth crosses it, where a leisurely conversation would need ten.
    await exchange(20_000);
    expect(h.engine.pending()).toHaveLength(1);
  });

  test("and the window can be switched off entirely", async () => {
    // 0 means a round is a round whatever the pace — the plain counter, for somebody who finds the
    // density bonus too eager.
    let clock = 1_000_000;
    const h = harness(ANSWER, { rapidFollowUpMs: 0 }, undefined, () => clock);
    for (let turn = 0; turn < 6; turn += 1) {
      clock += 20_000;
      const asked = clock;
      clock += 1000;
      await h.engine.observe({
        ...recoveryTurn(),
        userText: "lanjut",
        steps: [],
        iterations: 1,
        messages: [
          { role: "user" as const, content: "lanjut", timestamp: asked },
          { role: "assistant" as const, content: "ini", timestamp: clock },
        ],
      });
    }
    expect(h.engine.pending()).toHaveLength(0);
  });

  test("but a leisurely one still takes the full count", async () => {
    let clock = 1_000_000;
    const h = harness(ANSWER, {}, undefined, () => clock);

    const exchange = (gapMs: number) => {
      clock += gapMs;
      const asked = clock;
      clock += 1000;
      return h.engine.observe({
        ...recoveryTurn(),
        userText: "lanjut",
        steps: [],
        iterations: 1,
        messages: [
          { role: "user" as const, content: "lanjut", timestamp: asked },
          { role: "assistant" as const, content: "ini", timestamp: clock },
        ],
      });
    };

    // Half an hour between messages: a conversation, not a push.
    for (let turn = 0; turn < 5; turn += 1) await exchange(30 * 60_000);
    expect(h.engine.pending()).toHaveLength(0);
    for (let turn = 0; turn < 5; turn += 1) await exchange(30 * 60_000);
    expect(h.engine.pending()).toHaveLength(1);
  });

  test("work done during a cooldown is not thrown away", async () => {
    /**
     * Measured on the live box before it was fixed: resetting the counter the moment a trigger
     * matched — rather than when a model call is actually about to be made — lost 14 of 119
     * reflections over 550 recorded turns. A conversation that did real work during a quiet hour
     * started again from zero and was never examined.
     */
    const second = JSON.stringify({
      name: "second-thing",
      description: "when the second thing happens",
      requires: "",
      body: "## Procedure\n1. do it",
      why: "worked out over several turns",
    });
    let clock = 1000;
    const h = harness([ANSWER, second], {}, undefined, () => clock);

    // One draft, which puts the agent inside its cooldown.
    await h.engine.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });
    expect(h.engine.pending()).toHaveLength(1);

    // Ten more rounds of real work, every one of them refused by the cooldown.
    for (let turn = 0; turn < 10; turn += 1) {
      await h.engine.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 1 });
    }
    expect(h.calls).toBe(1);

    // The cooldown lifts. The work is still on the books, so the very next turn is looked at
    // rather than starting the count again.
    clock += 120_000;
    await h.engine.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 1 });
    expect(h.calls).toBe(2);
  });

  test("a session may replace its own pending draft, and keeps learning after the first one", async () => {
    /**
     * Watched live on 2026-09-02. An afternoon setting up a Windows workstation raised a draft
     * against `infrastructure-ops` at 17:40, and the next two lessons from the same session were
     * thrown away for colliding with it — the pass ran, the call was paid for, and the result was
     * dropped on the floor. The person saw one proposal and concluded the agent had stopped
     * learning.
     *
     * One pending draft per skill is right. Making it the *stale* one is not: the second pass read a
     * longer version of the same conversation, so it knows everything the first did and more.
     */
    const improve = JSON.stringify({ decision: "update", target: "deployment", why: "a gap" });
    const revised = (body: string) => JSON.stringify({ body, why: "carries both lessons now" });

    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, {
      name: "deployment",
      description: "Shipping it.",
      body: "## Procedure\n1. build",
      author: "nouva",
    });
    let clock = 1000;
    const h = harness(
      [
        revised("## Procedure\n1. the first thing that worked"),
        revised("## Procedure\n1. the first thing\n2. AND-THE-SECOND"),
      ],
      {},
      agentsDir,
      () => clock,
      improve,
    );

    await h.engine.observe({ ...recoveryTurn(), steps: [], iterations: 10 });
    expect(h.engine.pending()).toHaveLength(1);
    const first = h.engine.pending()[0]?.id;

    // Past the cooldown: this is about the collision, not about how often the pass may look.
    clock += 120_000;
    await h.engine.observe({ ...recoveryTurn(), steps: [], iterations: 10 });

    // Still one — a queue of near-identical drafts is what the guard was for, and it still holds.
    const pending = h.engine.pending();
    expect(pending).toHaveLength(1);
    // But it is the newer one, and it carries what the second pass learned.
    expect(pending[0]?.id).not.toBe(first);
    expect(pending[0]?.body).toContain("AND-THE-SECOND");
  });

  test("a rewritten draft is announced too, and says it replaced the earlier one", async () => {
    /**
     * Reported by the operator: only the first draft of a session ever produced a message, so a
     * proposal that grew through the afternoon looked like a proposal that had stopped.
     *
     * The second notice has to *say* it replaced the first, or a person reading two messages about
     * one skill has no way to tell a rewrite from the daemon repeating itself — and would go looking
     * for two drafts when there is one.
     */
    const improve = JSON.stringify({ decision: "update", target: "deployment", why: "a gap" });
    const revised = (body: string) => JSON.stringify({ body, why: "more of it now" });

    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, {
      name: "deployment",
      description: "Shipping it.",
      body: "## Procedure\n1. build",
      author: "nouva",
    });
    let clock = 1000;
    // Notifications are off in the shared config, which is why this path had no coverage at all.
    const h = harness(
      [revised("## Procedure\n1. first"), revised("## Procedure\n1. first\n2. second")],
      { notifyChat: true },
      agentsDir,
      () => clock,
      improve,
    );

    await h.engine.observe({ ...recoveryTurn(), steps: [], iterations: 10 });
    clock += 120_000;
    await h.engine.observe({ ...recoveryTurn(), steps: [], iterations: 10 });

    expect(h.notices).toHaveLength(2);
    // The first reads as a proposal.
    expect(h.notices[0]).toContain("drafted an improvement to");
    // The second says what actually happened, and names the same skill.
    expect(h.notices[1]).toContain("replacing the earlier one");
    expect(h.notices[1]).toContain("deployment");
    // Both are short. The old wording ran to ten lines — a description, a `Needs:` line, the reason,
    // and a paragraph about the approval gate — and by the tenth of these nobody reads the paragraph.
    for (const notice of h.notices) expect(notice.split("\n").length).toBeLessThanOrEqual(5);
  });

  test("another session's improvement is built on the waiting one, not queued beside it", async () => {
    /**
     * These used to stack: same session replaced, a different session queued alongside, because two
     * conversations learned two different things and the approval gate is where that judgement
     * belongs. The reasoning was right and the mechanism was not.
     *
     * The live box on 2026-09-08 had four pending drafts for `infrastructure-ops` from two agents.
     * Each body was a full rewrite of the same skill and contained none of the others' lessons — one
     * carried the `lxc-attach` fix, one Headlamp, one the macOS cleanup. `updateExistingSkill`
     * overwrites the body whole, so approving all four keeps the last and silently discards three.
     * The person does four approvals and gets one.
     *
     * Nothing decides a lesson is redundant now either: the second revision is *given the first
     * draft's body* to work from, so it contains both. What the queue holds is one decision instead
     * of four that cancel each other.
     */
    const improve = JSON.stringify({ decision: "update", target: "deployment", why: "a gap" });
    const one = JSON.stringify({ body: "## Procedure\n1. FROM-SESSION-ONE", why: "ok" });
    // What a model does when handed the first draft's body and told to keep what is still true.
    const two = JSON.stringify({
      body: "## Procedure\n1. FROM-SESSION-ONE\n2. FROM-SESSION-TWO",
      why: "ok",
    });
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, {
      name: "deployment",
      description: "Shipping it.",
      body: "## Procedure\n1. build",
      author: "nouva",
    });
    let clock = 1000;
    const h = harness([one, two], {}, agentsDir, () => clock, improve);

    await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_1", steps: [], iterations: 10 });
    clock += 120_000;
    await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_2", steps: [], iterations: 10 });

    // One decision, carrying both lessons.
    expect(h.engine.pending()).toHaveLength(1);
    const body = h.engine.pending()[0]?.body ?? "";
    expect(body).toContain("FROM-SESSION-ONE");
    expect(body).toContain("FROM-SESSION-TWO");
  });

  test("the draft says how many lessons it absorbed, so the decision is not bigger than the reason", async () => {
    /**
     * The cost of building each revision on the last one, and the reason this field exists.
     *
     * The queue now holds one draft instead of four, which is what stopped three lessons being
     * dropped on approval — but the survivor's reason describes only the pass that wrote it. On the
     * live box a draft reading "Document that lxc-attach fails without chmod +x" could equally have
     * been carrying Headlamp and a macOS cleanup, and the person would have approved three changes
     * having read one sentence. Three rounds here, so the list has to accumulate rather than hold
     * only the immediately previous one.
     */
    // The lesson comes from *triage* — `revise` has no `why` field, because the sentence a reviewer
    // needs is the one that decided the skill was the right target.
    const triage = [
      "watchdog needs a restart hook",
      "ssh to the voice server needs -o",
      "the cert has to be renewed first",
    ].map((why) => JSON.stringify({ decision: "update", target: "deployment", why }));
    const answers = [
      JSON.stringify({ body: "## Procedure\n1. watchdog" }),
      JSON.stringify({ body: "## Procedure\n1. watchdog\n2. ssh" }),
      JSON.stringify({ body: "## Procedure\n1. watchdog\n2. ssh\n3. tls" }),
    ];
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, {
      name: "deployment",
      description: "Shipping it.",
      body: "## Procedure\n1. build",
      author: "nouva",
    });
    let clock = 1000;
    const h = harness(answers, {}, agentsDir, () => clock, triage);

    for (const session of ["ses_1", "ses_2", "ses_3"]) {
      await h.engine.observe({ ...recoveryTurn(), sessionId: session, steps: [], iterations: 10 });
      clock += 120_000;
    }

    expect(h.engine.pending()).toHaveLength(1);
    const draft = h.engine.pending()[0]!;
    // Its own reason is the newest lesson; the two before it are named, oldest first.
    expect(draft.triggerReason).toContain("cert has to be renewed");
    expect(draft.carries).toEqual([
      "watchdog needs a restart hook",
      "ssh to the voice server needs -o",
    ]);
  });

  test("a first draft carries nothing, and the bookkeeping clause is not mistaken for a lesson", async () => {
    /**
     * Two things at once, because they share the mechanism. A draft nobody superseded has an empty
     * list — anything else would make the count meaningless. And a reason is `<why> · masked: …`,
     * so the lesson pulled out of it has to be the first clause only: recording "masked: api-key" as
     * a lesson would put a redaction notice in front of the next reviewer as if it were knowledge.
     */
    const triage = [
      JSON.stringify({ decision: "update", target: "deployment", why: "use the stored key" }),
      JSON.stringify({ decision: "update", target: "deployment", why: "and then this" }),
    ];
    // A body carrying something the redactor will mask, so the draft's reason gains a `masked:`
    // clause and the lesson pulled out of it has to stop before that clause.
    const first = JSON.stringify({ body: "## Procedure\n1. token AKIAIOSFODNN7EXAMPLE" });
    const second = JSON.stringify({ body: "## Procedure\n1. next" });
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, {
      name: "deployment",
      description: "Shipping it.",
      body: "## Procedure\n1. build",
      author: "nouva",
    });
    let clock = 1000;
    const h = harness([first, second], {}, agentsDir, () => clock, triage);

    await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_1", steps: [], iterations: 10 });
    expect(h.engine.pending()[0]?.carries).toEqual([]);

    clock += 120_000;
    await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_2", steps: [], iterations: 10 });
    expect(h.engine.pending()[0]?.carries).toEqual(["use the stored key"]);
  });

  test("the second pass is handed the waiting draft's body, not the file on disk", () => {
    /**
     * The mechanism behind the test above, asserted separately because the test above would also
     * pass if the model simply happened to repeat itself. What must be true is that the *input*
     * changed: read from disk, the second pass starts from `1. build` again and cannot carry
     * anything forward however well it behaves.
     */
    const improve = JSON.stringify({ decision: "update", target: "deployment", why: "a gap" });
    const one = JSON.stringify({ body: "## Procedure\n1. FROM-SESSION-ONE", why: "ok" });
    const two = JSON.stringify({ body: "## Procedure\n1. whatever", why: "ok" });
    return (async () => {
      const agentsDir = tempDir();
      await writeNewSkill(agentsDir, {
        name: "deployment",
        description: "Shipping it.",
        body: "## Procedure\n1. ONLY-ON-DISK",
        author: "nouva",
      });
      let clock = 1000;
      const h = harness([one, two], {}, agentsDir, () => clock, improve);

      await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_1", steps: [], iterations: 10 });
      clock += 120_000;
      h.prompts.length = 0;
      await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_2", steps: [], iterations: 10 });

      const revise = h.prompts.find((text) => text.includes("Skill: deployment")) ?? "";
      expect(revise).toContain("FROM-SESSION-ONE");
      expect(revise).not.toContain("ONLY-ON-DISK");
    })();
  });

  test("a superseded draft's files come along, so its pointer is not left dangling", async () => {
    /**
     * The body is inherited through `readSkill`; support files are not in the body. Both live drafts
     * on the box shipped a `references/` file, so without this an improvement that retires one
     * writes a body pointing at a file nobody ever creates — and it would only be noticed by the
     * agent that followed the pointer, weeks later.
     */
    const improve = JSON.stringify({ decision: "update", target: "deployment", why: "a gap" });
    const one = JSON.stringify({
      body: "## Procedure\n1. see references/first.md",
      files: [{ path: "references/first.md", content: "the first lesson" }],
      why: "ok",
    });
    const two = JSON.stringify({
      body: "## Procedure\n1. see references/first.md\n2. see references/second.md",
      files: [{ path: "references/second.md", content: "the second lesson" }],
      why: "ok",
    });
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, {
      name: "deployment",
      description: "Shipping it.",
      body: "## Procedure\n1. build",
      author: "nouva",
    });
    let clock = 1000;
    const h = harness([one, two], {}, agentsDir, () => clock, improve);

    await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_1", steps: [], iterations: 10 });
    clock += 120_000;
    await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_2", steps: [], iterations: 10 });

    const paths = (h.engine.pending()[0]?.files ?? []).map((f) => f.path).sort();
    expect(paths).toEqual(["references/first.md", "references/second.md"]);
  });

  test("a decline starts a cooldown too, or one session pays for the same refusal all afternoon", async () => {
    /**
     * The cooldown read `drafts.lastDraftAt` — the last time a draft was *written*. A pass the model
     * declined wrote nothing, so it started no cooldown, and the next qualifying turn paid for
     * another call carrying the whole conversation.
     *
     * Measured on the live box on 2026-09-02: fourteen declines against one draft in a day, eight of
     * them inside one half-hour session. A session declined for a reason will be declined again for
     * the same reason.
     */
    const skip = JSON.stringify({ decision: "skip", reason: "nothing durable here" });
    let clock = 1000;
    const h = harness([skip, skip], {}, undefined, () => clock);

    await h.engine.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });
    expect(h.calls).toBe(1);
    expect(h.engine.pending()).toHaveLength(0);

    // Ten more qualifying turns inside the window. Before the fix every one of these was a call.
    for (let turn = 0; turn < 10; turn += 1) {
      await h.engine.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });
    }
    expect(h.calls).toBe(1);

    // And it is a cooldown, not a mute: once it lifts, the pass looks again.
    clock += 120_000;
    await h.engine.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });
    expect(h.calls).toBe(2);
  });

  test("and the counter starts again after the pass has looked", async () => {
    // Reset when the pass *runs*, not when it produces something. A decline that left the counter
    // high would re-ask on the very next turn and keep paying for the same refusal.
    const h = harness(ANSWER);
    for (let turn = 0; turn < 10; turn += 1) {
      await h.engine.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 1 });
    }
    expect(h.calls).toBe(1);

    await h.engine.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 1 });
    expect(h.calls).toBe(1);
  });

  /**
   * Three levels, because whether to *look* and whether to *trust the result* are separate questions.
   *
   * `enabled` was a boolean and could not say the second one. Hermes answers it `always_allow`: its
   * background review writes skills through its own tools with no gate and auto-denies anything that
   * would have asked. That is right for one person's homelab and wrong for a daemon somebody else
   * talks to, so it is a setting rather than a decision.
   */
  describe("mode", () => {
    test("require_approval drafts and waits, exactly as `enabled = true` did", async () => {
      const h = harness(ANSWER, { mode: "ask" });
      await h.engine.observe(recoveryTurn());
      expect(h.engine.pending()).toHaveLength(1);
      expect(h.reloads).toBe(0);
    });

    /**
     * Repeated rewrites of one skill, which is what `always_allow` actually produces.
     *
     * The first version of these tests used the *create* path and proved nothing: the second pass
     * hit the "a skill of that name already exists" guard long before reaching the window, so they
     * passed with the window deleted. The live failure was twelve *improvements* to one skill, so
     * that is the path under test.
     */
    async function seededUpdater(clock: () => number) {
      const agentsDir = tempDir();
      await writeNewSkill(agentsDir, {
        name: "deployment",
        description: "Shipping it.",
        body: "## Procedure\n1. build",
        author: "nouva",
      });
      const improve = JSON.stringify({ decision: "update", target: "deployment", why: "a gap" });
      const revised = JSON.stringify({ description: "Shipping it.", requires: "", body: "## Procedure\n1. build\n2. more" });
      return harness([revised], { mode: "auto" }, agentsDir, clock, improve);
    }

    test("a skill written unattended is left alone for a while", async () => {
      /**
       * `always_allow` removed the thing that used to stop repeats.
       *
       * Under `require_approval` a second lesson about the same skill supersedes the draft still
       * waiting for a decision, so the queue holds one. Approve immediately and there is never a
       * pending draft to supersede — so the same skill is rewritten every time effort crosses the
       * threshold again, and every write reloads every agent. Watched on a live box: the same skill
       * three times in twenty-one minutes.
       */
      let clock = 1_000_000;
      const h = await seededUpdater(() => clock);

      await h.engine.observe({ ...recoveryTurn(), steps: [], iterations: 10 });
      expect(h.reloads).toBe(1);

      // Two minutes on. The ordinary cooldown is one minute here, so only the new window can stop it.
      clock += 2 * 60_000;
      await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_2", steps: [], iterations: 10 });
      expect(h.reloads).toBe(1);

      // Past the window it may write again: this damps a repeat, it does not end the loop.
      clock += 11 * 60_000;
      await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_3", steps: [], iterations: 10 });
      expect(h.reloads).toBe(2);
    });

    test("it damps that one skill and nothing else the agent might learn", async () => {
      /**
       * An earlier version keyed this on the *agent* and stopped everything it might learn for ten
       * minutes — a strange thing to do to somebody who turned autonomous learning on to get more
       * of it, and it suppresses the case the loop exists for in order to damp the case it does not.
       */
      const agentsDir = tempDir();
      for (const name of ["deployment", "rotate-the-certs"]) {
        await writeNewSkill(agentsDir, {
          name,
          description: `${name} matters.`,
          body: "## Procedure\n1. do it",
          author: "nouva",
        });
      }
      let clock = 1_000_000;
      const h = harness(
        [JSON.stringify({ description: "d", requires: "", body: "## Procedure\n1. do it\n2. more" })],
        { mode: "auto" },
        agentsDir,
        () => clock,
        // Two different targets, so the second pass is a different skill entirely.
        [
          JSON.stringify({ decision: "update", target: "deployment", why: "a gap" }),
          JSON.stringify({ decision: "update", target: "rotate-the-certs", why: "another gap" }),
        ],
      );

      await h.engine.observe({ ...recoveryTurn(), steps: [], iterations: 10 });
      expect(h.reloads).toBe(1);

      clock += 2 * 60_000;
      await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_2", steps: [], iterations: 10 });
      expect(h.reloads).toBe(2);
    });

    test("asking in words still gets through the window", async () => {
      // A person asking is not noise, and asking twice means they meant it. `user_request` skips
      // the ordinary cooldown already; it has to skip this one too or the two disagree.
      let clock = 1_000_000;
      const h = await seededUpdater(() => clock);
      await h.engine.observe({ ...recoveryTurn(), steps: [], iterations: 10 });
      expect(h.reloads).toBe(1);

      clock += 60_000;
      await h.engine.observe({
        ...recoveryTurn(),
        sessionId: "ses_2",
        userText: "catet jadi skill ya",
        steps: [],
      });
      expect(h.reloads).toBe(2);
    });

    test("always_allow puts it in the pool without asking, and says who did", async () => {
      const h = harness(ANSWER, { mode: "auto" });
      await h.engine.observe(recoveryTurn());

      // Nothing waiting, because it was decided. The reload is what proves it reached the pool
      // rather than only being marked approved.
      expect(h.engine.pending()).toHaveLength(0);
      expect(h.reloads).toBe(1);
      const decided = h.engine.recent(5);
      expect(decided[0]?.status).toBe("approved");
      // Truthfully attributed. "Who let this in" must have an answer, and it must not be a person.
      expect(decided[0]?.decidedBy).toBe("skill-learning:auto");
    });

    test("an unrecognised mode is gated, never autonomous", async () => {
      /**
       * The asymmetry that decides how this is written. The loader tolerates a bad enum rather than
       * refusing to boot — a file it accepted yesterday must not stop it starting — so the check
       * cannot be "anything that is not off". Read as gated, a typo costs one approval; read as
       * autonomous, it puts an unreviewed skill in front of every agent here.
       */
      const h = harness(ANSWER, { mode: "always-allow" as never });
      await h.engine.observe(recoveryTurn());
      expect(h.engine.pending()).toHaveLength(1);
      expect(h.reloads).toBe(0);
    });

    test("always_allow still tells the chat, in the past tense", async () => {
      // Nobody was asked; that is not the same as nobody being told. The pool changed under every
      // agent, and a message offering approve/deny for something already live is how a notification
      // teaches people to ignore it.
      const h = harness(ANSWER, { mode: "auto", notifyChat: true });
      await h.engine.observe(recoveryTurn());
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]).toContain("kept it as a skill");
      expect(h.notices[0]).not.toContain("approve");
    });
  });

  test("switched off, it does nothing at all", async () => {
    const h = harness(ANSWER, { mode: "off" });
    await h.engine.observe(recoveryTurn());
    expect(h.calls).toBe(0);
    expect(h.engine.pending()).toHaveLength(0);
  });

  test("the cooldown stops an afternoon of one broken system becoming a dozen drafts", async () => {
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());
    await h.engine.observe(recoveryTurn());
    expect(h.engine.pending()).toHaveLength(1);
    // The second turn never even asked the model.
    expect(h.calls).toBe(1);
  });

  test("a person asking ignores the cooldown", async () => {
    const second = JSON.stringify({
      name: "another-thing",
      description: "when the other thing happens",
      requires: "",
      body: "## Procedure\n1. do it",
    });
    const h = harness([ANSWER, second]);

    // First draft puts the agent inside its cooldown; a heuristic trigger would be refused here.
    await h.engine.observe(recoveryTurn());
    await h.engine.observe({ ...recoveryTurn(), userText: "catet jadi skill ya" });

    const kinds = h.engine.pending().map((draft) => draft.triggerKind);
    expect(kinds).toContain("user_request");
    expect(h.engine.pending()).toHaveLength(2);
  });

  test("a credential the model copied into the body is masked, and the draft says so", async () => {
    const leaky = JSON.stringify({
      name: "leaky-procedure",
      description: "when you need the key",
      requires: "",
      body: "## Procedure\n1. export API_TOKEN=ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const h = harness(leaky);
    await h.engine.observe(recoveryTurn());

    const draft = h.engine.pending()[0];
    expect(draft?.body).not.toContain("ghp_bbbb");
    // Said on the draft rather than silently: a reviewer seeing `[redacted:…]` in a procedure needs
    // to know that is the daemon's doing.
    expect(draft?.triggerReason).toContain("masked");
  });

  test("approving writes the pool file, reloads every agent, and records where it went", async () => {
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());
    const draft = h.engine.pending()[0]!;

    const result = await h.engine.approve(draft.id, "gading");
    expect(result.ok).toBe(true);

    const path = join(h.agentsDir, "skills", "restart-stuck-ingress", "SKILL.md");
    expect(existsSync(path)).toBe(true);
    expect(h.reloads).toBe(1);

    const { fields, body } = parseFrontmatter(readFileSync(path, "utf8"));
    expect(fields.name).toBe("restart-stuck-ingress");
    expect(fields.requires).toBe("kubectl");
    // Provenance: who wrote it and who let it in. This is the audit trail a pooled skill needs,
    // because it is now in every agent's prompt.
    expect(fields.author).toBe("nouva");
    expect(fields.verified_by).toBe("gading");
    expect(body).toContain("kubectl rollout restart");

    expect(h.engine.get(draft.id)?.status).toBe("approved");
    expect(h.engine.get(draft.id)?.publishedPath).toBe(path);
  });

  test("a correction made at approval time is what lands on disk", async () => {
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());
    const draft = h.engine.pending()[0]!;

    // The predictable correction: `requires:` is a local PATH lookup, and a procedure that
    // runs kubectl over ssh needs `ssh`, not the remote's tooling.
    await h.engine.approve(draft.id, "gading", { requires: "ssh", description: "corrected" });

    const path = join(h.agentsDir, "skills", "restart-stuck-ingress", "SKILL.md");
    const { fields } = parseFrontmatter(readFileSync(path, "utf8"));
    expect(fields.requires).toBe("ssh");
    expect(fields.description).toBe("corrected");
  });

  test("approving twice is refused rather than overwriting", async () => {
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());
    const draft = h.engine.pending()[0]!;

    expect((await h.engine.approve(draft.id, "gading")).ok).toBe(true);
    const again = await h.engine.approve(draft.id, "gading");
    expect(again.ok).toBe(false);
  });

  test("discarding deletes and writes nothing", async () => {
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());
    const draft = h.engine.pending()[0]!;

    expect(h.engine.deny(draft.id, "gading")).toBe(true);
    expect(h.engine.get(draft.id)).toBeNull();
    expect(existsSync(join(h.agentsDir, "skills", "restart-stuck-ingress", "SKILL.md"))).toBe(false);
  });

  test("it improves an existing skill instead of adding a second one", async () => {
    /**
     * The verb the loop was missing, and the reason it was missing mattered: over three days on the
     * live box, 8 of 39 refusals were "already covered by an existing skill" — eight skills that
     * could have been made better and were left alone.
     */
    const h = harness([]);
    await writeNewSkill(h.agentsDir, {
      name: "deploy-checklist",
      description: "Before a release.",
      body: "## Procedure\n1. tag it",
      author: "nouva",
      created: "2026-08-01",
    });

    // Triage says improve; the revision returns the better body.
    const engine = enginePointedAt(h.agentsDir, {
      triage: JSON.stringify({ decision: "update", target: "deploy-checklist", why: "you added the staging step" }),
      revise: JSON.stringify({
        description: "Before a release, including staging.",
        requires: "",
        body: "## Procedure\n1. tag it\n2. push to staging first",
        files: [{ path: "references/rollback.md", content: "how to roll back" }],
      }),
    });

    await engine.loop.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });

    const draft = engine.loop.pending()[0];
    expect(draft?.target).toBe("deploy-checklist");
    expect(draft?.files).toHaveLength(1);
    expect(draft?.triggerReason).toContain("staging step");

    // Approving overwrites the file rather than refusing because the name is taken, and provenance
    // survives the improvement.
    expect((await engine.loop.approve(draft!.id, "gading")).ok).toBe(true);
    const { fields, body } = parseFrontmatter(readFileSync(skillMd(h.agentsDir, "deploy-checklist"), "utf8"));
    expect(body).toContain("push to staging first");
    expect(fields.author).toBe("nouva");
    expect(fields.created).toBe("2026-08-01");
    expect(readFileSync(join(h.agentsDir, "skills", "deploy-checklist", "references", "rollback.md"), "utf8"))
      .toBe("how to roll back");
  });

  test("an update whose target vanished while it waited is refused, not turned into a create", async () => {
    const h = harness([]);
    // An agent's skill: one a person wrote is never drafted for, so it could not vanish while a draft waited.
    await writeNewSkill(h.agentsDir, { name: "doomed", description: "x", body: "y", author: "nouva" });
    const engine = enginePointedAt(h.agentsDir, {
      triage: JSON.stringify({ decision: "update", target: "doomed", why: "add a step" }),
      revise: JSON.stringify({ description: "x", requires: "", body: "improved" }),
    });
    await engine.loop.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });
    const draft = engine.loop.pending()[0]!;

    await deletePoolSkill(h.agentsDir, "doomed");
    const result = await engine.loop.approve(draft.id, "gading");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("to update");
  });

  test("a proposal for a name already in the pool is dropped", async () => {
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());
    await h.engine.approve(h.engine.pending()[0]!.id, "gading");

    // A second daemon-lifetime — fresh drafts table, same pool on disk — and the pass proposes the
    // same name again. `writeNewSkill` would refuse to overwrite, but the queue should never get
    // that far: a draft for a skill that already exists is a decision nobody should have to make.
    const later = harness(ANSWER, {}, h.agentsDir);
    await later.engine.observe(recoveryTurn());
    expect(later.engine.pending()).toHaveLength(0);
  });
});

describe("the skill file", () => {
  test("what is written is what the loader parses back", () => {
    // One renderer for `skill_create` and for an approved draft, so the two cannot drift — and a
    // description containing a colon has to survive, because the frontmatter is not YAML.
    const markdown = renderSkillMarkdown({
      name: "deploy-checklist",
      description: "Before a release: the four things that have gone wrong.",
      requires: "git, ssh",
      body: "## Procedure\n1. tag it",
      author: "nouva",
      verifiedBy: "gading",
      created: "2026-09-01",
    });

    const { fields, body } = parseFrontmatter(markdown);
    expect(fields.description).toBe("Before a release: the four things that have gone wrong.");
    expect(fields.requires).toBe("git, ssh");
    expect(fields.created).toBe("2026-09-01");
    expect(body.trim()).toBe("## Procedure\n1. tag it");
  });
});

// ── the chat surface ──────────────────────────────────────────────────────────

describe("/drafts", () => {
  const hook = draftHooks[0]!;

  function ctx(args: string[], engine?: ReflectionEngine): HookContext {
    return {
      senderId: "gading",
      args,
      deps: { ...(engine ? { drafts: engine } : {}) },
    } as unknown as HookContext;
  }

  test("says so plainly when the loop is not wired", async () => {
    const result = await hook.handler(ctx([]));
    expect(result.reply).toContain("not wired");
  });

  test("lists what is waiting, and that nothing expires", async () => {
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());

    const result = await hook.handler(ctx([], h.engine));
    expect(result.reply).toContain("restart-stuck-ingress");
    // The property people do not expect from a pending list, and the one that decides whether they
    // feel they have to clear it tonight.
    expect(result.reply).toContain("Nothing expires");
  });

  test("`/drafts approve` with nothing after it takes the whole queue", async () => {
    /**
     * Asked for, and only for approve. Denying deletes the row and its transcript, so a bare
     * `/drafts deny` would be one keystroke between a queue and nothing; approving in bulk is
     * undoable one skill at a time with `nouride skills off`.
     */
    // Two answers with *different* names, so the second is a second draft rather than a supersede.
    const second = JSON.stringify({
      name: "rotate-the-certs",
      description: "When the cert is about to expire.",
      requires: "",
      body: "## Procedure\n1. renew it",
    });
    let clock = 1000;
    const h = harness([ANSWER, second], {}, tempDir(), () => clock);
    await h.engine.observe(recoveryTurn());
    clock += 60 * 60_000;
    await h.engine.observe({ ...recoveryTurn(), sessionId: "ses_2" });
    expect(h.engine.pending()).toHaveLength(2);

    const result = await hook.handler(ctx([], h.engine));
    expect(result.reply).toContain("takes all 2");

    const approved = await hook.handler(ctx(["approve"], h.engine));
    expect(approved.reply).toContain("Approved 2");
    expect(approved.reply).toContain("restart-stuck-ingress");
    expect(approved.reply).toContain("rotate-the-certs");
    expect(h.engine.pending()).toHaveLength(0);
  });

  test("`/drafts approve` on an empty queue says so rather than claiming success", async () => {
    const h = harness(ANSWER);
    const result = await hook.handler(ctx(["approve"], h.engine));
    expect(result.reply).toContain("Nothing is waiting");
  });

  test("`/drafts deny` still refuses to act without a name", async () => {
    // The asymmetry is the point: bulk approve is convenient, bulk deny is a queue deleted by
    // somebody who typed four characters.
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());
    const result = await hook.handler(ctx(["deny"], h.engine));
    expect(result.reply).toContain("Name a draft");
    expect(h.engine.pending()).toHaveLength(1);
  });

  test("a draft is approved by its name, not by its id", async () => {
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());

    const result = await hook.handler(ctx(["approve", "restart-stuck-ingress"], h.engine));
    // On for the agent that learned it — not "every agent has it", which the chat said until 0.7.27.
    expect(result.reply).toContain("**restart-stuck-ingress** is in the pool, on for nouva from the next message");
    expect(result.reply).not.toContain("Every agent");
    expect(existsSync(join(h.agentsDir, "skills", "restart-stuck-ingress", "SKILL.md"))).toBe(true);
    expect(h.engine.pending()).toHaveLength(0);
  });

  test("denying deletes it and writes nothing", async () => {
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());

    await hook.handler(ctx(["deny", "restart-stuck-ingress"], h.engine));
    expect(h.engine.pending()).toHaveLength(0);
    expect(existsSync(join(h.agentsDir, "skills", "restart-stuck-ingress", "SKILL.md"))).toBe(false);
  });

  test("a name nobody proposed is refused rather than guessed at", async () => {
    const h = harness(ANSWER);
    await h.engine.observe(recoveryTurn());

    const result = await hook.handler(ctx(["approve", "something-else"], h.engine));
    expect(result.reply).toContain("No draft");
    expect(h.engine.pending()).toHaveLength(1);
  });
});

describe("deleting a skill from the pool", () => {
  const doc = {
    name: "throwaway-skill",
    description: "when the test needs something to delete",
    body: "## Procedure\n1. exist",
  };

  test("takes the whole directory, not just SKILL.md", async () => {
    const agentsDir = tempDir();
    const written = await writeNewSkill(agentsDir, doc);
    expect(written.ok).toBe(true);

    // A support file beside it. Leaving these behind would make the name un-recreatable —
    // `writeNewSkill` refuses an existing path, and nothing would say why.
    const dir = join(agentsDir, "skills", doc.name);
    writeFileSync(join(dir, "notes.md"), "detail");

    const removed = await deletePoolSkill(agentsDir, doc.name);
    expect(removed.ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("a name that is not there is said so, not silently ignored", async () => {
    const result = await deletePoolSkill(tempDir(), "never-existed");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no skill called");
  });

  test("a name that could escape the pool is refused before any path is built", async () => {
    // The security boundary, not a politeness: a name is a path segment, and `removePath` is
    // recursive. The pattern admits lowercase letters, digits and hyphens, so traversal cannot be
    // spelled in it — but the check has to happen before the join, and this is what proves it does.
    const agentsDir = tempDir();
    const outside = join(agentsDir, "keep-me");
    mkdirSync(outside, { recursive: true });

    for (const evil of ["../keep-me", "../../etc", "..", "/etc", "a/../../b"]) {
      const result = await deletePoolSkill(agentsDir, evil);
      expect(result.ok).toBe(false);
    }
    expect(existsSync(outside)).toBe(true);
  });

  test("the name can be used again afterwards", async () => {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, doc);
    await deletePoolSkill(agentsDir, doc.name);
    expect((await writeNewSkill(agentsDir, doc)).ok).toBe(true);
  });
});

/**
 * Improving a skill instead of only adding one — the verb the loop was missing.
 *
 * Measured motivation: over three days on the live box, 8 of 39 refusals were "already covered by an
 * existing skill". Every one was a skill that could have been made better and was left alone.
 */
describe("improving an existing skill", () => {
  const original = {
    name: "deploy-checklist",
    description: "Before a release.",
    body: "## Procedure\n1. tag it",
    author: "nouva",
    created: "2026-08-01",
  };

  test("overwrites the body and keeps who wrote it first", async () => {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, original);

    const updated = await updateExistingSkill(agentsDir, {
      name: original.name,
      description: "Before a release, including the staging step.",
      body: "## Procedure\n1. tag it\n2. push to staging first",
      author: "nero",
      verifiedBy: "gading",
      updated: "2026-09-01",
    });
    expect(updated.ok).toBe(true);

    const { fields, body } = parseFrontmatter(readFileSync(skillMd(agentsDir, original.name), "utf8"));
    expect(body).toContain("push to staging first");
    // Provenance survives: the agent that first worked this out still wrote it, and the skill can
    // still answer "where did this come from" after any number of improvements.
    expect(fields.author).toBe("nouva");
    expect(fields.created).toBe("2026-08-01");
    expect(fields.updated).toBe("2026-09-01");
    expect(fields.verified_by).toBe("gading");
  });

  test("listDir on a skill with no support directories is empty, not a throw", async () => {
    /**
     * The common case, and the one that would break every reflection if it threw: most skills have
     * no `references/` at all, so the lister runs against three directories that do not exist.
     * `listDir` swallows that; asserted here because the pass calls it on every improvement and a
     * throw would take the whole reflection with it.
     */
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, original);
    expect(existsSync(join(agentsDir, "skills", original.name, "references"))).toBe(false);
    expect(listDir(join(agentsDir, "skills", original.name, "references"))).toEqual([]);
  });

  test("triage can read a skill before deciding it is already covered", async () => {
    /**
     * The half of the gap the file reader did not close.
     *
     * Triage sees one description line per skill — deliberately, because eighteen bodies is tens of
     * thousands of tokens on every reflection. That shortlists and does not settle: "already
     * covered" and "that is the gap in it" look the same from a description and are opposite
     * answers. Hermes' review forks the whole agent and can `skill_view` anything; this is the
     * narrow version, scoped to the pool the list came from.
     *
     * Scripted with triage asking, because that is the call under test — the revise reader already
     * had coverage and this one had none.
     */
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, {
      name: "deployment",
      description: "Shipping it.",
      body: "## Procedure\n1. build\nONLY-IN-THE-BODY",
      author: "nouva",
    });

    const served: string[] = [];
    let asked = false;
    const provider = {
      async chat(request: { messages: { content: string; role: string }[]; tools?: { name: string }[] }) {
        const instruction = request.messages[0]?.content ?? "";
        if (!instruction.includes("what should happen to the skill")) {
          return {
            text: JSON.stringify({ description: "Shipping it.", requires: "", body: "## Procedure\n1. build\n2. more" }),
            toolCalls: [],
            stopReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        for (const m of request.messages) if (m.role === "tool") served.push(m.content);
        if (!asked) {
          asked = true;
          // The tool has to be *offered* to triage, which it never was before this change.
          expect(request.tools?.map((t) => t.name)).toContain("read_skill");
          return {
            text: "",
            toolCalls: [{ id: "t1", name: "read_skill", arguments: { name: "deployment" } }],
            stopReason: "tool_calls" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        return {
          text: JSON.stringify({ decision: "update", target: "deployment", why: "read it, there is a gap" }),
          toolCalls: [],
          stopReason: "stop" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as unknown as LLMProvider;

    const loop = new ReflectionEngine({
      config: RSI,
      drafts: new DraftStore(freshDb(), () => 1000),
      toolMemory: new ToolMemory(freshDb(), () => 1000),
      registry: { get: () => fakeAgent(), reloadAll: async () => {} } as unknown as AgentRegistry,
      providers: { get: () => provider } as unknown as ProviderRegistry,
      agentsDir,
      now: () => 1000,
    });

    await loop.observe({ ...recoveryTurn(), steps: [], iterations: 10 });

    // It got the body, not the description it already had.
    expect(served.join("\n")).toContain("ONLY-IN-THE-BODY");
    expect(loop.pending()[0]?.target).toBe("deployment");
  });

  test("it reads a reference before rewriting it, and gets the real contents", async () => {
    /**
     * The gap this closes. The revise pass used to get `SKILL.md` and the transcript and nothing
     * else, so it could only propose body edits — which is most of why the improvements read thin —
     * and `files` replaces by name, so a pass picking `references/hosts.md` would overwrite a
     * reference an earlier round attached without ever having seen it.
     *
     * Hermes gets this by forking the whole agent with its full toolset. This is one read-only tool
     * scoped to the skill's own directory, because the pass runs unattended with no approval gate:
     * an unscoped reader there is a filesystem reachable by a model nobody is watching.
     */
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, {
      ...original,
      files: [{ path: "references/hosts.md", content: "the old notes about hosts" }],
    });

    const engine = engineThatReads(agentsDir, {
      triage: JSON.stringify({ decision: "update", target: original.name, why: "a host was added" }),
      wants: "references/hosts.md",
      revise: JSON.stringify({
        description: original.description,
        requires: "",
        body: "## Procedure\n1. see references/hosts.md",
        files: [{ path: "references/hosts.md", content: "the old notes about hosts\nplus the new one" }],
      }),
    });

    await engine.loop.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });

    expect(engine.served).toContain("the old notes about hosts");
    // Extended rather than replaced — the whole point of letting it read first.
    const draft = engine.loop.pending()[0];
    expect(draft?.files[0]?.content).toContain("the old notes about hosts");
    expect(draft?.files[0]?.content).toContain("plus the new one");
  });

  test("a traversal cannot reach a file that really is there", async () => {
    /**
     * My first version of this test proved nothing, and the way it failed is worth keeping.
     *
     * It asked for `../../../config.toml` and asserted the answer said "No file". With the boundary
     * *deleted* it still said "No file" — nothing exists at that path from a temp directory, so the
     * read missed for the wrong reason and the test passed either way. A guard test has to point at
     * something the guard is the only thing stopping.
     *
     * So there is now a real file one level above the pool, and the traversal that would reach it is
     * exactly the shape a model produces. Both inputs to the reader come from the model: the skill
     * *name* resolves through the pool listing, and the *path* is matched against the same pattern
     * that governs writing.
     */
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, original);
    const secret = join(agentsDir, "not-yours.txt");
    writeFileSync(secret, "SENTINEL-c0ffee");
    // The path a traversal has to take from inside the skill directory to reach it.
    expect(readFileSync(join(agentsDir, "skills", original.name, "..", "..", "not-yours.txt"), "utf8")).toBe(
      "SENTINEL-c0ffee",
    );

    const engine = engineThatReads(agentsDir, {
      triage: JSON.stringify({ decision: "update", target: original.name, why: "x" }),
      wants: "../../not-yours.txt",
      revise: JSON.stringify({ description: original.description, requires: "", body: "## Procedure\n1. tag it" }),
    });

    await engine.loop.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });

    const handed = engine.served.join("\n");
    expect(handed).not.toContain("SENTINEL-c0ffee");
    // Told what was not found rather than handed an empty string: a model given nothing asks again,
    // and that is how a round budget goes on one bad path. The wording covers both readers now —
    // one serves file paths, one serves skill names — so it names neither.
    expect(handed).toContain("Nothing called");
    expect(handed).toContain("../../not-yours.txt");
  });

  test("a model that keeps asking runs out of rounds and produces nothing", async () => {
    /**
     * The other test I had to rewrite. It scripted a provider that asked *once*, so the loop never
     * went round twice and withholding the tool on the final round was never exercised — the
     * sabotage of removing that cap passed clean.
     *
     * This provider asks forever. What is asserted is that the pass terminates and gives up rather
     * than looping: a model that can always request one more file will, and there is nobody waiting
     * on this pass to notice that it has not come back.
     */
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, original);

    let calls = 0;
    const provider = {
      async chat(request: { messages: { content: string }[]; tools?: unknown[] }) {
        const instruction = request.messages[0]?.content ?? "";
        if (instruction.includes("what should happen to the skill")) {
          return {
            text: JSON.stringify({ decision: "update", target: original.name, why: "x" }),
            toolCalls: [],
            stopReason: "stop" as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        }
        calls += 1;
        return {
          text: "",
          toolCalls: [{ id: `c${calls}`, name: "read_skill_file", arguments: { path: "references/hosts.md" } }],
          stopReason: "tool_calls" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    } as unknown as LLMProvider;

    const loop = new ReflectionEngine({
      config: RSI,
      drafts: new DraftStore(freshDb(), () => 1000),
      toolMemory: new ToolMemory(freshDb(), () => 1000),
      registry: { get: () => fakeAgent(), reloadAll: async () => {} } as unknown as AgentRegistry,
      providers: { get: () => provider } as unknown as ProviderRegistry,
      agentsDir,
      now: () => 1000,
    });

    await loop.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });

    // Bounded, and the bound is small. Without the cap this never returns.
    expect(calls).toBeLessThanOrEqual(5);
    expect(loop.pending()).toHaveLength(0);
  });

  test("an improvement can ship a script, and the earlier files survive it", async () => {
    /**
     * The half of the chain that was never covered. Support files were only ever tested through
     * `writeNewSkill`, so "an RSI *improvement* can add a script" rested on reading the code — and
     * it is the likelier case of the two: sixteen drafts on the live box, fifteen of them
     * improvements to skills that already existed.
     *
     * The survival half matters as much. `files` replaces a file of that name and leaves the rest
     * alone, so an improvement that adds one helper must not take out the reference an earlier round
     * attached — that would make every improvement a small silent deletion.
     */
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, {
      ...original,
      files: [{ path: "references/hosts.md", content: "the old notes" }],
    });

    const updated = await updateExistingSkill(agentsDir, {
      name: original.name,
      description: original.description,
      body: "## Procedure\n1. run scripts/tag.sh",
      files: [{ path: "scripts/tag.sh", content: "#!/bin/sh\necho tagging\n" }],
      updated: "2026-09-05",
    });
    expect(updated.ok).toBe(true);

    const root = join(agentsDir, "skills", original.name);
    const script = join(root, "scripts", "tag.sh");
    expect(readFileSync(script, "utf8")).toContain("echo tagging");
    expect((statSync(script).mode & 0o111) !== 0).toBe(true);
    // Untouched by an improvement that never mentioned it.
    expect(readFileSync(join(root, "references", "hosts.md"), "utf8")).toBe("the old notes");
  });

  test("refuses when the target is gone rather than quietly creating it", async () => {
    // A draft can wait indefinitely, so its target can be deleted while it waits. Turning that into
    // a create would resurrect a skill somebody deliberately removed.
    const result = await updateExistingSkill(tempDir(), { name: "not-there", description: "x", body: "y" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("to update");
  });
});

describe("support files", () => {
  test("only the three directories, one level, no traversal", () => {
    expect(validateSupportFiles([{ path: "references/notes.md", content: "x" }])).toBeNull();
    expect(validateSupportFiles([{ path: "scripts/check.py", content: "x" }])).toBeNull();
    expect(validateSupportFiles([{ path: "templates/base.toml", content: "x" }])).toBeNull();

    for (const path of [
      "../../etc/passwd",
      "references/../../escape",
      "references/deep/nested.md",
      "SKILL.md",
      "notes.md",
      "scripts/",
    ]) {
      expect(validateSupportFiles([{ path, content: "x" }])).not.toBeNull();
    }
  });

  test("are written beside SKILL.md", async () => {
    const agentsDir = tempDir();
    const written = await writeNewSkill(agentsDir, {
      name: "with-extras",
      description: "when extras are needed",
      body: "## Procedure\n1. see references/detail.md",
      files: [{ path: "references/detail.md", content: "the long version" }],
    });
    expect(written.ok).toBe(true);
    expect(readFileSync(join(agentsDir, "skills", "with-extras", "references", "detail.md"), "utf8")).toBe(
      "the long version",
    );
  });

  test("a shipped script is executable, a reference is not", async () => {
    /**
     * The pool holds 44 support files on the live box, and the Python ones are meant to be run —
     * `home-pc-ops` says `python3 …/scripts/wake_pc.py` in its own procedure. Written 0644, a skill
     * whose step is `./scripts/foo.py` fails with `Permission denied`, which reads as the skill being
     * wrong rather than as one missing bit. Only `scripts/` gets it: a reference nobody executes has
     * no business being executable.
     */
    const agentsDir = tempDir();
    const written = await writeNewSkill(agentsDir, {
      name: "with-a-script",
      description: "when a script is needed",
      body: "## Procedure\n1. run scripts/wake.py",
      files: [
        { path: "scripts/wake.py", content: "#!/usr/bin/env python3\nprint('awake')\n" },
        { path: "references/detail.md", content: "the long version" },
      ],
    });
    expect(written.ok).toBe(true);

    const root = join(agentsDir, "skills", "with-a-script");
    const script = statSync(join(root, "scripts", "wake.py")).mode & 0o777;
    const reference = statSync(join(root, "references", "detail.md")).mode & 0o777;
    expect({ scriptRunnable: (script & 0o111) !== 0, referenceRunnable: (reference & 0o111) !== 0 }).toEqual({
      scriptRunnable: true,
      referenceRunnable: false,
    });
  });

  test("a bad path fails the whole write, leaving nothing behind", async () => {
    // Half-written support files are worse than none: the skill would claim a reference that is
    // not there, and the pointer in its body would be a dead end.
    const agentsDir = tempDir();
    const result = await writeNewSkill(agentsDir, {
      name: "half-written",
      description: "x",
      body: "y",
      files: [{ path: "references/ok.md", content: "a" }, { path: "../escape", content: "b" }],
    });
    expect(result.ok).toBe(false);
    expect(existsSync(join(agentsDir, "skills", "half-written"))).toBe(false);
  });
});

/**
 * Whose skill is it — the guard that had to exist the moment the loop could rewrite one.
 *
 * Derived from `author:` rather than declared anywhere: everything the daemon's own pipeline writes
 * stamps it, and a skill somebody added by hand never gains one. Before updates existed this
 * distinction did not matter; now it is the only thing standing between the loop and an operator's
 * hand-written file.
 */
describe("ownership", () => {
  test("a hand-written skill has no author, an agent-written one does", async () => {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, { name: "by-agent", description: "x", body: "y", author: "nouva" });
    mkdirSync(join(agentsDir, "skills", "by-hand"), { recursive: true });
    writeFileSync(
      join(agentsDir, "skills", "by-hand", "SKILL.md"),
      "---\nname: by-hand\ndescription: somebody typed this\n---\n\nmine\n",
    );

    const pool = await listSkills(join(agentsDir, "skills"), "shared", {});
    expect(pool.find((s) => s.name === "by-agent")?.author).toBe("nouva");
    // The whole ownership signal: absence, not a flag anybody had to remember to set.
    expect(pool.find((s) => s.name === "by-hand")?.author).toBeUndefined();
  });

  test("approving an update to a hand-written skill is refused", async () => {
    const agentsDir = tempDir();
    // No `author:` — the shape an operator's own file has.
    mkdirSync(join(agentsDir, "skills", "hand-written"), { recursive: true });
    writeFileSync(
      join(agentsDir, "skills", "hand-written", "SKILL.md"),
      "---\nname: hand-written\ndescription: mine\n---\n\noriginal\n",
    );

    const engine = enginePointedAt(agentsDir, {
      triage: JSON.stringify({ decision: "update", target: "hand-written", why: "add a step" }),
      revise: JSON.stringify({ description: "mine", requires: "", body: "rewritten by a model" }),
    });
    await engine.loop.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });

    // The draft can exist — the model was told not to name it, and this is the second gate.
    const draft = engine.loop.pending()[0];
    if (draft) {
      const result = await engine.loop.approve(draft.id, "gading");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("written by hand");
    }
    // Either way, the file is untouched.
    expect(readFileSync(join(agentsDir, "skills", "hand-written", "SKILL.md"), "utf8")).toContain("original");
  });

  test("propose refuses a hand-written skill outright", async () => {
    const agentsDir = tempDir();
    mkdirSync(join(agentsDir, "skills", "hand-written"), { recursive: true });
    writeFileSync(
      join(agentsDir, "skills", "hand-written", "SKILL.md"),
      "---\nname: hand-written\ndescription: mine\n---\n\noriginal\n",
    );
    const h = harness([], {}, agentsDir);

    const result = await h.engine.propose({
      agentId: "nouva",
      target: "hand-written",
      why: "it is missing a step",
      body: "improved",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("written by a person");
  });

  test("propose refuses a skill that ships with the daemon, and names the real reason", async () => {
    /**
     * Reached differently from the approval gate — this is an agent calling `skill_improve`
     * mid-turn — and it has to answer the same. It also has to answer *accurately*: a built-in has
     * no `author`, so before this it fell through to either "there is no skill called that", which
     * is false because the skill is listed to the agent by name, or the hand-written refusal, which
     * sends the operator looking for a person who does not exist.
     */
    const agentsDir = tempDir();
    const builtinDir = tempDir();
    mkdirSync(join(builtinDir, "nouride"), { recursive: true });
    writeFileSync(
      join(builtinDir, "nouride", "SKILL.md"),
      "---\nname: nouride\ndescription: Operate the daemon.\nauthor: Nouride\n---\n\nbody\n",
    );
    const h = harness([], {}, agentsDir, () => 1000, TRIAGE_CREATE, builtinDir);

    const result = await h.engine.propose({
      agentId: "nouva",
      target: "nouride",
      why: "the upgrade flags changed",
      body: "improved",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ships with Nouride");
      // The way forward, which is the half that decides what the agent does next: say it in the
      // reply so it can be fixed where the file is actually written.
      expect(result.error).toContain("say");
      expect(result.error).not.toContain("There is no skill called");
      expect(result.error).not.toContain("written by a person");
    }
  });
});

describe("skill_improve — an agent correcting a skill it is using", () => {
  async function seeded() {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, {
      name: "deploy-checklist",
      description: "Before a release.",
      body: "## Procedure\n1. tag it",
      author: "nouva",
      files: [{ path: "references/old.md", content: "outdated" }],
    });
    return { agentsDir, h: harness([], {}, agentsDir) };
  }

  test("raises a draft and writes nothing", async () => {
    const { agentsDir, h } = await seeded();
    const result = await h.engine.propose({
      agentId: "nero",
      target: "deploy-checklist",
      why: "the staging step was missing and I hit it",
      body: "## Procedure\n1. tag it\n2. push to staging",
      files: [{ path: "references/new.md", content: "the current version" }],
      removeFiles: ["references/old.md"],
    });
    expect(result.ok).toBe(true);

    const draft = h.engine.pending()[0]!;
    expect(draft.target).toBe("deploy-checklist");
    expect(draft.triggerKind).toBe("in_use");
    expect(draft.triggerReason).toContain("staging step was missing");
    // Nothing on disk has moved: proposing is not writing.
    expect(readFileSync(skillMd(agentsDir, "deploy-checklist"), "utf8")).not.toContain("push to staging");
    expect(existsSync(join(agentsDir, "skills", "deploy-checklist", "references", "old.md"))).toBe(true);
  });

  test("approving it adds the new file and removes the stale one", async () => {
    const { agentsDir, h } = await seeded();
    await h.engine.propose({
      agentId: "nero",
      target: "deploy-checklist",
      why: "refreshed the reference",
      body: "## Procedure\n1. tag it\n2. see references/new.md",
      files: [{ path: "references/new.md", content: "the current version" }],
      removeFiles: ["references/old.md"],
    });
    const draft = h.engine.pending()[0]!;
    expect((await h.engine.approve(draft.id, "gading")).ok).toBe(true);

    const dir = join(agentsDir, "skills", "deploy-checklist", "references");
    expect(readFileSync(join(dir, "new.md"), "utf8")).toBe("the current version");
    expect(existsSync(join(dir, "old.md"))).toBe(false);
  });

  test("credentials the agent pasted in are masked before the draft is stored", async () => {
    const { h } = await seeded();
    await h.engine.propose({
      agentId: "nero",
      target: "deploy-checklist",
      why: "found the token",
      body: "## Procedure\n1. export GH_TOKEN=ghp_cccccccccccccccccccccccccccccccccccc",
    });
    const draft = h.engine.pending()[0]!;
    expect(draft.body).not.toContain("ghp_cccc");
    expect(draft.triggerReason).toContain("masked");
  });

  test("a second proposal is refused while one waits, and the refusal hands over its body", async () => {
    /**
     * The hole this closes, and it is the same one the reflection pass had.
     *
     * `updateExistingSkill` overwrites the body whole, so two pending proposals for one skill mean
     * approving both keeps the last and drops the first — silently, with no error anywhere. That is
     * what put four competing rewrites of `infrastructure-ops` in the live queue and took a manual
     * merge to unpick.
     *
     * The reflection pass fixes it by *reading* the pending draft and revising from it. Nothing can
     * do that here: the body arrives from an agent that wrote it against whatever it read. So the
     * agent is handed the pending body and told to resubmit — which turns a silent loss into an
     * instruction it can act on.
     *
     * Not conditional on the session. An agent that proposed a body an hour ago and a body now has
     * no obligation to have carried the first into the second, and the old rule guessed that it had.
     */
    const { h } = await seeded();
    const base = { agentId: "nero", sessionId: "ses_1", target: "deploy-checklist", why: "the first gap" };
    const first = await h.engine.propose({ ...base, body: "FIRST-GAP" });
    expect(first.ok).toBe(true);

    const again = await h.engine.propose({ ...base, body: "SECOND-GAP only" });
    expect(again.ok).toBe(false);
    if (!again.ok) {
      // Everything it needs to comply: the id to assert against, why the draft exists, and its text.
      expect(again.error).toContain(first.ok ? first.draft.id : "");
      expect(again.error).toContain("the first gap");
      expect(again.error).toContain("FIRST-GAP");
    }
    // And nothing was lost in the meantime.
    expect(h.engine.pending().filter((d) => d.name === "deploy-checklist")).toHaveLength(1);
  });

  test("`replaces` is the assertion that lets it through, and it accumulates", async () => {
    const { h } = await seeded();
    const base = { agentId: "nero", sessionId: "ses_1", target: "deploy-checklist", why: "the first gap" };
    const first = await h.engine.propose({
      ...base,
      body: "FIRST-GAP",
      files: [{ path: "references/one.md", content: "the first detail" }],
    });
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.draft.id : "";

    const merged = await h.engine.propose({
      ...base,
      why: "the second gap",
      body: "FIRST-GAP and SECOND-GAP",
      files: [{ path: "references/two.md", content: "the second detail" }],
      replaces: firstId,
    });
    expect(merged.ok).toBe(true);

    const pending = h.engine.pending().filter((d) => d.name === "deploy-checklist");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.body).toContain("FIRST-GAP");
    expect(pending[0]?.body).toContain("SECOND-GAP");
    // The retired draft's file comes along: the body may still point at it, and it was attached to a
    // draft that no longer exists.
    expect((pending[0]?.files ?? []).map((f) => f.path).sort()).toEqual([
      "references/one.md",
      "references/two.md",
    ]);
    // And the reviewer is told the decision is bigger than the newest sentence.
    expect(pending[0]?.carries).toEqual(["the first gap"]);
  });

  test("a wrong `replaces` is refused, not treated as consent", async () => {
    // An id that does not match the waiting draft is either a stale one or a guess. Accepting it
    // would make the assertion decorative — which is worse than not having it.
    const { h } = await seeded();
    const base = { agentId: "nero", sessionId: "ses_1", target: "deploy-checklist", why: "a" };
    expect((await h.engine.propose({ ...base, body: "FIRST" })).ok).toBe(true);
    const bogus = await h.engine.propose({ ...base, body: "SECOND", replaces: "dft_notarealdraftid" });
    expect(bogus.ok).toBe(false);
    expect(h.engine.pending().filter((d) => d.name === "deploy-checklist")[0]?.body).toContain("FIRST");
  });


  test("a skill that does not exist is said so", async () => {
    const { h } = await seeded();
    const result = await h.engine.propose({ agentId: "nero", target: "nope", why: "a", body: "b" });
    expect(result.ok).toBe(false);
  });
});

/**
 * Skills are written in English, and that is enforced rather than requested.
 *
 * Three prompts already say it. Saying it was not enough: a model working in another language for a
 * whole turn writes the skill in that language too, and one sat in the live pool for weeks before
 * anybody noticed.
 *
 * The test is **positive** — "does this read as English" — and the first version was not. Looking
 * for Indonesian passes Spanish, Javanese, Japanese and every other language nobody thought of,
 * which is precisely the set that matters. The threshold is measured, not chosen: see `skillBodyIsEnglish`.
 */
describe("skills are written in English", () => {
  const english = `
## When to Use
- Asked for an architecture, flowchart or sequence diagram.

## Procedure
1. Write the diagram as a Graphviz DOT script, using a dark background and a font that is installed.
2. Render it to PNG at 150 DPI, and to SVG beside it.
3. Save both in the relevant workspace and send the PNG to the person who asked.

## Mistakes to Avoid
- Do not use Mermaid direct rendering for a complex diagram; the fonts come out unreadable.
- Do not rely on a font that is not on this host — Graphviz falls back and the result looks wrong.`;

  const indonesian = `
SOP ini mengatur cara pembuatan dan rendering diagram arsitektur homelab atau diagram teknis lainnya
agar menghasilkan gambar resolusi tinggi yang teksnya tajam dan layout-nya presisi. Jangan gunakan
Mermaid untuk diagram kompleks karena sering menghasilkan font yang tidak terbaca atau layout yang
tidak proporsional saat dikonversi ke PNG. Tulis kode diagram dengan format DOT dan gunakan styling
yang bersih agar rapi. Simpan file output di workspace yang relevan lalu kirim ke user.`;

  const spanish = `
Este procedimiento describe como generar y renderizar diagramas de arquitectura para el homelab con
una resolucion alta, texto nitido y una disposicion precisa. No utilices el renderizado directo de
Mermaid para diagramas complejos porque produce fuentes ilegibles o cajas vacias cuando se convierte
a PNG. Escribe el codigo del diagrama en formato DOT y usa un estilo limpio y moderno con un fondo
oscuro y texto claro. Guarda siempre los archivos de salida en el espacio de trabajo del proyecto.`;

  test("accepts English", () => {
    expect(skillBodyIsEnglish(english)).toBe(true);
  });

  test("rejects Indonesian", () => {
    expect(skillBodyIsEnglish(indonesian)).toBe(false);
  });

  test("rejects Spanish — the case the first version let through", () => {
    // A detector that looked for Indonesian passed this. Asking "is it English" is one test that
    // covers every language nobody enumerated.
    expect(skillBodyIsEnglish(spanish)).toBe(false);
  });

  test("English that talks *about* another language is still English", () => {
    // The real near-miss: `contributing-gading-dev` on the live box explains how to write blog posts
    // in Indonesian, and scores as ordinary English because the prose around it is English.
    expect(
      skillBodyIsEnglish(
        english +
          "\n\nThe blog publishes posts in Indonesian and English; keep the front matter identical " +
          "for both, and name the Indonesian file with an -id suffix so the router finds it.",
      ),
    ).toBe(true);
  });

  test("code is not prose", () => {
    // A fenced block is full of short tokens and would drag the ratio around for no reason.
    expect(skillBodyIsEnglish(english + "\n```bash\ndan ini itu yang untuk dengan dari pada\n```")).toBe(true);
  });

  test("something too short to judge is allowed through", () => {
    // Fifty words of prose is the floor. Below it there are no statistics, and refusing on a coin
    // flip is worse than letting it reach a human who sees it immediately.
    expect(skillBodyIsEnglish("Jalankan ini dulu.")).toBe(true);
  });
});

/**
 * The agent is told which of its skills cannot work here.
 *
 * Declaring `requires:` and `needs_tools:` was meant to catch a missing dependency before a task
 * fails on it. For a while the only surfaces that said so were the dashboard and `nouride doctor` —
 * both read by the operator. The agent, which is the one that reads the skill, follows the procedure
 * and hits "command not found" four steps in, was told nothing.
 */
describe("skills the agent cannot actually use", () => {
  const agent = fakeAgent();

  function ctxWith(skills: Skill[]) {
    // With `exec`: the install ladder is only offered to an agent that can run it.
    return { agent: { ...agent, skills }, gateway: "web", tools: [{ name: "exec" }] } as unknown as Parameters<
      typeof renderSkills
    >[0];
  }

  /** The operator's half: the list, as `/prompt` prints it. */
  function render(skills: Skill[]): string {
    return renderSkills(ctxWith(skills));
  }

  /**
   * Our half: the same block as the model sees it, list plus the harness wording about it.
   *
   * The two are rendered apart so that `/prompt` can show the operator their own list without
   * shipping our instructions with it — see `prompt-redaction.test.ts`. They are asserted together
   * here because the model reads them together, and a rule the list never reaches is not a rule.
   */
  function renderForModel(skills: Skill[]): string {
    const ctx = ctxWith(skills);
    return [renderSkills(ctx), ...renderSkillPolicy({ ctx } as never)].join("\n");
  }

  test("a skill whose program is missing is marked, and the marker says what to do", () => {
    const out = render([
      {
        name: "draw-diagram",
        description: "Render a diagram.",
        path: "/pool/draw-diagram/SKILL.md",
        scope: "shared",
        // A name nothing will ever have on PATH, so this does not depend on the test machine.
        requires: ["definitely-not-a-real-binary-xyz"],
      },
    ]);
    expect(out).toContain("UNAVAILABLE here: no definitely-not-a-real-binary-xyz");
    /**
     * The marker has to leave a way forward, and for a while it did not.
     *
     * It read "Say what is missing rather than working around it" — true and useless: no way to fix
     * it, so the model treated UNAVAILABLE as "this skill is out". Observed on 2026-09-05: asked for
     * a PDF with `document-authoring` UNAVAILABLE for want of `tectonic`, the agent produced one
     * with Python `reportlab` and explained the substitution afterwards, when `apt install` was one
     * approval away. It also contradicted the `exec` guidance in the same prompt, which already said
     * a missing binary is not a dead end and to offer the install line.
     */
    const model = renderForModel([
      {
        name: "draw-diagram",
        description: "Render a diagram.",
        path: "/pool/draw-diagram/SKILL.md",
        scope: "shared",
        requires: ["definitely-not-a-real-binary-xyz"],
      },
    ]);
    expect(model).toContain("still the right approach");
    expect(model).toContain("Install it, in this order");
    expect(model).toContain("The approval gate is how they say yes");
    // And the way forward is ours to write, so it is not in the operator's half of the block.
    expect(out).not.toContain("still the right approach");
  });

  test("the marker agrees with what the exec guidance says about a missing binary", () => {
    /**
     * The two lines are in one prompt and disagreed for weeks: `exec` said a missing binary is "not
     * a dead end, and not a reason to improvise a replacement", the skills block said report and
     * stop. The model read the weaker one. Asserted together so the next edit to either has to keep
     * them saying the same thing.
     */
    const skills = renderForModel([
      {
        name: "draw-diagram",
        description: "Render a diagram.",
        path: "/pool/draw-diagram/SKILL.md",
        scope: "shared",
        requires: ["definitely-not-a-real-binary-xyz"],
      },
    ]);
    expect(skills).not.toContain("cannot be carried out");
    // The behaviour both must describe: install, let them decide, and never substitute silently.
    for (const phrase of ["Install it, in this order", "Improvise only if they decline", "say up front"]) {
      expect(skills).toContain(phrase);
    }
  });

  test("a tool the agent does not hold counts too, and says it is a tool", () => {
    // The other axis. `fakeAgent` carries no tools, so anything named here is missing.
    const out = render([
      {
        name: "cctv",
        description: "Grab a snapshot.",
        path: "/pool/cctv/SKILL.md",
        scope: "shared",
        needsTools: ["send_file"],
      },
    ]);
    expect(out).toContain("UNAVAILABLE here: no send_file (tool)");
  });

  test("a healthy skill pays nothing — no marker, no extra line", () => {
    // This block is in every agent's prompt on every turn, so the common case has to cost zero.
    const out = renderForModel([
      { name: "notes", description: "Write notes.", path: "/pool/notes/SKILL.md", scope: "shared" },
    ]);
    expect(out).not.toContain("UNAVAILABLE");
    expect(out).not.toContain("Offer to install");
  });
});

/**
 * A skill that ships with the daemon is listed to the pass and written to by nobody.
 *
 * The live failure: an agent upgraded the daemon it runs inside and drafted
 * `nouride-daemon-update`, "capturing the procedure and flag requirements (--start, --then,
 * --agent, --gateway, --chat)". Two of those rules were in the system prompt it had read that turn,
 * word for word; the rest was `nouride update --help`. `prompt/harness-cli.ts` records why that
 * command list was deleted from the prompt — "a hand-kept copy of what `nouride help` prints. It
 * went stale within a day of a verb being added" — and this was the same copy, re-created in the
 * one place nobody maintains, about the command that replaces the binary.
 *
 * The pass was not wrong to act. `readPool` read only the operator's pool, so "is this territory
 * already covered?" could not be answered about anything Nouride ships with, and `create` was the
 * right answer to the wrong listing.
 */
describe("the skills Nouride ships with", () => {
  /** A built-in pool on disk, in the shape `resolveBuiltinSkillsDir()` finds. */
  function builtinPool(name: string, description: string): string {
    const dir = tempDir();
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(
      join(dir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\nauthor: Nouride\n---\n\n# ${name}\n\nbody\n`,
    );
    return dir;
  }

  test("the pool lists them, and says the operator's own copy wins a name collision", async () => {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, { name: "nouride", description: "mine", body: "x", author: "nouva" });
    const builtin = builtinPool("nouride", "ships with the daemon");
    mkdirSync(join(builtin, "document-reading"), { recursive: true });
    writeFileSync(
      join(builtin, "document-reading", "SKILL.md"),
      "---\nname: document-reading\ndescription: Read a PDF.\nauthor: Nouride\n---\n\nbody\n",
    );

    const pool = await readPool(agentsDir, builtin);
    // Present, or the collision assertion below is satisfied by a pool that never read them at all.
    expect(pool.find((s) => s.name === "document-reading")?.scope).toBe("builtin");
    // One entry, not two: `Skill.scope` documents shared beating builtin, and two rows with one name
    // would let the pass name a target that resolves differently depending on who looks it up.
    expect(pool.filter((s) => s.name === "nouride")).toHaveLength(1);
    expect(pool.find((s) => s.name === "nouride")?.scope).toBe("shared");
  });

  test("triage is shown them, marked", async () => {
    const agentsDir = tempDir();
    const builtin = builtinPool("nouride", "Operate the daemon you run inside.");
    const h = harness(ANSWER, {}, agentsDir, () => 1000, TRIAGE_CREATE, builtin);

    await h.engine.observe({ ...recoveryTurn(), steps: [], iterations: 10 });

    const triage = h.prompts.find((p) => p.includes("what should happen to the skill")) ?? "";
    // Present at all — without this the pass cannot decline as a duplicate, which is the whole fix.
    expect(triage).toContain("- nouride");
    expect(triage).toContain("ships with Nouride");
  });

  test("the pass drafts nothing for one, and does not pay for the revision", async () => {
    /**
     * Live (0.8.12): triage named `motion-graphics` for an update although its prompt says a skill that
     * ships with Nouride is off limits — said is not held — and the draft sat in the person's queue as
     * "improves", with an Apply the approval refuses. Refused in code, before the revise call.
     */
    const agentsDir = tempDir();
    const builtin = builtinPool("nouride", "Operate the daemon you run inside.");
    const engine = enginePointedAt(
      agentsDir,
      {
        triage: JSON.stringify({ decision: "update", target: "nouride", why: "add the flags" }),
        revise: JSON.stringify({ description: "x", requires: "", body: "improved" }),
      },
      builtin,
    );
    await engine.loop.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });
    expect(engine.loop.pending()).toEqual([]);
    expect(engine.calls.revise).toBe(0);
  });

  test("nor for a skill a person wrote, which the approval would refuse as well", async () => {
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, { name: "house-rules", description: "x", body: "y" });
    const engine = enginePointedAt(agentsDir, {
      triage: JSON.stringify({ decision: "update", target: "house-rules", why: "add a step" }),
      revise: JSON.stringify({ description: "x", requires: "", body: "improved" }),
    });
    await engine.loop.observe({ ...recoveryTurn(), userText: "lanjut", steps: [], iterations: 10 });
    expect(engine.loop.pending()).toEqual([]);
    expect(engine.calls.revise).toBe(0);
  });

  test("approving a draft that targets one is refused, and says why", async () => {
    /**
     * The gate that matters most, because the loser is invisible without it: `updateExistingSkill`
     * writes into the operator's pool, and shared beats builtin on a name collision — so an
     * "improvement" to a shipped skill would not update it at all. It would shadow it with a copy
     * that stops receiving our updates, and nothing would say so. The pass no longer drafts one, but
     * a draft made before it stopped — the live box had one — still reaches this.
     */
    const agentsDir = tempDir();
    const builtin = builtinPool("nouride", "Operate the daemon you run inside.");
    const engine = enginePointedAt(agentsDir, { triage: "", revise: "" }, builtin);
    engine.drafts.create({ agentId: "nouva", triggerKind: "sustained_effort", triggerReason: "add the flags", name: "nouride", description: "x", requires: "", body: "improved", target: "nouride" });
    // Asserted, not assumed. A `if (draft)` around the refusal would pass on a run that produced no
    // draft at all, which is the shape of test that agrees with the bug.
    const draft = engine.loop.pending()[0];
    expect(draft).toBeDefined();

    const result = await engine.loop.approve(draft!.id, "gading");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ships with Nouride");
      // Not the hand-written refusal: a built-in has no `author` either, and naming a person who
      // does not exist sends the operator looking for one.
      expect(result.error).not.toContain("written by hand");
    }
  });

  test("the pool is unchanged when there is nowhere the daemon's skills live", async () => {
    // Every install has them, but the field is optional and a test harness may not pass one. Without
    // this the pass would see an empty listing and start creating duplicates of everything.
    const agentsDir = tempDir();
    await writeNewSkill(agentsDir, { name: "deployment", description: "x", body: "y", author: "nouva" });
    expect((await readPool(agentsDir)).map((s) => s.name)).toEqual(["deployment"]);
  });
});

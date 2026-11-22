/**
 * The reflection pass — a triage call, and when triage proposes, an author or revise call, that turn a
 * transcript into a proposed skill; each may read skills for up to four rounds before it answers.
 *
 * Zero-bloat synthesis, and the zero-bloat part is literal: no test
 * harness, no trajectory evaluator, no background judge model. Calls against the agent's own provider
 * — metered under the turn, as a reflection — a JSON object back, and a row in a table. Everything that
 * would need a second process is what this design does without.
 *
 * The pass is told to extract *procedural* knowledge and nothing else. A summary of what happened is
 * worthless in a system prompt — the agent will not be in that conversation again — while "when this
 * applies, do this, avoid that" is the only shape that survives being read six weeks later by a
 * different agent on a different task.
 */

import { createLogger, cutAtWord, type ChatMessage, type LLMProvider, oneLine, type ToolDefinition } from "@nouride/shared";
import { extractJson } from "@/modules/llm/json-answer.ts";
import { outputCap } from "@/modules/llm/output-cap.ts";
import { parseFrontmatter, skillBodyIsEnglish, VALID_SKILL_NAME } from "@nouride/persona";
import { BODY_CHARS } from "./draft-lint.ts";
import { patched, readEdits } from "./patch.ts";
import { AUTHOR_INSTRUCTION, REVISE_INSTRUCTION, REWRITE_INSTRUCTION, TRIAGE_INSTRUCTION, renderCandidates, renderInPlay, renderSkillList } from "./prompts.ts";
import type { SkillFile, Trigger } from "./types.ts";

const log = createLogger("reflection.synthesis");

/** Triage answers a decision in a few lines. */
const TRIAGE_OUTPUT_TOKENS = 1400;
/**
 * Writing or revising returns the whole skill body plus any support files: the model's own output cap, as a turn's
 * reply has (`outputCap`). At 1,400 a revision of a large skill was cut off mid-JSON and dropped as "did not answer
 * with JSON"; at a flat 8,000 it happened again (live, 2026-10-21) — a 17KB skill revised by Claude Sonnet stopped at
 * exactly 8,000 tokens.
 */
const skillOutputTokens = (model: string): number => outputCap(0, model, SKILL_OUTPUT_CEILING);
/** The most one skill answer may cost, whatever the model allows. */
const SKILL_OUTPUT_CEILING = 32_000;

export interface SynthesisResult {
  name: string;
  description: string;
  requires: string;
  /** Nouride tools the procedure calls. The other axis from `requires` — see `Skill.needsTools`. */
  needsTools: string;
  body: string;
  /** The skill this improves, or undefined for a new one. */
  target?: string;
  /** Support files to write beside `SKILL.md`. Empty for most drafts. */
  files: SkillFile[];
  /**
   * The pass's own one-line account of why this is worth keeping.
   *
   * Shown in the queue in place of the mechanical trigger reason. "12 steps of work in this
   * conversation" says why the daemon *looked*; "you corrected the sort order twice before it was
   * right" says why it is *proposing*, and that is the sentence the person deciding needs. Empty
   * when the model did not give one, and the caller falls back to the counter.
   */
  why: string;
}

export interface SynthesisInput {
  provider: LLMProvider;
  /** Empty is not accepted here — the caller resolves the agent's own model first. */
  model: string;
  /** Already redacted. See `redact.ts` for why this is the caller's job and not this function's. */
  transcript: string;
  trigger: Trigger;
  /**
   * Every skill that exists, with what it is for.
   *
   * Descriptions and not just names, because the first call's job is to decide *which existing skill
   * this belongs to* — and a name alone cannot answer that. Cheap: eighteen of them measured ~3.4KB
   * on the live box, against a body-per-skill alternative costing tens of thousands of tokens.
   */
  existing: {
    name: string;
    description: string;
    /** Who maintains it — see `renderSkillList`, which turns this into what the pass may do. */
    owner: "agent" | "person" | "nouride";
    /**
     * How big the body is, which is the fact the pass was missing.
     *
     * Triage sees names and descriptions, deliberately, because bodies cost tens of thousands of
     * tokens on every reflection — but that meant it could not tell a focused skill from a
     * warehouse. `domain-management` grew from 5KB to 23KB in three hours across twelve approvals,
     * absorbing object storage, IPFS, Arweave and web analytics, and every one of those made its
     * description broader and the next match more certain.
     *
     * Read locally from a file already on disk, so it costs no tokens to compute and a few to state
     * on the minority of skills that are actually large. See `BROAD_SKILL_BYTES` for why this is one
     * number rather than a heading count.
     */
    bytes: number;
  }[];
  /** Classes of work seen once and not skills yet (`candidates.store.ts`), so a second sighting can say which it is. */
  candidates?: { name: string; description: string; day: string }[];
  /**
   * Whether a create is written now. Said by the caller, which knows whether the class of work has recurred — false
   * holds it as a candidate, and no body is written for it. Absent writes every create.
   */
  gate?: (create: Extract<Triage, { decision: "create" }>) => boolean;
  /**
   * Why the daemon would refuse this draft, or null (`gates.ts`). Given, a refused draft goes back to its writer once
   * with the reason: see `handedBackOnce`.
   */
  refusal?: (draft: SynthesisResult) => Promise<string | null>;
  /** Whether a skill is being left alone, its last draft refused a moment ago: no revision of it is paid for. */
  resting?: (skill: string) => boolean;
  /**
   * The model that decides (triage), where it is not the one that writes: a replay's, to measure what another model
   * would decide (`try-out.ts`). A pass decides on `model`: see `ReflectionEngine.pass` for the measurement.
   */
  triageModel?: string;
  /** The skills this conversation read, by name: the ones in play, which a lesson about their ground goes to first. */
  inPlay?: readonly string[];
  /** Told when the pass ends with nothing and can say why: what a person is shown when they ask why nothing was learned. */
  nothing?: (why: string) => void;
  /** Told what triage decided, before anything is written: what a replay of a conversation reports (`ReflectionEngine.tryOut`). */
  triaged?: (triage: Triage) => void;
  /** Stop once triage has decided: a replay that compares what two models decide pays for no writing. */
  decideOnly?: boolean;
  /**
   * Reads a skill's current body, for the second call.
   *
   * Injected rather than done here so this module still needs nothing but a provider — the pass is
   * the one part of the loop worth testing without a filesystem.
   */
  readSkill: (name: string) => Promise<string | null>;
  /**
   * The support files already sitting beside a skill, by relative path.
   *
   * The revise pass used to see `SKILL.md` and the transcript and nothing else, which had two costs.
   * It could only propose body edits, so it proposed body edits — the improvements read thin because
   * the body was the only thing it knew existed. And `files` replaces by name, so a pass that
   * happened to pick `references/notes.md` would silently overwrite a reference an earlier round had
   * attached, without ever having seen it.
   *
   * Paths only, not contents. Knowing `references/errors.md` is there is what changes the decision;
   * reading all of them would put the cost back where splitting triage from revise removed it.
   */
  listSkillFiles?: (name: string) => Promise<string[]>;
  /**
   * One support file's contents, for the revise pass to read before it replaces anything.
   *
   * Separate from `readSkill`, which serves `SKILL.md` and is called once up front. Absent in the
   * tests that script a single answer, and absent is a working state: the pass then behaves exactly
   * as it did before it could read.
   */
  readSkillFile?: (name: string, path: string) => Promise<string | null>;
}

/**
 * Ask for a skill. Returns `null` when the model declined, answered unusably, or the call failed.
 *
 * Every one of those is a normal outcome rather than an error worth raising: the turn it reflects on
 * is long finished and nobody is waiting. A failure here must cost nothing but a log line — which is
 * the same rule `compactHistory` follows, for the same reason.
 */

export async function synthesizeSkill(input: SynthesisInput): Promise<SynthesisResult | null> {
  const context = [
    `Why this turn was flagged: ${input.trigger.reason}.`,
    renderSkillList(input.existing),
    ...(input.inPlay?.length ? ["", renderInPlay(input.inPlay)] : []),
    ...(input.candidates?.length ? ["", renderCandidates(input.candidates)] : []),
    "",
    "Transcript:",
    input.transcript,
  ].join("\n");

  const triaged = parseTriage(
    await askWithFiles(input, TRIAGE_INSTRUCTION, context, [
      { tool: READ_SKILL_TOOL, read: (name) => input.readSkill(name) },
    ], TRIAGE_OUTPUT_TOKENS, input.triageModel),
    input.nothing,
  );
  if (!triaged) return null;
  input.triaged?.(triaged);
  if (input.decideOnly) return null;

  if (triaged.decision === "create") {
    if (input.gate && !input.gate(triaged)) return null;
    // The name triage chose is the candidate's, and the skill's if it holds: one class of work, one name.
    return await author(input, `${context}\n\nTriage named this class \`${triaged.name}\`: ${triaged.description} Keep that name unless it is wrong.`, triaged.why);
  }
  // Off limits in the prompt is not off limits: live (0.8.12), triage named `motion-graphics`, which ships with Nouride,
  // and its draft sat in the person's queue as "improves" with an Apply the approval refuses. A skill a person wrote is
  // refused there too. Both end here, before the revise call is paid for.
  const owner = input.existing.find((skill) => skill.name === triaged.target)?.owner;
  if (owner === "nouride" || owner === "person") {
    log.info(owner === "nouride" ? "reflection named a skill that ships with Nouride, so nothing was drafted" : "reflection named a skill a person wrote, so nothing was drafted", {
      skill: triaged.target,
      decision: triaged.decision,
      why: triaged.why,
    });
    input.nothing?.(owner === "nouride" ? `the lesson belongs to ${triaged.target}, which ships with Nouride and is not changed` : `the lesson belongs to ${triaged.target}, which a person wrote and is not changed`);
    return null;
  }
  if (input.resting?.(triaged.target)) {
    log.info("reflection left a skill alone: its last draft was refused a moment ago", { skill: triaged.target });
    input.nothing?.(`${triaged.target} is left alone for a while: its last draft was refused`);
    return null;
  }
  // `attach` is a revision asked to land in a file rather than in the body — same call, same output
  // shape, one extra sentence of steer. A third prompt for it would be a third thing to keep in step.
  return await revise(input, triaged.target, triaged.why, triaged.decision === "attach" ? "attach" : "edit");
}

export type Triage =
  | { decision: "update"; target: string; why: string }
  /**
   * An existing skill gains a support file rather than a longer body.
   *
   * The rung that was missing. Without it a bulky lesson — a working command sequence, an error and
   * its cause — had two homes: swell the body of a skill every agent reads on every turn, or start a
   * second skill for a subject that already has one. Both are worse than a file beside it, and the
   * second is the failure this pass is most careful to avoid.
   */
  | { decision: "attach"; target: string; why: string }
  /** `name` and `description` name the class of work; `recurs`, the candidate it is a second sighting of. */
  | { decision: "create"; why: string; name: string; description: string; recurs?: string };

/**
 * The triage answer, or nothing.
 *
 * Exported because it is the decision the whole feature turns on, and it has to be testable without
 * a provider: a model that answers `create` while naming a target, or names a target that is not a
 * valid skill name, must end as nothing rather than as a draft pointed at a file that does not exist.
 */
export function parseTriage(text: string | null, nothing?: (why: string) => void): Triage | null {
  if (text === null) return null;
  const parsed = extractJson(text);
  if (!parsed) {
    log.warn("reflection triage did not answer with JSON", { head: text.slice(0, 120) });
    return null;
  }

  const decision = typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
  const why = typeof parsed.why === "string" ? cutAtWord(oneLine(parsed.why), 200) : "";

  if (decision === "skip") {
    const reason = cutAtWord(oneLine(String(parsed.reason ?? "no reason given")), 240);
    log.info("reflection pass declined", { reason });
    nothing?.(reason);
    return null;
  }

  if (decision === "update" || decision === "attach") {
    const target = typeof parsed.target === "string" ? parsed.target.trim().toLowerCase() : "";
    if (!VALID_SKILL_NAME.test(target)) {
      log.warn("reflection named an unusable skill to improve", { target, decision });
      return null;
    }
    return { decision, target, why };
  }

  if (decision === "create") {
    const name = typeof parsed.name === "string" ? parsed.name.trim().toLowerCase() : "";
    const description = typeof parsed.description === "string" ? oneLine(parsed.description) : "";
    const recurs = typeof parsed.recurs === "string" ? parsed.recurs.trim().toLowerCase() : "";
    // Without a name and its "Use when" line there is nothing to hold until the work comes back.
    if (!VALID_SKILL_NAME.test(name) || !description) {
      log.warn("reflection proposed a new skill without a usable name or description", { name });
      return null;
    }
    log.info("reflection is proposing a new skill", {
      skill: name,
      closest: String(parsed.closest ?? "none"),
      why_not_update: String(parsed.why_not_update ?? ""),
      ...(recurs ? { recurs } : {}),
    });
    return { decision: "create", why, name, description, ...(recurs ? { recurs } : {}) };
  }

  log.warn("reflection triage answered with no usable decision", { decision });
  return null;
}

/** One answer of a writing call, with the draft read from it, or why no draft could be made of it. */
type Written = { answer: string; draft: SynthesisResult } | { answer: string; unplaced: string };

/**
 * A draft the daemon refuses goes back to its writer once, with the reason.
 *
 * It used to be dropped where it stood. On a live box over fifteen days that was 64 of the 83 drafts the pass wrote:
 * 43 for a body a few hundred characters past its size, 21 for an account's address. Each was the pass's dearest
 * call thrown away for something its writer could have put right had it been told, and the next pass wrote the same
 * draft and lost it the same way.
 *
 * Once, not until it fits: nobody is waiting, and a writer that cannot fix it when told will not on a third try. The
 * second draft is returned whatever it is, and the caller's own check still decides. Where the second call gives
 * nothing usable, the first is returned, so the refusal is recorded with its reason.
 */
async function handedBackOnce(input: SynthesisInput, write: (note?: string) => Promise<Written | null>): Promise<SynthesisResult | null> {
  const first = await write();
  if (!first) return null;
  // An edit that could not be placed is a refusal with no draft behind it: the same hand-back, and nothing if it fails.
  const reason = "unplaced" in first ? first.unplaced : ((await input.refusal?.(first.draft)) ?? null);
  if (reason === null) return "draft" in first ? first.draft : null;
  log.info("reflection draft refused, handed back to be put right", { ...("draft" in first ? { skill: first.draft.name } : {}), reason });
  const second = await write(refusedNote(first.answer, reason));
  if (second && "draft" in second) return second.draft;
  if ("draft" in first) return first.draft;
  log.info("reflection revision could not be placed, so nothing was drafted", { reason: second && "unplaced" in second ? second.unplaced : reason });
  input.nothing?.(`its change could not be placed in the skill (${reason})`);
  return null;
}

/** What the writer is told with its refused answer. The words carry the rule: one thing fixed, the rest kept. */
export const refusedNote = (answer: string, reason: string): string =>
  [
    "",
    "",
    "## Your first answer was refused",
    "",
    `The daemon refused the draft you wrote for this: ${reason}.`,
    "",
    "Your refused answer:",
    "",
    answer,
    "",
    "Answer again in the same JSON shape, with that put right and everything else kept. A fact about this",
    "environment becomes a placeholder (`<host>`, `<account>`) or is left out. A body past its size keeps its",
    "procedure and gives its detail to a file under `references/`, with a one-line pointer in the body. An",
    "edit whose `old` was not found is copied again from the skill, exactly as it is written there.",
  ].join("\n");

/**
 * Write the skill for a class of work already named, with no triage before it: a candidate a person asked to have
 * written now (`candidates.store.ts`). `input.transcript` is the conversation it was last seen in.
 */
export async function authorSkill(input: SynthesisInput, named: { name: string; description: string; why: string }): Promise<SynthesisResult | null> {
  const context = [renderSkillList(input.existing), "", "Transcript:", input.transcript, "", `This class of work was named \`${named.name}\`: ${named.description} Keep that name unless it is wrong.`].join("\n");
  return await author(input, context, named.why);
}

/** Second call, create branch. */
async function author(input: SynthesisInput, context: string, why: string): Promise<SynthesisResult | null> {
  return await handedBackOnce(input, async (note = "") => {
    const answer = await askWithFiles(input, AUTHOR_INSTRUCTION, context + note, [{ tool: READ_SKILL_TOOL, read: (name) => input.readSkill(name) }], skillOutputTokens(input.model));
    if (answer === null) return null;
    const draft = authored(answer, why);
    return draft ? { answer, draft } : null;
  });
}

/** The new skill an author's answer holds, or nothing. */
function authored(answer: string, why: string): SynthesisResult | null {

  const parsed = extractJson(answer);
  if (!parsed) {
    log.warn("reflection author did not answer with JSON", { head: answer.slice(0, 120) });
    return null;
  }

  const name = typeof parsed.name === "string" ? parsed.name.trim().toLowerCase() : "";
  const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";

  if (!VALID_SKILL_NAME.test(name) || !description || !body) {
    log.warn("reflection produced an unusable skill", {
      name,
      has_description: Boolean(description),
      has_body: Boolean(body),
    });
    return null;
  }
  /**
   * Dropped, not queued.
   *
   * Unlike the tools, there is nobody here to hand it back to — the turn is over. Queuing it would
   * put the work on the reviewer, who would have to translate a skill before they could judge it.
   * The trigger fires again on the next piece of work, and the pass declines most of the time
   * anyway, so losing one is cheap.
   */
  if (!skillBodyIsEnglish(body)) {
    log.warn("reflection wrote the skill in another language, so it was dropped", { name });
    return null;
  }

  return {
    name,
    description,
    requires: typeof parsed.requires === "string" ? parsed.requires.trim() : "",
    needsTools: typeof parsed.needs_tools === "string" ? parsed.needs_tools.trim() : "",
    body,
    files: readFiles(parsed.files),
    why,
  };
}

/**
 * Second call, update branch: here is the skill you named, give me the better version.
 *
 * A named target that does not exist is the interesting failure — the model matched against a
 * description it was shown, so a miss means the pool changed underneath us, and falling through to
 * a create would silently convert "improve this" into "add another one", which is the exact outcome
 * the triage step exists to prevent.
 */
async function revise(
  input: SynthesisInput,
  target: string,
  why: string,
  /**
   * `edit`: the lesson as edits to the body (`patch.ts`). `attach`: triage judged it bulky, so it belongs beside the
   * skill rather than inside it. `rewrite`: the weekly review's, which exists to shorten the whole and returns it whole.
   */
  how: "edit" | "attach" | "rewrite" = "edit",
): Promise<SynthesisResult | null> {
  const current = await input.readSkill(target);
  if (current === null) {
    log.warn("reflection wanted to improve a skill that is not there", { skill: target });
    return null;
  }

  const currentBody = (current.startsWith("---") ? parseFrontmatter(current).body : current).trim();
  const bodyChars = currentBody.length;
  const chars = (n: number) => n.toLocaleString("en-US");
  const content = [
    `Skill: ${target}`,
    // Said as numbers: "keep it under 12,000" was in the instruction, and a body at 11,900 was still revised past it.
    `Its body is ${chars(bodyChars)} characters now. Your revision's body may be at most ${chars(Math.max(BODY_CHARS, bodyChars))}.`,
    "",
    current,
    ...(await (async () => {
      const files = (await input.listSkillFiles?.(target)) ?? [];
      if (files.length === 0) return [];
      return [
        "",
        `Files already beside it: ${files.join(", ")}.`,
        "Anything you list under `files` replaces a file of that name, so use a new name unless you",
        "mean to rewrite that one, and prefer extending one of these over starting a third.",
      ];
    })()),
    ...(how === "attach"
      ? [
          "",
          "This lesson was judged bulky: put it in a support file under `references/`, `scripts/`",
          "or `templates/`, and change the body only to add the one-line pointer to it.",
        ]
      : []),
    "",
    // The weekly review hands its reason, not a conversation (`curator.ts`).
    input.trigger.kind === "curation" ? "Why the weekly review is revising it:" : "What happened this turn:",
    "",
    input.transcript,
  ].join("\n");
  // `SKILL.md` is already in the prompt above; offering it here too costs a round for nothing, so the reader serves
  // support files and answers for anything else.
  const readers = [{ tool: READ_FILE_TOOL, read: async (path: string) => (path === "SKILL.md" ? current : ((await input.readSkillFile?.(target, path)) ?? null)) }];

  return await handedBackOnce(input, async (note = "") => {
    const answer = await askWithFiles(input, how === "rewrite" ? REWRITE_INSTRUCTION : REVISE_INSTRUCTION, content + note, readers, skillOutputTokens(input.model));
    if (answer === null) return null;
    const draft = revised(answer, target, why, currentBody);
    return draft === null ? null : "unplaced" in draft ? { answer, unplaced: draft.unplaced } : { answer, draft };
  });
}

/** The revision a reviser's answer holds, or nothing. */
function revised(answer: string, target: string, why: string, current: string): SynthesisResult | { unplaced: string } | null {
  const parsed = extractJson(answer);
  if (!parsed) {
    log.warn("reflection revision did not answer with JSON", { skill: target, head: answer.slice(0, 120) });
    return null;
  }

  // Edits where it gave them; a whole body where it gave that (the weekly review's rewrite, or a model that wrote the
  // skill again whatever it was asked); the body as it stands where all it added is a file beside it.
  const edits = readEdits(parsed.edits);
  const made = edits.length > 0 ? patched(current, edits) : null;
  if (made && "failed" in made) return { unplaced: made.failed };
  const body = made ? made.body : typeof parsed.body === "string" && parsed.body.trim() ? parsed.body.trim() : readFiles(parsed.files).length > 0 ? current : "";
  if (!body) {
    log.warn("reflection revision came back with no body", { skill: target });
    return null;
  }
  if (!skillBodyIsEnglish(body)) {
    log.warn("reflection rewrote the skill in another language, so it was dropped", { skill: target });
    return null;
  }

  return {
    name: target,
    target,
    description: typeof parsed.description === "string" ? parsed.description.trim() : "",
    requires: typeof parsed.requires === "string" ? parsed.requires.trim() : "",
    needsTools: typeof parsed.needs_tools === "string" ? parsed.needs_tools.trim() : "",
    body,
    files: readFiles(parsed.files),
    why,
  };
}

/** A revision asked for by the weekly review rather than a conversation: `input.transcript` holds its reason. */
export async function reviseSkill(input: SynthesisInput, target: string, why: string): Promise<SynthesisResult | null> {
  return await revise(input, target, why, "rewrite");
}

/**
 * Support files the model asked for, filtered rather than refused.
 *
 * One bad path should not lose an otherwise good improvement — the body is the valuable part and
 * the file is an extra. What survives is re-validated by `validateSupportFiles` before anything is
 * written, so this is a first sieve and not the security boundary.
 */
function readFiles(raw: unknown): SkillFile[] {
  if (!Array.isArray(raw)) return [];
  const files: SkillFile[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { path, content } = entry as Record<string, unknown>;
    if (typeof path !== "string" || typeof content !== "string" || !content.trim()) continue;
    if (!/^(references|scripts|templates)\/[a-z0-9][a-z0-9._-]{0,63}$/.test(path)) {
      log.warn("reflection proposed a support file at a path it may not use", { path });
      continue;
    }
    files.push({ path, content });
  }
  return files;
}

/**
 * Reading *another* skill, for the two passes that decide which skill a lesson belongs to.
 *
 * Triage matches a lesson against one description line per skill — deliberately, because eighteen
 * bodies is tens of thousands of tokens on every reflection. That is enough to shortlist and not
 * enough to be sure: "this is already covered" and "this is a gap in that skill" look identical from
 * a description, and getting it wrong puts a lesson in the skill nobody reads for it.
 *
 * Author has the sharper version of the same problem. It must name the nearest existing skill and
 * say why that skill should not simply absorb the lesson — an argument it was making without having
 * opened the file.
 *
 * Scoped to the pool, which is where every name it could ask for comes from: the list is in its own
 * prompt, and `readSkill` resolves through that listing rather than joining a path.
 */
const READ_SKILL_TOOL: ToolDefinition = {
  name: "read_skill",
  description:
    "Read an existing skill's body in full, by name, from the list above. Use it before deciding that a skill already covers this lesson, or that it should not absorb it: a one-line description cannot settle either.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exactly as it appears in the list of existing skills." },
    },
    required: ["name"],
  },
};

/**
 * The one tool the revise pass gets, and the reason it gets exactly one.
 *
 * Hermes' review is a fork of the whole agent — same toolset, same system prompt — so it can list
 * skills, view them, read the repo, then write. Ours made two blind calls: a transcript and one
 * `SKILL.md`, and a whole improved body demanded in a single shot. That is most of why the
 * improvements read thin. It could only edit the body, because the body was the only thing it knew
 * existed.
 *
 * So it can now read, and only inside the skill it was asked to improve. Not the parent's full
 * toolset, because this pass runs unattended with no approval gate: `exec` or an unscoped `read`
 * there would be a filesystem reachable by a model nobody is watching, which is a much larger
 * change than the one being made. Reading the files a skill already ships is enough to extend
 * `references/errors.md` instead of overwriting it, and that was the concrete gap.
 */
const READ_FILE_TOOL: ToolDefinition = {
  name: "read_skill_file",
  description:
    "Read one file this skill already ships, so you can extend it rather than replace it. `SKILL.md` for the body, or a path under references/, scripts/ or templates/ as listed above. Read before you rewrite: anything you return under `files` replaces a file of that name outright.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "SKILL.md, or one of the support-file paths listed for this skill.",
      },
    },
    required: ["path"],
  },
};

/**
 * How many rounds of reading before it has to answer.
 *
 * Four is enough for a skill with a couple of references plus a re-read, and it is a ceiling rather
 * than a target — a pass with nothing to look up answers on the first round and costs exactly what
 * it did before. The bound matters because nobody is waiting on this and nothing would notice a loop
 * that kept asking.
 */
const MAX_READ_ROUNDS = 4;

/**
 * Ask, letting the model read the skill's own files first.
 *
 * Falls back to the plain single call when no reader is supplied — the create path has no skill to
 * read yet, and every test that scripts one answer keeps working.
 */
async function askWithFiles(
  input: SynthesisInput,
  instruction: string,
  content: string,
  /**
   * The tools this call may use, and what each one returns.
   *
   * A map rather than a fixed pair, because all three passes read now and they read different
   * things. Triage and author want *another skill's* body — triage decides which existing skill a
   * lesson belongs to from one description line, and author names the "closest" skill without ever
   * having opened it. Revise wants the files beside the skill already in its prompt. Same loop, same
   * round cap, different reach.
   */
  readers: { tool: ToolDefinition; read: (arg: string) => Promise<string | null> }[],
  maxTokens: number,
  /** The model this call runs on, where it is not the writer's (`SynthesisInput.triageModel`). */
  model = input.model,
): Promise<string | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: instruction, timestamp: Date.now() },
    { role: "user", content, timestamp: Date.now() },
  ];

  for (let round = 0; round <= MAX_READ_ROUNDS; round += 1) {
    let response;
    try {
      response = await input.provider.chat({
        model,
        maxTokens,
        temperature: 0,
        messages,
        // Withheld on the last round, so the model cannot spend it on a read it has no turn left to
        // use. A provider that sees no tools returns prose, which is the answer we want by then.
        ...(round < MAX_READ_ROUNDS ? { tools: readers.map((r) => r.tool) } : {}),
      });
    } catch (err) {
      log.warn("reflection pass failed: no draft from this turn", { error: String(err) });
      return null;
    }

    const calls = response.toolCalls ?? [];
    if (response.cutAtLimit) {
      // Said for what it is: an answer cut at the output limit is not one that "did not answer with JSON".
      log.warn("reflection answer was cut at the output limit: no draft from this turn", { model, limit: maxTokens });
      return null;
    }
    if (calls.length === 0) return response.text;

    messages.push({
      role: "assistant",
      content: response.text ?? "",
      toolCalls: calls,
      timestamp: Date.now(),
    });
    for (const call of calls) {
      // `path` for a file, `name` for a skill — whichever the tool declared. Read as one field
      // rather than branched per tool: this loop's job is to route the call, not to know the shapes.
      const arg =
        typeof call.arguments.path === "string"
          ? call.arguments.path
          : typeof call.arguments.name === "string"
            ? call.arguments.name
            : "";
      const reader = readers.find((r) => r.tool.name === call.name);
      const body = reader ? await reader.read(arg) : null;
      messages.push({
        role: "tool",
        // Said rather than left empty: a model handed nothing re-reads the same path, and that is how
        // the round budget goes on one missing file.
        content: body ?? `Nothing called "${arg}". Only what is listed above exists.`,
        toolCallId: call.id,
        timestamp: Date.now(),
      });
    }
  }

  // Every round spent reading. Not an error worth raising — the turn is finished and nobody is
  // waiting — but worth a line, because it means a skill's files are big enough to change the shape
  // of this pass.
  log.warn("reflection spent every round reading and never answered", { rounds: MAX_READ_ROUNDS });
  return null;
}

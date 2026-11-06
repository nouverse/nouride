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

import { extractJson } from "@/modules/llm/json-answer.ts";
import { outputCap } from "@/modules/llm/output-cap.ts";
import { createLogger, messageText, type ChatMessage, type LLMProvider, type ToolDefinition } from "@nouride/shared";
import { skillBodyIsEnglish, VALID_SKILL_NAME } from "@nouride/persona";
import { AUTHOR_INSTRUCTION, REVISE_INSTRUCTION, TRIAGE_INSTRUCTION, renderCandidates, renderSkillList } from "./prompts.ts";
import { redact } from "@nouride/secrets";
import { cutAtWord } from "@/commons/cut-at-word.ts";
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

/**
 * Characters of transcript the pass reads.
 *
 * Raised from 24,000, which was too small for the trigger that fires most often. Watched live: a
 * 22-turn session scaffolding a video project ran 35,680 characters of prompts and replies **before
 * counting a single tool result**, and one of its turns made 25 tool calls. `sustained_effort` fires
 * *because* the conversation was long, and then showed triage only its last third — so the eight
 * turns where the work was decided and the failures happened were invisible, and the pass declined
 * eight times describing the tail as routine.
 *
 * One triage call at this size is roughly 15k tokens, against agent turns on the same box measured
 * at 53k-110k input. The pass reading less than the agent did is the wrong economy.
 */
const MAX_TRANSCRIPT_CHARS = 60_000;

/** One recent tool result, before the transcript is budgeted. A 200KB log teaches nothing extra. */
const MAX_MESSAGE_CHARS = 2_000;

/**
 * The floor for an older message, so the whole arc survives instead of its last fifth.
 *
 * The head used to be dropped outright, and that is the wrong half to lose: "this failed, then this
 * failed, then *this* worked" is the shape of a lesson. Cutting the head leaves only the part where
 * everything already works, which reads as routine and gets skipped.
 */
const MIN_MESSAGE_CHARS = 320;

/** Messages kept at full width. Older ones are compressed rather than dropped. */
const FULL_WIDTH_MESSAGES = 24;

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
    ...(input.candidates?.length ? ["", renderCandidates(input.candidates)] : []),
    "",
    "Transcript:",
    input.transcript,
  ].join("\n");

  const triaged = parseTriage(
    await askWithFiles(input, TRIAGE_INSTRUCTION, context, [
      { tool: READ_SKILL_TOOL, read: (name) => input.readSkill(name) },
    ], TRIAGE_OUTPUT_TOKENS),
  );
  if (!triaged) return null;

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
    return null;
  }
  // `attach` is a revision asked to land in a file rather than in the body — same call, same output
  // shape, one extra sentence of steer. A third prompt for it would be a third thing to keep in step.
  return await revise(input, triaged.target, triaged.why, triaged.decision === "attach");
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
export function parseTriage(text: string | null): Triage | null {
  if (text === null) return null;
  const parsed = extractJson(text);
  if (!parsed) {
    log.warn("reflection triage did not answer with JSON", { head: text.slice(0, 120) });
    return null;
  }

  const decision = typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
  const why = typeof parsed.why === "string" ? cutAtWord(parsed.why.replace(/\s+/g, " ").trim(), 200) : "";

  if (decision === "skip") {
    log.info("reflection pass declined", { reason: String(parsed.reason ?? "no reason given") });
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
    const description = typeof parsed.description === "string" ? parsed.description.replace(/\s+/g, " ").trim() : "";
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

/** Second call, create branch. */
async function author(
  input: SynthesisInput,
  context: string,
  why: string,
): Promise<SynthesisResult | null> {
  const answer = await askWithFiles(input, AUTHOR_INSTRUCTION, context, [
    { tool: READ_SKILL_TOOL, read: (name) => input.readSkill(name) },
  ], skillOutputTokens(input.model));
  if (answer === null) return null;

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
  /** Triage judged the lesson bulky: it belongs beside the skill rather than inside it. */
  preferSupportFile = false,
): Promise<SynthesisResult | null> {
  const current = await input.readSkill(target);
  if (current === null) {
    log.warn("reflection wanted to improve a skill that is not there", { skill: target });
    return null;
  }

  const answer = await askWithFiles(
    input,
    REVISE_INSTRUCTION,
    [
      `Skill: ${target}`,
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
      ...(preferSupportFile
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
    ].join("\n"),
    [
      {
        tool: READ_FILE_TOOL,
        // `SKILL.md` is already in the prompt above; offering it here too costs a round for nothing,
        // so the reader serves support files and answers for anything else.
        read: async (path) =>
          path === "SKILL.md" ? current : ((await input.readSkillFile?.(target, path)) ?? null),
      },
    ],
    skillOutputTokens(input.model),
  );
  if (answer === null) return null;

  const parsed = extractJson(answer);
  if (!parsed) {
    log.warn("reflection revision did not answer with JSON", { skill: target, head: answer.slice(0, 120) });
    return null;
  }

  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
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
  return await revise(input, target, why);
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
): Promise<string | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: instruction, timestamp: Date.now() },
    { role: "user", content, timestamp: Date.now() },
  ];

  for (let round = 0; round <= MAX_READ_ROUNDS; round += 1) {
    let response;
    try {
      response = await input.provider.chat({
        model: input.model,
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
      log.warn("reflection answer was cut at the output limit: no draft from this turn", { model: input.model, limit: maxTokens });
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


/**
 * The turn, flattened into something a model can read — and scrubbed on the way out.
 *
 * Redaction happens here rather than at the call site so there is exactly one path from a turn to a
 * transcript, and it is not possible to build one that skips it. The same string is what gets stored
 * on the draft, so what the reviewer inspects is what the model was shown.
 *
 * Long tool results are cut in the middle rather than at the end: an error message is usually at the
 * top of a failing command's output and the recovery at the bottom, and keeping only the head loses
 * the half the reflection is about.
 *
 * The conversation is budgeted so the whole of it is visible.
 *
 * Recent messages keep their full width; older ones are compressed to fit, and dropped only when
 * even the floor will not. That ordering is the point: the tail holds the method that finally
 * worked, the head holds the failures that make it worth writing down, and losing either leaves the
 * pass reading a different conversation from the one that happened.
 *
 * No attempt is made to *find* the failures and keep those. That needs a guess about what a failure
 * looks like in free text, and a wrong guess quietly changes what the pass sees — the trap a
 * language check for skills already fell into once. Compressing evenly needs no such guess.
 */
export function buildTranscript(messages: ChatMessage[]): { text: string; redactions: string[] } {
  const label = (message: ChatMessage) => (message.role === "tool" ? "tool result" : message.role);
  /** The blank line between entries, plus the label and its colon. */
  const overhead = (message: ChatMessage) => label(message).length + 4;

  const recentFrom = Math.max(0, messages.length - FULL_WIDTH_MESSAGES);
  const recent = messages.slice(recentFrom);
  const older = messages.slice(0, recentFrom);

  const spend = (list: ChatMessage[], width: number) =>
    list.reduce((total, m) => total + Math.min(m.content.length, width) + overhead(m), 0);

  /**
   * What the older half may spend, once the recent half has taken what it needs.
   *
   * The recent half is never squeezed to make room for the older one: a lesson is written from the
   * method that worked, and that is at the end.
   */
  const budget = MAX_TRANSCRIPT_CHARS - spend(recent, MAX_MESSAGE_CHARS);
  let kept = older;
  let width = MAX_MESSAGE_CHARS;

  if (budget <= 0) {
    kept = [];
  } else {
    // Widest that fits, down to the floor. Halved rather than solved for: the content lengths are
    // arbitrary, so this converges in a few steps and needs no arithmetic anybody has to trust.
    while (width > MIN_MESSAGE_CHARS && spend(kept, width) > budget) width = Math.floor(width / 2);
    width = Math.max(width, MIN_MESSAGE_CHARS);
    // Still over at the floor: drop from the oldest end, the only end that can go.
    while (kept.length > 0 && spend(kept, width) > budget) kept = kept.slice(1);
  }

  const dropped = older.length - kept.length;
  const lines = [
    ...(dropped > 0 ? [`[${dropped} earlier message(s) dropped for length]`] : []),
    ...kept.map((m) => `${label(m)}: ${clip(messageText(m.content), width)}`),
    ...recent.map((m) => `${label(m)}: ${clip(messageText(m.content), MAX_MESSAGE_CHARS)}`),
  ];

  const scrubbed = redact(lines.join("\n\n"));
  return { text: scrubbed.text, redactions: scrubbed.hits };
}

/** Head and tail of one message, because a command cut in half is worse than one with a gap. */
function clip(content: string, width: number): string {
  if (content.length <= width) return content;
  const half = Math.floor(width / 2);
  return `${content.slice(0, half)}\n…[${content.length - width} characters cut]…\n${content.slice(content.length - half)}`;
}

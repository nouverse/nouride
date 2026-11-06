/**
 * The weekly review of the skill library — the part Hermes has no counterpart for.
 *
 * A pass that only adds grows a library nobody prunes. On the x64 box by 2026-10-22, six skills held facts about one
 * homelab, one had grown to 306 lines of incidents, three covered one subject (`deployment`, `deployment-docker`,
 * `deployment-k8s`) and one named a single audit workbook. So once a week the library is read whole, and three kinds
 * of proposal come out of it:
 *
 * - **tighten** — a skill past `BODY_CHARS`, or naming this environment or telling a session (`notAProcedure`):
 *   rewritten into its procedure, shorter than it was.
 * - **merge** — skills covering one subject, found by one model call over the names and descriptions: one rewritten
 *   to hold all of them, the others archived when it is approved.
 * - **archive** — a skill nobody has read in `UNREAD_DAYS` and older than that: moved to `skills/.archive/`, where
 *   moving it back undoes it.
 *
 * Which skills to rewrite or archive is decided in code — size, the lint, the audit log's reads — so a quiet library
 * costs one short call a week, the merge question. Only what an agent wrote is touched: a person's skill and a built-in are theirs. Every proposal
 * is a draft that waits for a person, in every mode: a rewrite or a move of something many agents rely on is a
 * decision, not a lesson.
 */

import { createLogger, type LLMProvider } from "@nouride/shared";
import { parseFrontmatter, type SkillState } from "@nouride/persona";
import { readTextFileIfExists } from "@nouride/runtime";
import type { SkillRead } from "@/commons/audit.store.ts";
import { extractJson } from "@/modules/llm/json-answer.ts";
import { BODY_CHARS, notAProcedure } from "./draft-lint.ts";
import type { DraftsPort } from "./drafts.store.ts";
import { refusalOf } from "./gates.ts";
import { listSkillFiles, readPool, readSkill, readSkillFile } from "./pool.ts";
import { reviseSkill, type SynthesisResult } from "./synthesis.ts";
import { cutAtWord } from "@/commons/cut-at-word.ts";

const log = createLogger("reflection.review");
const DAY_MS = 86_400_000;

/** A week between reviews: long enough that a skill has been used or not, short enough that a mistake does not set. */
export const REVIEW_EVERY_DAYS = 7;
/** A skill nobody has read in this long, and older than it, is proposed for the archive. */
const UNREAD_DAYS = 45;
/** Rewrites one review may ask a model for — each is a call; the merge question is one more. */
const MAX_REWRITES = 3;
/** Archive proposals one review makes: free to make, but each is a decision somebody reads. */
const MAX_ARCHIVES = 5;
/** Merges one review proposes. */
const MAX_MERGES = 2;

export interface ReviewReport {
  tighten: string[];
  merge: { into: string; retire: string[] }[];
  archive: string[];
  /** Rewrites the model wrote and the checks turned down, with why. */
  declined: { skill: string; reason: string }[];
}

export interface ReviewDeps {
  agentsDir: string;
  builtinSkillsDir?: string;
  drafts: DraftsPort;
  /** When each path was last read, and since when that has been watched (`AuditLog.skillReads`). */
  lastRead: (paths: string[]) => Map<string, SkillRead>;
  /** A metered provider and model to ask for an agent — the skill's author for its own rewrite, any for the merge question. */
  asker: (agentId: string | undefined) => { provider: LLMProvider; model: string; agentId: string } | null;
  now: () => number;
}

interface Entry {
  skill: SkillState;
  body: string;
  born: number;
  /** Not read since this: its last read, or when its reads began to be kept. */
  unreadSince: number;
}

const MERGE_INSTRUCTION = [
  "You review a library of skills: procedures an agent follows for a kind of task. Below is each skill an agent wrote,",
  "with when to use it and its size. Find the skills that cover **one subject**: an agent wanting one would want the",
  "others too, and a lesson about one belongs in the same place. A shared noun is not a shared subject: two skills",
  "that both mention Docker are one subject only if the task is the same. Most libraries have none; say so.",
  "",
  "Reply with a single JSON object and nothing else:",
  '{"merge": [{"into": "the skill to keep", "skills": ["the others"], "why": "one line"}]}',
  "",
  `At most ${MAX_MERGES} groups. Keep the skill whose name and scope fit the whole subject best.`,
].join("\n");

async function entries(deps: ReviewDeps): Promise<Entry[]> {
  // Only what an agent wrote, and nothing a draft is already waiting on.
  const pool = (await readPool(deps.agentsDir, deps.builtinSkillsDir)).filter((skill) => skill.scope === "shared" && skill.author && !deps.drafts.pendingByName(skill.name));
  const read = deps.lastRead(pool.map((skill) => skill.path));
  return await Promise.all(
    pool.map(async (skill) => {
      const { fields, body } = parseFrontmatter((await readTextFileIfExists(skill.path)) ?? "");
      const born = Date.parse(fields.updated ?? fields.created ?? "");
      const seen = read.get(skill.path);
      return { skill, body: body.trim(), born: Number.isNaN(born) ? 0 : born, unreadSince: seen ? (seen.readAt ?? seen.since) : deps.now() };
    }),
  );
}

/** The groups the model says cover one subject, kept only where every name is a skill this review may touch. */
async function mergeGroups(deps: ReviewDeps, eligible: Entry[]): Promise<{ into: string; retire: string[]; why: string }[]> {
  if (eligible.length < 2) return [];
  const asker = deps.asker(undefined);
  if (!asker) return [];
  const list = eligible.map((entry) => `- ${entry.skill.name} (${entry.body.length.toLocaleString("en-US")} characters): ${entry.skill.description}`).join("\n");
  let text: string | null = null;
  try {
    const answer = await asker.provider.chat({ model: asker.model, messages: [{ role: "system", content: MERGE_INSTRUCTION }, { role: "user", content: list }], maxTokens: 800, temperature: 0 });
    text = answer.text;
  } catch (err) {
    log.warn("the weekly review could not ask which skills overlap", { error: String(err) });
    return [];
  }
  const parsed = extractJson(text ?? "");
  const names = new Set(eligible.map((entry) => entry.skill.name));
  const taken = new Set<string>();
  const groups: { into: string; retire: string[]; why: string }[] = [];
  for (const raw of Array.isArray(parsed?.merge) ? parsed.merge : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const { into, skills, why } = raw as Record<string, unknown>;
    if (typeof into !== "string" || !names.has(into) || taken.has(into) || !Array.isArray(skills)) continue;
    const retire = [...new Set(skills.filter((name): name is string => typeof name === "string" && names.has(name) && name !== into && !taken.has(name)))];
    if (retire.length === 0) continue;
    for (const name of [into, ...retire]) taken.add(name);
    groups.push({ into, retire, why: typeof why === "string" ? cutAtWord(why.replace(/\s+/g, " ").trim(), 200) : "" });
    if (groups.length >= MAX_MERGES) break;
  }
  return groups;
}

/** One rewrite through the revise call, its reason as the context, checked as any draft is. */
async function rewrite(deps: ReviewDeps, pool: SkillState[], entry: Entry, reason: string, why: string): Promise<SynthesisResult | { refused: string } | null> {
  const asker = deps.asker(entry.skill.author);
  if (!asker) return null;
  const result = await reviseSkill(
    {
      provider: asker.provider,
      model: asker.model,
      transcript: reason,
      trigger: { kind: "curation", reason: why },
      existing: [],
      readSkill: (name) => readSkill(pool, name, deps.drafts),
      listSkillFiles: (name) => listSkillFiles(pool, name),
      readSkillFile: (name, path) => readSkillFile(pool, name, path),
    },
    entry.skill.name,
    why,
  );
  if (!result) return null;
  const refused = await refusalOf(result, pool, deps.drafts);
  if (refused) return { refused };
  return result;
}

/** Read the library and leave what it should become as drafts. */
export async function reviewLibrary(deps: ReviewDeps): Promise<ReviewReport> {
  const report: ReviewReport = { tighten: [], merge: [], archive: [], declined: [] };
  const all = await entries(deps);
  const pool = await readPool(deps.agentsDir, deps.builtinSkillsDir);
  const now = deps.now();
  const draft = (entry: Entry, fields: { body: string; description?: string; requires?: string; needsTools?: string; files?: SynthesisResult["files"]; retire: string[]; why: string; reason: string }) =>
    deps.drafts.create({
      agentId: entry.skill.author ?? "",
      triggerKind: "curation",
      triggerReason: fields.why,
      name: entry.skill.name,
      description: fields.description || entry.skill.description,
      requires: fields.requires ?? (entry.skill.requires ?? []).join(", "),
      ...(fields.needsTools ? { needsTools: fields.needsTools } : {}),
      body: fields.body,
      target: entry.skill.name,
      ...(fields.files?.length ? { files: fields.files } : {}),
      ...(fields.retire.length ? { retire: fields.retire } : {}),
      transcript: fields.reason,
    });

  const groups = await mergeGroups(deps, all);
  const merging = new Set(groups.flatMap((group) => [group.into, ...group.retire]));
  let rewrites = 0;

  for (const group of groups) {
    if (rewrites >= MAX_REWRITES) break;
    const into = all.find((entry) => entry.skill.name === group.into)!;
    const others = group.retire.map((name) => all.find((entry) => entry.skill.name === name)!);
    const reason = [
      `Merge ${group.retire.join(", ")} into this skill: ${group.why || "they cover one subject"}.`,
      "Keep every procedure from each that is still true, once; drop what repeats. The others are archived when this is",
      `approved, so nothing of theirs survives outside this body and its references/. Keep the body under ${BODY_CHARS.toLocaleString("en-US")} characters.`,
      ...others.flatMap((other) => ["", `### ${other.skill.name}: ${other.skill.description}`, "", other.body]),
    ].join("\n");
    rewrites += 1;
    const result = await rewrite(deps, pool, into, reason, `merge ${group.retire.join(", ")} into ${group.into}: ${group.why}`);
    if (!result) continue;
    if ("refused" in result) {
      report.declined.push({ skill: group.into, reason: result.refused });
      continue;
    }
    draft(into, { ...result, retire: group.retire, why: `merge ${group.retire.join(", ")} into this one: ${group.why}`, reason });
    report.merge.push({ into: group.into, retire: group.retire });
  }

  // Largest first: the one costing the most to read is the one most worth a call.
  const bloated = all
    .filter((entry) => !merging.has(entry.skill.name))
    .map((entry) => ({ entry, why: entry.body.length > BODY_CHARS ? `${entry.body.length.toLocaleString("en-US")} characters, past ${BODY_CHARS.toLocaleString("en-US")}` : notAProcedure(entry.body) }))
    .filter((found): found is { entry: Entry; why: string } => found.why !== null)
    .sort((a, b) => b.entry.body.length - a.entry.body.length);
  for (const { entry, why } of bloated) {
    if (rewrites >= MAX_REWRITES) break;
    const reason = [
      `This skill is ${why}. Tighten it into the procedure it is: keep every step that is still true, merge repeated`,
      "pitfalls, and take out dated incidents and facts about this environment (hosts, addresses, accounts, paths); memory",
      `keeps those. Move bulky detail to references/. It must end shorter than it started and under ${BODY_CHARS.toLocaleString("en-US")} characters.`,
    ].join(" ");
    rewrites += 1;
    const result = await rewrite(deps, pool, entry, reason, `tighten: ${why}`);
    if (!result) continue;
    // Past the limit, it has to come back shorter; for an address or a session told, the lint above is the test.
    if ("refused" in result || (entry.body.length > BODY_CHARS && result.body.length >= entry.body.length)) {
      report.declined.push({ skill: entry.skill.name, reason: "refused" in result ? result.refused : "the rewrite was not shorter" });
      continue;
    }
    draft(entry, { ...result, retire: [], why: `tighten: ${why}`, reason });
    report.tighten.push(entry.skill.name);
  }

  const stale = all
    .filter((entry) => !merging.has(entry.skill.name) && !report.tighten.includes(entry.skill.name))
    .filter((entry) => entry.born < now - UNREAD_DAYS * DAY_MS && entry.unreadSince < now - UNREAD_DAYS * DAY_MS)
    .slice(0, MAX_ARCHIVES);
  for (const entry of stale) {
    const why = `not read since ${new Date(entry.unreadSince).toISOString().slice(0, 10)}, over ${UNREAD_DAYS} days`;
    draft(entry, { body: entry.body, retire: [entry.skill.name], why: `archive: ${why}`, reason: `The weekly review found this skill ${why}.` });
    report.archive.push(entry.skill.name);
  }

  log.info("the weekly skill review ran", { ...report, declined: report.declined.length });
  return report;
}

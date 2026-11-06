/**
 * What a helper is handed: a brief — the goal, the context, the constraints, the deliverable — checked before anything
 * starts.
 *
 * It was one string of up to 4,000 characters, and what a model put in it was the shortest instruction that read as
 * complete to the model writing it: "check the logs on the NAS". The helper starts with nothing of the conversation —
 * which logs, which NAS, what was already tried — so it spent its first rounds finding out, or guessed. The owner's
 * words for what they wanted instead (2026-10-18): the parent gives its helper the context on its own initiative, "supaya
 * ga bingung dan bertele-tele" — so it is neither lost nor long-winded.
 *
 * So the shape asks for each part, and the one that matters most is refused when it is empty: a helper that starts
 * confused costs more than the one sentence the parent would have spent. Written in English whatever language the
 * person speaks — the helper reads it, and English is what a model's tool use is strongest in; the parent translates
 * when it reports. Checked on its prose alone (`workTextIsEnglish`): a brief is full of paths, names, commands and a
 * person's words quoted as they were said, and none of those is the brief's language.
 */

import { workTextIsEnglish, writeWorkInEnglish } from "@/modules/memory/index.ts";

/**
 * How far a brief reaches, and where it stops (0.7.25) — the same words in the harness's `delegate` lines and in what
 * `ask_agent` asks of its task. Not in `delegate`'s own description too: the harness already says it beside that tool,
 * and a schema is re-sent on every request.
 *
 * Live: a lead's brief said "delete these three ZFS datasets" and also asked for the root cause and the options for a
 * permanent fix, with nothing on when to stop — and the delegate spent fourteen minutes tracing the kernel on a
 * production hypervisor. A change is one brief; finding out why is another, which changes nothing.
 */
export const BRIEF_SCOPE =
  "A brief that changes or deletes something asks for that change only: research (a root cause, options for a fix) " +
  "goes in a separate, read-only brief. Say when to stop and report (after two failed attempts, or at anything " +
  "unexpected) and what to hand back.";

/** A helper's brief, as the agent wrote it — and as the job keeps it (`jobs.brief`). */
export interface HelperBrief {
  /** What the helper is to achieve, in a sentence. */
  goal: string;
  /** What it needs and cannot know: paths, hosts, decisions already made, what was tried. */
  context: string;
  /** What it must not do, or must keep to. */
  constraints?: string;
  /** What it hands back, and in what shape. */
  deliverable: string;
}

/** A goal is a sentence: it heads the job in `nouride jobs`, the dashboard and the report that comes back. */
const MAX_GOAL_CHARS = 300;

/** The whole brief. Longer material belongs in a file the brief names, where the helper can read the part it needs. */
const MAX_BRIEF_CHARS = 6_000;

/** What a model writes for "nothing" — a context of only this is an empty one. */
const PLACEHOLDER = /^(?:none|n\/?a|nil|null|nothing|empty|no context|tidak ada|-+|—|\.+|\?+)$/i; // em-dash-ok: what a model writes for an empty field

const SHAPE = '{"goal", "context", "constraints", "deliverable"}';

/** Each task's brief, or what is wrong with the first that is not one — said so the model can fix the call. */
export function parseBriefs(raw: unknown, max: number): { briefs: HelperBrief[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: `\`tasks\` must be a non-empty array of briefs, each ${SHAPE}.` };
  }
  if (raw.length > max) {
    return { error: `At most ${max} tasks at once. Send the most important ones and follow up.` };
  }
  const briefs: HelperBrief[] = [];
  for (const [index, entry] of raw.entries()) {
    const brief = parseBrief(entry, `Task ${index + 1}`);
    if ("error" in brief) return brief;
    briefs.push(brief.brief);
  }
  return { briefs };
}

function parseBrief(entry: unknown, task: string): { brief: HelperBrief } | { error: string } {
  if (typeof entry === "string") {
    return {
      error:
        `${task} is a single string. Each task is a brief: ${SHAPE}, written in English. The helper starts with ` +
        `nothing of this conversation, so \`context\` carries what it needs.`,
    };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { error: `${task} must be a brief: ${SHAPE}.` };
  const fields = entry as Record<string, unknown>;
  const text = (key: string): string => (typeof fields[key] === "string" ? (fields[key] as string).trim() : "");

  const goal = text("goal");
  if (!goal) return { error: `${task} has no \`goal\`: say in one sentence what the helper is to achieve.` };
  if (goal.length > MAX_GOAL_CHARS) {
    return { error: `${task}'s \`goal\` is ${goal.length} characters; keep it to one sentence, under ${MAX_GOAL_CHARS}, and put the rest in \`context\`.` };
  }

  const context = text("context");
  if (!context || PLACEHOLDER.test(context)) {
    return {
      error:
        `${task}'s \`context\` is empty. The helper starts with nothing of this conversation, so add what it needs and ` +
        `cannot know: the paths, hosts or repositories involved, decisions already made, what has been tried and what ` +
        `came of it, and anything the person said that changes the work. A sentence or two is enough: a helper that ` +
        `starts confused costs more than that sentence.`,
    };
  }

  const deliverable = text("deliverable");
  if (!deliverable) {
    return {
      error:
        `${task} has no \`deliverable\`: say what the helper hands back and in what shape (findings with their paths, ` +
        `a yes or no with the evidence, the file it writes).`,
    };
  }

  const constraints = text("constraints");
  const brief: HelperBrief = { goal, context, ...(constraints ? { constraints } : {}), deliverable };
  const length = goal.length + context.length + constraints.length + deliverable.length;
  if (length > MAX_BRIEF_CHARS) {
    return {
      error:
        `${task}'s brief is ${length} characters; keep it under ${MAX_BRIEF_CHARS}. Put long material in a file in ` +
        `the workspace and name its path in \`context\`: the helper reads the part it needs.`,
    };
  }
  if (!workTextIsEnglish([goal, context, constraints, deliverable].join("\n"))) return { error: writeWorkInEnglish(`${task}'s brief`) };
  return { brief };
}

/**
 * The brief as the helper reads it: its first message, one heading per part.
 *
 * Headings rather than prose, so the deliverable is where the helper looks for it when it is done — the part a model
 * forgets first in a long run is what it was asked to hand back.
 */
export function renderBrief(brief: HelperBrief): string {
  return [
    "GOAL",
    brief.goal,
    "",
    "CONTEXT",
    brief.context,
    ...(brief.constraints ? ["", "CONSTRAINTS", brief.constraints] : []),
    "",
    "DELIVERABLE",
    brief.deliverable,
  ].join("\n");
}

/** The goal on one line, for a list or a heading. */
export function goalLine(brief: Pick<HelperBrief, "goal">, max = 120): string {
  const flat = brief.goal.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The same goal said twice — what a helper already running is not started again for. */
export function sameGoal(a: Pick<HelperBrief, "goal">, b: Pick<HelperBrief, "goal">): boolean {
  const norm = (goal: string) => goal.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return norm(a.goal) === norm(b.goal);
}

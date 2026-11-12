/**
 * A list of steps as somebody wrote it — the dashboard's editor, a file given to the CLI, an agent's proposal — read
 * into the steps a job keeps. One reader for all three, so a step means the same whoever wrote it.
 *
 * It reads and names; what a step must be is `validate.ts`, which every job passes on its way into the store. Two
 * things are made easy here for a writer who is not the dashboard: a step with no id is given one by its place, and an
 * exit may name a step by its number.
 */

import type { JobStep, StepGo } from "@nouride/shared";
import { CronValidationError } from "./validate.ts";

const KINDS = ["systemEvent", "agentTurn", "command", "mission", "approval"] as const;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The steps of a job of several, from an untrusted list. */
export function stepsFrom(raw: unknown): JobStep[] {
  if (!Array.isArray(raw)) throw new CronValidationError("a job of steps needs its `steps`, a list.", "steps");
  const records = raw.map((one) => (one && typeof one === "object" ? (one as Record<string, unknown>) : {}));
  // Ids first: an exit may point at a step further down, which has to have its id by then.
  const taken = new Set(records.map((step) => text(step.id).trim()).filter(Boolean));
  const ids = records.map((step, index) => {
    const own = text(step.id).trim();
    if (own) return own;
    let made = `s${index + 1}`;
    while (taken.has(made)) made = `${made}x`;
    taken.add(made);
    return made;
  });
  return records.map((step, index) => stepFrom(step, index, ids));
}

function stepFrom(step: Record<string, unknown>, index: number, ids: readonly string[]): JobStep {
  const kind = KINDS.find((one) => one === step.kind);
  if (!kind) throw new CronValidationError(`step ${index + 1} must be a message, an agent's turn, a command, a mission or a wait for a person.`, "steps");
  const exit = (name: "then" | "whenFailed" | "whenEmpty"): Partial<Record<typeof name, StepGo>> => {
    const go = goFrom(step[name], ids);
    return go === undefined ? {} : ({ [name]: go } as Partial<Record<typeof name, StepGo>>);
  };
  const common = {
    id: ids[index]!,
    ...(text(step.name).trim() ? { name: text(step.name).trim().slice(0, 80) } : {}),
    ...exit("then"),
    ...exit("whenFailed"),
    ...exit("whenEmpty"),
    ...(step.onlyChanged === true ? { onlyChanged: true as const } : {}),
  };
  const agent = text(step.agentId).trim() ? { agentId: text(step.agentId).trim() } : {};

  switch (kind) {
    case "systemEvent":
      return { ...common, kind, text: text(step.text) };
    case "agentTurn":
      return { ...common, kind, message: text(step.message), ...(text(step.model).trim() ? { model: text(step.model).trim() } : {}), ...agent };
    case "command":
      return {
        ...common,
        kind,
        argv: Array.isArray(step.argv) ? step.argv.map(String) : [],
        ...(text(step.cwd) ? { cwd: text(step.cwd) } : {}),
        ...(typeof step.timeoutMs === "number" ? { timeoutMs: step.timeoutMs } : {}),
      };
    case "mission": {
      const checks = Array.isArray(step.checks) ? step.checks.map(String).map((check) => check.trim()).filter(Boolean) : [];
      return {
        ...common,
        kind,
        goal: text(step.goal).trim(),
        ...(checks.length > 0 ? { checks } : {}),
        // `false` turns the reviewer off; criteria in words, or nothing for the goal itself.
        ...(step.review === false ? { review: false as const } : text(step.review).trim() ? { review: text(step.review).trim() } : {}),
        ...agent,
      };
    }
    case "approval":
      return { ...common, kind, ask: text(step.ask).trim(), ...(typeof step.timeoutMs === "number" ? { timeoutMs: step.timeoutMs } : {}) };
  }
}

/**
 * An exit as written: `next`, `end`, a step's id, its number, or `{ to: either }`. Nothing for an exit left out, and
 * what was written as it stands when it is none of these, so the refusal names it (`validate.ts`).
 */
function goFrom(raw: unknown, ids: readonly string[]): StepGo | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === "next" || raw === "end") return raw;
  const to = raw && typeof raw === "object" ? (raw as Record<string, unknown>).to : raw;
  if (typeof to === "number" && Number.isInteger(to)) return { to: ids[to - 1] ?? String(to) };
  if (typeof to === "string" && to.trim()) return { to: ids.includes(to.trim()) || !/^\d+$/.test(to.trim()) ? to.trim() : (ids[Number(to.trim()) - 1] ?? to.trim()) };
  return { to: "" };
}

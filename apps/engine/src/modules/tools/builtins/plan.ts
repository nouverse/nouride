/**
 * A plan the model can hold across tool iterations — and, since 0.7.26, across turns.
 *
 * The gap this closes is specific. A turn runs up to 25 tool iterations, and the model's only memory
 * of what it set out to do is the conversation itself — which is exactly what truncation eats first on
 * a long turn. So on multi-step work it forgets step four, or repeats step two, or announces it is
 * finished having done half. Infrastructure work is the worst case: "drain the node, roll the
 * deployment, verify, uncordon" is four steps where doing three is worse than doing none.
 *
 * It was per turn and in memory, on the argument that a plan is scaffolding for one piece of work and
 * persisting it raised questions with no good answers — whose plan after a restart, does a new
 * conversation inherit it. Work notes answer both: the plan is kept with the task it belongs to, in the
 * conversation's notes (`modules/notes/`), which survive what the history does not and are cleared by
 * what clears the work. That mattered the day a four-hour task in a group waited on "confirm first" at
 * every step: each wait ended the turn, and the turn took the plan with it.
 *
 * Kept only while steps are left: a turn that ends with every step done or skipped drops it
 * (`settlePlan`). A helper's or a peer's plan stays in memory, under its own session — it is
 * scaffolding for the one job it was handed, and the conversation's plan is its agent's.
 *
 * The list is rendered back on every call. The model is not asked to remember what it wrote — it is
 * shown the current state each time, which is the whole point of it existing outside the model.
 */

import { createLogger, rootSessionOf, type Tool, type ToolContext, type ToolResult } from "@nouride/shared";
import type { StepState } from "@nouride/wire";
import { NotesRefused, type NotesKey, type NotesPort, type PlanStep } from "@/modules/notes/store.ts";
import { planLines } from "@/modules/notes/tail.ts";
import { isMissionChat } from "@/modules/missions/gateway.ts";
import { workTextIsEnglish, writeWorkInEnglish } from "@/modules/memory/index.ts";

const log = createLogger("tools.plan");

export type { PlanStep, StepState };

/**
 * Long enough for real work, short enough that a plan stays a plan.
 *
 * A model asked to enumerate everything will produce forty items and then spend its iterations
 * managing the list instead of doing the work. Fifty-two documents to check are one step with a count.
 */
const MAX_STEPS = 20;
/** A mission's checklist runs longer — hours of work, one list. */
const MAX_MISSION_STEPS = 30;
const MAX_TEXT = 200;
const MAX_REASON = 200;
const MAX_NOTE = 300;

const STATES: readonly StepState[] = ["pending", "active", "done", "skipped"];

/**
 * Plans of turns that keep none — a helper's, a peer's, a turn with no notes to keep one in — by session.
 *
 * By session rather than by chat: a helper runs in its parent's chat, and keyed by the chat its plan overwrote the
 * parent's, and its turn's end cleared it.
 */
const unkept = new Map<string, PlanStep[]>();

function keyOf(ctx: Pick<ToolContext, "agentId" | "gatewayId" | "chatId">): NotesKey {
  return { agentId: ctx.agentId, gatewayId: ctx.gatewayId, chatId: ctx.chatId };
}

/** Whether this turn's plan is the conversation's: its own session, and somewhere to keep it. */
function kept(notes: NotesPort | undefined, sessionId: string): notes is NotesPort {
  return notes !== undefined && rootSessionOf(sessionId) === sessionId;
}

function finished(steps: readonly PlanStep[]): boolean {
  return steps.every((step) => step.state === "done" || step.state === "skipped");
}

/**
 * Called when a turn ends. A plan with every step done or skipped described work that is over, and goes — carried into
 * the next request, the model would resume something already done; one with steps left stays with its task. And what
 * was set aside from the notes has now been said, so it is not said again.
 */
export async function settleNotes(
  notes: NotesPort | undefined,
  turn: { agentId: string; gatewayId: string; chatId: string; sessionId: string },
  options: { keepFinished?: boolean } = {},
): Promise<void> {
  unkept.delete(turn.sessionId);
  if (!kept(notes, turn.sessionId)) return;
  const key = keyOf(turn);
  const plan = notes.plan(key);
  if (plan && finished(plan.steps) && !options.keepFinished) await notes.dropPlan(key);
  if (notes.setAside(key)) await notes.acknowledge(key);
}

/**
 * Said for a step not in English. Working text, read turn after turn and on the dashboard whatever the person speaks,
 * so it is refused before anything is kept — the way memory refuses a fact.
 */
function notEnglish(index: number, text: string): string {
  return writeWorkInEnglish(`Step ${index + 1}, "${text.slice(0, MAX_TEXT)}",`);
}

function parseSteps(raw: unknown, maxSteps: number): PlanStep[] | { error: string } {
  if (!Array.isArray(raw)) return { error: "`steps` must be an array." };
  if (raw.length > maxSteps) {
    return { error: `A plan is at most ${maxSteps} steps. Group the small ones: a repeated action is one step with a count.` };
  }

  const steps: PlanStep[] = [];
  for (const [index, entry] of raw.entries()) {
    // Two accepted shapes: a bare string for the common case, and an object when a state is being
    // set. Refusing the string form would make the first call — where everything is pending anyway —
    // needlessly verbose, and verbosity in a tool call is tokens on every iteration.
    if (typeof entry === "string") {
      const text = entry.trim();
      if (text && !workTextIsEnglish(text)) return { error: notEnglish(index, text) };
      if (text) steps.push({ text: text.slice(0, MAX_TEXT), state: "pending" });
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      return { error: "Each step is a string, or an object with `text` and `state`." };
    }
    const record = entry as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) return { error: "Each step needs a non-empty `text`." };
    const state = record.state;
    if (state !== undefined && !STATES.includes(state as StepState)) {
      return { error: '`state` must be "pending", "active", "done" or "skipped".' };
    }
    const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, MAX_REASON) : "";
    if (state === "skipped" && !reason) return { error: `A skipped step says why: "${text}" needs a \`reason\`.` };
    const note = typeof record.note === "string" ? record.note.trim().slice(0, MAX_NOTE) : "";
    // Judged whole, before the cut: a quote cut at its middle would leave the person's words counted as the step's.
    const whole = [text, state === "skipped" ? record.reason : "", record.note].filter((part) => typeof part === "string").join("\n");
    if (!workTextIsEnglish(whole)) return { error: notEnglish(index, text) };
    steps.push({ text: text.slice(0, MAX_TEXT), state: (state as StepState) ?? "pending", ...(state === "skipped" ? { reason } : {}), ...(note ? { note } : {}) });
  }
  return steps;
}

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, isError: false, ...(metadata ? { metadata } : {}) };
}

/**
 * `plan` — write the whole list, every time.
 *
 * Whole-list rather than add/update/remove operations. Three reasons, and the third is the one that
 * settled it:
 *
 * - A model that can only replace the list cannot desynchronise from it.
 * - One call shape is one thing to describe in the schema, and the schema is sent on every request.
 * - Partial updates need stable ids, and a model inventing ids gets them wrong in a way that silently
 *   edits the wrong row.
 */
export function createPlanTool(notes?: NotesPort): Tool {
  return {
    requiresApproval: false,
    definition: {
      name: "plan",
      description:
        "Track a multi-step plan. Send the whole list each time, one step active and finished ones done; a step you drop is " +
        '"skipped" with a `reason`. Use it for three or more steps: 3 to 15, each with a result you can check, a repeated action ' +
        "as one step with a count. Kept with a task in your work notes (`task`; default the one written last) while steps are " +
        'left; an empty list ends it. Each step is {"text": "...", "state": "pending|active|done|skipped", "reason": "..."}.',
      parameters: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "The complete plan, in order.",
            // One object shape, not `anyOf` with a bare string: the providers get this schema unmodified,
            // and not every one accepts `anyOf`. `parseSteps` still takes a plain string.
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "The step, in a few words." },
                state: { type: "string", enum: [...STATES], description: "Default pending." },
                reason: { type: "string", description: "Why a step was skipped." },
                note: { type: "string", description: "On a finished step: what it did and left (files, ids, a count)." },
              },
              required: ["text"],
            },
          },
          task: { type: "string", description: "The work notes task this plan belongs to. Default: the one written last." },
        },
        required: ["steps"],
      },
    },

    async execute(args, ctx) {
      const parsed = parseSteps(args.steps, isMissionChat(ctx) ? MAX_MISSION_STEPS : MAX_STEPS);
      if ("error" in parsed) return { content: parsed.error, isError: true };

      const active = parsed.filter((step) => step.state === "active").length;
      if (active > 1) {
        // Not a style rule. Two active steps means the model has stopped tracking which one it is on,
        // and that is the failure this tool exists to catch.
        return { content: "Only one step may be active at a time.", isError: true };
      }

      const done = parsed.filter((step) => step.state === "done" || step.state === "skipped").length;
      if (!kept(notes, ctx.sessionId)) {
        if (parsed.length === 0) unkept.delete(ctx.sessionId);
        else unkept.set(ctx.sessionId, parsed);
        return ok(parsed.length ? planLines(parsed).join("\n") : "The plan is empty.", { count: parsed.length, done });
      }

      const key = keyOf(ctx);
      if (parsed.length === 0) {
        await notes.dropPlan(key);
        return ok("The plan is cleared.", { count: 0, done: 0 });
      }
      const named = typeof args.task === "string" && args.task.trim() ? args.task.trim() : undefined;
      if (named && !workTextIsEnglish(named)) return { content: writeWorkInEnglish(`The task "${named}"`), isError: true };
      const task = named ?? notes.plan(key)?.task ?? notes.latest(key)?.title ?? "Current work";
      try {
        await notes.keepPlan(key, task, parsed);
      } catch (err) {
        if (err instanceof NotesRefused) return { content: err.message, isError: true };
        throw err;
      }
      log.debug("plan updated", { agent_id: ctx.agentId, steps: parsed.length, done });
      return ok([`Kept with "${notes.plan(key)?.task ?? task}" in your work notes.`, ...planLines(parsed)].join("\n"), { count: parsed.length, done, task });
    },
  };
}

/** The tool with nowhere to keep a plan past the turn — for a toolset built without a notes store. */
export const planTool: Tool = createPlanTool();

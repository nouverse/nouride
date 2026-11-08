/**
 * The context window a model is budgeted at, where that number comes from — and saying once when it is a guess.
 */

import { contextWindowInfo } from "@nouride/llm";
import { createLogger } from "@nouride/shared";

const log = createLogger("llm.executor");

/**
 * Model ids already reported as having no known context window.
 *
 * Per process, not per turn: the fact is a property of the configuration, and repeating it on every
 * message would bury the log of the deployment it is trying to warn about.
 */
const unknownContextWindows = new Set<string>();

export function warnOnceAboutContextWindow(model: string, assumed: number): void {
  if (unknownContextWindows.has(model)) return;
  unknownContextWindows.add(model);
  log.warn("no known context window for this model, so assuming a conservative default", {
    model,
    assumed,
    hint:
      "If the real window is larger, set [llm] context_window in the agent's pack, or have its gateway state the" +
      " model's window in /models (Nougate does where it knows it). Until then history and tool output are trimmed" +
      " far harder than they need to be.",
  });
}

/** Where a model's window came from: the pack wrote it down, the gateway states it, the family table knows it, or none. */
export type WindowSource = "pack" | "gateway" | "table" | "default";

/**
 * The window a turn on `model` is budgeted against, and where the number came from — first that has one wins:
 *
 * 1. the pack's `[llm] context_window`, and only for the model it was written against — a `/model` override points at
 *    something else, and carrying a hand-written window across to it is how a 32k model gets a 1M budget;
 * 2. what the agent's gateway states for the model in its `/models` listing (`llm/catalog.ts`);
 * 3. the table of model families (`contextWindowInfo`, `@nouride/llm`);
 * 4. its conservative default — a guess, which `doctor` and the log say out loud.
 *
 * Pure, so a turn (`prepareTurn`) and `/status` (`doctor`) give the same answer.
 */
export function contextWindowFor(input: { model: string; packModel: string; declared?: number; stated: number | null }): { tokens: number; source: WindowSource } {
  if (input.declared !== undefined && input.model === input.packModel) return { tokens: input.declared, source: "pack" };
  if (input.stated !== null) return { tokens: input.stated, source: "gateway" };
  const table = contextWindowInfo(input.model);
  return { tokens: table.tokens, source: table.known ? "table" : "default" };
}

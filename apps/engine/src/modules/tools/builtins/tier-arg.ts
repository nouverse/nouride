/**
 * `tier`, on the tools that start work (0.8.0): which of three models the work runs on — `small`, `default`
 * or `high` (`types/tiers.ts`). `delegate` picks among the agent's own; `ask_agent` among the asked agent's. What each
 * is for, and what it costs against the others, is said once in TOOLS (`llm/prompt/harness-tiers.ts`) — a schema is
 * re-sent with every request, and the words that choose a tier belong beside the rest of what the agent is told.
 */

import { isModelTier, MODEL_TIERS, type ModelTier } from "@nouride/shared";

/** The parameter, as each tool's schema declares it. */
export function tierParameter(whose: string): { type: "string"; enum: string[]; description: string } {
  return {
    type: "string",
    enum: [...MODEL_TIERS],
    description: `Which of ${whose} models runs it, as TOOLS says. Unsaid: default.`,
  };
}

/** The tier asked for — `default` when none is — or what is wrong with it, said so the model can fix the call. */
export function tierArg(value: unknown): { tier: ModelTier } | { error: string } {
  if (value === undefined || value === null || value === "") return { tier: "default" };
  if (isModelTier(value)) return { tier: value };
  return { error: `\`tier\` is one of ${MODEL_TIERS.join(", ")}, not ${JSON.stringify(value)}. Leave it out for default.` };
}

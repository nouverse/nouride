/**
 * The TOOLS lines on model tiers (0.8.0): the three models work an agent starts can run on, what each is
 * for, and what it costs against the others — said where `delegate` and `ask_agent` are, the tools that take `tier`.
 *
 * Said in words, never in money: Nouride does not know what a box's models cost (invariant 4). The tiers are the
 * operator's own ordering — a cheaper model and a stronger one beside the default — so "the cheapest" and "the dearest"
 * are what the names promise. The models are named, so an agent whose three tiers are one model is told so rather than
 * choosing between three names for the same thing.
 */

import type { HarnessView } from "./types.ts";

export function renderTiers({ ctx, toolNames }: HarnessView): string[] {
  const tiers = ctx.harness.modelTiers;
  const delegates = toolNames.includes("delegate");
  const asks = toolNames.includes("ask_agent");
  if (!tiers || (!delegates && !asks)) return [];
  const which = [delegates && "`delegate`", asks && "`ask_agent`"].filter(Boolean).join(" and ");
  const mine =
    tiers.small === tiers.default && tiers.high === tiers.default
      ? `Your three tiers here are all ${tiers.default}${delegates ? ", so for `delegate` `tier` changes nothing: leave it out" : ""}.`
      : `Your tiers here: small is ${tiers.small}, default is ${tiers.default}, high is ${tiers.high}.`;
  return [
    `- Work you hand off with ${which} runs on one of three model tiers, chosen with \`tier\`: \`small\` is the cheapest, for quick and simple work (a lookup, a check, a summary, reformatting); \`default\` is for most work, and is what runs when you leave \`tier\` out; \`high\` is the strongest and the dearest, for hard work that has to be right (a subtle bug, a design, a review). Pick the cheapest that will do the job well: a helper on \`small\` that gets it wrong costs more than one on \`default\` that does not.`,
    `- ${mine}${asks ? " With `ask_agent` the tier is the other agent's own: its small, default or high model." : ""}`,
  ];
}

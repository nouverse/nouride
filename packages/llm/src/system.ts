/**
 * The one place that turns system blocks back into the string they came from.
 *
 * `ChatParams.system` accepts two representations of the same prompt, and the equivalence between
 * them has to hold exactly: a block list joined here must be byte-identical to what the caller would
 * have sent as a single string. Prompt caching is a prefix match, so "nearly identical" is a cache
 * that never hits, and a token estimate computed from a different join is a budget that disagrees
 * with the request it is bounding.
 *
 * The separator is a blank line because that is what the prompt builder puts between its sections.
 * Both halves of that agreement are asserted in the tests rather than left to the two files to
 * remember separately.
 */

import type { SystemBlock } from "@nouride/shared";

export const SYSTEM_BLOCK_SEPARATOR = "\n\n";

/** The system prompt as one string, whichever form it arrived in. */
export function flattenSystem(system: string | SystemBlock[] | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join(SYSTEM_BLOCK_SEPARATOR);
}

/**
 * The system prompt as blocks, whichever form it arrived in.
 *
 * Empty blocks are dropped rather than passed on: Anthropic rejects an empty text block outright
 * ("text content blocks must be non-empty"), so one empty section would be a 400 rather than a
 * slightly larger request.
 */
export function systemBlocks(system: string | SystemBlock[] | undefined): SystemBlock[] {
  if (!system) return [];
  const blocks = typeof system === "string" ? [{ text: system }] : system;
  return blocks.filter((block) => block.text.length > 0);
}

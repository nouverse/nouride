/**
 * A draft's fields on their way to a file: a person's corrections applied at approval, and credentials scrubbed from
 * what the pass wrote. Pure, and out of `index.ts`, which composes the loop and owns no text.
 */

import { redact } from "@nouride/secrets";
import type { DraftEdits, SkillDraft } from "./types.ts";

/** The draft's fields with a human's corrections applied. Anything absent keeps what the model wrote. */
export function applyEdits(
  draft: SkillDraft,
  edits: DraftEdits,
): { name: string; description: string; requires: string; needsTools: string; body: string } {
  return {
    name: (edits.name ?? draft.name).trim().toLowerCase(),
    description: (edits.description ?? draft.description).trim(),
    requires: (edits.requires ?? draft.requires).trim(),
    needsTools: (edits.needsTools ?? draft.needsTools).trim(),
    body: (edits.body ?? draft.body).trim(),
  };
}

/** Scrub the two fields that end up in a file every agent reads on every turn. */
export function redactAll(
  body: string,
  description: string,
): { body: string; description: string; hits: string[] } {
  const scrubbedBody = redact(body);
  const scrubbedDescription = redact(description);
  return {
    body: scrubbedBody.text,
    description: scrubbedDescription.text,
    hits: [...new Set([...scrubbedBody.hits, ...scrubbedDescription.hits])],
  };
}

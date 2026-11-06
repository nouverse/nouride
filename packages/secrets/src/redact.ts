/**
 * Scrubbing credentials out of a transcript before anything else looks at it — §7.1 of the RFC.
 *
 * The audit log, the turn's step log, memory's pass and reflection all use it, and a change made for one's deliberately
 * over-eager masking reaches the rest.
 *
 * Two reasons this runs, and the second is the one that makes it non-optional. A transcript goes to
 * a provider, so a key that was only ever in a tool result would leave the machine; and a synthesized
 * skill goes into a file that every agent reads on every turn, which is the worst place in this
 * daemon to put a secret. Invariant 3 says credentials are names and never values — a skill body
 * quoting the value the operator pasted an hour ago breaks that from the far end.
 *
 * Deliberately over-eager: it reads with every rule of the registry (`patterns.ts`), the ones only it takes included. A
 * masked git SHA costs a draft a little precision; a leaked token costs an incident, and the human reviewing the draft
 * can see exactly what was masked and where.
 *
 * The list is patterns, not entropy. An entropy check would catch more and could not say *what* it
 * caught, and "something in your draft looked random" is not a finding anybody can act on.
 */

import { findSecrets } from "./scan.ts";

export interface RedactionResult {
  text: string;
  /** Distinct labels that matched, in the order they appear. Empty means nothing was found. */
  hits: string[];
}

/** Mask every credential-shaped run in `text`, and say what was masked. Only the value goes: a key's name, a URL's host stay. */
export function redact(text: string): RedactionResult {
  const found = findSecrets(text, "eager");
  if (found.length === 0) return { text, hits: [] };
  let out = "";
  let at = 0;
  for (const match of found) {
    out += `${text.slice(at, match.start)}[redacted:${match.pattern.redactAs}]`;
    at = match.end;
  }
  return { text: out + text.slice(at), hits: [...new Set(found.map((match) => match.pattern.redactAs))] };
}

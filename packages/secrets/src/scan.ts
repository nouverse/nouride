/**
 * Finding credentials in text: every rule of the registry that applies to the reader, and one answer where they overlap.
 */

import { SECRET_PATTERNS, type SecretPattern, type SecretTier } from "./patterns.ts";

/**
 * Who is reading. `ingress` is a message a person sent, where a hit is taken out of it: the certain and context rules.
 * `eager` is text on its way into a draft, an audit row or a transcript: every rule.
 */
export type ScanMode = "ingress" | "eager";

export interface SecretMatch {
  pattern: SecretPattern;
  /** Where the secret part starts and ends — the rule's `value` group, or the whole match. */
  start: number;
  end: number;
  value: string;
}

const TIERS: Record<ScanMode, ReadonlySet<SecretTier>> = {
  ingress: new Set(["certain", "context"]),
  eager: new Set(["certain", "context", "eager"]),
};

const RANK: Record<SecretTier, number> = { certain: 0, context: 1, eager: 2 };

/** Each rule's pattern with `d`, so where its value group lies is known. Compiled once. */
const COMPILED = SECRET_PATTERNS.map((pattern, order) => ({
  pattern,
  order,
  regex: new RegExp(pattern.pattern.source, `${pattern.pattern.flags.replace(/[gd]/g, "")}gd`),
}));

/**
 * Every credential in `text`, in order, none overlapping.
 *
 * Where two rules claim the same characters, the surer one wins — certain, then context, then eager — then the longer
 * value, then the rule listed first; so `Authorization: Bearer ghp_…` is a GitHub token, not a bearer token, and a
 * private key's body is not also a run of long hex.
 */
export function findSecrets(text: string, mode: ScanMode): SecretMatch[] {
  if (!text) return [];
  const tiers = TIERS[mode];
  const candidates: (SecretMatch & { order: number })[] = [];
  for (const { pattern, order, regex } of COMPILED) {
    if (!tiers.has(pattern.tier)) continue;
    regex.lastIndex = 0;
    for (let found = regex.exec(text); found; found = regex.exec(text)) {
      const [start, end] = found.indices?.groups?.value ?? found.indices![0]!;
      const value = text.slice(start, end);
      if (pattern.accept && !pattern.accept(value)) {
        // Not a credential. Look again a character on: what a rule matched first need not be all it could match.
        regex.lastIndex = found.index + 1;
        continue;
      }
      candidates.push({ pattern, order, start, end, value });
    }
  }

  candidates.sort((a, b) => RANK[a.pattern.tier] - RANK[b.pattern.tier] || b.end - b.start - (a.end - a.start) || a.order - b.order || a.start - b.start);
  const taken: SecretMatch[] = [];
  for (const { order: _order, ...match } of candidates) {
    if (taken.some((held) => match.start < held.end && held.start < match.end)) continue;
    taken.push(match);
  }
  return taken.sort((a, b) => a.start - b.start);
}

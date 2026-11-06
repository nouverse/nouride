/**
 * What an edit to a `config.toml` is allowed to change: exactly what it set, and nothing else, as the loader reads the
 * file. Every editor in `edit.ts` and `edit-blocks.ts` returns its text through `checked`, so a shape the line reading
 * gets wrong — one nobody wrote a test for yet — is a refusal, never a file that quietly says something else.
 */

import { parseToml } from "@nouride/runtime";

export type Parsed = Record<string, unknown>;

/**
 * `after`, when it means exactly `before` with `change` made to it — compared as the loader reads them, empty tables
 * aside (`[gateways]` with nothing in it means what no `[gateways]` means). A refusal otherwise, naming `what`.
 */
export function checked(before: string, after: string, what: string, change: (parsed: Parsed) => void): string {
  let expected: Parsed;
  try {
    expected = structuredClone(parseToml<Parsed>(before));
  } catch (err) {
    throw new Error(`the file does not parse as it is. Fix it by hand first: ${err instanceof Error ? err.message : String(err)}`);
  }
  change(expected);
  let actual: Parsed;
  try {
    actual = parseToml<Parsed>(after);
  } catch {
    actual = { unparseable: true };
  }
  if (!sameValue(pruned(expected), pruned(actual))) {
    throw new Error(`${what} is written in a shape this editor cannot change safely: change it by hand in the file`);
  }
  return after;
}

function pruned(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruned);
  if (value instanceof Date || typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const kept = pruned(child);
    if (typeof kept === "object" && kept !== null && !Array.isArray(kept) && !(kept instanceof Date) && Object.keys(kept).length === 0) continue;
    out[key] = kept;
  }
  return out;
}

/** Whether two values a TOML file can hold are the same: tables by their keys whatever the order, lists in order, dates by instant. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValue((a as Parsed)[key], (b as Parsed)[key]));
  }
  return Object.is(a, b);
}

/** The table at `path` in a parsed file, made where it is missing. */
export function tableAt(parsed: Parsed, path: readonly string[]): Parsed {
  let table = parsed;
  for (const segment of path) {
    const next = table[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) table[segment] = {};
    table = table[segment] as Parsed;
  }
  return table;
}

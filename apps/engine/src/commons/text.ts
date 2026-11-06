/**
 * Putting text somewhere it would otherwise be read as syntax: a regular expression, a SQL `LIKE` pattern.
 *
 * One copy each. The router, the gateway rename and the memory rename each had their own `escapeRegex`, and two
 * stores their own `likeLiteral` — identical today, and a fix to one would have reached none of the others.
 */

/** `value` matched as itself inside a `RegExp`. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `text` matched as itself inside a `LIKE … ESCAPE '\'` pattern: someone searching for `100%` means it. */
export function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

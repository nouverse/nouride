/**
 * What an MCP token may do (`docs/SPEC.md` §12.3). A token names its person and its agents;
 * scopes say what of those agents it reaches, so a client that only needs a persona does not also
 * read everything that was said.
 *
 * - `memory`: search, read and count conversations and facts, as the token's person would see them.
 * - `memory:write`: save a conversation, condensed, as a transcript filed tonight like one of theirs.
 * - `personas`: who each agent is — its persona files, as prompts and resources.
 *
 * Kept as a space-separated list, as OAuth writes scopes, so a future one is a word, not a column.
 */

export const SCOPES = ["memory", "memory:write", "personas"] as const;
export type Scope = (typeof SCOPES)[number];

/** What a token made without saying gets: read memory and personas, never write. */
export const DEFAULT_SCOPES: readonly Scope[] = ["memory", "personas"];

const isScope = (value: string): value is Scope => (SCOPES as readonly string[]).includes(value);

/** Scopes as a person or a client wrote them, or why not. Order and repeats do not matter. */
export function parseScopes(input: readonly string[]): Scope[] | { error: string } {
  const unknown = input.filter((scope) => !isScope(scope));
  if (unknown.length) return { error: `unknown scope ${unknown.map((scope) => `"${scope}"`).join(", ")} (the scopes are ${SCOPES.join(", ")})` };
  const scopes = SCOPES.filter((scope) => input.includes(scope));
  if (scopes.length === 0) return { error: `a token needs at least one scope: ${SCOPES.join(", ")}` };
  return scopes;
}

/** Stored form: every known scope, in order. Unknown words from an older or newer build are dropped. */
export const scopesFromColumn = (column: string): Scope[] => SCOPES.filter((scope) => column.split(" ").includes(scope));
export const scopesToColumn = (scopes: readonly Scope[]): string => SCOPES.filter((scope) => scopes.includes(scope)).join(" ");

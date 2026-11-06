/**
 * Parsing a leading slash command out of a message.
 */

/** A leading slash command, or null. `/model gpt-4o` → `{ command: "/model", args: ["gpt-4o"] }`. */
export function parseCommand(text: string): { command: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0];
  if (!name) return null;

  // Telegram appends the bot username to commands in groups: `/new@nouride_bot`.
  const command = `/${name.split("@")[0]!.toLowerCase()}`;
  return { command, args: parts.slice(1) };
}

/**
 * Whether a token is a platform mention rather than a command argument.
 *
 * Discord: `<@123>`, `<@!123>` (with or without nickname flag).
 * Telegram / plain text: `@username` — but only when it is the whole token, not an approval id
 * that happens to contain `@`.
 *
 * Used by `/approve` and `/deny` to ignore a trailing mention of the bot the operator addressed the
 * command to. Without this, `/approve @Nero | Infra Agent` on Discord produced args
 * `["<@1111111111111111111>"]`, which was treated as an explicit approval id, matched nothing, and
 * replied "not waiting for an answer any more" — while the request sat unresolved.
 */
export function isPlatformMention(token: string): boolean {
  // Discord: <@id> or <@!id>
  if (/^<@!?\d+>$/.test(token)) return true;
  // A bare @word that is not an approval id (apr_…). Telegram strips the leading @
  // before delivering, so this mainly catches Discord display-name fragments — but it
  // costs nothing to be safe.
  if (/^@\w+$/.test(token)) return true;
  return false;
}

/**
 * A persona file's text under a heading of its own: its own first line where that is one, else `# <name>` above it.
 *
 * One rule wherever a file is written whole or joined to others. `agent_create` put `# SOUL` above a soul that already
 * began with `# SOUL`, and the CLI read the heading twice (Kuro, the live box, 0.8.5); a coding CLI's instruction file
 * joins the four files, and one that did not start with a heading read as the end of the one before it.
 */
export function underHeading(name: string, text: string): string {
  const body = text.trim();
  return /^# /.test(body) ? body : `# ${name}\n\n${body}`;
}

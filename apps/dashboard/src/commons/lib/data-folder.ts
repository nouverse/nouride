/**
 * Whether a piece of text names a file of this machine's data folder, and which: what makes a path an agent wrote, a
 * mission's result file or a command's argument a link to that file in System's Files.
 *
 * Two spellings: the folder's own path on this machine and what follows it (`/srv/nouride/.nouride/workspace/x.md`),
 * and the folder by its name alone (`.nouride/workspace/x.md`, `~/.nouride/…`). A path is taken whole or not at all:
 * nothing is cut out of the middle of a sentence, and a path of another machine's folder is no link.
 */

/** What may follow a path without being part of it: a line (and column) number, then a sentence's punctuation. */
const AFTER = /(?::\d+){0,2}[.,;:!?)\]'"]*$/;

/**
 * The path under the data folder that `text` names, `/` between its parts, or null. `folder` is where the data folder
 * is on this machine, as the daemon says it; without it (a reader the daemon does not tell), nothing is a link.
 */
export function underDataFolder(text: string, folder: string | null): string | null {
  if (!folder) return null;
  const said = text.trim();
  if (said === "" || said.length > 400 || /[\n\r\0]/.test(said)) return null;
  const base = folder.replace(/\/+$/, "");
  const rest = said.startsWith(`${base}/`) ? said.slice(base.length + 1) : (/^(?:~\/|\.\/)?\.nouride\/(.+)$/.exec(said)?.[1] ?? null);
  if (rest === null) return null;
  const path = rest.replace(AFTER, "").replace(/\/+$/, "");
  const parts = path.split("/");
  if (path === "" || parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return path;
}

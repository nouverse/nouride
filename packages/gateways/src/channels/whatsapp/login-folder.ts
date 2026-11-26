/**
 * A WhatsApp number's old login taken out of the way for a new link (`WhatsAppGateway.linkAgain`).
 *
 * Moved beside itself first, then removed: a folder removed part of the way (a file it may not delete) left a login
 * neither old nor new. Its name is taken without a slash at its end, since a `session_dir` written with one named a
 * place inside itself to move to. A folder that cannot be moved (a mount of its own), or that is a link to the login's
 * real place (moving the link would leave the login where it points, and the new one off that volume), is emptied
 * where it is, as a login always was before. Emptied part of the way, the old login is broken all the same, and the
 * link goes on from there, what was left said; nothing removed at all is said, and nothing more is done.
 */

import { join, linkTarget, listDir, removePath, renamePath, statFile } from "@nouride/runtime";

/** What became of the old login: gone, or `left` where something of it could not be removed; or why it is still whole. */
export type LoginCleared = { ok: true; left?: string } | { ok: false; reason: string };

export function clearLogin(sessionDir: string, now = Date.now()): LoginCleared {
  const folder = sessionDir.replace(/[\\/]+$/, "") || sessionDir;
  if (!statFile(folder)) return { ok: true };
  if (linkTarget(folder) === null) {
    const aside = `${folder}.logged-out-${now}`;
    let moved = false;
    try {
      renamePath(folder, aside);
      moved = true;
    } catch {
      // Not movable: emptied where it is, below.
    }
    if (moved) {
      try {
        removePath(aside);
        return { ok: true };
      } catch {
        return { ok: true, left: aside };
      }
    }
  }
  let removed = 0;
  for (const entry of listDir(folder)) {
    try {
      removePath(join(folder, entry.name));
      removed += 1;
    } catch (err) {
      if (removed === 0) return { ok: false, reason: `its old login could not be removed: ${err instanceof Error ? err.message : String(err)}` };
      return { ok: true, left: folder };
    }
  }
  return { ok: true };
}

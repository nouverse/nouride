/**
 * A WhatsApp number's old login taken out of the way for a new link (`WhatsAppGateway.linkAgain`).
 *
 * Moved beside itself first, then removed: a folder removed part of the way (a file it may not delete) left a login
 * neither old nor new. Its name is taken without a slash at its end, since a `session_dir` written with one named a
 * place inside itself to move to. A folder that cannot be moved (a mount of its own) is emptied where it is, as a login
 * always was before; one that can be neither moved nor emptied is said, and nothing more is done.
 */

import { join, listDir, removePath, renamePath, statFile } from "@nouride/runtime";

/** What became of the old login: gone, or out of the way at `left`, which could not be removed; or why it is still there. */
export type LoginCleared = { ok: true; left?: string } | { ok: false; reason: string };

export function clearLogin(sessionDir: string, now = Date.now()): LoginCleared {
  const folder = sessionDir.replace(/[\\/]+$/, "") || sessionDir;
  if (!statFile(folder)) return { ok: true };
  const aside = `${folder}.logged-out-${now}`;
  try {
    renamePath(folder, aside);
  } catch {
    try {
      for (const entry of listDir(folder)) removePath(join(folder, entry.name));
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `its old login could not be removed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  try {
    removePath(aside);
    return { ok: true };
  } catch {
    return { ok: true, left: aside };
  }
}

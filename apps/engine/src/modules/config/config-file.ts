/**
 * One way to change a config file — the daemon's `config.toml`, or a file of an agent's pack — and every writer of
 * one takes it: under the one file lock, read, edit, check that the result loads, keep what was there, write.
 *
 * Each step closes a way a save failed (the 0.7.7 audit's config-write findings):
 *
 * - **The lock.** Thirty-four of forty writers took none, and two saves at once lost one of them in the file while the
 *   running daemon kept both — a setting that reverted at the next restart, with nothing said. One lock instance
 *   (`commons/file-lock.ts`), keyed by the file's real path.
 * - **The check.** A save that left a file the next boot refuses answered ok, and was found at the restart, by a
 *   daemon and a CLI that would not start. The daemon's config goes through the loader's own steps
 *   (`readConfigText`); a pack is reloaded once it is written, and put back when the agent no longer loads. Either
 *   way, nothing stays written that would not load.
 * - **The backup.** Five (`commons/backups.ts`), as the dashboard's file editor keeps them, so a hand edit a save
 *   undid can be got back.
 * - **The running copy.** What the loader made of the new text is what the running daemon's config follows
 *   (`follow.ts`), under the same lock — so two saves land in memory in the order they landed in the file, and what
 *   is in memory is what the next boot would load, not what a writer guessed it would be.
 *
 * `scripts/check-arch.ts` refuses a config file written any other way.
 */

import { ensureDir, fileMode, join, parseToml, readTextFileIfExists, removePath, writeTextFileAtomic } from "@nouride/runtime";
import { parseSkillStates, renderSkillStates, SKILL_STATES_FILE, type RawSkillStates } from "@nouride/persona";
import type { GlobalConfig } from "@nouride/shared";
import { rotateBackups } from "@/commons/backups.ts";
import { withFileLock } from "@/commons/file-lock.ts";
import { followFile } from "./follow.ts";
import { readConfigText } from "./global/index.ts";
import { peopleDirOf, personFile, readPeopleDir } from "@/modules/people/files.ts";

/** What an edit makes of a file's text: the new text, or a refusal in the words the person reads. */
export type ConfigEdit = (text: string) => string | { refused: string };

/** A write that went through — `changed` false when the edit left the text as it was — or why nothing was written. */
export type Edited = { ok: true; changed: boolean } | { ok: false; error: string };

/** A config file held under its lock: edits made through it are read, checked and written in turn with every other. */
export interface HeldConfig {
  edit(edit: ConfigEdit): Promise<Edited>;
  /**
   * One person's own file (`people/<key>.toml`, 0.8.18) under this same lock: patched by `edit`, or removed when it
   * answers null. Checked as the household it makes, as the next load reads it from disk, and the running daemon's
   * people follow the folder once it is written.
   */
  editPerson(key: string, edit: (text: string) => string | null | { refused: string }): Promise<Edited>;
}

/**
 * Hold the daemon's config file for `fn`: for a writer whose own checks read what it then changes — `[[people]]`,
 * whose checks read the household the edit patches. The lock is not re-entrant, so the edit is only reachable through
 * the handle `fn` is given, never by taking the lock again.
 *
 * `running` is the running daemon's config, which follows each edit once it is written (`follow.ts`). Null where no
 * daemon's copy is this file's to follow: `nouride gateway rename`, which runs with the daemon stopped, and the
 * dashboard's whole-file editor, whose save is the next boot's (`setup/files.ts`).
 */
export function holdingConfig<T>(path: string, running: GlobalConfig | null, fn: (file: HeldConfig) => Promise<T>): Promise<T> {
  return withFileLock(path, () =>
    fn({
      edit: async (edit) => {
        const before = await readTextFileIfExists(path);
        const next = applyEdit(edit, before ?? "");
        if ("error" in next) return { ok: false, error: next.error };
        if (next.text === (before ?? "")) return { ok: true, changed: false };
        let after: GlobalConfig;
        try {
          after = readConfigText(next.text, path);
        } catch (err) {
          return { ok: false, error: `Saved nothing: with that change the config would not load. ${messageOf(err)}` };
        }
        if (before !== null) await rotateBackups(path, before);
        await writeTextFileAtomic(path, next.text);
        if (running) followFile(running, { path, before: before ?? "", after });
        return { ok: true, changed: true };
      },
      editPerson: (key, edit) => editPersonFile(path, running, key, edit),
    }),
  );
}

async function editPersonFile(
  configPath: string,
  running: GlobalConfig | null,
  key: string,
  edit: (text: string) => string | null | { refused: string },
): Promise<Edited> {
  const dir = peopleDirOf(configPath);
  const file = personFile(dir, key);
  const before = await readTextFileIfExists(file);
  let next: string | null;
  try {
    const answer = edit(before ?? "");
    if (answer !== null && typeof answer === "object") return { ok: false, error: answer.refused };
    next = answer;
  } catch (err) {
    return { ok: false, error: messageOf(err) };
  }
  if (next === (before ?? null) || (next === null && before === null)) return { ok: true, changed: false };
  if (next !== null) {
    // This person as the next load would read them, beside everyone else's file as it is on disk now.
    const read = readPeopleDir(dir, { key, text: next }) ?? { people: [], problems: [] };
    const mine = read.problems.find((problem) => problem.startsWith(`people/${key}.toml:`));
    if (mine) return { ok: false, error: `Saved nothing: ${mine}` };
  }
  ensureDir(dir, 0o750);
  if (before !== null) await rotateBackups(file, before);
  if (next === null) removePath(file);
  else await writeTextFileAtomic(file, next, { mode: fileMode(configPath) ?? 0o640 });
  // In place: parts of the daemon hold the list itself, as `follow.ts` keeps every section it changes.
  if (running) running.people.splice(0, running.people.length, ...(readPeopleDir(dir)?.people ?? []));
  return { ok: true, changed: true };
}

/** Change the daemon's `config.toml`, and the running daemon's copy with it — see `holdingConfig` for `running`. */
export function editDaemonConfig(path: string, running: GlobalConfig | null, edit: ConfigEdit): Promise<Edited> {
  return holdingConfig(path, running, (file) => file.edit(edit));
}

/**
 * Change one file of an agent's pack, and reload the agent. A `.toml` is checked that it parses first; then, written,
 * the agent is reloaded, and when it no longer loads the previous text goes back and it is reloaded again. A pack
 * that does not load is an agent gone at the next restart, behind a save that said ok.
 *
 * `backup: false` for a file that is generated whole and holds nothing to get back (`skills.toml`).
 */
export function editPackFile(input: {
  path: string;
  edit: ConfigEdit;
  reload: () => Promise<unknown>;
  backup?: boolean;
}): Promise<Edited> {
  return withFileLock(input.path, async () => {
    const before = await readTextFileIfExists(input.path);
    const next = applyEdit(input.edit, before ?? "");
    if ("error" in next) return { ok: false, error: next.error };
    if (next.text === (before ?? "")) return { ok: true, changed: false };
    if (input.path.endsWith(".toml")) {
      const problem = tomlProblem(next.text);
      if (problem) return { ok: false, error: `Saved nothing: that would not parse. ${problem}` };
    }
    if (before !== null && input.backup !== false) await rotateBackups(input.path, before);
    await writeTextFileAtomic(input.path, next.text);
    try {
      await input.reload();
    } catch (err) {
      if (before === null) removePath(input.path);
      else await writeTextFileAtomic(input.path, before);
      await input.reload().catch(() => {});
      return { ok: false, error: `Saved nothing: with that change the agent no longer loads. ${messageOf(err)}` };
    }
    return { ok: true, changed: true };
  });
}

/**
 * A pack's `skills.toml` with `changes` merged into what it holds when the write lands, the agent reloaded — the one
 * way to it for the Skills Workshop and `skill_toggle`. Merged under the lock rather than sent whole: two tabs each
 * sending their own copy of the map was a last write that quietly undid the first one's switch.
 */
export function editSkillStates(input: {
  packDir: string;
  changes: Record<string, boolean>;
  reload: () => Promise<unknown>;
}): Promise<Edited> {
  const path = join(input.packDir, SKILL_STATES_FILE);
  return editPackFile({
    path,
    reload: input.reload,
    // Generated whole and holding no prose: there is nothing in it a backup would get back.
    backup: false,
    edit: (text) => renderSkillStates({ ...parseSkillStates(text.trim() ? parseToml<RawSkillStates>(text) : null, path), ...input.changes }),
  });
}

/** Why `source` is not TOML, or null. */
export function tomlProblem(source: string): string | null {
  try {
    parseToml(source);
    return null;
  } catch (err) {
    return messageOf(err);
  }
}

/** An edit's answer as text or a refusal — a throw from one of the editors is a refusal too, never a 500. */
function applyEdit(edit: ConfigEdit, text: string): { text: string } | { error: string } {
  try {
    const next = edit(text);
    return typeof next === "string" ? { text: next } : { error: next.refused };
  } catch (err) {
    return { error: messageOf(err) };
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

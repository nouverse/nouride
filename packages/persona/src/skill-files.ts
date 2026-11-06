/**
 * The files a skill ships beside its `SKILL.md` — listing them, reading them, replacing them, and
 * removing them.
 *
 * ## Why this exists
 *
 * A skill is a directory, and until now only the daemon's own writers could see inside one. The
 * dashboard showed `SKILL.md` and nothing else; the only way to remove a stale support file was the
 * `skill_improve` tool's `remove_files`, which is an *agent's* verb. Measured on the live pool on
 * 2026-09-08: 14 of 23 skills ship support files, and **1.2MB of a 1.7MB pool was unreferenced PNG
 * screenshots** left behind by an agent's runs in `x-twitter-poster/tools/`. Nobody could see them
 * and nobody had a way to delete them.
 *
 * ## Reading follows the directory; writing follows the schema
 *
 * `VALID_SUPPORT_PATH` allows `references|scripts|templates`, one level. The live pool also has
 * `tools/` (ten files) and `assets/` (a font), written by agents through the plain `write` tool,
 * bypassing the draft path entirely. A lister bound to the schema would hide twelve real files —
 * including the four Playwright scripts `x-twitter-poster` actually runs.
 *
 * So listing and reading resolve any one-level directory, and writing stays on the allow-list.
 * Widening the *write* schema to bless `tools/` would ratify drift that happened by accident:
 * `tools/` is `scripts/` under another name.
 */

import { join, listDir, readTextFileIfExists, removePath, statFile, writeTextFileAtomic } from "@nouride/runtime";
import { skillsDirFor } from "./loader.ts";
import { parseFrontmatter } from "./skills.ts";
import { VALID_SKILL_NAME, VALID_SUPPORT_PATH } from "./skill-writer.ts";

/**
 * A path this module will *read*: one directory, one file, no traversal.
 *
 * Deliberately wider than `VALID_SUPPORT_PATH`, which governs writing — see the note above. Still
 * exactly two segments, so `../../config.toml` and `tools/node_modules/x/y.js` are both misses.
 */
const READABLE_PATH = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Extensions we will hand to a text editor.
 *
 * Markdown only, and the reason is provenance rather than safety. A `SKILL.md` that says
 * `curl … | sh` is exactly as dangerous as a script — the agent holds `exec` either way — so if the
 * argument were danger, prose would have to be locked too. The real rule is that the loop may only
 * ship a script that *actually ran in this conversation and worked*; a script edited in a browser
 * has by construction never run, so editing one quietly turns a verified tool into somebody's guess.
 * Viewing and deleting break nothing.
 */
const EDITABLE = new Set([".md", ".markdown"]);

/** Extensions worth showing as text even though they may not be edited. */
const READABLE_TEXT = new Set([
  ".md", ".markdown", ".txt", ".py", ".sh", ".bash", ".zsh", ".js", ".mjs", ".cjs", ".ts",
  ".rb", ".pl", ".ps1", ".sql", ".json", ".yaml", ".yml", ".toml", ".ini", ".env", ".csv",
]);

export type SupportFileKind = "markdown" | "script" | "text" | "binary";

export interface SupportFile {
  /** Relative to the skill's directory, e.g. `references/hosts.md`. */
  path: string;
  bytes: number;
  kind: SupportFileKind;
  /** Whether this module will accept a replacement for it. */
  editable: boolean;
  /** Whether the skill's own body mentions the path. An unreferenced file is dead weight. */
  referenced: boolean;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

/**
 * Markdown, then binary, then the directory — and the order is the fix for a bug this had.
 *
 * The directory was checked first, on the reasoning that a script is named by where it lives as much
 * as by its extension: `tools/` is `scripts/` renamed, and `x-twitter-poster` keeps four Playwright
 * scripts there. But `tools/` also holds six PNG screenshots, and they came back as `script` —
 * which is worse than a wrong label, because only `binary` is refused by the text reader. The
 * dashboard would have tried to render a PNG as source.
 *
 * So an extension nobody can read as text wins over the directory it happens to sit in.
 */
function kindOf(path: string): SupportFileKind {
  const ext = extensionOf(path);
  if (EDITABLE.has(ext)) return "markdown";
  if (!READABLE_TEXT.has(ext)) return "binary";
  const dir = path.slice(0, path.indexOf("/"));
  return dir === "scripts" || dir === "tools" ? "script" : "text";
}

function skillRoot(agentsDir: string, name: string): string | null {
  if (!VALID_SKILL_NAME.test(name)) return null;
  return join(skillsDirFor(agentsDir), name);
}

/**
 * Every file one level under the skill's directory, `SKILL.md` excluded.
 *
 * Directories inside a support directory are skipped rather than walked. `x-twitter-poster/tools/`
 * contains a `node_modules`, and a lister that recursed would report a dependency tree as the
 * skill's own content — which is both useless and the shape that makes a file list unreadable.
 */
export async function listSupportFiles(agentsDir: string, name: string): Promise<SupportFile[]> {
  const root = skillRoot(agentsDir, name);
  if (!root) return [];

  const source = await readTextFileIfExists(join(root, "SKILL.md"));
  const body = source ? parseFrontmatter(source).body : "";

  const out: SupportFile[] = [];
  for (const dir of listDir(root)) {
    if (!dir.isDirectory) continue;
    for (const entry of listDir(join(root, dir.name))) {
      if (entry.isDirectory) continue;
      const path = `${dir.name}/${entry.name}`;
      if (!READABLE_PATH.test(path)) continue;
      const kind = kindOf(path);
      out.push({
        path,
        bytes: statFile(join(root, path))?.size ?? 0,
        kind,
        editable: kind === "markdown",
        referenced: body.includes(path) || body.includes(entry.name),
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** One support file as text, or `null` when it does not resolve or is not text. */
export async function readSupportFile(
  agentsDir: string,
  name: string,
  path: string,
): Promise<{ ok: true; text: string; kind: SupportFileKind } | { ok: false; error: string }> {
  const root = skillRoot(agentsDir, name);
  if (!root || !READABLE_PATH.test(path)) return { ok: false, error: `"${path}" is not a file in this skill` };
  const kind = kindOf(path);
  if (kind === "binary") return { ok: false, error: `"${path}" is not a text file: it can be listed and deleted, not read` };
  const text = await readTextFileIfExists(join(root, path));
  if (text === null) return { ok: false, error: `"${path}" is not there` };
  return { ok: true, text, kind };
}

/**
 * Replace one markdown support file.
 *
 * Refuses anything else, and refuses a path outside the *write* schema — see the note at the top of
 * this file. `SKILL.md` is not handled here: it has its own route, which validates frontmatter and
 * keeps provenance.
 */
export async function writeSupportFile(
  agentsDir: string,
  name: string,
  path: string,
  source: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const root = skillRoot(agentsDir, name);
  if (!root) return { ok: false, error: `"${name}" is not a valid skill name` };
  if (!VALID_SUPPORT_PATH.test(path)) {
    return {
      ok: false,
      error: `"${path}" is not a writable support-file path: use references/<name>, scripts/<name> or templates/<name>, one level, lowercase`,
    };
  }
  if (kindOf(path) !== "markdown") {
    return {
      ok: false,
      error: `"${path}" is not markdown. Scripts are shipped because they ran and worked. Editing one here would present a version that never ran as a verified tool. Delete it and let an agent attach a version it has executed.`,
    };
  }
  if (!source.trim()) return { ok: false, error: "the file is empty: delete it instead" };

  const full = join(root, path);
  if ((await readTextFileIfExists(full)) === null) {
    // Replacing, not creating. A new support file has to arrive through a draft, where the body's
    // pointer to it is reviewed at the same time — a file nothing points at is the state this whole
    // module exists to clean up.
    return { ok: false, error: `"${path}" is not there. New support files arrive with a skill draft.` };
  }
  await writeTextFileAtomic(full, source);
  return { ok: true, path };
}

/**
 * Remove one support file.
 *
 * `referenced` is reported rather than refused, and the caller decides. A pointer to a file that is
 * gone is worse than a file nothing points at — `x-twitter-poster` already says `tools/.env` and
 * that file does not exist — so the operator has to be told, and then has to be able to proceed:
 * the fix is usually to remove the file *and* the line, in either order.
 */
export async function deleteSupportFile(
  agentsDir: string,
  name: string,
  path: string,
): Promise<{ ok: true; path: string; wasReferenced: boolean } | { ok: false; error: string }> {
  const root = skillRoot(agentsDir, name);
  if (!root || !READABLE_PATH.test(path)) return { ok: false, error: `"${path}" is not a file in this skill` };

  const full = join(root, path);
  const files = await listSupportFiles(agentsDir, name);
  const found = files.find((f) => f.path === path);
  if (!found) return { ok: false, error: `"${path}" is not there` };

  removePath(full);
  return { ok: true, path, wasReferenced: found.referenced };
}

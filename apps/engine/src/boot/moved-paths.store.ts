/**
 * The rows that name a path, renamed with the folder it is in: a folder `boot/kept-folders.ts` moves out of `data/`, or
 * the whole install started from another folder (`boot/install-root.ts`, 0.8.18). So an attachment in a conversation's
 * history still opens, a job's log is still found, a mission goes on in its folder, and a grant made for a directory
 * still holds there. Every column that holds such a path, or text that names one; the first two are the ones a move that
 * stopped half-way is found by.
 *
 * Left as they were: what records what happened (the audit log, the event stream, the log table, a run's result, a
 * turn's prompt and reply), and a waiting approval's arguments, which are what the person was asked to allow.
 */

import type { SqliteDb } from "@nouride/runtime";
import { execGrantKey, toolGrantKey } from "@nouride/policy";

/** Each `UPDATE` is `(from/, to/, from/)`: every `from/` in the column becomes `to/`. */
const RENAMES = [
  "UPDATE jobs SET log_path = replace(log_path, ?, ?) WHERE instr(log_path, ?) > 0",
  "UPDATE chat_attachments SET local_path = replace(local_path, ?, ?) WHERE instr(local_path, ?) > 0",
  "UPDATE chat_messages SET attachments = replace(attachments, ?, ?) WHERE instr(attachments, ?) > 0",
  "UPDATE turn_records SET attachments = replace(attachments, ?, ?) WHERE instr(attachments, ?) > 0",
  "UPDATE turn_journal SET entry = replace(entry, ?, ?) WHERE instr(entry, ?) > 0",
  // Its hash is of the message as written, so a changed one's is cleared: the store writes the row once more, with its own.
  "UPDATE session_messages SET message = replace(message, ?, ?), hash = NULL WHERE instr(message, ?) > 0",
  // Where a job ran; where a mission works, the files its result named and the commands its checks run there; a
  // scheduled command's folder and arguments; a message waiting to be answered, with the files it carried.
  "UPDATE jobs SET cwd = replace(cwd, ?, ?) WHERE instr(cwd, ?) > 0",
  "UPDATE missions SET workdir = replace(workdir, ?, ?) WHERE instr(workdir, ?) > 0",
  "UPDATE missions SET files = replace(files, ?, ?) WHERE instr(files, ?) > 0",
  "UPDATE missions SET checks = replace(checks, ?, ?) WHERE instr(checks, ?) > 0",
  "UPDATE cron_jobs SET payload = replace(payload, ?, ?) WHERE instr(payload, ?) > 0",
  "UPDATE inbox SET envelope = replace(envelope, ?, ?) WHERE instr(envelope, ?) > 0",
  // A skill's reads are kept by its file's path. One already kept under the new path is from an earlier stay there,
  // and gives way: the reads that go on are this stay's.
  "UPDATE OR REPLACE skill_reads SET path = replace(path, ?, ?) WHERE instr(path, ?) > 0",
  "UPDATE skill_drafts SET published_path = replace(published_path, ?, ?) WHERE instr(published_path, ?) > 0",
] as const;

interface ExecGrantRow {
  id: string;
  grant_key: string;
  agent_id: string;
  argv: string;
  cwd: string;
  file_sha256: string | null;
}

interface ToolGrantRow {
  id: string;
  grant_key: string;
  agent_id: string;
  tool: string;
  scope_dir: string;
}

export class MovedPaths {
  constructor(private readonly db: SqliteDb) {}

  /** Every path under `from/` named under `to/` instead; how many rows changed. */
  rename(from: string, to: string): number {
    return this.db.transaction(
      () => RENAMES.reduce((changed, sql) => changed + this.db.prepare(sql).run(`${from}/`, `${to}/`, `${from}/`).changes, 0) + this.regrant(from, to),
    );
  }

  /** Whether a job or an attachment is still named under `from/` — a move that stopped between the folder and the rows. */
  stillNamed(from: string): boolean {
    const prefix = `${from}/`;
    return (
      this.db.prepare("SELECT 1 FROM jobs WHERE instr(log_path, ?) > 0 LIMIT 1").get(prefix) !== null ||
      this.db.prepare("SELECT 1 FROM chat_attachments WHERE instr(local_path, ?) > 0 LIMIT 1").get(prefix) !== null
    );
  }

  /**
   * Each live grant bound to a directory under `from/`, bound under `to/`. What the gate matches is a hash of that
   * directory (`@nouride/policy`), so a grant whose path alone was renamed would never match again. Keyed again only
   * where its key is what its row says it was made of: an exec grant for a command handed secrets was keyed with their
   * names, which its row does not keep, so it stays as it was and the command asks once more. A revoked one is a record.
   */
  private regrant(from: string, to: string): number {
    const prefix = `${from}/`;
    const moved = (path: string) => path.replaceAll(prefix, `${to}/`);
    let changed = 0;
    const exec = this.db.prepare("UPDATE exec_grants SET cwd = ?, argv = ?, command_text = ?, grant_key = ? WHERE id = ?");
    const execRows = this.db
      .prepare<ExecGrantRow>("SELECT id, grant_key, agent_id, argv, cwd, file_sha256 FROM exec_grants WHERE revoked_at IS NULL AND (instr(cwd, ?) > 0 OR instr(argv, ?) > 0)")
      .all(prefix, prefix);
    for (const row of execRows) {
      const argv = argvOf(row.argv);
      const made = { agentId: row.agent_id, ...(row.file_sha256 ? { fileSha256: row.file_sha256 } : {}) };
      if (!argv || execGrantKey({ ...made, cwd: row.cwd, argv }) !== row.grant_key) continue;
      const now = { cwd: moved(row.cwd), argv: argv.map(moved) };
      exec.run(now.cwd, JSON.stringify(now.argv), now.argv.join(" "), execGrantKey({ ...made, ...now }), row.id);
      changed += 1;
    }
    const tool = this.db.prepare("UPDATE tool_grants SET scope_dir = ?, grant_key = ? WHERE id = ?");
    const toolRows = this.db
      .prepare<ToolGrantRow>("SELECT id, grant_key, agent_id, tool, scope_dir FROM tool_grants WHERE revoked_at IS NULL AND instr(scope_dir, ?) > 0")
      .all(prefix);
    for (const row of toolRows) {
      if (toolGrantKey({ agentId: row.agent_id, tool: row.tool, scopeDir: row.scope_dir }) !== row.grant_key) continue;
      const scopeDir = moved(row.scope_dir);
      tool.run(scopeDir, toolGrantKey({ agentId: row.agent_id, tool: row.tool, scopeDir }), row.id);
      changed += 1;
    }
    return changed;
  }
}

/** A grant's argv as the store wrote it, a JSON list of strings; null for anything else. */
function argvOf(text: string): string[] | null {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) && value.every((part) => typeof part === "string") ? value : null;
  } catch {
    return null;
  }
}

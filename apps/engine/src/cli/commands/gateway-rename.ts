/**
 * `nouride gateway rename <old> <new>` — the one gateway command that does not go through the API.
 *
 * It cannot. Renaming an instance rewrites the database the daemon has open, the config file it read at boot, every
 * agent pack bound to the gateway and the memory vault — and a running daemon holds all of them, plus in-memory
 * sessions keyed by the old id, which would be written back over the new ones on the next turn. So this refuses to run
 * while the daemon is up, and says how to stop it.
 *
 * A dry run by default. The thing this is protecting against is not a typo in the new name — that is
 * recoverable by renaming again. It is discovering afterwards that the rename reached the sessions
 * table but not the allowlist, leaving a bot that no longer answers the person who owns it.
 *
 * ## The order of the writes
 *
 * Everything that can be checked is checked before anything is written: the database's rows, work still in flight, the
 * renamed `config.toml` loading, each renamed pack loading, every vault file read. The vault is snapshotted. Then the
 * database moves, in one transaction — the step most able to fail, and the one that undoes itself when it does — and
 * after it the files, each written whole: the config, the packs, the vault.
 */

import {
  join,
  openDatabase,
  readTextFileSync,
  statFile,
} from "@nouride/runtime";
import { plural } from "@nouride/shared";
import { configProblem } from "@/modules/config/global/index.ts";
import { editDaemonConfig, editPackFile } from "@/modules/config/config-file.ts";
import {
  applyRename,
  planRename,
  RenameRefusal,
  type RenamePlan,
} from "@/modules/gateways/rename.ts";
import { packProblem, planPackRenames, type PackCheck, type PackRename } from "@/modules/gateways/rename-packs.ts";
import { applyVaultRename, planVaultRename, checkVaultFormat, VaultFormatError, backupVault, vaultBackupDir, vaultAt, type VaultRename } from "@/modules/memory/index.ts";
import { FLOOR_SCHEMA, MIGRATIONS } from "@/db/migrations.ts";
import { UPGRADE_FLOOR } from "@/commons/upgrade-floor.ts";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW, emit, fail, say, usageError, hasFlag } from "@nouride/cli-kit";
import { loadConfig } from "@/cli/load-config.ts";
import { runningDaemon } from "@/cli/daemon-lock.ts";

export async function gatewayRename(args: string[]): Promise<void> {
  const [from, to] = args.filter((arg) => !arg.startsWith("--"));
  const apply = hasFlag(args, "--apply");

  if (!from || !to) {
    usageError(
      "usage: nouride gateway rename <old-id> <new-id> [--apply]",
      "e.g. nouride gateway rename telegram:bot telegram:nouva (without --apply it only reports). The daemon must be stopped either way.",
    );
  }

  const { config, source } = await loadConfig();
  if (!source) {
    fail("No config.toml found.", "A rename edits the file the daemon booted from; there isn't one.");
  }

  // Refused while the daemon is up — asked of the process its lock names, not of the lock file alone: a stopped
  // daemon leaves its lock, and a file-existence check would refuse every real rename (`runningDaemon`).
  const holder = runningDaemon(config.daemon.dataDir);
  if (holder !== null) {
    fail(
      `The daemon is running (pid ${holder}): a rename would be overwritten by it.`,
      `Stop it first: systemctl stop nouride   (or ${BOLD}nouride stop${RESET})`,
    );
  }

  const dbPath = join(config.daemon.dataDir, "nouride.db");
  if (statFile(dbPath)?.isDirectory !== false) {
    fail(`No database at ${dbPath}.`, "Nothing to rename. Has this daemon ever started?");
  }

  const db = openDatabase(dbPath);
  /**
   * The schema this build has, or no rename. `openDatabase` does not migrate, and the rename reaches every table this
   * build knows names a gateway: on an older schema one of them is missing, and a plan read off it would be a plan for
   * a database that is not this one.
   */
  const schema = db.userVersion();
  const latest = MIGRATIONS.at(-1)!.version;
  if (schema !== latest) {
    db.close();
    fail(
      `Nothing was renamed: the database is at schema ${schema}, and this build's is ${latest}.`,
      schema < FLOOR_SCHEMA
        ? `It is from before ${UPGRADE_FLOOR}, which this build does not start on: install ${UPGRADE_FLOOR}, start it once, then this build, and run this again.`
        : schema < latest
          ? "Start the daemon once with this build so it brings the database up to date, stop it, and run this again."
          : "A newer Nouride wrote it: run the rename with that build.",
    );
  }

  const gateways = config.gateways.map((gateway) => gateway.id);
  const vault = vaultAt(config.memory.dir);
  let plan: RenamePlan;
  let packs: { packs: PackRename[]; refusals: string[] };
  let memory: VaultRename;
  const check: PackCheck = { defaults: config.llm.defaults, providers: Object.keys(config.providers) };
  try {
    plan = planRename({ db, config: readTextFileSync(source), from, to, existing: gateways });
    packs = await planPackRenames({
      agentsDir: config.daemon.agentsDir,
      from,
      to,
      gateways: { before: gateways, after: gateways.map((id) => (id === from ? to : id)) },
      check,
    });
    // A vault a newer build wrote is read wrong by this one — refused whole, as boot refuses it.
    await checkVaultFormat(vault, vaultBackupDir(config.daemon.dataDir));
    memory = await planVaultRename(vault, from, to);
  } catch (err) {
    db.close();
    if (err instanceof RenameRefusal || err instanceof VaultFormatError) fail(err.message);
    throw err;
  }

  report(plan, source, packs.packs, memory, vault.root);
  // What the lines are printed from — not `configAfter`, the whole rewritten file.
  const answer = {
    from: plan.from,
    to: plan.to,
    rows: plan.rows,
    kept: plan.kept,
    total: plan.total,
    config: source,
    configLines: plan.configLines,
    packs: packs.packs.map((pack) => ({ id: pack.id, file: pack.file, lines: pack.lines })),
    vault: { dir: vault.root, files: memory.counts },
  };
  emit({ ...answer, applied: false });

  if (!apply) {
    db.close();
    say();
    say(`${DIM}Nothing was changed. Re-run with ${BOLD}--apply${RESET}${DIM} to do it.${RESET}`);
    return;
  }

  // Checked before anything changes: a renamed config the daemon would not start from must not follow a database
  // already moved to the new name — nor an agent that would not load.
  const problem = configProblem(plan.configAfter);
  if (problem) {
    db.close();
    fail(`nothing was renamed: with the new name the config would not load. ${problem}`);
  }
  if (packs.refusals.length > 0) {
    db.close();
    fail(`nothing was renamed: ${packs.refusals.join("; ")}`);
  }
  /**
   * The vault copied first, outside the daily rotation (`-before-rename`): it is the one part of a rename that is files
   * nothing else keeps a copy of. A snapshot that could not be taken stops the rename while nothing has moved.
   */
  if (memory.files.length > 0) {
    const snapshot = await backupVault({ vaultDir: vault.root, dataDir: config.daemon.dataDir, keep: config.daemon.backupKeep, before: "rename" });
    if (!snapshot.path) {
      db.close();
      fail("nothing was renamed: the memory vault could not be snapshotted first (the log says why)");
    }
    say(`${DIM}  memory vault snapshotted to ${snapshot.path}${RESET}`);
  }

  try {
    applyRename(db, plan);
  } finally {
    // Closed before the files are written either way: they are the last thing that happens, so a failure in the
    // database leaves every file still naming the old gateway.
    db.close();
  }

  // From here the database is on the new name, and a file that fails to write is said by name with what to do — the
  // others are still written, since a half-written rename is better finished than abandoned.
  const unwritten: string[] = [];
  // No running copy to follow it: the rename refuses to run while the daemon does.
  const saved = await editDaemonConfig(source, null, () => plan.configAfter);
  if (!saved.ok) unwritten.push(`${source}: ${saved.error}`);
  const after = gateways.map((id) => (id === from ? to : id));
  for (const pack of packs.packs) {
    const written = await editPackFile({
      path: pack.file,
      edit: () => pack.after,
      // No daemon to reload it into: loading it is checked the way boot will, and a pack that loaded before must
      // still — otherwise the file goes back as it was.
      reload: async () => {
        const broken = pack.loads ? packProblem(pack.id, pack.after, after, check) : null;
        if (broken) throw new Error(broken);
      },
    });
    if (!written.ok) unwritten.push(`${pack.file}: ${written.error}`);
  }
  try {
    await applyVaultRename(memory);
  } catch (err) {
    unwritten.push(`the memory vault: ${err instanceof Error ? err.message : String(err)} (its snapshot from before the rename is in ${vaultBackupDir(config.daemon.dataDir)})`);
  }

  emit({ ...answer, applied: true, unwritten });
  if (unwritten.length > 0) {
    say();
    say(`${RED}✗${RESET} the database is on ${BOLD}${plan.to}${RESET}, and these still name ${plan.from}:`);
    for (const line of unwritten) say(`  ${line}`);
    fail("Rename the rest by hand before starting the daemon: each line above names the file, and the report above names the lines.");
  }

  say();
  say(`${GREEN}✓${RESET} ${BOLD}${plan.from}${RESET} is now ${BOLD}${plan.to}${RESET}`);
  say(`${DIM}  ${plan.total} ${plural(plan.total, "row")} rewritten · ${source} updated${RESET}`);
  if (packs.packs.length > 0) say(`${DIM}  ${packs.packs.length} agent ${plural(packs.packs.length, "pack")} updated${RESET}`);
  if (memory.files.length > 0) say(`${DIM}  ${memory.files.length} memory ${plural(memory.files.length, "file")} updated${RESET}`);
  say(`${DIM}  Start it again: systemctl start nouride${RESET}`);
  if (plan.from.startsWith("whatsapp:")) {
    // Named because the answer is reassuring and not obvious: the pairing lives in a directory named
    // by `session_dir`, not by the instance id, so the link survives.
    say(`${DIM}  The WhatsApp pairing is keyed by session_dir, not by the id, so no re-link is needed.${RESET}`);
  }
}

function report(plan: RenamePlan, source: string, packs: PackRename[], memory: VaultRename, vaultDir: string): void {
  say(`${BOLD}${plan.from}${RESET} → ${BOLD}${plan.to}${RESET}`);
  say();

  if (plan.rows.length === 0) {
    say(`${DIM}  no rows in the database name it${RESET}`);
  } else {
    say(`${BOLD}database${RESET}`);
    for (const entry of plan.rows) {
      say(`  ${String(entry.count).padStart(5)}  ${entry.table}.${entry.column}`);
    }
  }

  say();
  say(`${BOLD}${source}${RESET}`);
  if (plan.configLines.length === 0) {
    say(`${DIM}  nothing in the file names it. Is the id right?${RESET}`);
  } else {
    for (const line of plan.configLines) {
      say(`  ${String(line.line).padStart(5)}  ${line.text}`);
    }
  }

  for (const pack of packs) {
    say();
    say(`${BOLD}${pack.file}${RESET}`);
    for (const line of pack.lines) say(`  ${String(line.line).padStart(5)}  ${line.text}`);
  }

  const parts = Object.entries(memory.counts).filter(([, count]) => count > 0);
  if (parts.length > 0) {
    say();
    say(`${BOLD}memory vault${RESET} ${DIM}${vaultDir}${RESET}`);
    for (const [part, count] of parts) say(`  ${String(count).padStart(5)}  ${part}`);
  }

  if (plan.kept.length > 0) {
    say();
    say(`${YELLOW}not rewritten${RESET}`);
    for (const entry of plan.kept) say(`  ${String(entry.count).padStart(5)}  ${entry.table}.${entry.column}`);
    say(
      `${DIM}  records of what happened, on a gateway that was called ${plan.from} at the time. A gateway\n` +
        `  filter over that history will not reach back past this rename.${RESET}`,
    );
  }
}

/**
 * `nouride users reset` — every dashboard account removed, so the next start creates the first admin again and prints
 * its password: the way back from a lost first password (`docs/DEPLOY.md` § Lost the first password).
 *
 * The recovery was always "empty the account table", and the documented way to do it was `sqlite3` — which neither a
 * Box nor the boxes this is deployed to have. An operator locked out could not
 * follow the page. This is that step, with the binary they already have.
 *
 * Local, like `db restore`: the person it is for cannot sign in, and the control token reaches the daemon as an admin
 * already. It refuses while the daemon runs, asked of the same pid in the same way — a running daemon holds the database
 * and would go on answering the sign-ins of accounts that no longer exist — which also keeps it from an agent, whose
 * commands run only while the daemon does. The database is snapshotted first, so the reset is undone by putting that
 * snapshot back, and what it removed is said: each account's name, role and id, because a People entry that named one
 * as `web:<id>` has to be changed by hand.
 */

import { basename, join, openDatabase, statFile } from "@nouride/runtime";
import { AuditLog } from "@/commons/audit.store.ts";
import { backupDatabase } from "@/db/backup.ts";
import { UserStore } from "@/modules/users/users.store.ts";
import { bareArgs } from "@/cli/args.ts";
import { startHint } from "@/service/hints.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { refuseWhileRunning } from "@/cli/commands/db.ts";
import { BOLD, DIM, GREEN, RESET, emit, fail, say } from "@/cli/ui.ts";
import { helpFor, unknownAction } from "@/cli/usage.ts";

export async function users(args: string[]): Promise<void> {
  const [action] = bareArgs(args);
  if (action === undefined) return helpFor("users");
  if (action !== "reset") unknownAction("users", action);

  const { config } = await loadConfig();
  const dataDir = config.daemon.dataDir;
  const dbPath = join(dataDir, "nouride.db");
  if (statFile(dbPath)?.isDirectory !== false) {
    fail(`No database at ${dbPath}.`, "Nothing to reset: the daemon's first start creates the first admin and prints its password.");
  }
  refuseWhileRunning(dataDir);

  const db = openDatabase(dbPath);
  try {
    const store = new UserStore({ db });
    const accounts = store.list();
    if (accounts.length === 0) {
      emit({ removed: [], snapshot: null });
      return say(`${DIM}There are no accounts to remove. The daemon's next start creates the first admin and prints its password.${RESET}`);
    }

    // The way back, before anything is written: kept beside the daemon's own, where a rewrite's snapshot goes (`backup-dir.ts`).
    const snapshot = backupDatabase({ db, dataDir, keep: config.daemon.backupKeep });
    if (!snapshot.path) fail("Nothing was changed: the snapshot taken first did not complete.", snapshot.error);

    store.resetAll();
    const audit = new AuditLog(db);
    audit.record({ action: "users_reset", actor: "cli", details: { removed: accounts.map((account) => account.username), snapshot: snapshot.path } });
    audit.stop();

    emit({ removed: accounts.map(({ id, username, role }) => ({ id, username, role })), snapshot: snapshot.path });
    say(`${GREEN}✓${RESET} removed ${accounts.length} dashboard account(s), and every sign-in`);
    for (const account of accounts) say(`  ${BOLD}${account.username}${RESET} ${DIM}${account.role} · web:${account.id}${RESET}`);
    say(`${DIM}  the database as it was is ${snapshot.path} (\`nouride db restore ${basename(snapshot.path)}\` puts it back)${RESET}`);
    say();
    say("Start the daemon: with no account, it creates a new admin and prints the password (`journalctl -u nouride | grep -A12 'Nouride is ready'` under systemd).");
    say(`${DIM}  ${startHint()}${RESET}`);
    say(`${DIM}  INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD in the install's .env, if both are set, choose it instead.${RESET}`);
    say(`${DIM}  A People entry that named one of these as web:<id> needs that line changed: the new admin is a new id.${RESET}`);
  } finally {
    db.close();
  }
}

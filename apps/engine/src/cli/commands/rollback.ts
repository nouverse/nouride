/**
 * `nouride update --rollback` — the version before this one, back. `modules/update/rollback.ts` has the why.
 *
 * Local, like `db restore`, and for the same reason: it replaces what a running daemon holds open. Without `--apply`
 * it says what it would do — which build, and whether the database goes back to the snapshot taken before the update
 * migrated it, with what that loses — and changes nothing. A build from before 0.8.19 gets the secrets as it reads them,
 * which needs the store's key: opened in the preview too, so a key that is not here is said before anything is done.
 */

import { fileExistsSync, join, runCommand } from "@nouride/runtime";
import { SecretError } from "@nouride/secrets";
import { openCommandSecretStore } from "@/boot/secret-store.ts";
import { hasFlag } from "@/cli/args.ts";
import { startHint } from "@/cli/client.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { refuseWhileRunning } from "@/cli/commands/db.ts";
import { BOLD, DIM, GREEN, RESET, YELLOW, emit, fail, say } from "@/cli/ui.ts";
import { VERSION } from "@/cli/version.ts";
import { backupDirFor } from "@/commons/backup-dir.ts";
import { listBackups, restoreDatabase } from "@/db/backup.ts";
import { defaultConfigPath } from "@/modules/config/global/index.ts";
import { installDirFor } from "@/modules/update/facts.ts";
import { applyRollback, keptBuild, planRollback, readsPlainSecrets, rollbackRefusal, swapBack } from "@/modules/update/rollback.ts";

const minute = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");

export async function rollback(args: string[]): Promise<void> {
  const { config, source } = await loadConfig();
  const dataDir = config.daemon.dataDir;
  const installDir = installDirFor(dataDir);
  const kept = keptBuild(installDir);
  if (!kept) {
    fail("There is no previous build to go back to.", `An update keeps the build it replaces in ${join(installDir, ".nouride-previous")}; there is none here.`);
  }
  // Not recorded by `install.sh`, which does not run, as root, a binary the service account can rewrite. This runs
  // as that account already.
  kept.version ??= await versionOf(join(installDir, ".nouride-previous", "nouride"));
  const refusal = rollbackRefusal(kept, VERSION);
  if (refusal) fail(refusal, "Install the version you want with install.sh, then put its database back: nouride db list");

  const where = backupDirFor(config.daemon);
  const plan = planRollback(kept, listBackups(dataDir, "dir" in where ? where.dir : undefined));
  const to = plan.version ? `v${plan.version.replace(/^v/, "")}` : "the previous build";
  say(`${BOLD}v${VERSION} → ${to}${RESET} ${DIM}kept since ${minute(plan.putAsideAt)}${RESET}`);
  say(`  files     ${plan.names.join(", ")}, swapped with this build's, which is kept, so this goes forward again`);
  if (plan.snapshot) {
    say(`  database  ${plan.snapshot.name}, taken before the update migrated it`);
    say(`  ${YELLOW}what happened since ${minute(plan.snapshot.at)} is lost: conversations, turns, memory changes, jobs${RESET}`);
  } else {
    say(`  database  as it is (nothing was migrated since the build was put aside)`);
  }
  const secrets = readsPlainSecrets(plan.version) && fileExistsSync(join(dataDir, "secrets.enc")) ? await plainSecrets(dataDir, source, to) : null;
  if (secrets !== null) say(`  secrets   written as secrets.json, the only form ${to} reads; the encrypted store stays, for coming forward again`);
  emit({ to: plan.version, from: VERSION, files: plan.names, snapshot: plan.snapshot, secrets: secrets !== null, applied: false });
  if (!hasFlag(args, "--apply")) {
    say();
    return say(`${DIM}nouride update --rollback --apply does it, with the daemon stopped.${RESET}`);
  }

  refuseWhileRunning(dataDir);
  try {
    const done = applyRollback(plan, {
      installDir,
      dbPath: join(dataDir, "nouride.db"),
      currentVersion: VERSION,
      swapBack,
      restoreDatabase,
      plainSecrets: secrets === null ? null : { path: join(dataDir, "secrets.json"), text: secrets },
    });
    say();
    say(`${GREEN}✓${RESET} on ${to}: ${done.swapped.join(", ")} put back${done.restored?.ok ? ", and the database with them" : ""}`);
    if (done.restored?.ok && done.restored.replaced) say(`${DIM}  the database it replaced is at ${done.restored.replaced}${RESET}`);
    if (done.secrets) say(`${DIM}  the secrets are in secrets.json for ${to} (0600, values not shown)${RESET}`);
    say(`${DIM}  v${VERSION} is not taken again by an automatic update. ${startHint()}${RESET}`);
    emit({ to: plan.version, from: VERSION, files: done.swapped, snapshot: plan.snapshot, secrets: done.secrets, applied: true, replaced: done.restored?.ok ? done.restored.replaced : null });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The store as `secrets.json` holds it, for a build from before 0.8.19: opened with the store's key, or refused before
 * anything is done when the key is not here. Root's key file reaches the CLI through the launcher (`install.sh`).
 */
async function plainSecrets(dataDir: string, source: string | null | undefined, to: string): Promise<string> {
  try {
    return (await openCommandSecretStore({ dataDir, configPath: source ?? defaultConfigPath() })).plainCopy();
  } catch (err) {
    if (!(err instanceof SecretError)) throw err;
    return fail(`${to} reads the secrets only as secrets.json, and the store cannot be opened here: ${err.message}`, "Run it as root (sudo nouride update --rollback), whose file holds the store's key, or with NOURIDE_ENCRYPTION_KEY set.");
  }
}

/** What a build says it is, or null when it does not run or says nothing that reads as a version. */
async function versionOf(binary: string): Promise<string | null> {
  try {
    const run = await runCommand([binary, "--version"], { cwd: join(binary, ".."), timeoutMs: 10_000, maxOutputBytes: 4_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
    const line = run.exitCode === 0 ? run.stdout.trim().split("\n")[0] : "";
    return /^v?\d+\.\d+\.\d+\S*$/.test(line ?? "") ? line! : null;
  } catch {
    return null;
  }
}

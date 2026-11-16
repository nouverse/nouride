/**
 * `nouride update --retry` — the build an update's guard put aside, back in. `modules/update/retry.ts` has the why.
 *
 * Local, like `--rollback`, and for the same reason: it replaces what a running daemon holds open. Without `--apply`
 * it says what it would do and changes nothing. The database is left as it is: where the build that did not start had
 * migrated it, that build is the one that reads it.
 */

import { hasFlag, BOLD, DIM, GREEN, RESET, emit, fail, say } from "@nouride/cli-kit";
import { join } from "@nouride/runtime";
import { startHint } from "@/service/hints.ts";
import { FAILED_SUFFIX } from "@/service/update-guard.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { refuseWhileRunning } from "@/cli/commands/db.ts";
import { versionOf } from "@/cli/commands/rollback.ts";
import { VERSION } from "@/commons/version.ts";
import { installDirFor } from "@/modules/update/facts.ts";
import { putAside, retryRefusal, somethingKept, takeAgain } from "@/modules/update/retry.ts";

export async function retry(args: string[]): Promise<void> {
  const { config } = await loadConfig();
  const dataDir = config.daemon.dataDir;
  const installDir = installDirFor(dataDir);
  const aside = putAside(installDir);
  if (!aside) {
    fail("There is no build an update's guard put aside.", `When an update does not start, its parts are kept in ${installDir}, each with ${FAILED_SUFFIX} after its name; there are none here. To take a version again: nouride update.`);
  }
  const refusal = retryRefusal(aside, somethingKept(installDir));
  if (refusal) fail(refusal, "Install the version you want with install.sh. To see the snapshots of the database: nouride db list");
  // The guard's marker is gone once the previous build has run: the build itself says which it is.
  aside.version ??= (await versionOf(join(installDir, `nouride${FAILED_SUFFIX}`)))?.replace(/^v/, "") ?? null;

  const to = aside.version ? `v${aside.version}` : "the build that was put aside";
  say(`${BOLD}v${VERSION} → ${to}${RESET} ${DIM}put aside when it did not start${RESET}`);
  say(`  files     ${aside.names.join(", ")}, put back together; this build's are kept, so nouride update --rollback comes back to it`);
  say(`  database  as it is: where ${to} had migrated it, ${to} is the build that reads it`);
  emit({ to: aside.version, from: VERSION, files: aside.names, applied: false });
  if (!hasFlag(args, "--apply")) {
    say();
    return say(`${DIM}nouride update --retry --apply does it, with the daemon stopped.${RESET}`);
  }

  refuseWhileRunning(dataDir);
  try {
    const moved = takeAgain(installDir, aside, VERSION);
    say();
    say(`${GREEN}✓${RESET} on ${to}: ${moved.join(", ")} put back`);
    say(`${DIM}  If it does not start this time either, nouride update --rollback --apply goes back to v${VERSION}. ${startHint()}${RESET}`);
    emit({ to: aside.version, from: VERSION, files: moved, applied: true });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The unit's update guard, and the file names it shares with the daemon.
 *
 * Here rather than beside `modules/update/confirm.ts` because `unit.ts` renders it and a unit file
 * is pure text: this module has no dependencies, so the service layer does not pull the update
 * module in to write a unit. `confirm.ts` has the reasoning.
 */

/** Beside the binary. The daemon writes the first; the guard renames it to the second on a restore. */
export const PENDING_FILE = ".nouride-pending-update";
export const ROLLED_BACK_FILE = ".nouride-rolled-back";
/** Starts the guard allows an unconfirmed update before restoring the previous version. */
export const GUARD_STARTS = 3;
/**
 * What an upgrade replaces in the install directory, and keeps the old copy of in `.nouride-previous/`. The one list:
 * `nouride update` hands it to the update plugin, which swaps these names and nothing else; the guard below and
 * `nouride update --rollback` put the same names back; the Box flasher imports it; and `install.sh` carries a copy between
 * `# >>> swapped` markers, which `tests/contracts/install-swap.test.ts` holds to this one. It was written out five
 * times, so a new artefact had to be added in five places, and the copies all kept `wa-bridge` long after the last
 * edition stopped shipping a bridge beside the binary.
 *
 * Everything the release tarball carries beside the binary but `pkg/`. `frontend` is the LLM gateway's dashboard, in
 * the Router tarballs: an update that left it behind served an old bundle under the new gateway. `config.example.toml`
 * is the reference every refusal points at, and it stayed at the version first installed. `pkg/` is `nouride-pkg`, the
 * root half of system packages, which `install.sh --allow-packages` installs as root outside this directory: a copy
 * the service account could edit would be a root shell for anything running as it, so an update — which runs as that
 * account — must not, and cannot, replace it. `run/` is `nouride-run`, the helper that runs each agent's commands as
 * its own user: swapped like the rest, and never run from here by root — `install.sh` installs the tarball's own copy,
 * and a daemon that is root, whose install is root's, refreshes its helper from this one (`boot/agent-users.ts`).
 */
export const SWAPPED = ["nouride", "dashboard", "skills", "frontend", "run", "config.example.toml"] as const;

/**
 * The guard's own logic, as the unit runs it — exported so a test can run the same shell text.
 *
 * POSIX `sh`, no dependencies, and nothing outside `dir`. No single quotes, because the unit wraps it
 * in `sh -c '…'`; `$` is written `$$` there (systemd's escape), and this returns the plain form.
 */
export function guardScript(dir: string): string {
  const names = SWAPPED.join(" ");
  return [
    `d="${dir.replace(/["'$`\\]/g, "")}"`,
    `p="$d/${PENDING_FILE}"`,
    `[ -f "$p" ] || exit 0`,
    `n=$(( $(cat "$p.attempts" 2>/dev/null || echo 0) + 1 ))`,
    `echo "$n" > "$p.attempts"`,
    `[ "$n" -le ${GUARD_STARTS} ] && exit 0`,
    `for f in ${names}; do [ -e "$d/.nouride-previous/$f" ] || continue; rm -rf "$d/$f.failed"; [ -e "$d/$f" ] && mv "$d/$f" "$d/$f.failed"; mv "$d/.nouride-previous/$f" "$d/$f"; done`,
    `mv "$p" "$d/${ROLLED_BACK_FILE}"`,
    `rm -f "$p.attempts"`,
    `echo "nouride: the update did not come up; restored the previous version" >&2`,
    `exit 0`,
  ].join("; ");
}

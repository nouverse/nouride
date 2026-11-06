# nouride-pkg backends

One file per package manager, sourced by `nouride-pkg` after it has checked the request. The rules —
which operations, which names, what is protected, simulate first — are in `nouride-pkg` and apply to
every backend the same way. A backend only answers questions about its own manager and runs it.

Each defines these seven functions. Names reaching them are already valid package names (lowercase
letters, digits, `.+_-`), never options, paths or globs.

| Function | Answers |
|---|---|
| `pkg_detect` | 0 when this host uses this manager. Backends are tried in `BACKENDS` order. |
| `pkg_protected` | The packages that must never be removed, one per line: whatever keeps the box reachable and running. |
| `pkg_known NAME` | 0 when the repositories have a package called exactly `NAME` — never a pattern match. |
| `pkg_installed NAME` | 0 when `NAME` is installed. |
| `pkg_plan OP [NAME ...]` | What `OP` (`install`, `remove`, `upgrade`) would change, simulated: `+ name` per package installed or upgraded, `- name` per package removed. Non-zero when it cannot be planned, with the reason on stderr. `upgrade` with no names is everything. |
| `pkg_run OP [NAME ...]` | Do it, with no prompts. Output goes to the person who asked. |
| `pkg_refresh` | Refresh the package lists. |

To add a manager:

1. `backends/<name>.sh` with the seven functions.
2. Its name in `BACKENDS` in `nouride-pkg`, before any manager a host might also have installed.
3. A fixture in `packages/system-packages/tests/nouride-pkg.test.ts`: stand-in commands printing that
   manager's real simulate output, captured from a real host, and a protected package it must refuse.

Keep it POSIX sh: it runs as root, and on hosts whose `sh` is dash or busybox.

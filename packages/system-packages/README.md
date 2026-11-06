# system-packages

How a sandboxed daemon changes the machine's packages: `nouride-pkg`, a small root service with fixed
rules (`root/`), and the protocol and client the daemon speaks to it (`src/`). Set up by
`install.sh --allow-packages`; user docs are the site's *System packages* page.

The daemon runs with `NoNewPrivileges` and a read-only `/usr`, so nothing it starts can become root,
`sudo` included. This is the one way through, and it is narrow on purpose.

## Why it is shaped this way

| Question | Decision | Why |
|---|---|---|
| `sudo` for the agent? | No — a root service outside the sandbox | `NoNewPrivileges` makes `sudo` impossible, and removing it weakens everything else the sandbox protects |
| On by default? | No. `--allow-packages` turns it on; later runs keep it; `--no-packages` removes it | A closed-source daemon installing a listening root service unasked is a red flag; asked for, it is a feature |
| And in Nouride's container image? | Yes, unless `NOURIDE_SYSTEM_PACKAGES=off`; served by `root/container/`, with what agents installed kept on the volume (0.8.15) | Root there is the container's, and a recreate puts the image back; without it the agent could not install a package at all, and one installed by hand was gone at the next update |
| A warning when off? | None. The agent names the package and the flag only when a task needs one | Off is a choice, not a fault |
| What may it do? | install, remove, upgrade, refresh — from the host's repositories, by exact name | A removed package can be installed again, so most mistakes undo themselves |
| What is never allowed? | Options, paths, URLs, new repositories, versions, globs; removing a protected package, directly or as a dependency | A rollback does not undo a malicious package, and a box without ssh or networking cannot be fixed from afar |
| Only remove what an agent installed? | No | A ledger adds state and a failure mode; the protected list covers what cannot be recovered |
| Where the rules live | In the root script, never in the daemon | Agents run as the daemon's user and can reach the socket around the CLI; the script is what holds then |
| Where the gate lives | `packages/policy` (the fixed list's `system-packages`), never this package | One edit here must not be able to widen the only check in front of a change made as root |
| Its output | Run into a file, then sent to the client | A client that goes away mid-change must not SIGPIPE dpkg halfway |

Each backend is one file under `root/backends/` — see its README to add a distribution.

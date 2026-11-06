# isolation

Each agent's commands run as that agent's own user, `nr-<agent>`: `nouride-run`, a small root helper with fixed rules
(`root/`), and how the daemon finds and reaches it (`src/`). Set up by `install.sh`; the design is below, and
`docs/ARCHITECTURE.md` places it in the daemon.

The daemon runs with `NoNewPrivileges` and no capabilities, so nothing it starts can change user — not `sudo`, not a
setuid binary. This is the one way through, and it is narrow on purpose.

## How a command runs

```
daemon ─ nouride-run exec --agent nouva -- <command>      (the client: the daemon's user, in the commands cgroup)
            │  /run/nouride-run.sock — root:<service group> 0660, Accept=yes
            ▼
         nouride-run serve                                (root, one per connection, nothing resident)
            fork → setsid → the client's cgroup → the daemon's mount namespace
                 → nr-nouva's groups, group, user → no_new_privs → umask 002 → chdir → exec, as the agent
```

The client's stdin, stdout, stderr and exit are the command's, so the daemon's timeouts, output caps, process groups
and stops work unchanged: killing the client closes the connection, and the helper stops the command's whole group
(SIGTERM, then SIGKILL after five seconds). `prlimit`, `nice` and `script(1)` for a terminal run inside, as the agent
(`commandLine` in `@nouride/runtime`).

## Why it is shaped this way

| Question | Decision | Why |
|---|---|---|
| Language | Rust, `libc` the only dependency | The one process that runs as root reads a request from a socket: where memory safety pays. One more crate is one more thing a review reads |
| The request | Framed bytes (type, length, payload), not JSON | No parser to trust as root |
| Where it lives | `/usr/local/lib/nouride-run/`, root's | The install directory is the service user's: a root binary there is root for whoever owns the daemon |
| Whose users | Only `nr-<agent>` users it made, marked `nouride agent <id>` in GECOS | An id outside `[a-z0-9-]{1,29}` names nothing; a user someone else made under the name is never run as |
| Paths | Every one touched after the drop; its own folder work done with `O_NOFOLLOW` from `/` down | A check made as root is one a symlink gets around |
| What the command sees | The daemon's mount namespace | Its private `/tmp` and what its unit makes read-only — no more and no less than its commands always saw |
| Groups | `nr-agents` always; `nr-creds` by grant (`op: groups`); nothing else | The service group or a system group would undo the whole thing |
| A private folder's group | The service group, not `nr-<agent>` | The daemon reads a new agent's folder at once; a group made after it started would need a restart to count |
| The daemon's folders an agent reads | `--reads <dir>`: its pack, its jobs' logs, its attachments, its tools' long output — `<dir>/<agent>` the service user's, group `nr-<agent>`, setgid `2750` | The daemon writes there and what it writes takes the agent's group; the agent reads it and never writes it. They sit beside `data/`, never in it: `data/` is entered by no command |
| `shared/` | Group `nr-agents`, `2770`; what the daemon left there given the group once | Handover needs one place every agent writes; a file there stays its maker's, so only its maker changes its mode |
| The credentials directory | `--credentials <dir>`: group `nr-creds`, each file the group's to read, every time | A key is put there by hand, after the fact; the agents granted it should not wait. Granted by `op: groups`, from the pack's `[security] credentials` |
| A file a tool writes for an agent | `put`, run through `exec` as the agent: whole or not at all, the mode kept | One owner per file in an agent's folders: its command can `chmod +x` what `write` made, and `ssh` reads a config its user owns |
| Landlock | `[security.exec] landlock`: built in the daemon's view, applied after `no_new_privs`; takes away changing files and gives it back under the agent's folders and the temporary ones | A layer, not the wall: off at boot on many kernels. Reading and running stay with the files' modes, so no ordinary command breaks |
| What the command gets of the daemon's unit | Its mount namespace (entered), its cgroup (joined); `RestrictNamespaces=mnt`, the same socket families, `LockPersonality`, `RestrictRealtime` on the helper's unit | The command is the helper's child now, not the daemon's. Not `RestrictSUIDSGID`: the helper sets setgid on folders. A setgid file gains nothing where it runs — every command, and the daemon, has `no_new_privs` |
| Programs every agent shares | `.nouride/bin`, `lib`, `opt` and the shared HOME's `.local`, `.cargo`, `.rustup`: every agent's to run; the orchestrator's to change, as the daemon's user (`nouride tools run`, `[security] shared_tools`); each agent installs into its own `~/.local` | A shared directory an agent could write is a program it puts there for another agent, or the daemon, to run. The orchestrator is trusted with it, as an operator is |
| The shared HOME's logins | Copied into each agent's HOME at its first start, caches left; the shared HOME then passes agents through to its programs and nothing else | Nothing an agent reached the day before is out of reach the day after, and no agent writes another's settings — a `.gitconfig` alias or hook would run as whoever uses git next |
| No socket | Commands run as the daemon's user, said at boot and by `doctor` | Docker (the container is the boundary), macOS, a host without `install.sh`'s units. Never passed off as isolated |
| A root daemon (a Box) | The client applies the same rules in its own process | Nothing to ask; the same binary and rules |
| The secret store at rest | Not encrypted, yet | A key beside the store protects nothing a copy of the disk does not also hold, and a rollback to 0.7.x could not read it. With a key the daemon gets from systemd (`LoadCredentialEncrypted=`, sealed to the host or its TPM), it would — later |

## Built

`scripts/build/nouride-run.ts`: static musl for x86-64 and aarch64, linked by the toolchain's own `rust-lld` — about
half a megabyte each, nothing loaded at run time. Every Linux release tarball carries it as `run/nouride-run`.

## Tests

- `root/nouride-run` — unit tests, and the escape tests against the real binary, as root, with real users:
  `sh packages/isolation/scripts/test-root.sh` (needs Docker). CI runs them (`ci.yml`, `helper`).
- `tests/` — what boot decides, the client's command lines, the units.

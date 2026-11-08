/**
 * What always asks: one fixed list (0.8.0), and the classifier that finds a command on it.
 *
 * Hermes learned this the hard way and says it plainly in its own source: *"rm -rf build/
 * approved 100 times still never yields an rm allowlist entry."* Frequency of approval is
 * evidence that a command is convenient, not that it is safe to stop looking at. So a command on the
 * list is asked *allow once* and never remembered — under `careful` every entry, under `balanced` only
 * `BALANCED_ASKS`, under `trusted` none (`approvals.ts`).
 *
 * Two things this is **not**:
 *
 * - **Not a security boundary.** A determined model routes around any classifier — that is
 *   what the ask itself is for. Where each agent runs as its own user (0.8.0), the operating
 *   system is the boundary; this raises friction on the handful of commands whose blast radius is
 *   unrecoverable, so a permanent grant never quietly covers them.
 * - **Not a blocklist.** A listed command still runs if the operator says yes. The agent
 *   is supposed to be able to do anything on the machine with permission; it just cannot
 *   get *standing* permission for these.
 *
 * Until 0.8.0 this sorted commands by how they looked — privilege, system control, infrastructure — and a
 * `sudo cat` asked like an `rm -rf /`. The list is what a person would want to be asked about, whichever
 * program does it (SIMPLIFY RFC §1): a config changed, someone given access, the daemon stopped or replaced,
 * a secret replaced, the database, a delete outside the workspace, infrastructure torn down, a credential
 * leaving, a job that runs unasked, an interactive session, a remote's history rewritten.
 */

import { clip, type HardlineClass, oneLine } from "@nouride/shared";
import { classifyOwnCli, ownCliInner } from "./own-cli.ts";
import { programName } from "./shell-segments.ts";

/**
 * The entries `balanced` asks about — the default level, and the owner's everyday one (SIMPLIFY RFC §7).
 *
 * Four the RFC names — a `config.toml` changed, someone given access, the daemon stopped, a stored secret replaced or
 * deleted — and two more that are older than it and stay: a credential leaving (the secret guard, "off only under
 * `trusted`"), and the daemon's own state on an install where nothing else stands in front of it. Since then: what
 * every level asks, `trusted` too (`unwatched`, `shared-tools`, `persona`, `people`), and this machine's packages
 * changed as root (`system-packages`, 0.8.15). Everything else on the list is `careful`'s alone.
 *
 * A class added here is a line in every text that names what `balanced` asks: the prompt's, `/approvals`, the
 * dashboard's and the docs' — `tests/llm/harness-levels.test.ts` fails until the prompt's names it.
 */
export const BALANCED_ASKS: ReadonlySet<HardlineVerdict["class"]> = new Set([
  "config",
  "access",
  "stop",
  "secret",
  "credential-out",
  "own-state",
  "unwatched",
  "shared-tools",
  "system-packages",
  "persona",
  "people",
]);

/** Whether `balanced` answers a question of this class by itself — a question with no class it always does. */
export function autoApprovable(hardlineClass: HardlineVerdict["class"] | undefined): boolean {
  return hardlineClass === undefined || !BALANCED_ASKS.has(hardlineClass);
}

export interface HardlineVerdict {
  /** Stable identifier, recorded in the audit log so classifier changes are traceable. */
  class: HardlineClass;
  /** Shown to the operator in the approval prompt. Written for a human deciding in a chat. */
  reason: string;
}

/**
 * Elevation, which the list looks *through*: what `sudo` runs decides, not that it elevates.
 *
 * `runuser` and `chroot` are the same thing as `su` for this purpose — `runuser -u root -- reboot` walked straight
 * through the gate once while the `su -c reboot` beside it was caught. A `sudo cat` on its own is on no list since
 * 0.8.0: a new command like any other, asked once under `careful`; where each agent is its own user, `sudo` is not
 * its to run anyway.
 */
const PRIVILEGE = new Set(["sudo", "su", "doas", "pkexec", "runas", "runuser", "chroot"]);

const DISK = new Set(["dd", "mkfs", "fdisk", "parted", "shred", "diskutil", "hdiutil"]);

/** Ends the machine, and this daemon with it, until somebody switches it back on. `reboot` comes back: not here. */
const MACHINE_STOP = new Set(["shutdown", "halt", "poweroff"]);

/** Ends processes — this daemon's, when one of their arguments names it. */
const KILLERS = new Set(["kill", "pkill", "killall"]);

/**
 * Subcommands that take a service down and keep it down. `restart` is not one — the daemon comes back, and the RFC
 * draws the line there — though for this daemon it still ends the turn that ran it.
 */
const SERVICE_STOP = new Set(["stop", "disable", "mask", "unload", "bootout", "remove", "delete"]);

/** Names this daemon, its units, or its helper: `nouride`, `nouride.service`, `nouride-run.socket`, `tech.nouverse.nouride`. */
const NAMES_THIS_DAEMON = /(^|[/.@\s])nouride\b/;

/**
 * Infrastructure torn down, by the subcommand that tears it down.
 *
 * Creating and changing are not on the list (RFC §1, item 7): `terraform apply`, `kubectl scale`, `pct stop` are the
 * work an agent is given a Terraform repository or a cluster for, and `careful` asks them as new commands. What is here
 * is what does not come back — a destroyed stack, a deleted namespace, a container's disk.
 *
 * A map rather than a set of program names because the subcommand carries the whole distinction: `terraform plan`
 * reads, `terraform destroy` ends a homelab; `kubectl get` looks, `kubectl delete` loses.
 */
const TEARDOWN: Record<string, Set<string>> = {
  terraform: new Set(["destroy"]),
  tofu: new Set(["destroy"]),
  pulumi: new Set(["destroy"]),
  kubectl: new Set(["delete"]),
  helm: new Set(["uninstall", "delete"]),
  // Proxmox (`pct` for LXC, `qm` for QEMU VMs), LXD and Incus — Incus is LXD after the 2024 rename, and `incus` is the
  // command a current install ships. `exec` is not here because it is a wrapper, handled by `remoteExecPayload`.
  pct: new Set(["destroy"]),
  qm: new Set(["destroy"]),
  lxc: new Set(["delete"]),
  incus: new Set(["delete"]),
  vzctl: new Set(["destroy"]),
};

/**
 * Paths that hold a credential.
 *
 * Not on the fixed list: they make a command a new one, never an everyday one (`decideExec`), and what such a command
 * prints is masked whichever level let it run (`credential-files.ts`). Sending one off the machine is on the list
 * (`credential-send.ts`).
 *
 * Every non-flag argument is tested as a whole string, which is what makes this survive the shape an agent actually
 * reaches for: `python3 -c "…open('/…/.env')…"` is one argument holding a whole script.
 */
const CREDENTIAL_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/,
  /id_(rsa|ed25519|ecdsa|dsa)/,
  /(^|\/)\.aws\/credentials/,
  /(^|\/)\.kube\/config/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.env$/,
  /(^|\/)\.gnupg(\/|$)/,
  /**
   * The credentials directory, whatever an operator pointed `[security] credentials_dir` at.
   *
   * Matched on the directory *name* rather than an absolute path, because the path is configurable and this package
   * knows nothing about config — the cost is a false positive on an unrelated folder called `credentials`. The leading
   * dot is optional because `.credentials` is the name an operator reaches for beside a project's other
   * dot-directories. The second half is the directory by the name agents are given for it: argv reaches this file
   * unexpanded, so `cat $NOURIDE_CREDENTIALS_DIR/token.json` carries no `credentials/` segment at all — and that is the
   * spelling the harness hands every agent with a shell.
   */
  /(^|\/)\.?credentials(\/|$)|\bNOURIDE_CREDENTIALS_DIR\b/,
  /**
   * A process's environment or memory through `/proc` — the daemon's among them, which holds every credential `.env`,
   * an `EnvironmentFile=` or compose's `env_file` handed it. `cat` is an everyday program, so `cat /proc/<pid>/environ`
   * ran unprompted once and put every provider key into the model's context. Matched however the process is named.
   * On Linux the daemon is also non-dumpable (`makeNonDumpable`), which refuses the read however the path is written.
   */
  /\/proc\/[^/\s]+\/(?:task\/[^/\s]+\/)?(?:environ|mem)\b/,
];

/**
 * The daemon's own state, as `exec` reaches it where agents run as the daemon's user (`classifyOwnState`).
 *
 * On the live install, `read` refused `/srv/nouride/.nouride/agents/nix/config.toml` as outside the workspace, and
 * eight seconds later a `python3 -c` through `exec` rewrote every agent pack's `config.toml` in 21ms with no prompt:
 * binding a command's cwd is not binding what it can reach. Where each agent is its own user (0.8.0) these files are
 * closed to it by their permissions and this is not consulted; elsewhere it is the only thing in front of them.
 *
 * Matched on the `.nouride/` segment rather than on `config.toml`, which on its own would fire on every project the
 * agent works in. The agents directory is matched as a whole because the script that rewrote every pack built its
 * paths by concatenation (`agents_dir + "/" + name + "/config.toml"`): the only literal in it was the directory.
 * `.nouride/workspace/` and the job logs are deliberately not here — they are where the agent works.
 */
const OWN_STATE: readonly { pattern: RegExp; class: HardlineClass; what: string }[] = [
  /**
   * An agent's persona — its SOUL.md, IDENTITY.md or AGENTS.md in the daemon's packs — first, so it is answered as the
   * `persona` tool's change is, by an admin, rather than as any other file of a pack (HARDENING §9, C7): where agents
   * run as the daemon's user, `sed -i` on its own SOUL.md changed its rules with nobody asked who may.
   */
  { pattern: /(^|\/)\.nouride\/agents\/[^/\s'"]+\/(?:SOUL|IDENTITY|AGENTS)\.md\b/, class: "persona", what: "an agent's persona: its SOUL.md, IDENTITY.md or AGENTS.md, which an admin alone changes" },
  { pattern: /(^|\/)\.nouride\/(agents\/[^/\s'"]+\/)?config\.toml/, class: "config", what: "a config.toml that decides what agents may do" },
  { pattern: /nouride\.db/, class: "database", what: "the daemon's database, which holds every agent's conversations" },
  { pattern: /secrets\.json|\.control-token|(^|\/)\.nouride\/agents\b/, class: "own-state", what: "Nouride's own state" },
  /**
   * What is remembered and the documents kept for reference (0.8.20, KNOWLEDGE_BASE §4): memory's tools open them only
   * where the conversation may read them, by who is in it. A command reaching the folders read a profile, or a
   * collection kept for one person, in any chat.
   */
  { pattern: /(^|\/)\.nouride\/(memory|knowledge)\b/, class: "own-state", what: "what is remembered and the documents kept for reference, which memory's tools open only where they may be read" },
];

const RECURSIVE_FLAGS = new Set(["-r", "-R", "-rf", "-fr", "-rF", "--recursive"]);

/**
 * Deleting for good that is not a filesystem `rm`.
 *
 * The line drawn here is **irreversible and outside the workspace**, not merely "changes something". `docker stop` is
 * reversible; `docker volume rm` loses data. `apt install` is routine; `apt purge` removes software the machine may
 * need to boot. A repository's own history — `git reset --hard`, `git clean -f`, `git branch -D` — is the agent's work
 * in its workspace: a new command under `careful`, and no longer on the list.
 *
 * Gating more than that would be worse than gating nothing: asking about something ordinary trains an operator to click
 * through prompts, which is how the gate stops working. This list is short on purpose.
 */
const DELETES: { program: string; when: (args: string[]) => string | null }[] = [
  {
    program: "docker",
    when: (args) => {
      const joined = args.join(" ");
      if (/^volume\s+rm/.test(joined)) return "deletes a Docker volume and the data inside it";
      if (/^system\s+prune/.test(joined)) return "removes unused containers, images, networks and volumes at once";
      // No `rm -f` rule: on a compose-managed host a force-removed container comes back with `up -d`.
      if (/^compose\s+down/.test(joined) && args.some((a) => a === "-v" || a === "--volumes")) return "takes the stack down and deletes its volumes";
      return null;
    },
  },
  { program: "dropdb", when: () => "drops an entire database" },
  { program: "dropuser", when: () => "drops a database role" },
  {
    program: "redis-cli",
    when: (args) => (args.some((a) => /^FLUSH(ALL|DB)$/i.test(a)) ? "empties the Redis keyspace" : null),
  },
  {
    program: "find",
    when: (args) =>
      args.includes("-delete") || (args.includes("-exec") && args.includes("rm"))
        ? "deletes everything it matches, and what it matches is not visible in the command"
        : null,
  },
  {
    program: "crontab",
    when: (args) => (args.includes("-r") ? "wipes the crontab, and `-r` sits next to `-e` on the keyboard" : null),
  },
];

/**
 * A push that rewrites or removes a remote's history (RFC §1, item 11) — to any branch, since 0.8.0: a force-push to a
 * feature branch overwrites what a colleague pulled as surely as one to `main`. An ordinary push is not on the list.
 */
function rewritesRemote(args: readonly string[]): string | null {
  if (args[0] !== "push") return null;
  if (args.some((a) => ["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror"].includes(a) || a.startsWith("--force-with-lease="))) {
    return "force-pushes, which overwrites history for everyone who has it";
  }
  // `+main` forces one ref; `:main` and `--delete` remove a branch from the remote.
  const refs = args.slice(1).filter((a) => !a.startsWith("-"));
  if (refs.slice(1).some((ref) => ref.startsWith("+"))) return "force-pushes a ref (`+…`), which overwrites history for everyone who has it";
  if (args.includes("--delete") || args.includes("-d") || refs.slice(1).some((ref) => ref.startsWith(":"))) {
    return "deletes a branch on the remote, and the history only it held";
  }
  return null;
}

/** Package managers, where removal takes software off the machine. Installing is ordinary. */
const PACKAGE_REMOVAL: Record<string, RegExp> = {
  apt: /^(remove|purge|autoremove)$/,
  "apt-get": /^(remove|purge|autoremove)$/,
  dnf: /^(remove|erase)$/,
  yum: /^(remove|erase)$/,
  apk: /^del$/,
  pacman: /^-R/,
  brew: /^uninstall$/,
};

function isFlag(arg: string): boolean {
  return arg.startsWith("-");
}

function looksRecursive(args: string[]): boolean {
  return args.some(
    (arg) =>
      RECURSIVE_FLAGS.has(arg) ||
      // Clustered short flags: `-rfv`. Only when it is a single-dash cluster, so `--force`
      // is not read as containing an `r`.
      (/^-[a-zA-Z]+$/.test(arg) && arg.includes("r")),
  );
}

/**
 * Would this operand delete or rewrite something outside the working tree?
 *
 * An absolute path, a home-relative path, or a glob: all three mean the operator cannot tell
 * from the command alone what it will hit, which is exactly when a standing grant is wrong.
 */
function isWidePath(arg: string): boolean {
  if (isFlag(arg)) return false;
  return (
    arg.startsWith("/") ||
    arg.startsWith("~") ||
    arg.includes("$HOME") ||
    arg.includes("*") ||
    arg === ".." ||
    arg.startsWith("../")
  );
}

/**
 * The directory an agent may treat as disposable, matched by name rather than by path.
 *
 * The friction this removes was a real turn. The agent screenshotted a Mac over ssh, sent the file,
 * then tidied up with `ssh mac rm -f /tmp/screen.png` — an absolute-path delete, so on the list, so
 * it stopped the turn dead *and* could not be answered by the level that skips ordinary questions. The gate was right about the command and wrong about the situation: the
 * file was thirty seconds old, the agent had made it, and nothing else in the world referred to it.
 *
 * "Is this file temporary?" cannot be answered from argv. `/tmp` holds other processes' state, and a
 * classifier keyed on names like `screen.png` is one a model routes around by picking another name.
 * So the question is turned around: rather than guessing which paths are disposable, one directory is
 * *declared* disposable and the agent is told to put throwaway work there. Ownership by construction,
 * not by heuristic — which is also why this is a directory the harness creates rather than a pattern.
 *
 * Matched on the directory **name**, the same compromise `CREDENTIAL_PATTERNS` makes for the
 * credentials directory and for the same reason: this package knows nothing about config, and the
 * scratchpad on the far end of an `ssh` is not a path this machine could resolve anyway. The cost is
 * a false negative on an unrelated folder somebody else called `.scratchpad` — a directory whose name
 * means "throwaway" and whose contents someone would nonetheless mind losing. That trade is the whole
 * design, and it is why the name is `.scratchpad` rather than `tmp` or `scratch`.
 *
 * This is one of two ways an operand can qualify as disposable; `TEMP_ROOTS` is the other, and was
 * added after this one turned out to be unreachable on a machine the daemon does not control. They
 * are complementary: a scratchpad works anywhere and has to be chosen, a temp root is already there
 * and does not.
 *
 * The exemption is deliberately not a list of blessed programs. `rm` was the first thing to trip on
 * it, but an agent clears up with whatever is to hand — `find … -delete`, `shred`, `truncate`,
 * `mv`, `chmod` before a delete that would not otherwise work — and gating four of those while
 * exempting the fifth teaches nothing except that the rule is arbitrary. So the question asked is
 * about the *operands*, not the program: a command every one of whose operands is inside a
 * scratchpad cannot reach past it, whatever the verb.
 *
 * What it does **not** relax:
 *
 * - Every operand must be inside a scratchpad. `rm -rf /var/lib ~/.scratchpad/x` stays gated on the
 *   half that reaches outside, and `dd if=/dev/zero of=~/.scratchpad/x` stays gated on `/dev/zero`.
 * - A `..` anywhere in the path disqualifies it.
 * - A command with **no** operands is never exempt, which is what keeps `reboot`, `shutdown` and
 *   `crontab -r` where they are: there is nothing for a scratchpad to bound.
 * - It downgrades a never-grantable entry to an ordinary command. It does not make anything run
 *   unasked — the approval level still applies.
 *
 * The classes that are not about paths at all are unaffected either way, and by construction rather
 * than by exception: `apt remove nginx`, `pkill nouride` and `kubectl delete pod`
 * all carry operands that are not paths, so they can never satisfy "every operand is in a
 * scratchpad". Worth knowing when reading the guard below and wondering what else it lets through.
 */
export const SCRATCHPAD_DIRNAME = ".scratchpad";

/**
 * The machine's own scratch directories, which POSIX already declares disposable.
 *
 * Added after watching the scratchpad work perfectly on the daemon's box and change nothing at all
 * on the other end of an `ssh`: the agent wrote `screencapture -x /tmp/screen.png` on a Mac, copied
 * the file back into its scratchpad correctly, and then still needed a hardline approval to delete
 * the original. `$TMPDIR` does not cross an ssh, and the prompt line telling it to use
 * `~/.scratchpad` over there was read and ignored.
 *
 * The honest fix is not a louder instruction. It is admitting that `/tmp` already *is* a scratchpad:
 * every convention on the system says a file there is disposable, the directory is cleared on
 * reboot, and nothing that writes there expects what it wrote to survive. Gating deletes in it
 * taught an operator to approve the same harmless `rm` over and over, which is precisely how a gate
 * stops being read.
 *
 * `/var/tmp` is here too — same convention, longer life — as are the `/private/…` spellings macOS
 * resolves to, and the per-user directory a Mac's `$TMPDIR` actually points at.
 */
const TEMP_ROOTS = ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"];

/** macOS per-user temp: `/var/folders/<xx>/<hash>/T/…`, which is what `$TMPDIR` expands to there. */
const MACOS_TEMP = /^\/(private\/)?var\/folders\/[^/]+\/[^/]+\/[A-Z]\/./;

/**
 * Whether an operand names something *inside* a temp directory — not the directory itself.
 *
 * The distinction is the whole of the rule. A file under `/tmp` is disposable by convention; `/tmp`
 * is a directory the running system depends on, and a bare `/tmp/*` sweeps every socket and lock
 * file every other process on the box left there. One is tidying up, the other breaks software that
 * is running right now, so the first is exempt and the second stays exactly where it was.
 */
function insideTempRoot(path: string): boolean {
  for (const root of TEMP_ROOTS) {
    if (!path.startsWith(`${root}/`)) continue;
    const rest = path.slice(root.length + 1);
    // `/tmp/` is the directory; `/tmp/*` is everything in it, which is not the same as a file in it.
    return rest !== "" && rest !== "*";
  }
  return MACOS_TEMP.test(path);
}

/**
 * Whether an operand names something the machine already treats as disposable.
 *
 * Two ways to qualify, answering different halves of the same problem: a `.scratchpad` is a
 * directory *we* create and own, so it works on a host we have never seen; a temp root is one the
 * operating system already declares disposable, so it works without the agent having to choose it.
 *
 * A glob is fine here where it is not fine elsewhere: `~/.scratchpad/*` and `/tmp/build/*` cannot
 * expand past the directory that bounds them, so what they hit is bounded even though it is not
 * visible in the command.
 */
function disposablePath(arg: string): boolean {
  const path = arg.replace(/\\/g, "/");
  // `~/.scratchpad/../../etc` and `/tmp/../etc` are neither of these things.
  if (path.split("/").includes("..")) return false;
  return path.split("/").includes(SCRATCHPAD_DIRNAME) || insideTempRoot(path);
}

/**
 * `find` predicates that run another command, and where that command's own operands begin.
 *
 * The one way a `find` rooted in a scratchpad reaches outside it: `find ~/.scratchpad -exec rm
 * /etc/passwd \;` is rooted somewhere harmless and does something else entirely. The payload is
 * bounded separately below.
 */
const FIND_EXEC_PREDICATES = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Tokens inside a `-exec` payload that stand for the matched file, or end the payload. */
const FIND_EXEC_PLACEHOLDERS = new Set(["{}", ";", "+", "\\;"]);

/**
 * Whether a `find` can only touch things inside a scratchpad.
 *
 * Judged on what `find` actually guarantees rather than by scanning every token, which is both
 * simpler and more accurate: the operands before the first predicate are the roots, `find` walks
 * nothing outside them, and so a predicate's own value (`-name '*.png'`, `-mtime +3`) needs no
 * checking at all. Scanning tokens would have gated `-name '*.png'` for looking like a stray glob.
 *
 * The exception is the `-exec` family, which runs an arbitrary command with arbitrary arguments —
 * so those arguments have to be a placeholder or inside the scratchpad, like anything else.
 *
 * Known gap, stated rather than papered over: `-fprint /etc/x` writes outside the roots and is not
 * checked. It is exotic enough that handling it would cost more legibility than it buys, and this is
 * a friction rule rather than a boundary — see the file header.
 */
function findBoundedToDisposable(args: string[]): boolean {
  const firstPredicate = args.findIndex(isFlag);
  const roots = firstPredicate === -1 ? args : args.slice(0, firstPredicate);
  if (roots.length === 0 || !roots.every(disposablePath)) return false;

  for (let i = 0; i < args.length; i++) {
    if (!FIND_EXEC_PREDICATES.has(args[i] as string)) continue;
    // The token straight after the predicate is a program name, not a path.
    for (let j = i + 2; j < args.length; j++) {
      const token = args[j] as string;
      if (FIND_EXEC_PLACEHOLDERS.has(token)) break;
      if (!disposablePath(token)) return false;
    }
  }
  return true;
}

/**
 * Whether this command works only inside a scratchpad, and so cannot reach anything that matters.
 *
 * `every`, and at least one — the two halves are equally load-bearing. `every` is what stops a
 * scratchpad path appended to a real command from laundering it; the minimum of one is what stops a
 * command with no operands at all (`reboot`, `crontab -r`) from passing vacuously.
 *
 * Flags are not operands. `--` is skipped for the same reason, so `rm -rf -- ~/.scratchpad/-weird`
 * is judged on the file it names.
 *
 * Two programs need their argv read rather than filtered, and both were found by the exemption not
 * firing where it obviously should: `chmod -R 700 ~/.scratchpad` has a *mode* as its first operand,
 * and a mode is not a path. `find` has a grammar. Everywhere else every operand is a file, which is
 * why this is two special cases and not a table that would need one row per program.
 */
function boundedToDisposable(program: string, args: string[]): boolean {
  if (program === "find") return findBoundedToDisposable(args);

  let operands = args.filter((arg) => !isFlag(arg) && arg !== "--");
  // `chmod 700 f`, `chown me f`, `chgrp staff f` — the first operand says what to set, not where.
  if (program === "chmod" || program === "chown" || program === "chgrp") operands = operands.slice(1);

  return operands.length > 0 && operands.every(disposablePath);
}

/**
 * `ssh` flags that consume the next argument, so the host is not mistaken for one of their values.
 */
const SSH_FLAGS_WITH_VALUE = new Set(["-i", "-p", "-o", "-l", "-F", "-J", "-b", "-c", "-D", "-L", "-R", "-W"]);

/**
 * The command `ssh` would run on the other machine, or `null` when it opens an interactive session.
 *
 * This is the hole that mattered most on a real install, and it is invisible from the local
 * filesystem: the agent's destructive reach is not this box, it is every box it can log into.
 * `ssh proxmox "rm -rf /var/lib/vz"` passed every rule here because the program was `ssh` — while
 * the same command typed locally was refused. Gating the front door and leaving the back one open.
 */
function sshPayload(args: string[]): string[] | null {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (!isFlag(arg)) break;
    i += SSH_FLAGS_WITH_VALUE.has(arg) ? 2 : 1;
  }
  // args[i] is the host; everything after it is the remote command.
  const remote = args.slice(i + 1);
  return remote.length > 0 ? remote : null;
}

/** Shells whose `-c` payload is another command, not a filename. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);

/** Flags for `docker exec` that consume the next argument as a value. */
const DOCKER_EXEC_FLAGS_WITH_VALUE = new Set(["-u", "--user", "-w", "--workdir", "-e", "--env", "--env-file"]);

/** Flags for `lxc`/`incus exec` that consume the next argument as a value. */
const LXC_EXEC_FLAGS_WITH_VALUE = new Set([
  "--mode",
  "--env",
  "-e",
  "--user",
  "--group",
  "--cwd",
  "--project",
  "-p",
]);

/** Flags for `kubectl exec` that consume the next argument as a value. */
const KUBECTL_EXEC_FLAGS_WITH_VALUE = new Set(["-n", "--namespace", "-c", "--container"]);

/** Flags for `nsenter` that consume the next argument as a value. */
const NSENTER_FLAGS_WITH_VALUE = new Set(["-t", "--target", "-S", "--setuid", "-G", "--setgid"]);

/**
 * The inner command from a `<tool> exec [opts] <target> [opts] [--] command...` argv, or null.
 *
 * Shared by every wrapper of that shape, because writing the walk per wrapper is how `docker exec`
 * came to skip options correctly while `lxc exec` did not skip them at all — and every real
 * `lxc exec` invocation carries one.
 *
 * Options are skipped on **both** sides of the target, since the tools accept either ordering:
 * `lxc exec --mode=x c1 -- cmd` and `lxc exec c1 --mode=x -- cmd` are the same call. A
 * `--flag=value` token needs no lookahead, and clustered short flags like `-it` are one token with
 * no value.
 *
 * Where this is imprecise it fails *open* rather than closed — an option whose value we did not
 * expect shifts the target by one and the inner command is misread as benign. That is the same
 * failure the classifier already has for any wrapper it does not know, and it is why this is
 * friction on the obvious cases rather than a security boundary (see the file header).
 *
 * Every remote-execution wrapper — one whose trailing arguments are a command to run elsewhere — comes through here.
 *
 * `ssh` is handled separately (it has its own option-parsing), but every other wrapper that takes
 * a command after a container/VM id and optional `--` lives here. The pattern is always the same:
 * skip the wrapper, skip options, skip the target identifier, skip an optional `--`, and everything
 * left is the inner command.
 *
 * This is the hole the agent walked through on a real install: `ssh host pct exec 102 --
 * systemctl restart nouride` cleared the SSH layer (the inner command was `pct exec 102 --
 * systemctl restart nouride`), but `pct` fell through every rule because it is not a dangerous
 * program — only what it *runs* is.
 */
function execWrapperInner(
  rest: string[],
  from: number,
  flagsWithValue: Set<string>,
): string[] | null {
  const skipFlags = (start: number): number => {
    let i = start;
    while (i < rest.length && rest[i] !== "--" && isFlag(rest[i] as string)) {
      i += flagsWithValue.has(rest[i] as string) ? 2 : 1;
    }
    return i;
  };

  // Options, then the container/VM identifier, then any options written after it.
  let i = skipFlags(from) + 1;
  i = skipFlags(i);
  if (rest[i] === "--") i += 1;

  const inner = rest.slice(i);
  return inner.length > 0 ? inner : null;
}

/**
 * Wrappers that run the rest of their argv as a command, right here on this machine.
 *
 * The same hole as `pct exec`, one layer simpler: the program named first is harmless, and what it
 * runs is the whole point. `timeout 5 reboot`, `env FOO=bar reboot`, `nohup reboot` and
 * `nice -n 10 reboot` all walked through the gate while the bare `reboot` beside them was caught —
 * and `sh -c "find / | xargs rm -rf"` split into a segment starting with `xargs`, which was not a
 * dangerous program either.
 *
 * `operands` is how many non-flag arguments belong to the wrapper before the command starts:
 * `timeout` takes a duration, the rest take nothing. `env` is special-cased for its `NAME=VALUE`
 * assignments, which are neither flags nor the command.
 */
const PREFIX_WRAPPERS: Record<string, { flagsWithValue: Set<string>; operands: number }> = {
  env: { flagsWithValue: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]), operands: 0 },
  timeout: {
    flagsWithValue: new Set(["-s", "--signal", "-k", "--kill-after"]),
    operands: 1,
  },
  nohup: { flagsWithValue: new Set(), operands: 0 },
  setsid: { flagsWithValue: new Set(), operands: 0 },
  nice: { flagsWithValue: new Set(["-n", "--adjustment"]), operands: 0 },
  ionice: { flagsWithValue: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid"]), operands: 0 },
  stdbuf: {
    flagsWithValue: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
    operands: 0,
  },
  xargs: {
    flagsWithValue: new Set([
      "-n", "--max-args", "-P", "--max-procs", "-I", "--replace",
      "-d", "--delimiter", "-s", "--max-chars", "-a", "--arg-file",
      "-E", "--eof", "-L", "--max-lines",
    ]),
    operands: 0,
  },
  "systemd-run": {
    flagsWithValue: new Set(["-p", "--property", "-u", "--unit", "--on-calendar", "--slice", "-M", "--machine"]),
    operands: 0,
  },
};

/**
 * Flags for the privilege wrappers that consume the next argument as a value.
 *
 * `sudo -u nobody cmd`, `runuser -u root -- cmd`, `chroot /mnt cmd`. Everything else in the set takes
 * either no options or ones that stand alone.
 */
const PRIVILEGE_FLAGS_WITH_VALUE = new Set([
  "-u", "--user", "-g", "--group", "-U", "-h", "--host", "-p", "--prompt", "-C", "--close-from",
]);

/** Privilege wrappers whose first non-flag argument is a target, not the command. */
const PRIVILEGE_TAKES_TARGET = new Set(["chroot", "runas"]);

/**
 * The command a privilege wrapper would run, or `null` when there is none.
 *
 * `su` is read apart: its command comes after `-c` as one shell string, run as a shell would run it — and its trailing
 * argument is a *username*, which read as a program would be one. Since 0.8.0 an elevation is on no list of its own, so
 * a `su -c` this did not read would be a command nothing looked at.
 */
function privilegePayload(argv: string[]): string[] | null {
  const prog = programName(argv[0] ?? "");
  if (prog === "su") {
    const at = argv.findIndex((arg) => arg === "-c" || arg === "--command");
    const script = at < 0 ? undefined : argv[at + 1];
    return script ? ["sh", "-c", script] : null;
  }

  let i = 1;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (arg === "--") {
      i += 1;
      break;
    }
    if (!isFlag(arg)) break;
    i += PRIVILEGE_FLAGS_WITH_VALUE.has(arg) ? 2 : 1;
  }
  // `chroot /mnt reboot` — the directory is the wrapper's own argument, not the command.
  if (PRIVILEGE_TAKES_TARGET.has(prog)) i += 1;

  const inner = argv.slice(i);
  return inner.length > 0 && inner.length < argv.length ? inner : null;
}

/**
 * The command a prefix wrapper would run, or `null` when this is not one of them.
 *
 * A `NAME=VALUE` assignment is only skipped for `env`, where it is part of the wrapper's own syntax.
 * Anywhere else a token with an `=` in it is an ordinary argument and must not be stepped over.
 */
function prefixWrapperInner(argv: string[]): string[] | null {
  const spec = PREFIX_WRAPPERS[programName(argv[0] ?? "")];
  if (!spec) return null;

  const isAssignment = (arg: string): boolean =>
    programName(argv[0] ?? "") === "env" && !arg.startsWith("-") && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg);

  let i = 1;
  let operandsLeft = spec.operands;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (arg === "--") {
      i += 1;
      break;
    }
    if (isFlag(arg)) {
      i += spec.flagsWithValue.has(arg) ? 2 : 1;
      continue;
    }
    if (isAssignment(arg)) {
      i += 1;
      continue;
    }
    if (operandsLeft > 0) {
      operandsLeft -= 1;
      i += 1;
      continue;
    }
    break;
  }

  const inner = argv.slice(i);
  // A wrapper with nothing after it runs nothing, and a wrapper wrapping itself is not progress.
  return inner.length > 0 && inner.length < argv.length ? inner : null;
}

/**
 * Extract the inner command from a remote-execution wrapper, or `null` when the argv is not a
 * recognised wrapper or has no trailing command.
 *
 * The wrapper name is `argv[0]` (or `argv[0] argv[1]` for `pct exec` / `lxc exec` / `docker exec`
 * / `kubectl exec`). The function returns the argv that the wrapper would execute.
 */
function remoteExecPayload(argv: string[]): string[] | null {
  const prog = programName(argv[0] ?? "");
  const rest = argv.slice(1);

  // --- pct exec <vmid> [--] command... (Proxmox) ---
  // --- lxc/incus exec [opts] <name> [--] command... (LXD, and Incus which it was renamed to) ---
  //
  // The first version of this skipped exactly one token for the target and no flags at all, which
  // meant every real `lxc exec` invocation escaped: `lxc exec --mode=non-interactive c1 -- reboot`
  // read `--mode=non-interactive` as the container name and `c1 -- reboot` as the command, and
  // `c1` is not a dangerous program. Flags are skipped the same way `docker exec` does it.
  if ((prog === "pct" || prog === "lxc" || prog === "incus") && rest[0] === "exec") {
    return execWrapperInner(rest, 1, LXC_EXEC_FLAGS_WITH_VALUE);
  }

  // --- docker/podman exec [opts] container command... ---
  //
  // `podman` takes the same argv as `docker` by design — it ships a `docker` alias — so gating one
  // and not the other only means the gate is skipped on every RHEL-family host.
  if ((prog === "docker" || prog === "podman") && rest[0] === "exec") {
    return execWrapperInner(rest, 1, DOCKER_EXEC_FLAGS_WITH_VALUE);
  }

  // --- kubectl exec [opts] pod [--] command... ---
  // kubectl's `exec` always requires `--` before the command in practice, and the official docs
  // say so. Handle both: with `--` (find it and take everything after) and without (skip opts,
  // skip pod, take the rest).
  if (prog === "kubectl" && rest[0] === "exec") {
    const dashDash = rest.indexOf("--", 1);
    if (dashDash >= 0) {
      const inner = rest.slice(dashDash + 1);
      return inner.length > 0 ? inner : null;
    }
    // No `--`: skip options, then the pod name, then the command.
    return execWrapperInner(rest, 1, KUBECTL_EXEC_FLAGS_WITH_VALUE);
  }

  // --- nsenter [opts] command... ---
  if (prog === "nsenter") {
    let i = 0;
    while (i < rest.length) {
      const arg = rest[i] as string;
      if (arg === "--") { i++; break; }
      if (!isFlag(arg)) break;
      // nsenter flags: some take values (-t PID), some are standalone (-m, -u, -i, etc.)
      // The ones with = (--target=PID) are a single token. For the short forms:
      if (NSENTER_FLAGS_WITH_VALUE.has(arg)) {
        i += 2;
      } else {
        i += 1;
      }
    }
    const inner = rest.slice(i);
    return inner.length > 0 ? inner : null;
  }

  return null;
}

/**
 * Split a shell payload into the commands it runs.
 *
 * Deliberately naive: it splits on the operators that separate commands and tokenises on
 * whitespace. It is not a shell parser and does not pretend to be one — quoting, `$()`, here-docs
 * and variable expansion can all hide a command from it.
 *
 * That limit is worth stating plainly rather than papering over, because the alternative was worse.
 * Before this, `sh -lc "rm -rf /"` matched **nothing**: the program was `sh`, so every rule below
 * looked at the wrong string and the whole classifier was one `sh -c` away from irrelevant. And
 * `sh -lc` is not an edge case here — it is the shape `exec` uses for anything with a pipe, and the
 * shape `cron` wraps every `--command` in.
 *
 * A heuristic that catches the obvious cases beats a perfect check that is never reached.
 */
function shellSegments(payload: string): string[][] {
  return payload
    .split(/(?:\|\||&&|[;\n|])/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/**
 * Which entry of the fixed list `argv` is, or `null` when it is on none.
 *
 * Ordinary is the common case and stays cheap: most calls fall through every branch.
 *
 * `depth` bounds the recursion into shell payloads. `sh -c "sh -c '...'"` is legitimate and rare;
 * unbounded recursion on a crafted string is neither. `remote` is set for what runs on another machine — over ssh, or
 * in a container — where no operand is inside this agent's workspace, so a relative path is as wide as any.
 */
export function classifyHardline(argv: string[], depth = 0, remote = false): HardlineVerdict | null {
  const program = programName(argv[0] ?? "");
  const args = argv.slice(1);
  if (!program) return null;

  // A shell's `-c` payload is a command, not data. Classify what it would actually run.
  if (SHELLS.has(program) && depth < 3) {
    const payload = args.find((arg) => !isFlag(arg));
    if (payload && args.some((arg) => /^-[a-z]*c[a-z]*$/.test(arg))) {
      for (const segment of shellSegments(payload)) {
        const verdict = classifyHardline(segment, depth + 1, remote);
        if (verdict) {
          return {
            ...verdict,
            // Said explicitly, because the operator is looking at `sh -lc "…"` in the prompt and the
            // dangerous part may be the third command in a pipeline.
            reason: `${verdict.reason} (inside a shell command)`,
          };
        }
      }
    }
  }

  // What `ssh` would run over there is a command, exactly like a shell payload — and on a homelab
  // it is the command that matters, because the machines worth breaking are the remote ones.
  if ((program === "ssh" || program === "rsh") && depth < 3) {
    const payload = sshPayload(args);
    if (payload) {
      // First, try classifying the remote payload directly — this preserves argv boundaries,
      // which matters when the remote command is itself a wrapper: `ssh host pct exec 102 --
      // sh -c "systemctl stop x"` keeps `"systemctl stop x"` as one token.
      const direct = classifyHardline(payload, depth + 1, true);
      if (direct) {
        return { ...direct, reason: `${direct.reason} (on the remote host, over ssh)` };
      }
      // Then, join and re-split through the shell splitter: `ssh host "a && b"` arrives as one
      // argument, while `ssh host a b` arrives as several. Both are one remote command line.
      for (const segment of shellSegments(payload.join(" "))) {
        const verdict = classifyHardline(segment, depth + 1, true);
        if (verdict) {
          return { ...verdict, reason: `${verdict.reason} (on the remote host, over ssh)` };
        }
      }
    }
  }

  // Remote-execution wrappers: `pct exec`, `lxc exec`, `docker exec`, `kubectl exec`, `nsenter`.
  // Same idea as SSH — the wrapper itself is benign, the *inner* command is what matters.
  if (depth < 3) {
    const inner = remoteExecPayload(argv);
    if (inner) {
      const verdict = classifyHardline(inner, depth + 1, true);
      if (verdict) {
        // `nsenter` has no `exec` subcommand, so naming it that way would describe a command the
        // operator never typed. The wrapper's own name is what they are looking at.
        return { ...verdict, reason: `${verdict.reason} (run through ${program})` };
      }
    }
  }

  // Prefix wrappers — `timeout`, `env`, `nohup`, `nice`, `xargs`. Same shape, one layer simpler.
  if (depth < 3) {
    const wrapped = prefixWrapperInner(argv);
    if (wrapped) {
      const verdict = classifyHardline(wrapped, depth + 1, remote);
      if (verdict) {
        return { ...verdict, reason: `${verdict.reason} (run through ${program})` };
      }
    }
  }

  // This daemon's own CLI: one verb table — see `own-cli.ts` — and what it runs for the agent, classified as itself.
  if (program === "nouride") {
    const inner = depth < 3 ? ownCliInner(args) : null;
    const within = inner ? (classifyHardline(inner.argv, depth + 1, remote) ?? (inner.asDaemon ? classifyOwnState(inner.argv) : null)) : null;
    if (within) return { ...within, reason: `${within.reason} (${inner!.how})` };
    const verdict = classifyOwnCli(args);
    if (verdict) return verdict;
  }

  // What an elevation runs decides, never that it elevates: `sudo rm -rf /` is a delete, `sudo cat` is on no list.
  if (PRIVILEGE.has(program)) {
    const elevated = privilegePayload(argv);
    if (!elevated || depth >= 3) return null;
    const verdict = classifyHardline(elevated, depth + 1, remote);
    return verdict ? { ...verdict, reason: `${verdict.reason} (as another user via ${program})` } : null;
  }

  // The daemon stopped for good — by name, or with the machine under it. Above the disposable-path exemption: a
  // pid file in `/tmp` bounds nothing a `kill` does.
  if (MACHINE_STOP.has(program)) {
    return { class: "stop", reason: `${program} stops this machine, and this daemon with it` };
  }
  if (KILLERS.has(program) && args.some((arg) => NAMES_THIS_DAEMON.test(arg))) {
    return { class: "stop", reason: `${program} ends this daemon` };
  }
  if (
    (program === "systemctl" || program === "launchctl" || program === "service") &&
    args.some((arg) => SERVICE_STOP.has(arg)) &&
    args.some((arg) => NAMES_THIS_DAEMON.test(arg))
  ) {
    return { class: "stop", reason: "stops or disables this daemon's service, and it does not come back by itself" };
  }

  // Below the stop rules and above every delete, which is the whole of the ordering argument: a disposable directory
  // bounds what a command can touch, so it answers every rule that exists because a path is not visible. See
  // `SCRATCHPAD_DIRNAME` for what this deliberately does not cover, and `TEMP_ROOTS` for why `/tmp` counts at all.
  if (boundedToDisposable(program, args)) return null;

  if (DISK.has(program) || program.startsWith("mkfs")) {
    return { class: "delete", reason: `${program} writes to devices or destroys data irreversibly` };
  }

  // Deleting for good outside the workspace: a path the command does not show — absolute, home, a glob, `..`, none at
  // all where `xargs` hands them in — or, on another machine, any path. `rm -rf build/` here is the agent's own work: a
  // new command, not the list.
  if (program === "rm") {
    const operands = args.filter((arg) => !isFlag(arg));
    if (operands.some(isWidePath) || (remote && operands.length > 0) || (operands.length === 0 && looksRecursive(args))) {
      return {
        class: "delete",
        reason: looksRecursive(args)
          ? "recursive delete outside the workspace, the classic unrecoverable mistake"
          : "deletes by absolute path or glob, so what it hits is not visible in the command",
      };
    }
  }

  if (program === "git") {
    const reason = rewritesRemote(args);
    if (reason) return { class: "force-push", reason: `\`git\` ${reason}` };
  }

  for (const rule of DELETES) {
    if (rule.program !== program) continue;
    const reason = rule.when(args);
    if (reason) return { class: "delete", reason: `\`${program}\` ${reason}` };
  }

  const removal = PACKAGE_REMOVAL[program];
  if (removal && args.some((arg) => removal.test(arg))) {
    return {
      class: "delete",
      reason: `${program} removes installed software, and an unattended machine can lose something it needs to boot`,
    };
  }

  const teardown = TEARDOWN[program];
  if (teardown) {
    // `--dry-run` turns a delete into a preview, and `terraform apply -destroy` is a destroy by another name.
    const dryRun = args.some((arg) => arg === "--dry-run" || arg.startsWith("--dry-run="));
    const subcommand = args.find((arg) => !isFlag(arg));
    const destroys = (subcommand !== undefined && teardown.has(subcommand)) || (subcommand === "apply" && args.includes("-destroy"));
    if (destroys && !dryRun) {
      return {
        class: "teardown",
        reason: `\`${program} ${subcommand}\` tears infrastructure down, and what it removes does not come back`,
      };
    }
  }

  return null;
}

/**
 * The daemon's own state a command names — its config, its database, the store and the packs — or `null`.
 *
 * Asked only where agents run as the daemon's user (`DecideInput.ownStateByOs`): there, nothing else stands between
 * `exec` and these files, since workspace roots bound its *cwd* and not what a process it spawns may open.
 */
export function classifyOwnState(argv: readonly string[], cwd?: string): HardlineVerdict | null {
  for (const arg of argv.slice(1)) {
    if (isFlag(arg)) continue;
    // The argument as written, then each path in it resolved from the command's folder: `../../agents/nix/SOUL.md`
    // from an agent's workspace names its pack without the literal `.nouride/agents` (C7).
    const named = [arg, ...(cwd ? pathsIn(arg).map((path) => resolvedFrom(cwd, path)) : [])];
    const hit = OWN_STATE.find((entry) => named.some((one) => entry.pattern.test(one)));
    if (hit) return { class: hit.class, reason: `touches ${hit.what} (${matchedLine(arg)})` };
  }
  return null;
}

/** The words of an argument — a script's included — that read as a relative path: a `/` in them, not at the start. */
function pathsIn(arg: string): string[] {
  return arg.split(/[\s'"`=;|&<>(),]+/).filter((word) => word.includes("/") && !word.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(word));
}

/** `path` from `cwd`, `.` and `..` folded — the folder a relative path names, as the command would open it. */
function resolvedFrom(cwd: string, path: string): string {
  const parts: string[] = [];
  for (const part of `${cwd}/${path}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/** The argument naming a credential path, clipped for a prompt — or `null`. See `CREDENTIAL_PATTERNS`. */
export function credentialPath(argv: readonly string[]): string | null {
  const hit = argv.slice(1).find((arg) => !isFlag(arg) && CREDENTIAL_PATTERNS.some((pattern) => pattern.test(arg)));
  return hit === undefined ? null : matchedLine(hit);
}

/**
 * The matched argument, short enough to read in a chat prompt.
 *
 * The reason string is rendered into an approval a person answers on a phone, and the argument that
 * matched is now routinely a whole `python3 -c` script — the very shape this classifier was widened
 * to catch. Printing it in full turns the one line that says *why* into a wall nobody reads, which
 * is the same failure the preview design exists to avoid.
 */
function matchedLine(value: string): string {
  return clip(oneLine(value), 80, 77);
}

/**
 * The fixed list, for a person: what each entry is and what reaches it. `careful` asks every row; `balanced` the ones
 * in `BALANCED_ASKS`; `trusted` none.
 *
 * Exported because the rules were only discoverable by reading this file or by tripping over one. Deliberately prose
 * rather than a dump of the tables: `classifyHardline` remains the authority — `nouride policy check` runs the real
 * classifier rather than consulting this.
 */
export const HARDLINE_SUMMARY: { class: HardlineVerdict["class"]; what: string; examples: string[] }[] = [
  {
    class: "config",
    what: "A config.toml changed: the daemon's, the agent's own, another agent's (a pack's skills.toml and mcp.toml are not)",
    examples: ["nouride gateway|provider add|set|rm, agent enable|disable, memory set", "edit or write of a .nouride config.toml"],
  },
  {
    class: "access",
    what: "Someone given access, or a person's answer given for them",
    examples: ["nouride access approve|allow|mode …, users reset", "nouride approvals allow-once|allow-always|deny, grants revoke", "nouride mcp-server on|off|token, mcp login|logout"],
  },
  { class: "stop", what: "This daemon stopped, killed or uninstalled (a restart is not)", examples: ["nouride stop, service install|uninstall", "systemctl stop|disable nouride, pkill nouride", "shutdown, halt, poweroff"] },
  { class: "secret", what: "A stored secret replaced or deleted", examples: ["nouride secret set|rm", "secret_save over a name already kept"] },
  {
    class: "credential-out",
    what: "A credential leaving: sent off the machine, handed to a command bound to it, or used after outside content (the secret guard)",
    examples: ["scp .env host:, curl -T ~/.ssh/id_ed25519 …", "a command an exec_secrets entry hands a secret to"],
  },
  { class: "own-state", what: "Nouride's own state, where agents run as the daemon's user", examples: ["secrets.json, secrets.enc and its key, .control-token, another agent's pack, the memory and knowledge folders"] },
  { class: "replace", what: "This daemon replaced", examples: ["nouride update --start, --rollback"] },
  { class: "database", what: "The daemon's database read or written (it holds every agent's conversations)", examples: ["sqlite3 …/nouride.db", "nouride db restore|adopt"] },
  {
    class: "delete",
    what: "Deleted for good outside the workspace",
    examples: [
      "rm by absolute path, ~, glob or .. (rm -rf build/ in the workspace is not), anything rm'd over ssh",
      "dd, mkfs, shred, fdisk, parted",
      "docker volume rm, system prune, compose down -v; dropdb, redis-cli FLUSHALL",
      "find … -delete, crontab -r, apt purge, pacman -R",
    ],
  },
  { class: "teardown", what: "Infrastructure torn down (creating and changing are not)", examples: ["terraform|tofu|pulumi destroy", "kubectl delete, helm uninstall", "pct|qm destroy, lxc|incus delete"] },
  { class: "unattended", what: "A scheduled job created or changed that runs without asking", examples: ["nouride cron add|update|enable", "nouride webhook add|rotate"] },
  { class: "interactive", what: "An interactive session: what is typed into it is not a command any check sees", examples: ["session start …, session send …"] },
  { class: "force-push", what: "A remote's history rewritten (an ordinary push is not)", examples: ["git push --force|-f|--force-with-lease|--mirror", "git push origin +main, git push --delete …"] },
  {
    class: "unwatched",
    what: "Work nobody watches sending somewhere its job did not name, or what the second look held; asked under trusted too",
    examples: ["send_message to another chat from a scheduled job's run", "a send the second look found does not belong to the work"],
  },
  {
    class: "shared-tools",
    what: "A program installed or updated for every agent, as the daemon's user; asked under trusted too",
    examples: ["nouride tools run -- npm i -g …", "nouride tools run -- pipx install …"],
  },
  {
    class: "system-packages",
    what: "This machine's packages changed, as root, through nouride-pkg; answered in a chat by an admin only",
    examples: ["nouride pkg install|remove|upgrade …"],
  },
  {
    class: "persona",
    what: "An agent's own SOUL.md, IDENTITY.md or AGENTS.md changed, or the folders it takes skills from; asked under trusted too, and answered in a chat by an admin only",
    examples: ["persona, the one way an agent changes them", "skill_root, its request for a project's skills", "nouride agent skill-root add|rm"],
  },
  {
    class: "people",
    what: "Who People says a person is, changed (an admin is one); asked under trusted too, and answered in a chat by an admin only",
    examples: ["nouride people set|remove", "nouride access approve <code> --as <key>|--me"],
  },
];

/**
 * Where a command is *not* on the list, which is as much of the design as the list above.
 *
 * A gate that fires on routine work is one an operator learns to dismiss, so these are guarantees
 * rather than omissions. Under `careful` they still ask once, as any new command does.
 */
export const HARDLINE_EXEMPTIONS = [
  "Reading anything: ls, cat, grep -r, find without -delete, git status, docker ps, kubectl get",
  "Elevating: sudo, su, doas (what they run decides)",
  "Creating and changing: terraform apply, kubectl apply|scale, pct stop|start, apt install, systemctl restart",
  "The workspace's own work: rm -rf build/, git reset --hard, git clean -f, chmod -R",
  "Files under /tmp, /var/tmp or a `.scratchpad/`: rm -rf, find -delete, shred, over ssh too, but not /tmp itself and not a bare /tmp/*, which sweep what other processes are still using",
];

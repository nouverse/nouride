/**
 * A coding-CLI account signed in once, where it is added on the Models page, for a CLI whose sign-in is files in its
 * folder rather than a token it hands out (every built-in but Claude Code's): an agent is then put on the account, as
 * one is on a Claude Code account, and signs in nowhere itself. Before, each agent on such an account signed in on its
 * own Brain tab, and an account added on the page was a name with no sign-in.
 *
 * The CLI signs in as the daemon's user, in a HOME of the account's own under the data folder, which no agent reads:
 * what it wrote there is the account's sign-in, whatever the CLI names its files (Antigravity's are known only once one
 * has signed in). As an agent's CLI starts on the account they are written into the agent's folder, as the agent, over
 * what was there; after each of its turns, a file the CLI changed there (a token it refreshed) is copied back, so the
 * account holds the newest and the next CLI to start on it takes that. Two agents' CLIs running on one account at once
 * can still refresh a token under each other, which is why each signed in by itself before: narrowed to the time
 * between one's refresh and the other's next start, which restarts it with the newer one.
 */

import { dirname, ensureDir, fileExistsSync, join, listDir, readBytesSync, removePath, renamePath, runCommand, sha256Text, writeBytesSync } from "@nouride/runtime";
import { NourideError } from "@nouride/shared";
import type { CliRow } from "@nouride/acp";

/** A file past this is not a sign-in (a log, a cache): left where the CLI wrote it, and copied nowhere. */
const LARGEST = 64 * 1024;
/** A copy is a few small files: one that takes longer is stuck. */
const RUN_MS = 20_000;

export interface SignInFile {
  /** Under the sign-in's folder, `/` between its parts. */
  path: string;
  /** Its bytes, base64. */
  data: string;
}

/** The folder a CLI keeps its sign-in in, under a HOME: its profile folder where it is pointed at one, else the HOME. */
export function signInRoot(row: CliRow, home: string): string {
  return row.profileEnv ? join(home, "profile") : home;
}

/** Every file of a sign-in under `root`, small ones, but a starting file the agent's folder keeps its own of (`profileFiles`). */
export function signInFiles(row: CliRow, root: string): SignInFile[] {
  const own = new Set(Object.keys(row.profileFiles ?? {}));
  const out: SignInFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of listDir(dir)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A name the copy's lines could not carry; no CLI's sign-in has one.
      if (/[\t\n\r\\]/.test(path)) continue;
      if (entry.isDirectory) walk(join(dir, entry.name), path);
      else if (entry.isFile && !own.has(path)) {
        const bytes = readBytesSync(join(dir, entry.name));
        if (bytes.byteLength <= LARGEST) out.push({ path, data: Buffer.from(bytes).toString("base64") });
      }
    }
  };
  if (fileExistsSync(root)) walk(root, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Written as the agent, in its folder (`$1`): each line a path and its bytes, each file whole or not at all. */
const WRITE = `set -e
mkdir -p "$1"
cd "$1"
while IFS='	' read -r path data; do
  [ -n "$path" ] || continue
  mkdir -p "$(dirname -- "$path")"
  printf '%s' "$data" | base64 -d > "$path.nouride-in"
  chmod 600 "$path.nouride-in"
  mv -f -- "$path.nouride-in" "$path"
done`;

/** Read as the agent, in its folder (`$1`): each path named after it that is a file, with its bytes. */
const READ = `cd "$1" || exit 0
shift
for path; do
  [ -f "$path" ] && printf '%s\\t%s\\n' "$path" "$(base64 < "$path" | tr -d '\\n')"
done
exit 0`;

export class AccountSignIns {
  constructor(private readonly deps: { dir: () => string; run?: typeof runCommand }) {}

  /** The account's own HOME, where its CLI signed in. */
  home(cli: string, account: string): string {
    return join(this.deps.dir(), cli, account);
  }

  files(row: CliRow, account: string): SignInFile[] {
    return signInFiles(row, signInRoot(row, this.home(row.id, account)));
  }

  /** Whether the account was signed in here: its HOME holds what the sign-in wrote. */
  signedIn(row: CliRow, account: string): boolean {
    return this.files(row, account).length > 0;
  }

  /** What tells one sign-in of the account from the next: a CLI started with an older one is started again. Empty: none. */
  stamp(row: CliRow, account: string): string {
    const files = this.files(row, account);
    return files.length > 0 ? sha256Text(files.map((file) => `${file.path}\t${file.data}`).join("\n")) : "";
  }

  /**
   * The account's sign-in written into the agent's folder (`target`), as the agent, before its CLI starts: the paths
   * written, none where the account was not signed in here (the agent's own sign-in, from its Brain tab, is used then).
   */
  async copyIn(row: CliRow, account: string, agentId: string, target: string): Promise<string[]> {
    const files = this.files(row, account);
    if (files.length === 0) return [];
    const out = await (this.deps.run ?? runCommand)(["sh", "-c", WRITE, "nouride-sign-in", target], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: RUN_MS,
      maxOutputBytes: 4096,
      agent: agentId,
      stdin: files.map((file) => `${file.path}\t${file.data}\n`).join(""),
    });
    if (out.exitCode !== 0) {
      const why = out.stderr.trim() || (out.timedOut ? "it took too long" : `exit ${out.exitCode}`);
      throw new NourideError("external_agent", `${row.name}'s sign-in of the account ${account} could not be written into ${agentId}'s folder: ${why}`, `The account ${account}'s sign-in could not be given to this agent: ${why}`);
    }
    return files.map((file) => file.path);
  }

  /**
   * What the agent's CLI changed of the account's sign-in in its folder (a token it refreshed), kept as the account's,
   * each file whole: the paths changed. A file gone or emptied there is not taken back: the account keeps its own.
   */
  async copyBack(row: CliRow, account: string, agentId: string, target: string, paths: readonly string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const out = await (this.deps.run ?? runCommand)(["sh", "-c", READ, "nouride-sign-in", target, ...paths], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: RUN_MS,
      maxOutputBytes: paths.length * LARGEST * 2,
      agent: agentId,
    });
    if (out.exitCode !== 0) return [];
    const root = signInRoot(row, this.home(row.id, account));
    const kept = new Map(signInFiles(row, root).map((file) => [file.path, file.data]));
    const changed: string[] = [];
    for (const line of out.stdout.split("\n")) {
      const tab = line.indexOf("\t");
      const path = line.slice(0, tab);
      const data = line.slice(tab + 1);
      if (tab <= 0 || !data || !paths.includes(path) || kept.get(path) === data) continue;
      const to = join(root, path);
      ensureDir(dirname(to), 0o700);
      writeBytesSync(`${to}.nouride-in`, Buffer.from(data, "base64"), 0o600);
      renamePath(`${to}.nouride-in`, to);
      changed.push(path);
    }
    return changed;
  }

  /** The account's sign-in, gone with the account. */
  forget(cli: string, account: string): void {
    removePath(this.home(cli, account));
  }
}

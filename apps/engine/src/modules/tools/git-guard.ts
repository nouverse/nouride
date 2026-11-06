/**
 * A credential file is not committed or pushed by an agent's command (0.7.17).
 *
 * Before a command that runs `git add`, `git commit` or `git push` starts, what it would put into a commit or send is
 * read from git itself — what `add` would stage, what a `commit -a` takes, what is staged, and the commits a push would
 * send that no remote has — and a credential file among them (`credentialKind`: the files `read` hides values in, and
 * not a template such as `.env.example`) refuses the command, naming the file and the way that works.
 *
 * A check in the daemon rather than a hook in the repository: nothing is written into anybody's git setup, and it holds
 * at every approval level. What it does not see is git run inside a script the command starts; nor does it read what
 * other files say — a key pasted into source is the egress guard's and the reviewer's to catch, not a path's.
 */

import { runCommand } from "@nouride/runtime";
import { commandSegments, looseSegments } from "@nouride/policy";
import { credentialKind, pathFrom } from "@/modules/tools/credential-files.ts";

/** Runs git in a directory and says what it printed, or nothing when it could not — not a repository, no git. */
type GitRunner = (args: string[], cwd: string) => Promise<string | null>;

/**
 * Git's own, with the environment a command would have: nothing of the daemon's beyond what git needs to run.
 *
 * A directory that does not exist yet is nothing known, not an error: the check runs before the command, and
 * `git worktree add … && cd <it> && git commit` or `cd "$(mktemp -d)"` makes its directory first. Spawning git there
 * threw, and the whole command failed with "Something went wrong" (2026-10-23).
 */
const runGit: GitRunner = async (args, cwd) => {
  try {
    const result = await runCommand(["git", ...args], { cwd, timeoutMs: 5_000, maxOutputBytes: 1024 * 1024, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/" } });
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
};

/** Options git reads before its command, and whether each takes the next word. */
const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/**
 * One git invocation in a command: the directory it works in, its subcommand and that subcommand's words — and what
 * the command added to a `.gitignore` before it, since the check runs before anything does: `echo .env >> .gitignore
 * && git add -A` is the fix, not the leak.
 */
function gitCalls(argv: readonly string[], cwd: string): { dir: string; command: string; args: string[]; ignored: string[] }[] {
  const calls: { dir: string; command: string; args: string[]; ignored: string[] }[] = [];
  // Where each runs: `cd app && git add -A` is app's repository, as a shell would have it.
  let here = cwd;
  const ignored: string[] = [];
  for (const segment of commandSegments(argv) ?? looseSegments(argv)) {
    if ((segment[0] === "cd" || segment[0] === "pushd") && segment[1] && segment[1] !== "-") here = pathFrom(here, segment[1], process.env.HOME);
    if (segment.some((word) => /(^|\/)\.gitignore$/.test(word))) {
      ignored.push(...segment.slice(1).flatMap((word) => word.split(/\\n|\n/)).filter((word) => word && !/^(>>?|-\w+|tee)$/.test(word) && !/\.gitignore$/.test(word)));
    }
    if (segment[0]?.replace(/^.*\//, "") !== "git") continue;
    let dir = here;
    let at = 1;
    while (at < segment.length && segment[at]!.startsWith("-")) {
      const word = segment[at]!;
      if (word === "-C" && segment[at + 1]) dir = pathFrom(dir, segment[at + 1]!, process.env.HOME);
      at += GLOBAL_WITH_VALUE.has(word) ? 2 : 1;
    }
    if (segment[at]) calls.push({ dir, command: segment[at]!, args: segment.slice(at + 1), ignored: [...ignored] });
  }
  return calls;
}

const isCredential = (path: string) => {
  const kind = credentialKind(path);
  return kind === "env" || kind === "credential";
};

/** `git status -z`'s paths, with the two of a rename: what is new or changed, tracked or not, minus what is ignored. */
function statusPaths(output: string): { path: string; tracked: boolean }[] {
  const entries = output.split("\0").filter(Boolean);
  const paths: { path: string; tracked: boolean }[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    paths.push({ path: entry.slice(3), tracked: !entry.startsWith("??") });
    // A rename's old name follows as an entry of its own.
    if (entry[0] === "R" || entry[0] === "C") i += 1;
  }
  return paths;
}

/** Why this command may not run — the credential file it would commit or send — or null. */
export async function gitGuard(argv: readonly string[], cwd: string, run: GitRunner = runGit): Promise<string | null> {
  for (const call of gitCalls(argv, cwd)) {
    if (call.command === "add") {
      // Its words are paths: one that names a credential file is refused before git is asked anything.
      const words = call.args.filter((arg) => !arg.startsWith("-"));
      const named = words.find((word) => isCredential(word));
      if (named) return refusal(named, "`git add` would stage it");
      const updateOnly = call.args.some((arg) => arg === "-u" || arg === "--update");
      const broad = updateOnly || words.some((word) => [".", ":/", "*"].includes(word)) || call.args.some((arg) => arg === "-A" || arg === "--all");
      const status = await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], call.dir);
      const found = statusPaths(status ?? "").find(
        ({ path, tracked }) =>
          isCredential(path) &&
          (tracked || !ignoredBy(path, call.ignored)) &&
          (!updateOnly || tracked) &&
          (broad || words.some((word) => path === word || path.startsWith(`${word.replace(/\/+$/, "")}/`))),
      );
      if (found) return refusal(found.path, "`git add` would stage it");
    }

    if (call.command === "commit") {
      // Not its words: a message saying "ignore .env" is not a path.
      const everything = call.args.some((arg) => arg === "--all" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(arg));
      const staged = (await run(["diff", "--cached", "--name-only", "-z"], call.dir)) ?? "";
      const changed = everything ? statusPaths((await run(["status", "--porcelain=v1", "-z"], call.dir)) ?? "").filter((entry) => entry.tracked).map((entry) => entry.path) : [];
      const found = [...staged.split("\0"), ...changed].find((path) => path && isCredential(path));
      if (found) return refusal(found, "`git commit` would commit it");
    }

    if (call.command === "push") {
      // What a push sends that is not on any remote yet — commits made a moment ago, by this command or an earlier one.
      const sent = (await run(["log", "--name-only", "--format=", "-z", "HEAD", "--not", "--remotes"], call.dir)) ?? "";
      const found = sent.split(/[\0\n]/).find((path) => path && isCredential(path));
      if (found) return pushRefusal(found);
    }
  }
  return null;
}

/** Whether a pattern the command added to `.gitignore` covers an untracked path: a bare name anywhere, a path as written. */
function ignoredBy(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const bare = pattern.replace(/^\/+|\/+$/g, "");
    return bare.includes("/") ? path === bare || path.startsWith(`${bare}/`) : path.split("/").includes(bare);
  });
}

function refusal(path: string, how: string): string {
  return (
    `${how}: \`${path}\` holds credentials, and a commit keeps them in the repository's history for good. ` +
    `Add it to .gitignore before the add (\`echo '${path}' >> .gitignore && git add -A\`), or stage the files you mean by name. If it truly belongs in the repository, the person commits it themselves`
  );
}

function pushRefusal(path: string): string {
  return (
    `the commits this push would send include \`${path}\`, which holds credentials: once pushed, it is in the remote's history. ` +
    `Take it out of those commits first (\`git rm --cached '${path}'\`, add it to .gitignore, and amend or squash the commit that added it), or ask the person`
  );
}

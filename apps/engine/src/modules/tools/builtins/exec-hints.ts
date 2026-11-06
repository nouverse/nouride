/**
 * One line at the exact error where agents used to start improvising.
 *
 * The install steps in the prompt are read once and then the conversation moves on. What an agent
 * actually reacts to is the error in front of it, and each of these errors has one right answer that
 * the error itself does not give: `externally-managed-environment` does not say a venv is already on
 * PATH, `sudo: command not found` does not say there is a door for system packages, `Exec format error`
 * reads like a corrupt download. Without the line, the next call was `--break-system-packages`, a
 * scratchpad venv, or a parser written from memory.
 *
 * Matched on the tail of a command's output — where the error is — by the error's own wording, not by
 * the exit code. Agents capture a status with `; echo "EXIT:$?"`, which makes the command as a whole
 * succeed: on the live box `sudo true 2>&1; echo "EXIT:$?"` exited 0 and the hint, keyed on failure,
 * never showed. Every pattern here is something a tool prints when it fails, and seeing one in a
 * passing command means the failure was swallowed, not that it did not happen. One hint at most, the
 * most specific first: a missing glibc also exits 127, and the useful sentence is about the C library,
 * not about installing something that is already there.
 */

import { agentCommandsHaveOwnUsers, dirname } from "@nouride/runtime";
import { pythonEnvDir } from "@/modules/toolchain/env.ts";
import { describeHost } from "@/modules/toolchain/facts.ts";
import { pythonEnvState } from "@/modules/toolchain/python.ts";

const TAIL_CHARS = 4096;

/** Where installs land: `$NOURIDE_BIN` is the agent's own bin where it is its own user (`ownUserEnv`), and its Python env too. */
const noInstallWall = () =>
  "Global installs need no root here: `npm i -g`, `bun add -g`, `pipx install`, `go install` and `cargo install` land in $NOURIDE_BIN, and `pip install` in " +
  (agentCommandsHaveOwnUsers() ? "your own Python env." : "the shared Python env.");

const RULES: { when: (tail: string, exitCode: number | null) => boolean; say: () => string }[] = [
  {
    when: (tail) => tail.includes("externally-managed-environment"),
    say: () => {
      const env = pythonEnvState();
      if (env?.state === "ready") {
        const whose = agentCommandsHaveOwnUsers() ? "your own env's, with what is installed for every agent importable too" : "the shared env's";
        return `That is the system's own Python, which refuses pip (PEP 668). The \`python3\` and \`pip\` on your PATH are ${whose}: plain \`pip install <pkg>\` works there, no flags. Never \`--break-system-packages\`.`;
      }
      const dir = process.env.NOURIDE_BIN ? pythonEnvDir(dirname(process.env.NOURIDE_BIN)) : "<the install>/.nouride/opt/python";
      const missing = env?.state === "failed" && env.why.includes("python3-venv") ? "First `nouride pkg install python3-venv` (or ask the operator for it), then " : "";
      return `That is the system's own Python, which refuses pip (PEP 668), and the shared env is not built yet. ${missing}\`python3 -m venv --system-site-packages ${dir}\` builds it (it is already on your PATH), and \`pip install <pkg>\` works from then on. Never \`--break-system-packages\`, never a venv in the scratchpad.`;
    },
  },
  {
    when: (tail) => /GLIBC_\d|required file not found|ld-linux[\w.-]*: No such file|ld-musl/.test(tail),
    say: () => `Built for another C library, or a newer glibc than this host has. This host is ${describeHost()}: take the static or musl build of the same release.`,
  },
  {
    when: (tail) => /Exec format error|cannot execute binary file/.test(tail),
    say: () => `Built for another architecture. This host is ${describeHost()}: download that build.`,
  },
  {
    when: (tail) => /sudo: (command )?not found|sudo: .*(no new privileges|password is required|not in the sudoers|effective uid is not 0)|sudo: unable to/.test(tail),
    say: () =>
      `There is no sudo here, by design. ${noInstallWall()} A system package goes through \`nouride pkg install <pkg>\` where this box allows it; otherwise name it for the operator.`,
  },
  {
    when: (tail) => /ERR_PNPM_NO_GLOBAL_BIN_DIR|Unable to find the global bin directory/.test(tail),
    say: () => "pnpm has no global bin directory here: `npm i -g <pkg>` installs the same package into $NOURIDE_BIN.",
  },
  {
    when: (tail) => /linker [`'"]?cc[`'"]? not found|\b(gcc|cc|x86_64-linux-gnu-gcc): (command )?not found|command '(x86_64-linux-gnu-)?gcc' failed|unable to execute '(x86_64-linux-gnu-)?gcc'/.test(tail),
    say: () => "There is no C compiler here. `nouride pkg install build-essential` where this box allows system packages; otherwise use a prebuilt binary or wheel.",
  },
  {
    when: (tail) => /\b(EACCES|EROFS|Permission denied|Read-only file system)\b/.test(tail) && /\s'?\/usr\//.test(tail),
    say: () => `/usr is the system's, and read-only to you. ${noInstallWall()} Never \`sudo\` or \`--prefix /usr/local\`.`,
  },
  {
    // SIGTERM, which leaves no words to match. A Nouride user's agent ran `pkill -f '<its daemon>'; sleep 3; echo …`
    // and got "exit code 143" and nothing else, again and again: the pattern was in the command's own line, so `pkill`
    // stopped the shell running it, and the agent concluded every command's output was being cut (0.8.6).
    when: (_tail, exitCode) => exitCode === 143,
    say: () =>
      "Exit 143 is SIGTERM: something stopped this command's shell. A `pkill -f` or `killall` whose pattern is in this " +
      "command's own line stops the shell running it, and nothing after it runs. Match with a pattern the line does not " +
      "contain (`pkill -f '[c]ctv-daemon'`), or find the pid with `pgrep -f` and kill that.",
  },
  {
    // The shell's own report of a missing program — `bash: line 1: rg: command not found` — or exit 127.
    when: (tail, exitCode) =>
      exitCode === 127 || /(^|\n)\S*\b(ba|da|z)?sh: ((line )?\d+: )?[^\s:]+: (command )?not found|Executable not found in \$PATH/.test(tail),
    say: () =>
      "Not installed. What is in $NOURIDE_BIN is listed under TOOLS; anything else, install it as the install steps there say rather than writing a replacement.",
  },
];

/** The hint for a command's output, or null. */
export function execHint(output: string, exitCode: number | null): string | null {
  const tail = output.slice(-TAIL_CHARS);
  const rule = RULES.find((candidate) => candidate.when(tail, exitCode));
  return rule ? `[hint] ${rule.say()}` : null;
}

/**
 * What an agent is told when the kernel stopped the agents' commands for memory while one ran (0.7.19). The exit cannot
 * say so: a pipeline's code is its last command's, and on the live box `head | tail | wc -c` with `tail` killed came
 * back "exit 0, output 0" — which the agent reported as the command having worked.
 */
export function oomKillNote(kills: number): string {
  const what = kills === 1 ? "a process" : `${kills} processes`;
  return (
    `[while this ran, the kernel stopped ${what} of the agents' commands for memory: together they may use only so ` +
    "much, so the daemon keeps answering (`nouride doctor` says how much). Treat the output as cut short whatever the " +
    "exit code says, and run less at once.]"
  );
}

/**
 * Interactive processes, and the quoting that a terminal costs.
 *
 * Getting a real pty without a native module means `script(1)`, whose `-c` takes a **command string** —
 * so an argv array has to be rendered back into shell syntax. That is the exact conversion this
 * codebase refuses to do everywhere else, and the reason it refuses is that getting it wrong turns an
 * argument into syntax. So the quoting gets the hostile cases, one by one.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  shellQuote,
  spawnInteractive,
  withBackgroundPriority,
  withLimits,
} from "../src/process.ts";
import { terminalCommand } from "../src/process-terminal.ts";
import { eventually } from "./wait.ts";

/** Where a terminal can be had: `script(1)` on Linux and on macOS, each its own way (`process-terminal.ts`). */
const linux = process.platform === "linux";
const terminal = linux || process.platform === "darwin";

/** Read until the expected text arrives or the budget runs out — then the caller's `expect` says what did arrive. */
async function drainUntil(
  proc: ReturnType<typeof spawnInteractive>,
  wanted: string,
  budgetMs = 4000,
): Promise<string> {
  let out = "";
  await eventually(() => (out += proc.drain()).includes(wanted), budgetMs).catch(() => {});
  return out;
}

describe("shellQuote", () => {
  test("wraps every argument so nothing inside can be syntax", () => {
    expect(shellQuote(["ls", "-la"])).toBe("'ls' '-la'");
  });

  test("neutralises everything a shell would otherwise act on", () => {
    // None of these may survive as syntax: inside single quotes a shell treats every character
    // literally, which is the whole reason this is the chosen quoting and not escaping per character.
    for (const hostile of ["$HOME", "`id`", "a; rm -rf /", "a && b", "a | b", "$(whoami)", "*", "\n"]) {
      const quoted = shellQuote(["echo", hostile]);
      expect(quoted.startsWith("'echo' '")).toBe(true);
      expect(quoted.endsWith("'")).toBe(true);
    }
  });

  test("a single quote is closed, escaped and reopened", () => {
    // The one character single quotes cannot contain. `it's` becomes `'it'\''s'`.
    expect(shellQuote(["it's"])).toBe(`'it'\\''s'`);
  });

  test("an empty argument survives as an empty argument", () => {
    // `''` is a real argument; dropping it would shift everything after it by one position.
    expect(shellQuote(["a", "", "b"])).toBe("'a' '' 'b'");
  });
});

describe("the terminal command", () => {
  test.skipIf(!existsSync("/usr/bin/script") && !existsSync("/bin/script"))("on Linux is util-linux script with the argv quoted into its -c", () => {
    expect(terminalCommand(["printf", "%s", "a b"], "linux")?.slice(1)).toEqual(["-qec", "'printf' '%s' 'a b'", "/dev/null"]);
  });

  test("on a Mac is BSD script, fed a pipe by cat, with the argv passed as argv — nothing quoted into a string", () => {
    // BSD script takes no -c, and dies on the socket Bun gives a child for stdin: bash hands it a pipe(2) instead.
    const cmd = terminalCommand(["printf", "%s", "$HOME `id`"], "darwin");
    expect(cmd).toEqual(["/bin/bash", "-c", 'exec /usr/bin/script -q /dev/null "$@" < <(exec cat)', "nouride-session", "printf", "%s", "$HOME `id`"]);
  });

  test("elsewhere is none, and the session runs on pipes", () => {
    expect(terminalCommand(["sh"], "win32")).toBeNull();
  });
});

describe("spawnInteractive", () => {
  test("reports honestly whether it got a terminal", () => {
    const proc = spawnInteractive(["cat"]);
    try {
      expect(proc.tty).toBe(terminal);
    } finally {
      proc.kill();
    }
  });

  test("pipes are still available when a terminal is declined", async () => {
    const proc = spawnInteractive(["cat"], { tty: false });
    try {
      expect(proc.tty).toBe(false);
      proc.write("hello\n");
      expect(await drainUntil(proc, "hello")).toContain("hello");
    } finally {
      proc.kill();
    }
  });

  test.skipIf(!terminal)("a terminal is a terminal, and isatty agrees", async () => {
    // The property the whole exercise is for: a child that checks `isatty` must see one, or
    // `kubectl exec -it` and everything like it stays broken.
    const proc = spawnInteractive(["sh", "-c", "test -t 0 && echo HAS_TTY || echo NO_TTY"]);
    try {
      expect(await drainUntil(proc, "TTY")).toContain("HAS_TTY");
    } finally {
      proc.kill();
    }
  });

  test.skipIf(!terminal)("a REPL on it answers what is typed, on a terminal of its own", async () => {
    // What a session is for: `sh -i` reading from the terminal, a line typed at it, the answer read back.
    const proc = spawnInteractive(["sh", "-i"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PS1: "$ " } });
    try {
      proc.write("tty; echo answer-$((6*7))\n");
      const out = await drainUntil(proc, "answer-42");
      expect(out).toContain("answer-42");
      expect(out).toMatch(/\/dev\/(pts\/\d+|ttys\d+)/);
    } finally {
      // The session tool's close: the default signal, which an interactive shell ignores — the hangup is what ends it.
      proc.kill();
    }
    await eventually(() => !proc.running(), 3_000, "the session to end").catch(() => {});
    const running = proc.running();
    if (running) process.kill(proc.pid, "SIGKILL");
    expect(running).toBe(false);

  });

  test.skipIf(process.platform !== "darwin")("closing a session on a Mac ends what it started", async () => {
    // Killing the session kills `script`, whose terminal hangs up on what runs on it: a background child of a script
    // goes with it. (`script(1)` on Linux is unchanged, and not what this is about.)
    const proc = spawnInteractive(["sh", "-c", "sleep 313.517 & echo started; wait"]);
    try {
      expect(await drainUntil(proc, "started")).toContain("started");
    } finally {
      proc.kill("SIGKILL");
    }
    await proc.exited;
    const left = () => spawnSync("pgrep", ["-f", "^sleep 313.517$"], { encoding: "utf8" }).stdout.trim();
    await eventually(() => left() === "", 3_000, "the sleep it started to be gone").catch(() => {});
    const pids = left();
    for (const pid of pids.split("\n").filter(Boolean)) spawnSync("kill", ["-9", pid]);
    expect(pids).toBe("");
  });

  test.skipIf(!terminal)("arguments reach the child verbatim through the quoting", async () => {
    // The risk the quoting exists for, tested end to end rather than on the string alone: if any of
    // this were expanded by the shell `script` runs, it would come back changed.
    const hostile = "$HOME `id` a; b && c | d '\"quoted\"'";
    const proc = spawnInteractive(["printf", "%s", hostile]);
    try {
      const out = await drainUntil(proc, "quoted");
      expect(out).toContain("$HOME");
      expect(out).toContain("`id`");
      expect(out).toContain("a; b && c | d");
    } finally {
      proc.kill();
    }
  });

  test("a runaway process cannot fill memory", async () => {
    const proc = spawnInteractive(["sh", "-c", "yes hello"], { maxBufferBytes: 4096 });
    try {
      // One drain at a time, each on its own, until one of them has had to drop something.
      let out = "";
      await eventually(() => (out = proc.drain()).includes("earlier output dropped"), 4_000, "a drain past the ceiling");
      // Bounded, and it says it dropped something rather than presenting a gap as the whole output.
      expect(out.length).toBeLessThan(8192);
      expect(out).toContain("earlier output dropped");
    } finally {
      proc.kill();
    }
  });

  test("drain clears, so the same output is never read twice", async () => {
    const proc = spawnInteractive(["cat"], { tty: false });
    try {
      proc.write("once\n");
      expect(await drainUntil(proc, "once")).toContain("once");
      // Drained again only once something new has come: had the first drain not cleared, "once" would come with it.
      proc.write("twice\n");
      expect(await drainUntil(proc, "twice")).not.toContain("once");
    } finally {
      proc.kill();
    }
  });
});

describe("resource limits", () => {
  test("no limits leaves the command untouched", () => {
    // Every command that asks for nothing must run exactly as written — wrapping unconditionally
    // would put `prlimit` in the audit log of every call and change the argv a grant is keyed on.
    expect(withLimits(["ls", "-la"], undefined)).toEqual(["ls", "-la"]);
    expect(withLimits(["ls"], { memoryMb: 0, cpuSeconds: 0 })).toEqual(["ls"]);
  });

  test.skipIf(!linux)("a limit wraps the command as arguments, with no shell", () => {
    const wrapped = withLimits(["sh", "-c", "echo hi"], { memoryMb: 100, cpuSeconds: 5 });

    expect(wrapped[0]).toContain("prlimit");
    expect(wrapped).toContain("--as=104857600");
    expect(wrapped).toContain("--cpu=5");
    // `--` then the original argv, unchanged: no joining, no quoting, nothing to inject through.
    expect(wrapped.slice(wrapped.indexOf("--") + 1)).toEqual(["sh", "-c", "echo hi"]);
  });

  test.skipIf(!linux)("the kernel actually enforces it", async () => {
    // The point of doing this at all. A process that allocates past the ceiling is killed by the
    // kernel rather than trusted to stop, which is what the timeout cannot do.
    const { runCommand } = await import("../src/process.ts");
    const result = await runCommand(
      /**
       * `dd` with a 128MB block size under a 64MB ceiling, because `dd` mallocs its buffer up front.
       *
       * It was `head -c 200000000 /dev/zero | tail -c 1`, which allocates nothing at all — both
       * stream, and neither holds more than a few KB. The test asserted enforcement and proved only
       * that two tiny programs can move 200MB through a pipe. It never ran on the machine it was
       * written on (`skipIf(!linux)`) and CI was red for other reasons, so nothing caught it.
       */
      ["dd", "if=/dev/zero", "of=/dev/null", "bs=128M", "count=1"],
      {
        cwd: "/tmp",
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
        env: { PATH: "/usr/bin:/bin" },
        limits: { memoryMb: 64 },
      },
    );
    expect(result.exitCode).not.toBe(0);
  });

  test.skipIf(linux)("a platform without prlimit runs unlimited rather than failing", () => {
    // Reported at boot rather than pretending the setting applied — but the command still runs.
    expect(withLimits(["ls"], { memoryMb: 100 })).toEqual(["ls"]);
  });
});

describe("runCommand cancellation", () => {
  test("kills the child when the caller aborts", async () => {
    const { runCommand } = await import("../src/process.ts");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const result = await runCommand(["sh", "-c", "sleep 10"], {
      cwd: "/tmp",
      timeoutMs: 10_000,
      maxOutputBytes: 4096,
      env: { PATH: "/usr/bin:/bin" },
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeLessThan(5000);
  });
});

describe("background priority", () => {
  test("a spawned command runs below the daemon that started it", () => {
    const wrapped = withBackgroundPriority(["bun", "test"]);
    // On a machine without `nice` the command comes back untouched — a missing utility is not worth
    // failing a turn over.
    if (wrapped[0] === "bun") {
      expect(wrapped).toEqual(["bun", "test"]);
      return;
    }
    expect(wrapped[0]).toMatch(/\/nice$/);
    // No `--` after nice: BusyBox's `nice` (the Docker image) runs it as the program — "can't execute '--'" —
    // which failed every `exec` in a container. `choom`, util-linux's, takes one, and is absent from BusyBox.
    const choom = wrapped[3]?.endsWith("/choom") ? [wrapped[3], "-n", "500", "--"] : [];
    expect(wrapped.slice(1)).toEqual(["-n", "10", ...choom, "bun", "test"]);
  });

  // Skipped, not passed, where there is nothing to assert: these returned early and reported green on every Mac.
  const scored = withBackgroundPriority(["cat", "/proc/self/oom_score_adj"]);
  // From the filesystem, not from `scored`: a guard read off the code under test skips the test when that code breaks.
  const installed = (...paths: string[]) => paths.some((path) => existsSync(path));
  const hasChoom = process.platform === "linux" && installed("/usr/bin/choom", "/bin/choom") && installed("/usr/bin/nice", "/bin/nice");
  test.skipIf(!hasChoom)("and is what the OOM killer reaches for before the daemon (E8)", () => {
    const [program, ...args] = scored;
    const out = spawnSync(program!, args, { encoding: "utf8" });
    expect(out.stdout.trim()).toBe("500");
  });

  test("and the wrapped command actually runs", async () => {
    const [program, ...args] = withBackgroundPriority(["echo", "ran"]);
    const out = spawnSync(program!, args, { encoding: "utf8" });
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe("ran");
  });

  const limited = withLimits(withBackgroundPriority(["sh", "-c", "echo hi"]), { memoryMb: 100, cpuSeconds: 5 });
  test.skipIf(process.platform !== "linux" || !installed("/usr/bin/prlimit", "/bin/prlimit") || !installed("/usr/bin/nice", "/bin/nice"))("nice wraps inside prlimit, not outside it", () => {
    // `prlimit` has to be the outermost program or its own accounting is what gets capped.
    const cmd = limited;
    const nice = cmd.findIndex((part) => part.endsWith("/nice"));
    // prlimit first, its `--` next, then nice, then the command.
    expect(cmd.indexOf("--")).toBeLessThan(nice);
  });
});

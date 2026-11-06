/**
 * The process adapter's decisions one by one — written for the mutation sweep (tests-unreviewed-areas-mutation),
 * which ran these on Linux (glibc, and musl without util-linux) and on macOS, since most of what is decided here is
 * decided by what the host has.
 *
 * Where a test expects a wrapper (`nice`, `choom`, `prlimit`, `script`), the expectation comes from the filesystem,
 * never from the code under test: a guard computed by the function it guards turns a broken function into a skipped
 * test, which is how the `choom` test in interactive.test.ts went on passing with `findChoom` deleted.
 */

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBackgroundCommand } from "../src/process-background.ts";
import { processGroupActivity } from "../src/process-activity.ts";
import { forward, readCapped } from "../src/process-output.ts";
import { withOwnProcessGroup } from "../src/process-group.ts";
import { systemProgram, withBinFirst } from "../src/process-shell.ts";
import {
  availableMemoryBytes,
  isRoot,
  canElevate,
  processCommandLine,
  processMemory,
  resourceLimitsAvailable,
  runCommand,
  signalProcess,
  spawnInteractive,
  spawnLongLived,
  totalMemoryBytes,
  whichBinary,
  withBackgroundPriority,
  withLimits,
} from "../src/process.ts";
import { eventually, sleep } from "./wait.ts";

const linux = process.platform === "linux";
const firstOf = (paths: string[]) => paths.find((path) => existsSync(path)) ?? null;
const PRLIMIT = linux ? firstOf(["/usr/bin/prlimit", "/bin/prlimit"]) : null;
const SCRIPT = linux ? firstOf(["/usr/bin/script", "/bin/script"]) : null;
const CHOOM = linux ? firstOf(["/usr/bin/choom", "/bin/choom"]) : null;
const NICE = linux || process.platform === "darwin" ? firstOf(["/usr/bin/nice", "/bin/nice"]) : null;
const MODULE = join(import.meta.dir, "../src/process.ts");

const dir = mkdtempSync(join(tmpdir(), "nouride-process-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sandbox = { cwd: dir, timeoutMs: 10_000, maxOutputBytes: 4096, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } };

async function collect(lines: AsyncIterableIterator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

/** What an interactive process prints, drained as it comes until `enough` holds of all of it. */
async function drainUntil(proc: ReturnType<typeof spawnInteractive>, enough: (out: string) => boolean): Promise<string> {
  let out = "";
  await eventually(() => enough((out += proc.drain())), 2_000, "its output");
  return out;
}

/**
 * How many bytes the adapter has decoded into its buffer: what a test waits on before draining once, when the output is
 * too long to arrive in one read. A drain empties what the ceiling counts, so draining as it came would never fill it.
 */
function decodedBytes() {
  const decode = spyOn(TextDecoder.prototype, "decode");
  return {
    total: () => decode.mock.calls.reduce((sum, [input]) => sum + ((input as { byteLength: number } | undefined)?.byteLength ?? 0), 0),
    restore: () => decode.mockRestore(),
  };
}

/** A Bun child running `source` with this repo's process module importable; its stdout, stderr and status. */
function bunChild(source: string, input?: string) {
  const run = spawnSync(process.execPath, ["-e", source], { encoding: "utf8", timeout: 20_000, ...(input !== undefined ? { input } : {}) });
  return { stdout: run.stdout.trim(), status: run.status, signal: run.signal };
}

describe("a long-lived process speaks in lines", () => {
  test("an empty command is refused; one word is a command", async () => {
    expect(() => spawnLongLived([])).toThrow("spawnLongLived: empty command");
    const one = spawnLongLived(["true"]);
    expect(await one.exited).toBe(0);
  });

  test("blank lines are skipped, a line's trailing space and CR come off, and a last line with no newline still counts", async () => {
    const proc = spawnLongLived(["printf", "\\na \\n\\n  \\r\\n  b\\r\\nc"]);
    expect(await collect(proc.lines())).toEqual(["a", "  b", "c"]);
  });

  test("a character split across two writes is one character", async () => {
    const proc = spawnLongLived([
      process.execPath,
      "-e",
      "process.stdout.write(Buffer.from([0x68, 0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9, 0x0a, 0x6f, 0x6b, 0x0a])), 100);",
    ]);
    expect(await collect(proc.lines())).toEqual(["hé", "ok"]);
  });

  test("what is written reaches it, a line at a time, and its stderr is a stream of its own", async () => {
    const proc = spawnLongLived(["sh", "-c", "read line; echo \"got $line\"; echo oops >&2"]);
    proc.writeLine("ping");
    expect(await collect(proc.lines())).toEqual(["got ping"]);
    expect(await collect(proc.stderrLines())).toEqual(["oops"]);
  });
});

describe("runCommand", () => {
  test("an empty command is refused", async () => {
    await expect(runCommand([], sandbox)).rejects.toThrow("runCommand: empty command");
  });

  test("a signal that never fires changes nothing", async () => {
    const result = await runCommand(["echo", "ran"], { ...sandbox, signal: new AbortController().signal });
    expect(result).toMatchObject({ stdout: "ran\n", exitCode: 0, aborted: false, timedOut: false });
  });

  test("a signal already fired kills at once", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runCommand(["sleep", "30"], { ...sandbox, signal: controller.signal });
    expect(result).toMatchObject({ aborted: true, exitCode: null });
    expect(result.durationMs).toBeLessThan(5_000);
  });

  test("the timeout kills a command that ignores SIGTERM", async () => {
    const result = await runCommand(["sh", "-c", "trap '' TERM; sleep 30"], { ...sandbox, timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  test("forwarded output says which stream it came from", async () => {
    const seen: [string, string][] = [];
    await runCommand(["sh", "-c", "echo out; echo err >&2"], { ...sandbox, onOutput: (stream, text) => seen.push([stream, text]) });
    expect(seen.sort()).toEqual([
      ["stderr", "err\n"],
      ["stdout", "out\n"],
    ]);
  });

  test("how long it had been quiet counts from its last output, not from its start", async () => {
    const result = await runCommand(["sh", "-c", "sleep 1; echo x; sleep 30"], { ...sandbox, timeoutMs: 2_500, onOutput: () => {} });
    expect(result.timedOut).toBe(true);
    expect(result.activity!.quietForMs).toBeLessThan(2_200);
  });

  test.skipIf(!linux)("a signal fired after the command finished signals nothing", async () => {
    const controller = new AbortController();
    await runCommand(["true"], { ...sandbox, signal: controller.signal });
    const kill = spyOn(process, "kill");
    try {
      controller.abort();
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});

describe("an interactive process", () => {
  test("an empty command is refused", () => {
    expect(() => spawnInteractive([])).toThrow("spawnInteractive: empty command");
  });

  test("it has a terminal exactly where script(1) is installed on Linux, and always on macOS (BSD script, which every Mac has)", async () => {
    const proc = spawnInteractive(["true"]);
    expect(proc.tty).toBe(SCRIPT !== null || process.platform === "darwin");
    await proc.exited;
  });

  test("is running until it exits", async () => {
    const proc = spawnInteractive(["sleep", "0.5"], { tty: false });
    expect(proc.running()).toBe(true);
    await proc.exited;
    await eventually(() => !proc.running(), 1_000, "running() to say it has exited");
  });

  test("a character split across two writes is one character", async () => {
    const proc = spawnInteractive(
      [process.execPath, "-e", "process.stdout.write(Buffer.from([0x68, 0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 100);"],
      { tty: false },
    );
    await proc.exited;
    expect(await drainUntil(proc, (out) => out.length >= 2)).toBe("hé");
  });

  test("stderr is read with stdout", async () => {
    const proc = spawnInteractive(["sh", "-c", "echo err >&2"], { tty: false });
    await proc.exited;
    expect(await drainUntil(proc, (out) => out.endsWith("\n"))).toBe("err\n");
  });

  test("output exactly at the ceiling is kept whole; past it, the newest is kept and the drop is said once", async () => {
    // Each `printf` is one write, so what it prints arrives in one read: the ceiling sees all of it at once.
    const exact = spawnInteractive(["printf", "abcdef"], { tty: false, maxBufferBytes: 6 });
    await exact.exited;
    expect(await drainUntil(exact, (out) => out.length >= 6)).toBe("abcdef");

    // The command paces itself: its first write is drained as soon as it arrives, long before the second.
    const over = spawnInteractive(["sh", "-c", "printf abcdef; sleep 0.4; printf gh"], { tty: false, maxBufferBytes: 4 });
    expect(await drainUntil(over, (out) => out !== "")).toBe("[earlier output dropped]\ncdef");
    await over.exited;
    expect(await drainUntil(over, (out) => out.length >= 2)).toBe("gh");
  });

  test("the default ceiling is 256 KiB", async () => {
    for (const [bytes, dropped] of [[262_144, false], [262_145, true]] as const) {
      const decoded = decodedBytes();
      try {
        const proc = spawnInteractive(["sh", "-c", `head -c ${bytes} /dev/zero | tr '\\0' a`], { tty: false });
        await eventually(() => decoded.total() >= bytes, 4_000, `all ${bytes} bytes to be read`);
        expect(proc.drain().startsWith("[earlier output dropped]")).toBe(dropped);
        await proc.exited;
      } finally {
        decoded.restore();
      }
    }
  });
});

describe("resource limits", () => {
  test("are available exactly where prlimit is installed", () => {
    expect(resourceLimitsAvailable()).toBe(PRLIMIT !== null);
  });

  test.skipIf(PRLIMIT !== null)("without prlimit a limit leaves the command as it is", () => {
    expect(withLimits(["ls"], { memoryMb: 100, cpuSeconds: 5 })).toEqual(["ls"]);
  });

  test.skipIf(PRLIMIT === null)("each ceiling is asked for only when it is set, from its smallest value", () => {
    expect(withLimits(["ls"], { memoryMb: 64 })).toEqual([PRLIMIT!, "--as=67108864", "--", "ls"]);
    expect(withLimits(["ls"], { cpuSeconds: 5 })).toEqual([PRLIMIT!, "--cpu=5", "--", "ls"]);
    expect(withLimits(["ls"], { memoryMb: 1, cpuSeconds: 0 })).toEqual([PRLIMIT!, "--as=1048576", "--", "ls"]);
    expect(withLimits(["ls"], { memoryMb: 0, cpuSeconds: 1 })).toEqual([PRLIMIT!, "--cpu=1", "--", "ls"]);
  });
});

describe("background priority", () => {
  test("nice where nice is installed, and choom inside it where choom is", () => {
    const choom = CHOOM ? [CHOOM, "-n", "500", "--"] : [];
    expect(withBackgroundPriority(["cmd"])).toEqual(NICE ? [NICE, "-n", "10", ...choom, "cmd"] : [...choom, "cmd"]);
  });
});

describe("what the host is asked", () => {
  test("a command line is read for a live process, and nothing for a pid that is not one", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    try {
      // Read once the child has run `sleep`: between its fork and its exec, Linux's /proc/<pid>/cmdline is still the
      // parent's — which is what CI read on 2026-10-17, `bun test …` where `sleep 30` was expected.
      await eventually(() => processCommandLine(child.pid) !== processCommandLine(process.pid), 4_000, "the child to exec");
      expect(processCommandLine(child.pid)).toBe("sleep 30");
      expect(processCommandLine(process.pid)).toContain("bun");
      expect(processCommandLine(1)).not.toBeNull();
      for (const pid of [0, -5, 1.5]) expect(processCommandLine(pid)).toBeNull();
    } finally {
      child.kill();
    }
  });

  test("a signal is delivered to a live process, and says false for one that is not there", async () => {
    const child = Bun.spawn(["sleep", "30"]);
    expect(signalProcess(child.pid, "SIGTERM")).toBe(true);
    await child.exited;
    expect(signalProcess(2_147_483_000, "SIGTERM")).toBe(false);
  });

  test("a binary is found by name only — never by a path", () => {
    const bin = mkdtempSync(join(dir, "bin-"));
    writeFileSync(join(bin, "2fa"), "#!/bin/sh\n");
    chmodSync(join(bin, "2fa"), 0o755);
    expect(whichBinary("2fa", bin)).toBe(join(bin, "2fa"));
    expect(whichBinary("/bin/sh")).toBeNull();
    expect(whichBinary("../sh", "/bin")).toBeNull();
  });

  test("root is uid 0", () => {
    expect(isRoot()).toBe(process.getuid?.() === 0);
  });

  test("whether sudo could work is read off this process's own status — and with no /proc, nothing says it cannot", () => {
    expect(canElevate()).toBe(!linux || !/^NoNewPrivs:\s*1\s*$/m.test(readFileSync("/proc/self/status", "utf8")));
  });

  test.skipIf(!linux)("total memory is the kernel's MemTotal", () => {
    const kb = Number(/^MemTotal:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"))![1]);
    expect(totalMemoryBytes()).toBe(kb * 1024);
  });

  test("this process's memory is its own resident set", () => {
    expect(processMemory().rssBytes).toBeGreaterThan(0);
    const available = availableMemoryBytes();
    expect(Number.isInteger(available) && available > 0).toBe(true);
  });
});

describe("the process itself", () => {
  test("stdin is read whole", () => {
    expect(bunChild(`import { readStdin } from ${JSON.stringify(MODULE)}; console.log(JSON.stringify(await readStdin()));`, "a\nb").stdout.split("\n").at(-1)).toBe('"a\\nb"');
  });

  test("stdin is read whole as bytes, a file handed over by the shell", () => {
    // A PDF's bytes are not UTF-8: read as text, 0xff and the lone 0xc3 come back as other bytes.
    const bytes = [0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xc3, 0x0a];
    const source = `import { readStdinBytes } from ${JSON.stringify(MODULE)}; console.log(JSON.stringify([...(await readStdinBytes())]));`;
    const run = spawnSync(process.execPath, ["-e", source], { input: Buffer.from(bytes), encoding: "utf8", timeout: 20_000 });
    expect(run.stdout.trim().split("\n").at(-1)).toBe(JSON.stringify(bytes));
  });

  test("SIGTERM and SIGINT each reach the shutdown handler, by name", () => {
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const run = bunChild(
        `import { onShutdownSignal } from ${JSON.stringify(MODULE)};
         onShutdownSignal((name) => { console.log("got " + name); process.exit(0); });
         process.kill(process.pid, ${JSON.stringify(signal)});
         setTimeout(() => {}, 5000);`,
      );
      expect(run.stdout.split("\n").at(-1)).toBe(`got ${signal}`);
    }
  });

  test("exitProcess exits with the code it is given", () => {
    expect(bunChild(`import { exitProcess } from ${JSON.stringify(MODULE)}; exitProcess(3);`).status).toBe(3);
  });
});

describe.skipIf(!linux)("activity, measured from /proc", () => {
  /** One process's state letter: R running, S sleeping, T stopped. */
  const stateOf = (pid: number) => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.charAt(stat.lastIndexOf(")") + 2);
  };

  /** utime, stime, cutime, cstime and rchar + wchar of one process, read the way the kernel documents them. */
  function measured(pid: number) {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ").map(Number);
    const io = readFileSync(`/proc/${pid}/io`, "utf8");
    const count = (name: string) => Number(new RegExp(`^${name}:\\s*(\\d+)`, "m").exec(io)![1]);
    return { ticks: fields.slice(11, 15), bytes: count("rchar") + count("wchar") };
  }

  test("a stopped group's numbers are its CPU ticks over a hundred, and every byte it read and wrote", async () => {
    // A shell that reaps children doing system time, moves data itself, then spins in user time: every field counts.
    const proc = Bun.spawn(
      withOwnProcessGroup(["sh", "-c", "for i in 1 2 3 4; do head -c 268435456 /dev/zero > /dev/null; done; j=0; while [ $j -lt 20000 ]; do : > /dev/null; j=$((j+1)); done; i=0; while :; do i=$((i+1)); done"]),
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      await eventually(() => {
        const [utime, stime, cutime, cstime] = measured(proc.pid).ticks as [number, number, number, number];
        return utime > 0 && stime > 0 && cutime + cstime > 0;
      }, 4_000, "every kind of CPU time to have been spent");
      process.kill(-proc.pid, "SIGSTOP");
      await eventually(() => stateOf(proc.pid) === "T", 2_000, "the group to stop");
      const own = measured(proc.pid);
      const [utime, stime, cutime, cstime] = own.ticks as [number, number, number, number];
      expect(utime).toBeGreaterThan(0);
      expect(stime).toBeGreaterThan(0);
      expect(cutime + cstime).toBeGreaterThan(0);
      expect(processGroupActivity(proc.pid)).toEqual({ bytesMoved: own.bytes, cpuSeconds: (utime + stime + cutime + cstime) / 100 });
    } finally {
      process.kill(-proc.pid, "SIGKILL");
    }
  });

  test("a group with nobody in it is nothing, not zeroes", () => {
    expect(processGroupActivity(2_147_483_000)).toBeNull();
  });

  test("bytes read and bytes written both count", async () => {
    const result = await runCommand(["sh", "-c", "(head -c 41943040 /dev/zero; sleep 30) | dd of=/dev/null bs=65536 2>/dev/null"], {
      ...sandbox,
      timeoutMs: 2_000,
      onOutput: () => {},
    });
    expect(result.activity!.bytesMoved!).toBeGreaterThan(75 * 1024 * 1024);
  });
});

describe("a background job", () => {
  test("an empty command is refused", () => {
    expect(() => startBackgroundCommand([], { cwd: dir, env: sandbox.env, logPath: join(dir, "never.log") })).toThrow("startBackgroundCommand: empty command");
  });

  test.skipIf(!linux)("kill with no signal named is a SIGTERM to the whole group", async () => {
    const logPath = join(dir, "kill.log");
    const job = startBackgroundCommand(["sh", "-c", "sleep 300 & echo started; wait"], { cwd: dir, env: sandbox.env, logPath });
    // Said once the shell has started its `sleep`: a group of two, which only a signal to the whole group ends.
    await eventually(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("started"), 2_000, "the job to start");
    job.kill();
    let signal: string | null | undefined;
    void job.exited.then((exit) => (signal = exit.signal), () => (signal = "never started"));
    await eventually(() => signal !== undefined, 4_000, "the job to end");
    expect(signal).toBe("SIGTERM");
  });

  test("a single byte of output is logged", async () => {
    const logPath = join(dir, "one-byte.log");
    const job = startBackgroundCommand(["printf", "x"], { cwd: dir, env: sandbox.env, logPath });
    await job.exited;
    expect(readFileSync(logPath, "utf8")).toBe("x");
  });

  test("its log can be read while it is still running", async () => {
    const logPath = join(dir, "running.log");
    const job = startBackgroundCommand(["sh", "-c", "echo early; sleep 30"], { cwd: dir, env: sandbox.env, logPath });
    try {
      await eventually(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("early"), 2_000, "its first line in the log");
      expect(readFileSync(logPath, "utf8")).toBe("early\n");
    } finally {
      await job.stop(100);
    }
  });
});

describe("a shell command's PATH", () => {
  const BIN = "/home/x/.nouride/bin/nouride";
  const PATH = process.env.PATH ?? "/usr/bin:/bin";
  const shell = (name: string) => systemProgram(name, { PATH });

  test("sh, bash, zsh and dash running `-c` get the daemon's directories put back first, positional arguments kept", () => {
    for (const name of ["sh", "bash", "zsh", "dash"]) {
      expect(withBinFirst([name, "-c", "echo $0 $1", "me", "one"], { PATH, NOURIDE_BIN: BIN })).toEqual([
        shell(name),
        "-c",
        'export PATH="$NOURIDE_BIN:$PATH"; echo $0 $1',
        "me",
        "one",
      ]);
    }
  });

  test("a script file is a file, not a command string — whatever follows it", () => {
    expect(withBinFirst(["sh", "job.sh", "arg"], { PATH, NOURIDE_BIN: BIN })).toEqual([shell("sh"), "job.sh", "arg"]);
  });

  test("a command that is not a shell is not touched, not even resolved", () => {
    expect(withBinFirst(["ls", "-c", "x"], { PATH, NOURIDE_BIN: BIN })).toEqual(["ls", "-c", "x"]);
  });

  test("with nothing to put back, the command is left as written", () => {
    expect(withBinFirst(["sh", "-c", "echo hi"], { PATH })).toEqual([shell("sh"), "-c", "echo hi"]);
  });

  test("the shell is looked up on the command's own PATH", () => {
    const own = mkdtempSync(join(dir, "shells-"));
    writeFileSync(join(own, "bash"), "#!/bin/sh\n");
    chmodSync(join(own, "bash"), 0o755);
    expect(withBinFirst(["bash", "-c", "x"], { PATH: own })[0]).toBe(join(own, "bash"));
  });
});

describe("reading a command's output", () => {
  const bytes = (...chunks: (string | number[])[]) =>
    chunks.map((chunk) => (typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)));
  function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }
  const never = new Promise<void>(() => {});

  test("output past the cap in a later chunk is truncated; an empty chunk after a full cap is not", async () => {
    expect(await readCapped(stream(bytes("ab", "c")), 2, never)).toEqual({ text: "ab", truncated: true });
    expect(await readCapped(stream(bytes("ab", [])), 2, never)).toEqual({ text: "ab", truncated: false });
  });

  test("a last character left unfinished is said as a replacement, not dropped, when nothing was cut", async () => {
    expect(await readCapped(stream(bytes("h", [0xc3])), 10, never)).toEqual({ text: "h�", truncated: false });
  });

  test("forwarded text joins a character split across chunks, flushes an unfinished one, and says nothing empty", async () => {
    const seen: string[] = [];
    const result = await forward(stream(bytes([0x68, 0xc3], [0xa9], [0xc3])), (text) => seen.push(text), never);
    expect(seen).toEqual(["h", "é", "�"]);
    expect(result).toEqual({ text: "", truncated: false });
    const whole: string[] = [];
    await forward(stream(bytes("ok")), (text) => whole.push(text), never);
    expect(whole).toEqual(["ok"]);
  });

  test("once the command is settled, what is still coming is read to the end rather than left to block its writer", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Paced, not instant: every read is still pending when the command settles, so the settle wins the race.
        await sleep(5);
        pulled += 1;
        if (pulled > 50) controller.close();
        else controller.enqueue(new Uint8Array([1]));
      },
    });
    await readCapped(endless, 4096, Promise.resolve());
    await eventually(() => pulled > 50, 2_000, "the rest of the stream to be read");
  });
});

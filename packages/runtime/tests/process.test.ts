/**
 * The sandbox's stdin: a value handed to a command without putting it in `argv`.
 *
 * The only way a credential reaches a command without being written down. Everything in `argv` is
 * kept in three places permanently — the exec grant, the audit table and the daemon's own log table
 * — so an inline flag writes the secret to disk three times on its way to being stored properly.
 *
 * Until this existed the sandbox ran every command with `stdin: "ignore"`, which made the prompt's
 * own advice impossible to follow: it told the agent to pipe an MCP token in, and the only path that
 * actually worked was the inline flag the same sentence warned against.
 */

import { describe, expect, test } from "bun:test";
import { canElevate, runCommand, whichBinary } from "../src/process.ts";
import { eventually } from "./wait.ts";

// `env: {}` and not the daemon's own: the environment holds every API key and a sandboxed command
// never inherits it (§17.1). `cat` needs nothing from it.
const sandbox = { cwd: process.cwd(), timeoutMs: 5000, maxOutputBytes: 4096, env: {} };

describe("stdin", () => {
  test("reaches the command, and the pipe is closed so it does not hang", async () => {
    // `cat` reads to EOF. Left open, this would sit until the timeout with the value already
    // delivered — which is the failure worth pinning, not the delivery.
    const result = await runCommand(["cat"], { ...sandbox, stdin: "sk-not-a-real-token\n" });

    expect(result.stdout.trim()).toBe("sk-not-a-real-token");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("an empty string is still a value, and still closes", async () => {
    // Distinct from absent: a command that reads stdin should see EOF immediately rather than
    // inheriting whatever the daemon's own stdin happens to be.
    const result = await runCommand(["cat"], { ...sandbox, stdin: "" });

    expect(result.stdout).toBe("");
    expect(result.timedOut).toBe(false);
  });

  test("omitted means the child gets no stdin at all", async () => {
    // `"ignore"`, not `"inherit"`: a child that inherits a terminal can block forever waiting for
    // input nobody is there to type.
    const result = await runCommand(["cat"], sandbox);

    expect(result.stdout).toBe("");
    expect(result.timedOut).toBe(false);
  });
});

/**
 * A command that starts something and leaves it running returns when the command does.
 *
 * Found live: an agent ran `cd site && nohup python3 -m http.server … > /dev/null 2>&1 < /dev/null &`.
 * The `&` backgrounds the whole list, so the subshell kept the call's pipe open, and the call waited
 * for it until it timed out thirty seconds later — reporting a failure for a server that was running.
 */
describe("a process left running", () => {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

  test("does not hold the call open, whichever way it was started", async () => {
    for (const script of ["sleep 30 & echo started", "cd / && nohup sleep 30 > /dev/null 2>&1 < /dev/null & echo started"]) {
      // Not timed out is the claim: the call is given ten seconds and the job runs thirty, so returning at all means it
      // returned when the command did. A wall-clock bound on top of that measured the machine's load, not the code.
      const result = await runCommand(["sh", "-c", script], { ...sandbox, env, timeoutMs: 10_000 });
      expect({ script, stdout: result.stdout, timedOut: result.timedOut }).toEqual({ script, stdout: "started\n", timedOut: false });
    }
  }, 30_000);

  test("keeps running, and may keep writing, after the call returned", async () => {
    // More than a pipe buffer, after the call returned. Under Bun this holds whether the pipe is drained,
    // dropped or cancelled (see `untilSettled`); it is here so the guarantee stays one if the runtime
    // or that code changes.
    //
    // The child waits for a `go` file this test writes once the call has returned, rather than sleeping a second and
    // being looked for three seconds later: on a loaded machine that margin was the whole test, and it flaked. And it
    // writes into a directory of its own, not the repository's root, where a slow run left its marker behind.
    const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "nouride-left-running-"));
    try {
      const script = "(until [ -e go ]; do sleep 0.02; done; head -c 262144 /dev/zero; touch done) & echo started";
      const result = await runCommand(["sh", "-c", script], { ...sandbox, cwd: dir, env, timeoutMs: 10_000 });
      expect(result.stdout).toBe("started\n");
      expect(existsSync(join(dir, "done"))).toBe(false);
      writeFileSync(join(dir, "go"), "");
      await eventually(() => existsSync(join(dir, "done")), 20_000, "the command to write its file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("what the command itself printed before exiting is all there", async () => {
    const result = await runCommand(["sh", "-c", "for i in $(seq 1 2000); do echo line $i; done"], { ...sandbox, env, maxOutputBytes: 1_000_000 });
    expect(result.stdout.trim().split("\n")).toHaveLength(2000);
  });
});

/**
 * A shell script keeps the daemon's bin directory first on its PATH, whatever its login profile does.
 *
 * Found on a Pi: `exec` runs a script as `bash -lc`, Debian's `/etc/profile` resets PATH, and
 * `command -v cloudflared` failed for a binary the agent had installed in `.nouride/bin` itself.
 * Simulated here with a `~/.bash_profile` that resets PATH the same way.
 */
describe("the daemon's bin directory on a script's PATH", () => {
  test("survives a login profile that resets PATH, and only when it is named", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "nouride-bin-"));
    try {
      const bin = join(root, "bin");
      const home = join(root, "home");
      mkdirSync(bin);
      mkdirSync(home);
      writeFileSync(join(bin, "hello-bin"), "#!/bin/sh\necho hi\n");
      chmodSync(join(bin, "hello-bin"), 0o755);
      writeFileSync(join(home, ".bash_profile"), "PATH=/usr/bin:/bin\n");
      const run = (env: Record<string, string>) =>
        runCommand(["bash", "-lc", "command -v hello-bin || echo missing"], { ...sandbox, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env } });

      expect((await run({})).stdout.trim()).toBe("missing");
      expect((await run({ NOURIDE_BIN: bin })).stdout.trim()).toBe(join(bin, "hello-bin"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * A program is found on the PATH as it is now, not as the process started with it. The daemon puts
 * `.nouride/bin` first at boot, and `Bun.which` alone never saw it: on a live box `nouride doctor`
 * said the `ffmpeg` an agent had installed there was missing.
 */
describe("whichBinary", () => {
  test("sees a directory put on PATH after start", async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const bin = mkdtempSync(join(tmpdir(), "nouride-which-"));
    const before = process.env.PATH;
    try {
      writeFileSync(join(bin, "late-bin"), "#!/bin/sh\n");
      chmodSync(join(bin, "late-bin"), 0o755);
      expect(whichBinary("late-bin")).toBeNull();
      process.env.PATH = `${bin}:${before ?? ""}`;
      expect(whichBinary("late-bin")).toBe(join(bin, "late-bin"));
    } finally {
      process.env.PATH = before;
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

/** `NoNewPrivileges=true` — every hardened unit — leaves `sudo` on PATH and unable to elevate. */
describe("canElevate", () => {
  test("false under NoNewPrivs, true without it or with no /proc", () => {
    expect(canElevate("Name:\tnouride\nNoNewPrivs:\t1\nSeccomp:\t0\n")).toBe(false);
    expect(canElevate("Name:\tnouride\nNoNewPrivs:\t0\n")).toBe(true);
    expect(canElevate("")).toBe(true);
  });
});

/**
 * What a command was doing when its timeout killed it — the evidence `exec` turns into "it needed
 * longer, go to the background" or "it was waiting". Measured from `/proc`, so the numbers exist on
 * Linux only; the quiet time exists everywhere.
 */
describe("activity at the timeout", () => {
  const quietSandbox = { ...sandbox, onOutput: () => {} };

  test("is reported only when the timeout fired, and says how long it had been quiet", async () => {
    const done = await runCommand(["true"], quietSandbox);
    expect(done.activity).toBeUndefined();

    const killed = await runCommand(["sleep", "5"], { ...quietSandbox, timeoutMs: 400 });
    expect(killed.timedOut).toBe(true);
    expect(killed.activity?.quietForMs).toBeGreaterThanOrEqual(350);
  });

  test.skipIf(process.platform !== "linux")("a busy command moved data and used CPU", async () => {
    const busy = await runCommand(["sh", "-c", "while :; do head -c 1048576 /dev/zero; done > /dev/null"], {
      ...quietSandbox,
      timeoutMs: 1500,
    });
    expect(busy.activity?.bytesMoved ?? 0).toBeGreaterThan(8 * 1024 * 1024);
    expect(busy.activity?.cpuSeconds ?? 0).toBeGreaterThan(0.1);
  });

  test.skipIf(process.platform !== "linux")("a waiting one moved next to nothing", async () => {
    const idle = await runCommand(["sleep", "5"], { ...quietSandbox, timeoutMs: 1000 });
    expect(idle.activity?.bytesMoved ?? Number.POSITIVE_INFINITY).toBeLessThan(1024 * 1024);
    expect(idle.activity?.cpuSeconds ?? Number.POSITIVE_INFINITY).toBeLessThan(0.5);
  });

  test.skipIf(process.platform === "linux")("elsewhere the numbers are absent rather than zero", async () => {
    const killed = await runCommand(["sleep", "5"], { ...quietSandbox, timeoutMs: 300 });
    expect(killed.activity?.bytesMoved).toBeNull();
    expect(killed.activity?.cpuSeconds).toBeNull();
  });
});

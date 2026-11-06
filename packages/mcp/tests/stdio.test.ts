/**
 * What a stdio server's process inherits from the daemon.
 *
 * Third-party code, so a short list — and since 0.7.9 not the ssh-agent socket (S11): every server of every agent got
 * `SSH_AUTH_SOCK`, which signs with every key the agent holds, for whoever asks. The engine puts it in `env` for an
 * agent that asked; this package hands on only what it is given.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stdioTransport } from "../src/stdio.ts";
import { eventually } from "./wait.ts";

/** The first line a child prints, from a process that then waits to be closed. */
async function firstLine(env?: Record<string, string>): Promise<string> {
  let resolve: (line: string) => void = () => {};
  const line = new Promise<string>((done) => (resolve = done));
  const transport = stdioTransport({
    command: "sh",
    args: ["-c", 'printf "%s\\n" "${SSH_AUTH_SOCK-unset}"; sleep 5'],
    ...(env ? { env } : {}),
    closeWaitsMs: { input: 100, term: 1_000, kill: 1_000 },
  })({ onMessage: (raw) => resolve(raw), onClose: () => resolve("closed") });
  try {
    return await line;
  } finally {
    await transport.close();
  }
}

describe("a stdio server's environment", () => {
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/tmp/nouride-test-daemon-agent.sock";
  });
  afterEach(() => {
    if (before === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = before;
  });

  test("does not carry the daemon's ssh-agent socket — with the daemon holding one", async () => {
    expect(await firstLine()).toBe("unset");
  });

  test("carries one it was given, which is how an agent that asked for it hands it on", async () => {
    expect(await firstLine({ SSH_AUTH_SOCK: "/tmp/nouride-test-given.sock" })).toBe("/tmp/nouride-test-given.sock");
  });
});

/** Whether a process is gone — given a moment, since an orphan is reaped by whoever adopts it. */
async function gone(pid: number): Promise<boolean> {
  const there = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await eventually(() => !there(), 1_000, `process ${pid} to be gone`);
    return true;
  } catch {
    return false;
  }
}

/** A server started, with what it prints first, and how long its `close` took. */
async function started(script: string, closeWaitsMs?: { input: number; term: number; kill: number }) {
  let resolve: (line: string) => void = () => {};
  const first = new Promise<string>((done) => (resolve = done));
  const transport = stdioTransport({ command: "sh", args: ["-c", script], ...(closeWaitsMs ? { closeWaitsMs } : {}) })({
    onMessage: (raw) => resolve(raw),
    onClose: () => resolve("closed"),
  });
  const line = await first;
  const at = Date.now();
  await transport.close();
  return { line, tookMs: Date.now() - at };
}

describe("closing a stdio server (issue #11 on nouride-releases)", () => {
  test("one that exits at the end of its input is closed by that, not by a signal", async () => {
    // `mcp-atlassian` ignores SIGTERM while its stdin is open, and exits at once when it closes.
    const { tookMs } = await started(`trap '' TERM; echo ready; read line`, { input: 5_000, term: 5_000, kill: 1_000 });
    expect(tookMs).toBeLessThan(2_000);
  });

  test("one that ignores SIGTERM with its input open is killed, and close returns", async () => {
    // It waited for ever: `agent reload` never reached the connect step, and the old server ran on.
    const { line, tookMs } = await started(`trap '' TERM; echo $$; exec sleep 1000`, { input: 100, term: 200, kill: 2_000 });
    expect(tookMs).toBeLessThan(2_000);
    expect(await gone(Number(line))).toBe(true);
  });

  test("what the server started goes with it — `uvx` runs the server as a child of `uv`", async () => {
    const { line } = await started(`trap '' TERM; sleep 1000 & echo $!; wait`, { input: 100, term: 200, kill: 2_000 });
    expect(await gone(Number(line))).toBe(true);
  });
});

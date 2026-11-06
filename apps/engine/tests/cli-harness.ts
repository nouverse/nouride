/**
 * The real CLI, spawned against a test's own install — one harness for every test that does it.
 *
 * There were six, each copying the last and each scrubbing the environment by its own hand-written list of what to
 * leave out. None left out `NOURIDE_DATA_DIR` or `NOURIDE_AGENTS_DIR`, which override the install's config, nor the
 * variables the exec sandbox sets (`NOURIDE_AGENT_ID`, `NOURIDE_GATEWAY_ID`, `NOURIDE_CHAT_ID`, `NOURIDE_BIN`): run
 * from a shell or an agent's sandbox that had them, `db backup` and `update --rollback --apply` acted on that data
 * directory instead of the test's. So the child gets an allowlist — what a process needs to run at all — and the
 * test's config, and nothing else this process holds. And it runs on this process's Bun, not whichever `bun` is first
 * on PATH.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

export const CLI_MAIN = join(import.meta.dir, "../src/cli/main.ts");

/** What a process needs to run at all, and nothing that names an install. */
const PASSED_ON = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "USER"];

/** The child's environment: the allowlist from this one, the test's config, `LOG_LEVEL=error`, and `extra` over all. */
export function cliEnv(config: string, extra: Record<string, string> = {}, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept = Object.fromEntries(PASSED_ON.flatMap((name) => (from[name] === undefined ? [] : [[name, from[name]!]])));
  return { ...kept, NOURIDE_CONFIG: config, LOG_LEVEL: "error", ...extra };
}

export interface CliOptions {
  /** The install's `config.toml`. */
  config: string;
  cwd: string;
  env?: Record<string, string>;
  /** A file run in the CLI's process before it: a stand-in for what the machine would answer (`cli/fixtures/free-disk.ts`). */
  preload?: string;
}

/** The CLI, running — for a test that has to hold it or end it (`events -f`). */
export function spawnCli(args: readonly string[], options: CliOptions): ChildProcessWithoutNullStreams {
  const preload = options.preload ? ["--preload", options.preload] : [];
  return spawn(process.execPath, [...preload, CLI_MAIN, ...args], { cwd: options.cwd, env: cliEnv(options.config, options.env) });
}

/** Without the terminal's colours. */
export const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The CLI, run to its end: its exit code and what it printed, colours removed. Not `spawnSync` — that holds this
 * process's event loop, and a stand-in daemon a test serves answers from it.
 */
export function runCli(args: readonly string[], options: CliOptions & { stdin?: string }): Promise<{ code: number; out: string; err: string }> {
  const child = spawnCli(args, options);
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  child.stdin.end(options.stdin ?? "");
  return new Promise((resolve) => child.on("close", (code) => resolve({ code: code ?? -1, out: plain(out), err: plain(err) })));
}

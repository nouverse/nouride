#!/usr/bin/env bun
/**
 * The coding CLIs' handshake with no sign-in (0.8.24, v0.8.24 item 4): what the weekly workflow runs after installing
 * each built-in CLI's newest version (`.github/workflows/cli-handshake.yml`), so a version that drops something Nouride
 * uses is found in a week, not at a person's update. Each CLI is started in its ACP mode as Nouride starts it — its
 * row's environment, a profile folder and a HOME of its own, empty — asked `initialize`, then a session, where one opens
 * signed out, for the modes the presets set. Read by the rule an update's check reads (`handshakeProblem`).
 *
 *   bun run scripts/cli-handshake.ts                                  every built-in CLI, by its command on PATH
 *   bun run scripts/cli-handshake.ts --only codex                     one of them
 *   bun run scripts/cli-handshake.ts --only claude-code -- <cmd …>    that CLI's row over a stand-in for it (the tests')
 *   bun run scripts/cli-handshake.ts --packages                       each row's package at its newest, for `npm install`
 *
 * Exit 0 when each has what Nouride uses, 1 when one does not or would not start, 2 for misuse. A version that passes
 * here and a real turn on the box is named tested in the next release (`CliRow.tested`, PLAN_TO_1.0 §3.3).
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AcpClient, BUILT_IN_CLIS, handshakeProblem, type CliRow } from "../packages/acp/src/index.ts";

/** A first start installs nothing, but a cold one loads a few hundred megabytes: a minute is what a slow runner takes. */
const OPEN_MS = 60_000;

/** One CLI's handshake: its version, and what it lacks of what Nouride uses — null where nothing — or why it did not answer. */
async function handshakeOf(row: CliRow, command: readonly string[]): Promise<{ version: string | null; problem: string | null; signedOut: boolean }> {
  const home = mkdtempSync(join(tmpdir(), `cli-handshake-${row.id}-`));
  const profile = join(home, "profile");
  mkdirSync(profile, { recursive: true });
  for (const [name, text] of Object.entries(row.profileFiles ?? {})) writeFileSync(join(profile, name), text);
  const env = { ...process.env, ...row.env, HOME: home, ...(row.profileEnv ? { [row.profileEnv]: profile } : {}) } as Record<string, string>;
  const child = spawn(command[0]!, command.slice(1), { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  const stderr: string[] = [];
  createInterface({ input: child.stderr }).on("line", (line) => stderr.push(line));
  const client = new AcpClient({
    transport: { send: (line) => void child.stdin.write(`${line}\n`) },
    permission: async () => ({ outcome: "cancelled" }),
    clientInfo: { name: "nouride-cli-handshake", version: "0" },
  });
  createInterface({ input: child.stdout }).on("line", (line) => client.receive(line));
  child.on("exit", (code) => client.closed(`exited with code ${code}`));
  child.on("error", (err) => client.closed(String(err)));
  try {
    const info = await client.initialize(OPEN_MS);
    let modes: string[] | null = null;
    let signedOut = false;
    try {
      modes = (await client.newSession(home, [])).modes?.availableModes.map((mode) => mode.id) ?? [];
    } catch {
      // Signed out, as a CLI with no sign-in is: its modes are no verdict, and steering is read from the handshake.
      signedOut = true;
    }
    return { version: info.agentInfo?.version ?? null, problem: handshakeProblem(row, info, modes), signedOut };
  } catch (err) {
    return { version: null, problem: `it did not answer the handshake: ${err instanceof Error ? err.message : String(err)}${stderr.length ? ` (${stderr.slice(-2).join(" / ")})` : ""}`, signedOut: false };
  } finally {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  // What the workflow installs: the rows' own packages, so a CLI added to them is checked with no edit there.
  if (args.length === 1 && args[0] === "--packages") {
    console.log(BUILT_IN_CLIS.flatMap((row) => (row.package ? [`${row.package}@latest`] : [])).join(" "));
    process.exit(0);
  }
  const end = args.indexOf("--");
  const own = end === -1 ? args : args.slice(0, end);
  const standIn = end === -1 ? [] : args.slice(end + 1);
  const only = own[0] === "--only" ? own[1] : undefined;
  if ((own.length > 0 && !only) || own.length > 2 || (standIn.length > 0 && !only)) {
    console.error("Usage: bun run scripts/cli-handshake.ts [--only <cli> [-- <command …>]]");
    process.exit(2);
  }
  const rows = BUILT_IN_CLIS.filter((row) => !only || row.id === only);
  if (rows.length === 0) {
    console.error(`No built-in CLI "${only}": ${BUILT_IN_CLIS.map((row) => row.id).join(", ")}`);
    process.exit(2);
  }
  let failed = 0;
  for (const row of rows) {
    const { version, problem, signedOut } = await handshakeOf(row, standIn.length > 0 ? standIn : [row.command, ...row.args]);
    const said = `${row.id}${version ? ` ${version}` : ""}`;
    if (problem) {
      failed += 1;
      console.log(`✗ ${said}: ${problem}`);
    } else console.log(`✓ ${said}: has what Nouride uses${signedOut ? " (signed out, so its modes were not read)" : ""}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

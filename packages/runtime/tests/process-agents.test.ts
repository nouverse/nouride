/**
 * An agent's command behind the helper's client (`process-agents.ts`): which layer runs as the agent, which as the
 * daemon, and where the daemon reads what the command is doing.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandLine, runCommand } from "../src/process.ts";
import { writeFileAsAgent } from "../src/process-agent-files.ts";
import { agentCommandsHaveOwnUsers, asItsAgent, commandGroupOf, runAgentCommandsThrough, trackCommand, untrackCommand } from "../src/process-agents.ts";

const CLIENT = "/usr/local/lib/nouride-run/nouride-run";
const prefix = (agent: string, cwd: string | undefined, pidFile: string) => [CLIENT, "exec", "--agent", agent, "--cwd", cwd ?? "", "--pid-file", pidFile, "--"];
const unused = () => [] as string[];

afterEach(() => runAgentCommandsThrough(null));

test("with no helper, or no agent named, a command runs as the daemon's user, as before", () => {
  expect(agentCommandsHaveOwnUsers()).toBe(false);
  expect(asItsAgent(["ls"], "nouva", "/w")).toEqual({ cmd: ["ls"] });
  runAgentCommandsThrough({ prefix, put: unused });
  expect(asItsAgent(["git", "status"], undefined, "/w")).toEqual({ cmd: ["git", "status"] });
});

test("the client goes around what runs as the agent: its limits and priority are the command's, not the client's", () => {
  runAgentCommandsThrough({ prefix, put: unused });
  const line = commandLine(["make", "test"], { agent: "nouva", cwd: "/w", limits: { memoryMb: 64, cpuSeconds: 5 } });
  const at = (part: string) => line.cmd.indexOf(part);
  expect(at(CLIENT)).toBeGreaterThanOrEqual(0);
  expect(line.cmd.slice(at(CLIENT), at(CLIENT) + 5)).toEqual([CLIENT, "exec", "--agent", "nouva", "--cwd"]);
  expect(line.pidFile).toBeDefined();
  expect(line.cmd).toContain(line.pidFile!);
  // Whatever of `prlimit`, `nice` and `choom` this machine has sits between the client and the command.
  const after = line.cmd.slice(at(CLIENT));
  for (const wrapper of ["prlimit", "nice", "choom"]) {
    const index = line.cmd.findIndex((part) => part.endsWith(`/${wrapper}`));
    if (index >= 0) expect(index).toBeGreaterThan(at(CLIENT));
  }
  expect(after.slice(-2)).toEqual(["make", "test"]);
});

test("the pid the daemon holds stands for the command's group once the client has written it, and the file goes after", () => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-agents-"));
  const file = join(dir, "cmd.pid");
  expect(commandGroupOf(4242)).toBe(4242);
  trackCommand(4242, file);
  expect(commandGroupOf(4242)).toBe(4242);
  writeFileSync(file, "5151");
  expect(commandGroupOf(4242)).toBe(5151);
  untrackCommand(4242);
  expect(existsSync(file)).toBe(false);
  expect(commandGroupOf(4242)).toBe(4242);
});

test("a command run through a client gets the client's exit, output and the pid file it named", async () => {
  // A stand-in for the client: writes a pid where it is told, then runs the command as it is.
  runAgentCommandsThrough({ prefix: (_agent, _cwd, pidFile) => ["/bin/sh", "-c", 'echo 777 > "$0"; exec "$@"', pidFile], put: unused });
  const out = await runCommand(["/bin/sh", "-c", "echo hi; exit 3"], { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 10_000, maxOutputBytes: 1024, agent: "nouva" });
  expect({ stdout: out.stdout, exitCode: out.exitCode }).toEqual({ stdout: "hi\n", exitCode: 3 });
});

test("a file written as an agent goes through the helper's put, bytes and all — and a refusal is an error, not a silence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-put-"));
  // A stand-in for `put` run as the agent: stdin into the file it names, or a refusal like the kernel's.
  runAgentCommandsThrough({ prefix, put: (agent, path) => ["/bin/sh", "-c", agent === "nouva" ? 'cat > "$0"' : 'echo "$0: Permission denied" >&2; exit 1', path] });
  const bytes = new Uint8Array([0, 255, 10, 13]);
  await writeFileAsAgent("nouva", join(dir, "blob.bin"), bytes);
  expect(new Uint8Array(readFileSync(join(dir, "blob.bin")))).toEqual(bytes);
  await writeFileAsAgent("nouva", join(dir, "note.md"), "# hi\n");
  expect(readFileSync(join(dir, "note.md"), "utf-8")).toBe("# hi\n");
  await expect(writeFileAsAgent("nox", join(dir, "theirs.md"), "x")).rejects.toThrow(`${join(dir, "theirs.md")} could not be written as nox`);
});

test("with no helper a file is written by the daemon, keeping the mode it had", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-put-"));
  const script = join(dir, "run.sh");
  writeFileSync(script, "old", { mode: 0o755 });
  await writeFileAsAgent("nouva", script, "new");
  expect({ text: readFileSync(script, "utf-8"), mode: statSync(script).mode & 0o777 }).toEqual({ text: "new", mode: 0o755 });
});

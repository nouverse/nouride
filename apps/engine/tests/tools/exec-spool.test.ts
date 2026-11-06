/**
 * `exec` end to end: a command whose output is too big to hold goes to disk as it runs.
 *
 * `exec-output.test.ts` covers the capture on its own. This is the part only the real tool can show:
 * a real child, the real pipe, and the result the executor's spill then reads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@nouride/shared";
import { createExecTool } from "@/modules/tools/builtins/exec.ts";
import { childEnvOf } from "../helpers.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-exec-spool-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = "sk-live-0123456789abcdef";

/** The tool's own limit on a command. */
const COMMAND_TIMEOUT_MS = 20_000;

/**
 * How long a test of LOUD waits: for the tool's own answer, past the tool's own limit.
 *
 * Sixty thousand `echo`s take half a second on an idle laptop. Under bun:test's default of 5 s, a busy
 * machine (a load average of 15 and up, several suites at once) failed all three as timeouts, though the
 * capture was fine and the command would have finished. Past COMMAND_TIMEOUT_MS the verdict is the
 * tool's: a command that really ran out of time comes back as a result that says so.
 */
const WAITS_FOR_THE_TOOL = COMMAND_TIMEOUT_MS + 10_000;

const tool = () =>
  createExecTool({
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: 10 * 1024 * 1024,
    blocked: [],
    policy: { mode: "full", ask: "off", askFallback: "deny", sensitivePaths: "ask", allowlist: [], blocked: [] },
    childEnv: childEnvOf({ API_TOKEN: TOKEN }),
  } as Parameters<typeof createExecTool>[0]);

const ctx = (spoolPath?: string): ToolContext => ({
  agentId: "nouva",
  sessionId: "ses_1",
  chatId: "chat-1",
  gateway: "web",
  gatewayId: "web:dashboard",
  senderId: "dev",
  chatType: "dm",
  workspaceDir: dir,
  agentDir: dir,
  workspaceRoots: [dir],
  ...(spoolPath ? { spoolPath } : {}),
  signal: new AbortController().signal,
});

/** ~1.2MB on stdout with the token in the middle, then a last word on stderr. */
const LOUD = [
  "sh",
  "-c",
  'i=0; while [ $i -lt 60000 ]; do echo "row $i"; if [ $i -eq 30000 ]; then echo "key=$API_TOKEN"; fi; i=$((i+1)); done; echo "exit summary" >&2',
];

describe("a large output", () => {
  test("is on disk whole, masked, and the result says where", async () => {
    const spoolPath = join(dir, "call.txt");
    const result = await tool().execute({ command: LOUD }, ctx(spoolPath));

    expect(result.isError).toBe(false);
    expect(result.spooled?.path).toBe(spoolPath);
    const file = readFileSync(spoolPath, "utf8");
    expect(file).toContain("row 0\n");
    expect(file).toContain("row 59999\n");
    expect(file).toContain("key=[REDACTED:API_TOKEN]");
    expect(file).not.toContain(TOKEN);
    // 60000 rows, the key line and the summary, each ended by a newline.
    expect(result.spooled?.lines).toBe(60_002);
    expect(statSync(spoolPath).mode & 0o777).toBe(0o600);
  }, WAITS_FOR_THE_TOOL);

  test("hands back its two ends, and the end is the real one", async () => {
    const result = await tool().execute({ command: LOUD }, ctx(join(dir, "call.txt")));

    expect(result.content.length).toBeLessThan(120 * 1024);
    expect(result.content).toStartWith("row 0\n");
    // stderr arrived last and is in the tail, because the tail is the end of the output — not of
    // the first 10MB of it.
    expect(result.content.trimEnd()).toEndWith("exit summary");
  }, WAITS_FOR_THE_TOOL);

  test("with no spool path, the ends are all that is kept and the gap is marked", async () => {
    const result = await tool().execute({ command: LOUD }, ctx());

    expect(result.spooled?.path).toBeNull();
    expect(result.content).toContain("characters in the middle were not kept here");
  }, WAITS_FOR_THE_TOOL);
});

describe("a small output", () => {
  test("is exactly what it was before this existed", async () => {
    const result = await tool().execute({ command: ["sh", "-c", "echo out; echo err >&2"] }, ctx(join(dir, "call.txt")));

    expect(result.content).toBe("out\n[stderr]\nerr");
    expect(result.spooled).toBeUndefined();
    expect(() => statSync(join(dir, "call.txt"))).toThrow();
  });
});

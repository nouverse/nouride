/**
 * What a subprocess is allowed to see of the daemon's environment.
 *
 * `execEnvAllowlist()` was exported with the comment "the sandbox contract is worth asserting on
 * directly" and then never asserted on. It is the boundary that stops a command the model chose from
 * reading every provider key this process started with, so it gets a test of its own — and one that
 * fails loudly if the list ever grows something with a secret in it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runAgentCommandsThrough } from "@nouride/runtime";
import type { ToolContext } from "@nouride/shared";
import { childEnvFor } from "@/boot/child-env.ts";
import { createExecTool, execEnvAllowlist } from "@/modules/tools/builtins/exec.ts";
import { TOOLCHAIN_ENV_NAMES } from "@/modules/toolchain/env.ts";
import { childEnvOf } from "../helpers.ts";

/**
 * Names that must never appear, however the list is edited.
 *
 * Matched as substrings on purpose: the danger is not one known variable, it is the shape of a name.
 * `ANTHROPIC_API_KEY`, `NOUGATE`, `TELEGRAM_BOT_TOKEN` and whatever the next deployment invents all
 * carry one of these words.
 */
const FORBIDDEN_SUBSTRINGS = ["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "AUTH_TOKEN"];

describe("exec env allowlist", () => {
  test("carries only what a program needs to run correctly", () => {
    expect(execEnvAllowlist()).toEqual([
      "PATH",
      "NOURIDE_BIN",
      "NOURIDE_PATH",
      "HOME",
      "LANG",
      "LC_ALL",
      "TZ",
      "TERM",
      // Not SSH_AUTH_SOCK, since 0.7.9 (S11): an agent that needs the ssh-agent asks for it — see below.
      // Where installers put what they install — `modules/toolchain/env.ts`. Paths and switches only.
      ...TOOLCHAIN_ENV_NAMES,
    ]);
  });

  test("carries NOURIDE_BIN, so a script whose login profile resets PATH still finds this daemon's binaries", () => {
    // The runtime puts it back first on the script's PATH (`withBinFirst`); dropped here, it cannot.
    expect(execEnvAllowlist()).toContain("NOURIDE_BIN");
  });

  test("nothing on it looks like a credential", () => {
    for (const name of execEnvAllowlist()) {
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        // Matched on the name, so a credential under an innocent one gets past it: SSH_AUTH_SOCK holds neither
        // word and was on this list until 0.7.9, signing for every command of every agent. A future
        // `SSH_PRIVATE_KEY` would fail here, which is the point.
        expect(name.toUpperCase()).not.toContain(forbidden);
      }
    }
  });

  test("is a copy, so a caller cannot widen the real list", () => {
    const first = execEnvAllowlist();
    first.push("ANTHROPIC_API_KEY");
    expect(execEnvAllowlist()).not.toContain("ANTHROPIC_API_KEY");
  });
});

/**
 * `TMPDIR`, which is the difference between telling the agent where to put throwaway files and
 * deciding it for them. A command that reaches for a temporary file lands in the scratchpad — where
 * deleting is ordinary — rather than in `/tmp`, where deleting is hardline and `/approvals balanced` is not
 * allowed to answer.
 *
 * Asserted through the background path because that is the one whose spawn is injectable. Both paths
 * build their environment from the same helper; a foreground-only regression is not a shape this file
 * can express without a fake for `runCommand`.
 */
describe("the scratchpad is where a child's temporary files go", () => {
  const base = {
    timeoutMs: 5000,
    maxOutputBytes: 64 * 1024,
    blocked: [] as string[],
    policy: {
      mode: "full" as const,
      ask: "off" as const,
      askFallback: "deny" as const,
      sensitivePaths: "ask" as const,
      allowlist: [] as string[],
      blocked: [] as string[],
    },
  };

  function ctx(scratchpadDir?: string): ToolContext {
    return {
      agentId: "nouva",
      sessionId: "ses_1",
      chatId: "chat-1",
      gateway: "web",
      gatewayId: "web:dashboard",
      senderId: "dev",
    chatType: "dm",
      workspaceDir: "/tmp/nouride-test-workspace",
      agentDir: "/tmp/nouride-test-workspace",
      workspaceRoots: ["/tmp/nouride-test-workspace"],
      ...(scratchpadDir ? { scratchpadDir } : {}),
      signal: new AbortController().signal,
    };
  }

  /** The env a spawned job would have been given. */
  async function envOf(context: ToolContext, childEnv?: Record<string, string>) {
    let captured: Record<string, string> = {};
    const tool = createExecTool({
      ...base,
      ...(childEnv ? { childEnv: childEnvOf(childEnv) } : {}),
      startJob: (job: { env: Record<string, string> }) => {
        captured = job.env;
        return { id: "job_1", logPath: "/dev/null" };
      },
    } as Parameters<typeof createExecTool>[0]);
    await tool.execute({ command: ["sleep", "1"], background: true }, context);
    return captured;
  }

  test("all three spellings point at the scratchpad", async () => {
    const env = await envOf(ctx("/data/workspace/private/nouva/.scratchpad"));
    expect(env.TMPDIR).toBe("/data/workspace/private/nouva/.scratchpad");
    expect(env.TMP).toBe(env.TMPDIR);
    expect(env.TEMP).toBe(env.TMPDIR);
  });

  test("a child is told nobody is at its keyboard — apt takes its defaults, git does not wait for a password", async () => {
    const env = await envOf(ctx("/scratch/.scratchpad"));
    expect(env.DEBIAN_FRONTEND).toBe("noninteractive");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("where each agent is its own user, a job runs as its agent, with its folder as HOME and its own bin", async () => {
    let started: { env: Record<string, string>; agent?: string } | undefined;
    const tool = createExecTool({
      ...base,
      startJob: (job: { env: Record<string, string>; agent?: string }) => {
        started = job;
        return { id: "job_1", logPath: "/dev/null" };
      },
    } as Parameters<typeof createExecTool>[0]);
    const own = { ...ctx("/w/private/nouva/.scratchpad"), privateDir: "/w/private/nouva" };
    runAgentCommandsThrough({ prefix: () => [], put: () => [] });
    try {
      await tool.execute({ command: ["sleep", "1"], background: true }, own);
      expect(started?.agent).toBe(own.agentId);
      expect({ home: started?.env.HOME, bin: started?.env.NOURIDE_BIN }).toEqual({ home: "/w/private/nouva", bin: "/w/private/nouva/.local/bin" });
      // The daemon's own CLI, run for the agent by the `nouride` tool, stays the daemon's: its user, its HOME.
      await tool.execute({ command: ["sleep", "1"], background: true }, { ...own, ownCliTool: true });
      expect(started?.agent).toBeUndefined();
      expect(started?.env.HOME).not.toBe("/w/private/nouva");
    } finally {
      runAgentCommandsThrough(null);
    }
  });

  test("a context with no scratchpad leaves the environment as it was", async () => {
    const env = await envOf(ctx());
    expect(env.TMPDIR).toBeUndefined();
  });

  test("a credential still wins over it — the layering must not have been inverted", async () => {
    // `childEnv` is how a secret reaches a command without passing through the model. If setting
    // TMPDIR had been layered *after* it, this file would be quietly deciding what a credential is.
    const env = await envOf(ctx("/scratch/.scratchpad"), { MY_TOKEN: "s3cret" });
    expect(env.MY_TOKEN).toBe("s3cret");
    expect(env.TMPDIR).toBe("/scratch/.scratchpad");
  });
});

/**
 * The ssh-agent socket reaches the agents that asked for it, and no others (S11).
 *
 * It was on the allowlist above, so every command of every agent held a socket that signs with every key the ssh-agent
 * holds — `git push` or `ssh` to any host those keys open was an ordinary command for an agent that never needed SSH.
 * Planted for real here: the daemon has a socket, and only the agent whose pack says `ssh_agent = true` sees it, in
 * the foreground command it actually runs as well as in the job it starts.
 */
describe("the ssh-agent socket", () => {
  const SOCKET = "/tmp/nouride-test-ssh-agent.sock";
  let before: string | undefined;
  beforeEach(() => {
    before = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = SOCKET;
  });
  afterEach(() => {
    if (before === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = before;
  });

  const policy = {
    mode: "full" as const,
    ask: "off" as const,
    askFallback: "deny" as const,
    sensitivePaths: "ask" as const,
    allowlist: [] as string[],
    blocked: [] as string[],
  };
  const childEnv = childEnvFor({
    credentialsDir: "/tmp/nouride-test-credentials",
    execSecrets: () => [],
    sshAgent: (agentId) => agentId === "ops",
    resolve: () => undefined,
  });
  const context = (agentId: string): ToolContext => ({
    agentId,
    sessionId: "ses_1",
    chatId: "chat-1",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "dev",
    chatType: "dm",
    workspaceDir: "/tmp",
    agentDir: "/tmp",
    workspaceRoots: ["/tmp"],
    signal: new AbortController().signal,
  });

  /** What `printenv` says, run for real in the foreground — the spawn the model's command actually gets. */
  async function printed(agentId: string, withChildEnv = true): Promise<string> {
    const tool = createExecTool({ timeoutMs: 5000, maxOutputBytes: 64 * 1024, blocked: [], policy, ...(withChildEnv ? { childEnv } : {}) });
    const result = await tool.execute({ command: ["printenv", "SSH_AUTH_SOCK"] }, context(agentId));
    return result.content;
  }

  test("an agent that did not ask runs its commands without it — with the daemon holding one", async () => {
    expect(await printed("nouva")).not.toContain(SOCKET);
    // And with no per-agent environment at all, which is what the allowlist alone decides.
    expect(await printed("nouva", false)).not.toContain(SOCKET);
  });

  test("an agent whose pack says ssh_agent = true gets it, in the foreground and in a job it starts", async () => {
    expect(await printed("ops")).toContain(SOCKET);

    let jobEnv: Record<string, string> = {};
    const tool = createExecTool({
      timeoutMs: 5000,
      maxOutputBytes: 64 * 1024,
      blocked: [],
      policy,
      childEnv,
      startJob: (job) => {
        jobEnv = job.env;
        return { id: "job_1", logPath: "/dev/null" };
      },
    });
    await tool.execute({ command: ["sleep", "1"], background: true }, context("ops"));
    expect(jobEnv.SSH_AUTH_SOCK).toBe(SOCKET);
  });

  test("a session gets it the same way, and output is never masked with it — a socket path is not a secret", () => {
    expect(childEnv.forCommand("ops", null).env.SSH_AUTH_SOCK).toBe(SOCKET);
    expect(childEnv.forCommand("nouva", null).env.SSH_AUTH_SOCK).toBeUndefined();
    expect(childEnv("ops").SSH_AUTH_SOCK).toBeUndefined();
    // Nor is it a secret the command is handed, for the gate to ask about or a grant to name.
    expect(childEnv.forCommand("ops", ["ssh", "host"]).secrets).toEqual([]);
  });
});

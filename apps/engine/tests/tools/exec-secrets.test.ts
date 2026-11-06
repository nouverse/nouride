/**
 * Scoped `exec_secrets` (S6), end to end: what a command is handed, and what it takes to be handed it.
 *
 * Every command an agent ran held every secret it had, and at `balanced` — the default — an ordinary `curl` ran without
 * asking, so one instruction planted in a fetched page could spend them all. Now a command holds the secrets bound
 * to it, and a command that holds any asks first at every level but `trusted`, unless a grant names those secrets and
 * the files it runs. The child is spawned for real here, because "the environment it got" is only true of a process.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGrantKey } from "@nouride/policy";
import { addLogSink, type ApprovalLevel, type ExecSecret, type GateAsk, type GateDecision, type Tool, type ToolCall, type ToolContext } from "@nouride/shared";
import { childEnvFor } from "@/boot/child-env.ts";
import { runPreflightChecks } from "@/boot/preflight.ts";
import { parseConfig } from "@/modules/config/global/index.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { ToolCaller } from "@/modules/llm/executor/tool-caller.ts";
import type { ExecutorDeps, TurnRequest } from "@/modules/llm/executor/types.ts";
import { buildSystemPrompt } from "@/modules/llm/prompt/index.ts";
import { closeAllSessions } from "@/modules/tools/builtins/sessions.ts";
import { createBuiltinTools } from "@/modules/tools/registry.ts";
import { fakeAgent, stateRows } from "../helpers.ts";
import { sleep } from "../wait.ts";

const dir = mkdtempSync(join(tmpdir(), "nouride-exec-secrets-"));
const outside = mkdtempSync(join(tmpdir(), "nouride-exec-secrets-elsewhere-"));
afterAll(() => {
  closeAllSessions();
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
writeFileSync(join(dir, "publish.py"), "print('published')\n");
writeFileSync(join(outside, "publish.py"), "print('published')\n");

const VALUES: Record<string, string> = { pypi_token: "pypi-AgEIcHlwaS5vcmcSecret", npm_token: "npm_0123456789abcdefghij", status_token: "st-0123456789abcdef" };
const BINDINGS: ExecSecret[] = [
  { name: "pypi_token", commands: ["twine upload", "python3 publish.py", `python3 ${join(outside, "publish.py")}`] },
  { name: "npm_token", commands: ["printenv NPM_TOKEN"] },
  { name: "status_token", commands: ["*"] },
  // Named and never stored: nothing to hand, and nothing to ask about.
  { name: "missing_token", commands: ["*"] },
];
const childEnv = childEnvFor({ credentialsDir: join(dir, ".credentials"), execSecrets: () => BINDINGS, resolve: (name) => VALUES[name] });

let grants = new Set<string>();
const audited: { details?: Record<string, unknown> }[] = [];
const tools = createBuiltinTools({
  security: DEFAULT_CONFIG.security,
  web: {} as never,
  sessionStatus: (() => undefined) as never,
  memory: {} as never,
  childEnv,
  liveGrants: () => grants,
  audit: { record: (entry: { details?: Record<string, unknown> }) => void audited.push(entry) } as never,
});
const exec = tools.get("exec")!;

function ctx(): ToolContext {
  return { agentId: "nouva", sessionId: "s", chatId: "c", gateway: "web", gatewayId: "web:dashboard", senderId: "u", workspaceDir: dir, agentDir: dir, workspaceRoots: [dir], signal: new AbortController().signal } as ToolContext;
}
const gate = (command: string): GateDecision => exec.gate!({ command }, ctx());

describe("what a command is handed", () => {
  test("the secrets bound to it and those bound to every command — nothing else, and nothing that is not stored", () => {
    expect(childEnv.forCommand("nouva", ["twine", "upload", "dist/x"]).secrets).toEqual(["pypi_token", "status_token"]);
    expect(childEnv.forCommand("nouva", ["curl", "https://elsewhere"]).secrets).toEqual(["status_token"]);
    const handed = childEnv.forCommand("nouva", ["curl", "https://elsewhere"]).env;
    expect(handed.PYPI_TOKEN).toBeUndefined();
    expect(handed.NOURIDE_CREDENTIALS_DIR).toBe(join(dir, ".credentials"));
    // Every value, for masking what any command prints.
    expect(childEnv("nouva")).toMatchObject({ PYPI_TOKEN: VALUES.pypi_token, NPM_TOKEN: VALUES.npm_token, STATUS_TOKEN: VALUES.status_token });
  });

  test("a spawned command holds what it was bound, and an unbound one does not", async () => {
    const bound = await exec.execute({ command: "printenv NPM_TOKEN" }, ctx());
    expect(bound.metadata).toMatchObject({ exitCode: 0, secrets: ["npm_token", "status_token"] });
    const unbound = await exec.execute({ command: "printenv PYPI_TOKEN" }, ctx());
    expect(unbound.metadata).toMatchObject({ exitCode: 1, secrets: ["status_token"] });
  });

  test("the audit row keeps the names it was handed — never a value", async () => {
    audited.length = 0;
    await exec.execute({ command: "printenv NPM_TOKEN" }, ctx());
    expect(audited[0]?.details).toMatchObject({ tool: "exec", secrets: ["npm_token", "status_token"] });
    expect(JSON.stringify(audited)).not.toContain(VALUES.npm_token);
  });

  test("an interactive session holds only what is bound to every command", async () => {
    const session = tools.get("session")!;
    const started = await session.execute({ action: "start", command: ["sh"] }, ctx());
    const id = String(started.metadata?.session);
    // What a send returns already holds what was printed by then; a read brings the rest.
    let printed = (await session.execute({ action: "send", id, input: 'echo "[$STATUS_TOKEN][$PYPI_TOKEN][$NPM_TOKEN]"' }, ctx())).content;
    for (const deadline = Date.now() + 5_000; !printed.includes(`${VALUES.status_token}]`) && Date.now() < deadline; ) {
      await sleep(25);
      printed += (await session.execute({ action: "read", id }, ctx())).content;
    }
    expect(printed).toContain(`[${VALUES.status_token}][][]`);
  }, 15_000);
});

describe("what it takes to be handed one", () => {
  test("a command handed a secret asks as a credential leaving — which balanced asks too — saying which, never the value", () => {
    expect(gate("ls -la")).toMatchObject({ action: "run" });
    const asked = gate("twine upload dist/x.whl") as GateAsk;
    expect(asked).toMatchObject({ action: "ask", grantable: true, hardline: true, hardlineClass: "credential-out" });
    expect(asked.reason).toContain("$PYPI_TOKEN");
    expect(asked.reason).not.toContain(VALUES.pypi_token);
  });

  test("a grant for it runs it — and stops matching when the script it runs changes", () => {
    const asked = gate("python3 publish.py") as GateAsk;
    grants = new Set([asked.grant!.grantKey]);
    expect(gate("python3 publish.py")).toMatchObject({ action: "run", via: "grant" });
    writeFileSync(join(dir, "publish.py"), "import os, urllib.request\n");
    expect(gate("python3 publish.py")).toMatchObject({ action: "ask" });
    grants = new Set();
  });

  test("a grant made before the secret was bound is not one for the secret", () => {
    grants = new Set([execGrantKey({ agentId: "nouva", cwd: dir, argv: ["twine", "upload", "dist/x.whl"] })]);
    expect(gate("twine upload dist/x.whl")).toMatchObject({ action: "ask" });
    grants = new Set();
  });

  test("a script outside the agent's roots leaves nothing to bind a grant to: it asks every time", () => {
    expect(gate(`python3 ${join(outside, "publish.py")}`)).toMatchObject({ action: "ask", grantable: false });
  });

  /** The real gate through the real executor, a recorder where the person would be. */
  async function underLevel(level: ApprovalLevel, command: string): Promise<{ asked: boolean; ran: boolean }> {
    let asked = false;
    let ran = false;
    const standIn: Tool = { ...exec, execute: async () => ((ran = true), { content: "ran", isError: false }) };
    const toolset = {
      definitions: [exec.definition],
      get: (name: string) => (name === "exec" ? standIn : undefined),
      requiresApproval: () => true,
      parallelSafe: () => false,
      gate: (_name: string, args: Record<string, unknown>, callCtx: ToolContext) => exec.gate!(args, callCtx),
      blockedPatterns: [],
    };
    const approvals = { request: async () => ((asked = true), { status: "denied" as const }) };
    const caller = new ToolCaller({ approvalLevel: () => level, approvals } as unknown as ExecutorDeps);
    const req = { toolset, agent: fakeAgent(), sessionId: "s", chatId: "c", gateway: "web", gatewayId: "web:dashboard", senderId: "u", chatType: "dm", workspaceDir: dir, workspaceRoots: [dir] } as unknown as TurnRequest;
    const call: ToolCall = { id: "c1", name: "exec", arguments: { command } };
    await caller.run(req, call, 4_000);
    return { asked, ran };
  }

  test("balanced — the default — asks; only `trusted` lets it through unasked", async () => {
    expect(await underLevel("balanced", "twine upload dist/x.whl")).toEqual({ asked: true, ran: false });
    expect(await underLevel("careful", "twine upload dist/x.whl")).toEqual({ asked: true, ran: false });
    expect(await underLevel("trusted", "twine upload dist/x.whl")).toEqual({ asked: false, ran: true });
    // What every command gets is not asked about: that is how every command was before secrets were scoped, and an
    // agent holding one would otherwise ask before everything it ran.
    expect(await underLevel("balanced", "curl https://elsewhere")).toEqual({ asked: false, ran: true });
  });
});

describe("what the agent is told", () => {
  test("each secret with the commands it reaches, and that anything chained to one gets none", () => {
    const agent = fakeAgent();
    const prompt = buildSystemPrompt({
      agent,
      tools: [{ name: "exec", description: "run a command", parameters: {} }],
      harness: { approvalRequired: [], approvalAvailable: true, maxToolIterations: 25, commands: [], truncates: false, workspace: { dir: "/w", roots: ["/w"] }, execSecrets: BINDINGS.slice(0, 3) },
      gateway: "telegram",
      chatId: "1",
      chatType: "dm",
      sessionId: "s",
      timezone: "UTC",
      now: new Date("2026-10-16T00:00:00Z"),
    } as never);
    expect(prompt.text).toContain("$PYPI_TOKEN (only `twine upload`, `python3 publish.py`");
    expect(prompt.text).toContain("(only `printenv NPM_TOKEN`), $STATUS_TOKEN.");
    expect(prompt.text).toContain("anything chained to it gets none");
    expect(prompt.text).not.toContain(VALUES.pypi_token);
  });
});

describe("what boot says", () => {
  test("which agent holds a secret bound to a bare shell — every command by another name", () => {
    const said: { message: string; agent?: string }[] = [];
    addLogSink((entry) => {
      if (entry.level === "warn") said.push({ message: entry.message, ...(entry.agent_id ? { agent: entry.agent_id } : {}) });
    });
    const agent = fakeAgent();
    agent.config.execSecrets = [{ name: "sh_token", commands: ["/bin/bash"] }, ...BINDINGS.slice(0, 2)];
    const config = parseConfig({});
    config.daemon.dataDir = join(dir, "data");
    config.daemon.workspaceDir = join(dir, "workspace");
    config.daemon.agentsDir = join(dir, "agents");
    runPreflightChecks({ config, registry: { all: () => [agent], active: () => [agent] } as never, providers: { available: () => [] } as never, credentialsDir: join(dir, ".credentials"), state: stateRows() });
    expect(said.filter((line) => line.message.includes("exec_secrets."))).toEqual([
      { message: expect.stringContaining('exec_secrets.sh_token is bound to "/bin/bash" alone'), agent: agent.config.id },
    ]);
  });
});

describe("a secret named and never stored", () => {
  test("is said once per agent, not on every command", () => {
    const said: string[] = [];
    addLogSink((entry) => {
      if (entry.message === "exec_secrets names a secret that is not set") said.push(String(entry.agent_id));
    });
    const env = childEnvFor({ credentialsDir: join(dir, ".credentials"), execSecrets: () => BINDINGS, resolve: (name) => VALUES[name] });
    for (let i = 0; i < 3; i += 1) {
      env("nouva");
      env.forCommand("nouva", ["ls"]);
    }
    env("nox");
    expect(said).toEqual(["nouva", "nox"]);
  });
});

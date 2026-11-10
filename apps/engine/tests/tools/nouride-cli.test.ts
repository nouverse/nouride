/**
 * The `nouride` tool — the daemon's own CLI as one tool instead of a copy of `nouride help` in the
 * prompt.
 *
 * Two things are worth testing and they are not the happy path. First, that it really is an adapter:
 * the gate has to be `exec`'s, so the hardline classes, the grants and the ask policy apply without a
 * second implementation to keep in step. Second, that it can reach the install directory at all —
 * `resolveCwd` bounds `cwd` to the workspace roots, which is why the prompt's old "run it from
 * <installDir>" was refused by the sandbox it was telling the agent to use.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecTool } from "@/modules/tools/builtins/exec.ts";
import { createNourideCliTool } from "@/modules/tools/builtins/nouride-cli.ts";
import type { ToolContext } from "@nouride/shared";

const install = mkdtempSync(join(tmpdir(), "nouride-install-"));
const binary = join(install, "nouride");
// A stand-in that reports what it was given, so the argv and cwd the adapter builds are observable.
writeFileSync(
  binary,
  // `env-probe` prints the three variables the CLI falls back to, so a test can assert on the
  // environment the child actually received rather than on what was meant to be passed.
  '#!/bin/sh\necho "argv: $*"\necho "cwd: $(pwd)"\n'
    + 'echo "NOURIDE_AGENT_ID=${NOURIDE_AGENT_ID}"\necho "NOURIDE_GATEWAY_ID=${NOURIDE_GATEWAY_ID}"\n'
    + 'echo "NOURIDE_CHAT_ID=${NOURIDE_CHAT_ID}"\necho "PATH=${PATH}"\n',
);
chmodSync(binary, 0o755);

const workspace = mkdtempSync(join(tmpdir(), "nouride-ws-"));
const ctx = {
  agentId: "nouva", sessionId: "s", chatId: "c", gateway: "web", gatewayId: "web:dashboard", senderId: "dev",
  workspaceDir: workspace, workspaceRoots: [workspace], signal: new AbortController().signal,
} as ToolContext;

function build(blocked: string[] = []) {
  const exec = createExecTool({
    timeoutMs: 15_000,
    maxOutputBytes: 200_000,
    blocked: [],
    policy: { blocked },
  });
  return createNourideCliTool({ exec, installDir: install, command: binary });
}

describe("reaching the install directory", () => {
  test("runs the binary from the install, which the workspace sandbox would otherwise refuse", async () => {
    /**
     * The bug this closes. `resolveCwd` allows only the agent's workspace roots, and the install is
     * not one — so `exec` with `cwd: <installDir>` was refused, and the prompt spent ~1,500 tokens
     * telling the agent to do exactly that. Running from there is what lets the CLI's client find
     * `data/.control-token` by itself, which is why the agent never needs to read it.
     */
    const result = await build().execute({ args: ["agents"] }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("argv: agents");
    // Compared on the basename: macOS resolves /var to /private/var, so the sandbox reports a
    // realpath'd cwd and an equality check here would fail on the platform and not the behaviour.
    // Read off its own line rather than off the end of the output — the stub prints more after it,
    // and a test that depends on line order fails the next time the stub grows.
    const cwd = result.content.split("\n").find((line) => line.startsWith("cwd: "));
    expect(cwd?.endsWith(install.split("/").pop()!)).toBe(true);
  });

  test("the widening is this tool's alone — plain exec still cannot cd there", () => {
    // Granting the cwd through the forwarded context, not through `ExecToolOptions`, is what keeps
    // every other command out of the install directory.
    const exec = createExecTool({
      timeoutMs: 15_000, maxOutputBytes: 200_000, blocked: [],
      policy: { blocked: [] },
    });
    const decision = exec.gate!({ command: ["ls"], cwd: install }, ctx);
    expect(decision.action).toBe("refuse");
  });
});

describe("it is an adapter, not a second implementation", () => {
  test("a fixed-list command keeps its class through it — and scheduling is refused before anyone is asked (0.8.0)", () => {
    /**
     * A hand-written gate here would have dropped the hardline flags — the exact bug `exec.gate` has a forty-line comment
     * about, twice. `cron add --command` was the example until 0.8.0, when an agent began proposing scheduled work with
     * `schedule` instead: the command that would make one is refused, not put to a person (`scheduler/proposals.test.ts`).
     */
    const update = build().gate!({ args: ["update", "--start"] }, ctx);
    expect(update).toMatchObject({ action: "ask", hardline: true, hardlineClass: "replace" });
    const job = build().gate!({ args: ["cron", "add", "--name", "x", "--every", "1h", "--command", "whoami"] }, ctx);
    expect(job).toMatchObject({ action: "refuse", reason: expect.stringContaining("propose one with `schedule`") });
  });

  test("answering an approval asks a person through it, and listing them does not", () => {
    // An agent could once answer the queue — its own request included. Listing what is waiting is how an agent tells
    // somebody, and stays free of the list.
    const answer = build().gate!({ args: ["approvals", "allow-always", "apr_1"] }, ctx);
    expect(answer).toMatchObject({ action: "ask", grantable: false, hardlineClass: "access" });
    expect(build().gate!({ args: ["approvals"] }, ctx)).not.toHaveProperty("hardlineClass");
  });

  test("a system package change asks every time, and is never remembered (0.8.15)", () => {
    // On the fixed list: `allow-always` writes no grant, and `balanced` asks it too. The 0.8.0 list had left it out.
    const install = build().gate!({ args: ["pkg", "install", "poppler-utils"] }, ctx);
    expect(install).toMatchObject({ action: "ask", grantable: false, hardline: true, hardlineClass: "system-packages" });
  });

  test("the operator's veto reaches it too, since the decision is exec's", () => {
    expect(build(["nouride status"]).gate!({ args: ["status"] }, ctx).action).toBe("refuse");
  });
});

describe("it covers what exec covers", () => {
  /**
   * The redirect made this load-bearing. `exec nouride …` is now refused for an agent that holds
   * both, so anything `exec` can do with the CLI and this tool cannot is not a preference any more —
   * it is a capability the agent lost. A long `db backup` is the case: a foreground command dies at the
   * turn deadline.
   */
  test("background and on_complete reach exec, which is what makes a long command possible", async () => {
    const seen: Record<string, unknown>[] = [];
    const spy = { requiresApproval: false, definition: { name: "exec", description: "", parameters: { type: "object" } },
      execute: async (args: Record<string, unknown>) => { seen.push(args); return { content: "", isError: false }; } };

    await createNourideCliTool({ exec: spy as never, installDir: install, command: binary }).execute(
      { args: ["db", "backup"], background: true, on_complete: "summarise any errors" },
      ctx,
    );

    expect(seen[0]?.background).toBe(true);
    expect(seen[0]?.on_complete).toBe("summarise any errors");
    expect(seen[0]?.command).toEqual([binary, "db", "backup"]);
  });

  test("a follower is not what it offers background for — it never ends, and held a job slot for an hour", () => {
    // `exec-timeout.ts` tells the agent a streaming command will not finish in the background either; this
    // description used to recommend exactly that, with `logs --follow` as its example.
    const tool = createNourideCliTool({ exec: { requiresApproval: false, definition: { name: "exec", description: "", parameters: { type: "object" } }, execute: async () => ({ content: "" }) } as never, installDir: install, command: binary });
    expect(JSON.stringify(tool!.definition.parameters)).not.toContain("--follow");
  });

  test("and they are omitted rather than sent as undefined when not asked for", async () => {
    // `exec` decides to background an obviously-long command on its own when the field is absent;
    // sending `background: undefined` would not be the same thing as not sending it.
    const seen: Record<string, unknown>[] = [];
    const spy = { requiresApproval: false, definition: { name: "exec", description: "", parameters: { type: "object" } },
      execute: async (args: Record<string, unknown>) => { seen.push(args); return { content: "", isError: false }; } };

    await createNourideCliTool({ exec: spy as never, installDir: install, command: binary }).execute({ args: ["status"] }, ctx);

    expect("background" in (seen[0] ?? {})).toBe(false);
    expect("on_complete" in (seen[0] ?? {})).toBe(false);
  });

  test("an install for every agent gets the longest a foreground command may have, unless it says otherwise (0.8.1)", async () => {
    // `npm i -g` of a coding CLI was cut off at the 30 seconds every command has, on the live box — reported as failed,
    // and finished all the same.
    const seen: Record<string, unknown>[] = [];
    const spy = { requiresApproval: false, definition: { name: "exec", description: "", parameters: { type: "object" } },
      execute: async (args: Record<string, unknown>) => { seen.push(args); return { content: "", isError: false }; } };
    const tool = createNourideCliTool({ exec: spy as never, installDir: install, command: binary, changesSharedTools: () => true });
    await tool.execute({ args: ["tools", "run", "--", "npm", "i", "-g", "x"] }, ctx);
    await tool.execute({ args: ["tools", "run", "--", "npm", "i", "-g", "x"], timeout_ms: 60_000 }, ctx);
    await tool.execute({ args: ["status"] }, ctx);
    // Read as the CLI reads it, `--json` and all.
    await tool.execute({ args: ["--json", "tools", "run", "--", "npm", "i", "-g", "x"] }, ctx);
    expect(seen.map((args) => args.timeout_ms)).toEqual([240_000, 60_000, undefined, 240_000]);
  });

  test("a coding CLI's update runs in the background unless asked otherwise: cut off at 30 seconds it left the CLI held (2026-11-08)", async () => {
    const seen: Record<string, unknown>[] = [];
    const spy = { requiresApproval: false, definition: { name: "exec", description: "", parameters: { type: "object" } },
      execute: async (args: Record<string, unknown>) => { seen.push(args); return { content: "", isError: false }; } };
    const tool = createNourideCliTool({ exec: spy as never, installDir: install, command: binary, changesSharedTools: () => true });
    await tool.execute({ args: ["agents", "update", "claude-code"] }, ctx);
    await tool.execute({ args: ["--json", "agents", "update", "codex", "2.5.0"] }, ctx);
    await tool.execute({ args: ["agents", "update", "codex"], background: false }, ctx);
    await tool.execute({ args: ["agents", "scan"] }, ctx);
    expect(seen.map((args) => args.background)).toEqual([true, true, false, undefined]);
  });

  test("it tells `exec` the call is the tool, on the context and not in the arguments", async () => {
    /**
     * `exec` refuses this daemon's own CLI and points here, and this is what stops the redirect
     * being a circle — the argv forwarded below is exactly what that rule looks for.
     *
     * Asserted on the contract between the two halves rather than on the outcome, because the
     * outcome hides it: the install directory is added to `workspaceRoots` for the cwd, and the
     * binary lives inside it, so the rule would let this through even with the flag gone. That
     * coincidence is not the mechanism and must not be what the suite is resting on — a tool that
     * one day widens a different directory would turn the redirect into a loop with every test
     * still green.
     *
     * And it has to be the context: arguments are written by the model, so a flag there is a flag
     * the model can set to take the closed door back.
     */
    const seen: ToolContext[] = [];
    const spy = { requiresApproval: false, definition: { name: "exec", description: "", parameters: { type: "object" } },
      execute: async (_args: Record<string, unknown>, c: ToolContext) => { seen.push(c); return { content: "", isError: false }; } };

    await createNourideCliTool({ exec: spy as never, installDir: install, command: binary }).execute({ args: ["status"] }, ctx);

    expect(seen[0]?.ownCliTool).toBe(true);
  });
});

describe("it says who is calling", () => {
  /**
   * The escalation behind three approvals for one update.
   *
   * `nouride update --start --then "…"` needs an agent, a gateway and a chat to aim its follow-up
   * turn at. The CLI reads them from the environment when the flags are absent — and nothing ever
   * set them, so the run failed *after* its approval was granted, and the agent retried with the
   * flags spelled out and paid a second interruption.
   */
  test("the three the CLI falls back to reach the command", async () => {
    const result = await build().execute({ args: ["env-probe"] }, ctx);

    // The stand-in binary prints its own environment, so this asserts what the child actually got.
    expect(result.content).toContain("NOURIDE_AGENT_ID=nouva");
    expect(result.content).toContain("NOURIDE_GATEWAY_ID=web:dashboard");
    expect(result.content).toContain("NOURIDE_CHAT_ID=c");
  });

  test("and nothing else — a tool cannot set a child's PATH", async () => {
    /**
     * `caller_env` is a passthrough handed over by a tool, so `exec` filters it to three names
     * rather than spreading it. Without that filter this is a way to set `PATH` or `LD_PRELOAD` on
     * every command the daemon runs, from inside a tool call.
     */
    const exec = createExecTool({
      timeoutMs: 15_000,
      maxOutputBytes: 200_000,
      blocked: [],
      policy: { mode: "full", ask: "off", askFallback: "deny", allowlist: [], blocked: [] } as never,
    });
    /**
     * Through the context the real caller uses, `ownCliTool` included.
     *
     * `caller_env` is set by exactly one thing in this daemon — the tool above — and `exec` now
     * refuses this install's own CLI from anyone else. Calling it here with a bare `ctx` would be
     * testing the filter through a door production never uses, and would start failing for a reason
     * that has nothing to do with the filter. Which it did.
     */
    const result = await exec.execute(
      { command: [binary, "env-probe"], caller_env: { PATH: "/evil", NOURIDE_AGENT_ID: "nouva" } },
      { ...ctx, ownCliTool: true },
    );

    expect(result.content).toContain("NOURIDE_AGENT_ID=nouva");
    expect(result.content).not.toContain("/evil");
  });

  test("and only from the tool: a model's own exec call cannot say which chat it calls from (S16)", async () => {
    const exec = createExecTool({
      timeoutMs: 15_000,
      maxOutputBytes: 200_000,
      blocked: [],
      policy: { mode: "full", ask: "off", askFallback: "deny", allowlist: [], blocked: [] } as never,
    });
    const result = await exec.execute({ command: ["sh", "-c", "echo chat=${NOURIDE_CHAT_ID:-none}"], caller_env: { NOURIDE_CHAT_ID: "elsewhere" } }, ctx);
    expect(result.content).toContain("chat=none");
  });
});

describe("what it refuses", () => {
  test("empty args, rather than running bare `nouride` and printing usage", async () => {
    // Usage text reads like a successful call. The model would report the command as done.
    const result = await build().execute({ args: [] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-empty array");
  });

  test("arguments are an argv array, so shell syntax is data and not syntax", async () => {
    // No shell is involved, so a metacharacter reaches the CLI as one literal argument.
    const result = await build().execute({ args: ["agents", "; rm -rf /"] }, ctx);
    expect(result.content).toContain("argv: agents ; rm -rf /");
  });
});

describe("what the model reads", () => {
  test("the CLI's terminal colours are taken out — they are tokens that say nothing to a model", async () => {
    // Live (2026-10-20): `nouride provider` reached the model as `\x1b[32m●\x1b[0m \x1b[1mnougate\x1b[0m …`.
    const coloured = "\x1b[32m●\x1b[0m \x1b[1mnougate\x1b[0m \x1b[90mopenai · http://gateway.example:3000\x1b[0m";
    const spy = { requiresApproval: false, definition: { name: "exec", description: "", parameters: { type: "object" } },
      execute: async () => ({ content: coloured, isError: false }) };
    const result = await createNourideCliTool({ exec: spy as never, installDir: install, command: binary }).execute({ args: ["provider"] }, ctx);
    expect(result.content).toBe("● nougate openai · http://gateway.example:3000");
    expect(result.isError).toBe(false);
  });
});

describe("the programs every agent runs (0.8.0)", () => {
  const tool = (orchestrator: string | null) => {
    const exec = createExecTool({
      timeoutMs: 15_000,
      maxOutputBytes: 200_000,
      blocked: [],
      policy: { mode: "full", ask: "off", askFallback: "deny", allowlist: [], blocked: [] } as never,
    });
    return createNourideCliTool({ exec, installDir: install, command: binary, changesSharedTools: (agentId) => agentId === orchestrator });
  };

  test("are the orchestrator's to install and update — refused to any other agent before anything is asked", async () => {
    const run = { args: ["tools", "run", "--", "npm", "i", "-g", "x"] };
    expect(tool("nox").gate!(run, ctx)).toMatchObject({ action: "refuse", reason: expect.stringContaining("Only the orchestrator installs") });
    const refused = await tool("nox").execute(run, ctx);
    expect({ isError: refused.isError, ownHome: refused.content.includes("lands in your own HOME") }).toEqual({ isError: true, ownHome: true });
    const ran = await tool("nouva").execute(run, ctx);
    expect(ran.content).toContain("argv: tools run -- npm i -g x");
  });

  test("the orchestrator's call the command would refuse is refused before anyone is asked, not approved first (0.8.1)", () => {
    // On the live box an admin said yes to an `ln -s` through `tools run`, and the command then refused it.
    const link = { args: ["tools", "run", "--", "ln", "-s", "/a", "/b"] };
    expect(tool("nouva").gate!(link, ctx)).toMatchObject({ action: "refuse", reason: expect.stringContaining("runs an installer") });
    expect(tool("nouva").gate!({ args: ["tools", "run", "--", "npm", "i", "-g", "x"] }, ctx)).not.toMatchObject({ action: "refuse" });
  });

  test("a `--json` anywhere before `--` is read as the CLI reads it — taken off, never taken for the verb", async () => {
    // The CLI takes `--json` off wherever it stands (`dispatchedArgv`); read at fixed positions, it stood where `tools`
    // was looked for, so any agent installed for every agent as the daemon's user, and scheduled a shell job, unasked.
    for (const args of [
      ["--json", "tools", "run", "--", "npm", "i", "-g", "x"],
      ["tools", "--json", "run", "--", "npm", "i", "-g", "x"],
      ["--json=tools", "run", "--", "npm", "i", "-g", "x"],
    ]) {
      expect({ args, gate: tool("nox").gate!({ args }, ctx) }).toMatchObject({ args, gate: { action: "refuse", reason: expect.stringContaining("Only the orchestrator installs") } });
      expect({ args, ran: (await tool("nox").execute({ args }, ctx)).isError }).toEqual({ args, ran: true });
    }
    for (const args of [["--json", "cron", "add", "--command", "id"], ["cron", "--json", "add", "--command", "id"], ["--json", "webhook", "add", "--name", "x"]]) {
      expect({ args, gate: tool("nox").gate!({ args }, ctx) }).toMatchObject({ args, gate: { action: "refuse", reason: expect.stringContaining("propose one with `schedule`") } });
    }
    // The orchestrator's: what `tools run` would refuse is refused as before.
    expect(tool("nouva").gate!({ args: ["--json", "tools", "run", "--", "ln", "-s", "/a", "/b"] }, ctx)).toMatchObject({ action: "refuse", reason: expect.stringContaining("runs an installer") });
    // And what the policy decides is decided on the same words: asked, never answered by `balanced` itself.
    expect(tool("nouva").gate!({ args: ["--json", "approvals", "allow-always"] }, ctx)).toMatchObject({ action: "ask", hardlineClass: "access" });
    expect(tool("nouva").gate!({ args: ["--json", "agent", "external", "kuro", "claude-code"] }, ctx)).toMatchObject({ action: "ask", hardlineClass: "config" });
  });

  test("and every other command is everyone's, as before", async () => {
    expect((await tool(null).execute({ args: ["agents"] }, ctx)).content).toContain("argv: agents");
  });
});

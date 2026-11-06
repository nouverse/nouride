/**
 * The daemon's own CLI, reached through `exec` instead of through the tool built for it.
 *
 * `nouride` exists as a tool for three reasons an agent cannot see from inside `exec`: it runs from
 * the install directory, it carries a `stdin` field that is the one argument this daemon never
 * records, and it keeps the exec grant off the whole CLI. None of that stopped `exec nouride …` from
 * working, so agents took the familiar door and nothing told them otherwise.
 */

import { describe, expect, test } from "bun:test";
import type { Tool, ToolContext } from "@nouride/shared";
import { resolveToolset } from "@/modules/tools/registry.ts";
import { fakeAgent } from "../helpers.ts";

const security = { toolTimeoutMs: 1000, toolMaxOutputBytes: 1024 } as never;
const ctx = { agentId: "nouva" } as ToolContext;

/** A stand-in for the real `exec`: records what reached it, so a pass-through is visible. */
function fakeExec(): Tool & { ran: string[][] } {
  const ran: string[][] = [];
  return {
    ran,
    requiresApproval: false,
    definition: { name: "exec", description: "run a command", parameters: { type: "object" } },
    gate: () => ({ action: "run", via: "test" }) as never,
    async execute(args) {
      ran.push((args.command as string[]) ?? []);
      return { content: "ok", isError: false };
    },
  };
}

const cliTool: Tool = {
  requiresApproval: false,
  definition: { name: "nouride", description: "the daemon's CLI", parameters: { type: "object" } },
  execute: async () => ({ content: "", isError: false }),
};

function toolsetWith(enabled: string[], exec: Tool) {
  const agent = fakeAgent({
    config: { tools: { enabled, approvalRequired: [], blocked: [] } } as never,
  });
  const registry = new Map<string, Tool>([
    ["exec", exec],
    ["nouride", cliTool],
  ]);
  return resolveToolset(agent, registry, security);
}

describe("exec nouride", () => {
  test("is refused and pointed at the tool, with the arguments to use", async () => {
    const exec = fakeExec();
    const result = await toolsetWith(["exec", "nouride"], exec)
      .get("exec")!
      .execute({ command: ["nouride", "cron", "--all"] }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('{"args": ["cron","--all"]}');
    expect(exec.ran).toEqual([]);
  });

  test("is caught by absolute path and through a shell wrapper", async () => {
    const exec = fakeExec();
    const toolset = toolsetWith(["exec", "nouride"], exec);

    // The absolute form is what an agent writes after reading a systemd unit.
    expect((await toolset.get("exec")!.execute({ command: ["/srv/nouride/nouride", "status"] }, ctx)).isError).toBe(true);
    // And this exact line is the documented workaround for the cwd problem, so it is in transcripts.
    expect(
      (await toolset.get("exec")!.execute({ command: ["sh", "-lc", "cd /srv/nouride && nouride status"] }, ctx)).isError,
    ).toBe(true);
    expect(exec.ran).toEqual([]);
  });

  test("gives up rather than guess when the shell is doing work the tool cannot", async () => {
    /**
     * The tool takes one argv array, so a pipe or a redirect is not something it can express — and
     * the first version of this refusal answered `nouride logs -n 500 | grep error` with
     * `{"args": ["logs","-n","500","|","grep","error"]}`, which the CLI takes literally. A refusal
     * that hands back a command running something else is worse than no refusal, so these run.
     */
    const exec = fakeExec();
    const toolset = toolsetWith(["exec", "nouride"], exec);

    for (const script of [
      "nouride logs -n 500 | grep error",
      "nouride status > /tmp/out.txt",
      "nouride status; nouride agents",
      'nouride people set u1 --name "Jane Roe"',
    ]) {
      expect((await toolset.get("exec")!.execute({ command: ["sh", "-lc", script] }, ctx)).isError).toBe(false);
    }
    expect(exec.ran).toHaveLength(4);
  });

  test("leaves every other command alone", async () => {
    const exec = fakeExec();
    const toolset = toolsetWith(["exec", "nouride"], exec);

    // `nouride` as an argument, not as the program — a real and common command.
    await toolset.get("exec")!.execute({ command: ["journalctl", "-u", "nouride", "-n", "20"] }, ctx);
    await toolset.get("exec")!.execute({ command: ["ls", "-la"] }, ctx);

    expect(exec.ran).toEqual([["journalctl", "-u", "nouride", "-n", "20"], ["ls", "-la"]]);
  });

  test("an agent without the tool is not sent to a tool it does not have", async () => {
    /**
     * The `ask_agent` trap: a refusal that names a call the schema does not carry costs the turn and
     * teaches nothing. A pack with `exec` and no `nouride` keeps the only door it has.
     */
    const exec = fakeExec();
    const result = await toolsetWith(["exec"], exec).get("exec")!.execute({ command: ["nouride", "status"] }, ctx);

    expect(result.isError).toBe(false);
    expect(exec.ran).toEqual([["nouride", "status"]]);
  });

  test("the gate still comes from the real exec", async () => {
    // The refusal is about which door, never about whether the command is allowed — losing `gate`
    // here would drop the hardline flags the executor reads to decide on auto-approval.
    const toolset = toolsetWith(["exec", "nouride"], fakeExec());
    expect(toolset.gate("exec", { command: ["ls"] }, ctx).action).toBe("run");
  });
});

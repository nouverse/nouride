/**
 * Every CLI verb that writes a setting says what happened: "applied", or "saved — takes effect after
 * a restart" with how to restart — decided by the daemon's answer, `restartRequired`, never by the verb.
 *
 * Each worded it its own way before: `gateway add` warned nothing was connected yet, `mcp add` that it was connecting,
 * `access mode` said "no restart", and the rest printed a tick and nothing about whether the change was in force.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Client } from "@nouride/cli-kit";
import { access } from "../../../cli/src/commands/access.ts";
import { agentAction } from "../../../cli/src/commands/agents.ts";
import { gateway } from "../../../cli/src/commands/gateway.ts";
import { mcp } from "../../../cli/src/commands/mcp.ts";
import { mcpServerCommand } from "../../../cli/src/commands/mcp-server.ts";
import { memoryCommand } from "../../../cli/src/commands/memory.ts";
import { peopleCommand } from "../../../cli/src/commands/people.ts";
import { provider } from "../../../cli/src/commands/provider.ts";
import { skills } from "../../../cli/src/commands/skills.ts";
import { toolBudget } from "../../../cli/src/commands/tool-budget.ts";
import { turnBudget } from "../../../cli/src/commands/turn-budget.ts";
import { plain } from "../cli-harness.ts";

/** A daemon that answers every write with `answer`, and every read with what the verbs ask before writing. */
function daemon(answer: Record<string, unknown>): Client {
  const reads: Record<string, unknown> = {
    "/status": { gateways: [], agents: [] },
    "/policy/tool-iterations": { maxToolIterations: 250, min: 5, max: 9999, editable: true },
    "/policy/turn-seconds": { turnSeconds: 600, queueSeconds: 900, min: 30, max: 7200, editable: true },
  };
  const write = async <T>() => ({ ok: true, ...answer }) as T;
  return { baseUrl: "http://127.0.0.1:9", get: async <T>(path: string) => reads[path] as T, post: write, put: write, del: write } as unknown as Client;
}

let lines: string[] = [];
let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  lines = [];
  log = spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? ""))));
});
afterEach(() => log.mockRestore());

const said = () => lines.join("\n");

/** Each save path the CLI has, as an argv against its command. */
const SAVES: [name: string, run: (client: Client) => Promise<void>][] = [
  ["gateway add", (c) => gateway(c, ["add", "--platform", "telegram", "--name", "nox", "--token", "5550002222:AAH-test"])],
  ["gateway rm", (c) => gateway(c, ["rm", "telegram:nox"])],
  ["mcp add", (c) => mcp(c, ["add", "--agent", "nouva", "--name", "files", "--command", "mcp-files"])],
  ["mcp rm", (c) => mcp(c, ["rm", "--agent", "nouva", "--name", "files"])],
  ["access mode", (c) => access(c, ["mode", "allowlist"])],
  ["mcp-server on", (c) => mcpServerCommand(c, ["on"])],
  ["memory set", (c) => memoryCommand(c, ["set", "prompt_recent", "8"])],
  ["provider add", (c) => provider(c, ["add", "gate", "--url", "https://gate.example.com/v1", "--no-probe"])],
  ["provider rm", (c) => provider(c, ["rm", "gate"])],
  ["tool-budget", (c) => toolBudget(c, ["60"])],
  ["tool-budget --agent", (c) => toolBudget(c, ["--agent", "nouva", "120"])],
  ["turn-budget", (c) => turnBudget(c, ["300"])],
  ["turn-budget --agent", (c) => turnBudget(c, ["--agent", "nouva", "follow"])],
  ["people set", (c) => peopleCommand(c, ["set", "sam", "--name", "Sam"])],
  ["people remove", (c) => peopleCommand(c, ["remove", "sam"])],
  ["skills on", (c) => skills(c, ["on", "web-research", "nouva"])],
  ["agent disable", (c) => agentAction(c, ["disable", "nox"])],
  ["agent external", (c) => agentAction(c, ["external", "nox", "claude-code", "--profile", "work"])],
  ["agent internal", (c) => agentAction(c, ["internal", "nox"])],
];

describe("a save from the CLI says what happened", () => {
  for (const [name, run] of SAVES) {
    test(`${name}: "applied" when the daemon needs no restart`, async () => {
      await run(daemon({ restartRequired: false }));
      expect(said()).toMatch(/: applied$/m);
      expect(said()).not.toContain("restart");
    });

    test(`${name}: "saved (takes effect after a restart)", and how, when it does`, async () => {
      await run(daemon({ restartRequired: true }));
      expect(said()).toContain(": saved (takes effect after a restart)");
      expect(said()).not.toMatch(/: applied$/m);
    });
  }

  test("an answer that says nothing of a restart changed nothing read at boot: applied", async () => {
    await access(daemon({ mode: "pair" }), ["mode", "pair"]);
    expect(said()).toContain("access mode is now pair: applied");
  });

  test("a gateway's restart line says how to restart and confirm it connected", async () => {
    await gateway(daemon({ restartRequired: true }), ["add", "--platform", "telegram", "--name", "nox", "--token", "5550002222:AAH-test"]);
    expect(said()).toContain('nouride restart --then "confirm telegram:nox connected"');
  });
});

/**
 * A long-lived process run as an agent's own user (0.8.1): an external agent's coding CLI is that agent's whole shell,
 * and its stdio MCP server can be one, so each goes behind the same helper its commands do — and a process that names
 * no agent does not.
 */

import { afterEach, expect, test } from "bun:test";
import { runAgentCommandsThrough, spawnLongLived } from "../src/index.ts";

afterEach(() => runAgentCommandsThrough(null));

async function firstLine(agent?: string): Promise<string | undefined> {
  const child = spawnLongLived(["sh", "-c", 'echo "as:${NR_AGENT:-daemon}"; read never'], agent ? { agent } : {});
  try {
    return (await child.lines().next()).value;
  } finally {
    child.endInput();
    child.kill("SIGKILL");
    await child.exited;
  }
}

test("with an agent, it starts behind the helper's prefix for that agent", async () => {
  runAgentCommandsThrough({ prefix: (agent) => ["env", `NR_AGENT=${agent}`], put: () => [] });
  expect(await firstLine("nova")).toBe("as:nova");
});

test("without one, or where no helper was found, it runs as the daemon's user", async () => {
  runAgentCommandsThrough({ prefix: (agent) => ["env", `NR_AGENT=${agent}`], put: () => [] });
  expect(await firstLine()).toBe("as:daemon");
  runAgentCommandsThrough(null);
  expect(await firstLine("nova")).toBe("as:daemon");
});

/**
 * A scheduled command gets the environment a command an agent runs by hand gets.
 *
 * It got the allowlist and the agent's `exec_secrets`, and no temporary directory: so a nightly script
 * wrote its temp files to /tmp, where a delete is hardline and nothing ever cleaned them up, while the
 * same script run through `exec` used the agent's scratchpad.
 */

import { afterEach, expect, test } from "bun:test";
import { runAgentCommandsThrough } from "@nouride/runtime";
import { scratchpadFor, privateWorkspace } from "@nouride/persona";
import type { Job } from "@nouride/shared";
import type { Pipeline } from "@/modules/pipeline/index.ts";
import { childEnvOf } from "../helpers.ts";
import { pipelineBench, type Bench } from "../pipeline-bench.ts";

let bench: Bench | undefined;
afterEach(() => bench?.dispose());

/** A pipeline whose agent's commands are handed `DEPLOY_TOKEN` — only `./deploy.sh`, given `scoped`. */
async function pipelineWith(scoped: boolean): Promise<{ pipeline: Pipeline; workspaceDir: string }> {
  // No connections: a scheduled command's sandbox is all this is about.
  bench = await pipelineBench({
    gateways: [],
    deps: { childEnv: childEnvOf({ DEPLOY_TOKEN: "from-exec-secrets" }, (argv) => !scoped || argv?.[0] === "./deploy.sh") },
  });
  return { pipeline: bench.pipeline, workspaceDir: bench.config.daemon.workspaceDir };
}

test("a scheduled command writes its temporary files to the agent's scratchpad, with its credentials", async () => {
  const { pipeline, workspaceDir } = await pipelineWith(false);
  const sandbox = pipeline.cronExecutors().commandSandbox({ agentId: "nouva", payload: { kind: "command", argv: ["./deploy.sh"] } } as Job);
  const scratchpad = scratchpadFor(privateWorkspace(workspaceDir, "nouva"));
  expect(sandbox?.env.TMPDIR).toBe(scratchpad);
  expect(sandbox?.env.TMP).toBe(scratchpad);
  expect(sandbox?.env.DEPLOY_TOKEN).toBe("from-exec-secrets");
  expect(sandbox?.env.PATH).toBeDefined();
});

test("a scheduled command holds the secrets bound to its own command line — and its output is masked with every one (S6)", async () => {
  const { pipeline } = await pipelineWith(true);
  const deploy = pipeline.cronExecutors().commandSandbox({ agentId: "nouva", payload: { kind: "command", argv: ["./deploy.sh"] } } as Job);
  expect(deploy?.env.DEPLOY_TOKEN).toBe("from-exec-secrets");
  const curl = pipeline.cronExecutors().commandSandbox({ agentId: "nouva", payload: { kind: "command", argv: ["curl", "https://elsewhere"] } } as Job);
  expect(curl?.env.DEPLOY_TOKEN).toBeUndefined();
  expect(curl?.secrets?.DEPLOY_TOKEN).toBe("from-exec-secrets");
});

test("where each agent is its own user, a scheduled command's HOME is its agent's folder, and its installs its own", async () => {
  const { pipeline, workspaceDir } = await pipelineWith(false);
  runAgentCommandsThrough({ prefix: () => [], put: () => [] });
  try {
    const sandbox = pipeline.cronExecutors().commandSandbox({ agentId: "nouva", payload: { kind: "command", argv: ["./deploy.sh"] } } as Job);
    const own = privateWorkspace(workspaceDir, "nouva");
    expect({ home: sandbox?.env.HOME, bin: sandbox?.env.NOURIDE_BIN }).toEqual({ home: own, bin: `${own}/.local/bin` });
    expect(sandbox?.env.PATH?.split(":")[0]).toBe(`${own}/.local/bin`);
  } finally {
    runAgentCommandsThrough(null);
  }
});

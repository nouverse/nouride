/**
 * The agents an upgrade to 0.7.9 took the ssh-agent socket from, named at boot.
 *
 * Every command and stdio MCP server of every agent held `SSH_AUTH_SOCK` until 0.7.9; now an agent's pack has to ask.
 * A default that changes under an install that relied on it fails far from the cause — a `git push` waiting on a
 * passphrase nobody can type — so the agents it changes for are said once at warn, and listed by `nouride doctor`.
 */

import { describe, expect, test } from "bun:test";
import { agentsLosingSshAgent } from "@/boot/preflight.ts";

const SOCKET = "/run/user/1000/ssh-agent.sock";
const agent = (id: string, enabled: string[], extra: { sshAgent?: boolean; stdio?: boolean } = {}) => ({
  config: {
    id,
    tools: { enabled },
    mcpServers: extra.stdio ? [{ transport: "stdio" }] : [{ transport: "streamable-http" }],
    ...(extra.sshAgent === undefined ? {} : { sshAgent: extra.sshAgent }),
  },
});

describe("which agents lost the socket", () => {
  test("those that run commands, sessions or stdio servers and have not said either way", () => {
    expect(
      agentsLosingSshAgent(
        [agent("ops", ["exec"]), agent("pair", ["session"]), agent("tools", ["read"], { stdio: true }), agent("reader", ["read", "web_fetch"])],
        SOCKET,
      ),
    ).toEqual(["ops", "pair", "tools"]);
  });

  test("not one that asked for it, nor one that said it does not need it — both have decided", () => {
    expect(agentsLosingSshAgent([agent("ops", ["exec"], { sshAgent: true }), agent("web", ["exec"], { sshAgent: false })], SOCKET)).toEqual([]);
  });

  test("nobody, when the daemon has no socket to hand — nothing an agent did used one", () => {
    expect(agentsLosingSshAgent([agent("ops", ["exec"])], undefined)).toEqual([]);
  });
});

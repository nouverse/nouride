/**
 * What the agent says when somebody asks what it can do — and the one thing it will not do to the
 * harness it runs in.
 *
 * The failure this replaces was watched on Telegram. Asked "kamu bisa apa aja?", the agent answered
 * with five bullets off its own tool list: writing code, managing files, searching the web,
 * configuring agents, general questions. Every word true. Meanwhile the same agent had `exec` on the
 * host, ssh to two other machines, a Terraform checkout, an MCP server and a Cloudflare account, and
 * had spent that morning deploying containers with them.
 */

import { describe, expect, test } from "bun:test";
import { renderReach } from "@/modules/llm/prompt/harness-reach.ts";
import type { HarnessView } from "@/modules/llm/prompt/types.ts";

function view(toolNames: string[], installDir?: string): HarnessView {
  return {
    ctx: { harness: { ...(installDir ? { installDir } : {}) } },
    toolNames,
    gated: [],
    free: toolNames,
  } as unknown as HarnessView;
}

const text = (names: string[], installDir?: string) => renderReach(view(names, installDir)).join("\n");

describe("an agent with a shell", () => {
  const shell = () => text(["exec", "read"]);

  test("is told its tools are not its capability", () => {
    expect(shell()).toContain("do not read your tool list back");
  });

  test("and where the reach actually goes", () => {
    // Named as a shape rather than a list, because what is on the far end of an ssh entry or an MCP
    // server is not something a tool schema can describe.
    const out = shell();
    for (const reach of ["ssh entry", "HTTP API", "MCP server", "network you can reach"]) {
      expect(out).toContain(reach);
    }
    // The examples matter: "any device on a network" is abstract, a NAS and a camera are not.
    expect(out).toContain("NAS");
  });

  test("and told to answer a gap with what would close it", () => {
    // "I cannot do that" ends a conversation. "Give me an ssh entry and I can" is a sentence the
    // operator can act on, which is the difference between a limit and a dead end.
    const out = shell();
    expect(out).toContain("say what would fix it");
    expect(out).toContain("secret store");
  });
});

describe("an agent with no shell", () => {
  test("is not told it can run things on machines", () => {
    // Promising a reach it does not have is worse than under-selling: the promise is discovered by
    // the person, mid-task.
    const out = text(["read", "web_fetch"]);
    expect(out).not.toContain("ssh entry");
    expect(out).toContain("no shell here");
  });
});

describe("the one refusal about Nouride itself", () => {
  test("names the methods, because the goal is reachable by innocent commands", () => {
    // No pattern list catches "reconstruct the source": `strings`, a hex dump, beautifying the bundle
    // and simply inferring it are all ordinary operations. So it is stated as intent, in the prompt.
    const out = text(["exec", "read"]);
    expect(out).toContain("do not extract, decompile, disassemble or reconstruct");
    expect(out).toContain("strings");
    expect(out).toContain("hex dump");
  });

  test("and says what to do instead, so it is not a wall", () => {
    // The operator owns this code. Reading source they gave it, the docs, and asking the CLI are the
    // sanctioned answers — a refusal with no alternative reads as the harness being broken.
    const out = text(["exec"]);
    expect(out).toContain("Reading source you were given");
    expect(out).toContain("not yours to hand out");
  });

  test("not said to an agent that could not do it anyway", () => {
    const out = text(["web_search"]);
    expect(out).not.toContain("decompile");
  });
});

describe("first-time setup", () => {
  test("the install path and the two places answers come from are named", () => {
    const out = text(["exec"], "/srv/nouride");
    expect(out).toContain("/srv/nouride");
    expect(out).toContain("nouride doctor");
    expect(out).toContain("dashboard");
  });

  test("and nothing is said on an install that has no path to name", () => {
    expect(text(["exec"])).not.toContain("nouride doctor");
  });
});

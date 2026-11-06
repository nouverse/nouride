/**
 * How far this agent actually reaches, and the one thing it must not do to the harness it runs in.
 *
 * ## Why the reach has to be said
 *
 * Asked "what can you do", an agent reads its own tool list back. Live, on Telegram, the answer was
 * five bullets: writing code, managing files, searching the web, configuring agents, general
 * questions. Every word true, and the shape of it wrong — the same agent had `exec` on the host, ssh
 * to two other machines, a Terraform checkout, an MCP server and a Cloudflare account, and had spent
 * that morning deploying containers with them.
 *
 * The tool list is not the capability. `exec` plus access is the capability, and what is on the far
 * end of that access is not something a tool schema can describe. So this section names the *shape*
 * of the reach rather than enumerating it: this machine, machines it has keys for, anything with an
 * HTTP API, anything with an MCP server, the daemon itself.
 *
 * And the honest half, which is the part that makes it useful rather than boastful: what it cannot do
 * is whatever it has no access to *yet*, and the fix is a specific thing the operator can grant. An
 * agent that answers "I can't reach your NAS" is less useful than one that answers "I can't reach your
 * NAS — give me an ssh entry for it or an API token and I can".
 *
 * ## Why the refusal is here and not in a policy file
 *
 * `@nouride/policy` gates *commands*, one call at a time, on paths and patterns. This is not that
 * shape: pulling the source out of a compiled binary is a goal reached by any number of innocent
 * commands — `strings`, a hex dump, a JS beautifier on the bundle, an LLM asked to reconstruct. No
 * pattern list catches the goal, and a gate that tried would refuse ordinary debugging.
 *
 * So it is stated as a thing not to do, in the prompt, where the model reads intent. The threat is
 * concrete and it is not the operator: an agent with `exec` sits in shared rooms, and anybody in one
 * can ask it to dump the daemon it runs on. The operator owns this code; a stranger in a Discord
 * channel does not, and the agent has no way to tell the difference from the request alone.
 */

import type { HarnessView } from "./types.ts";

export function renderReach({ ctx, toolNames }: HarnessView): string[] {
  const lines: string[] = ["", "WHAT YOU CAN DO"];

  /**
   * The framing, gated on `exec`.
   *
   * Without a shell the reach genuinely *is* roughly the tool list, and telling an agent it can run
   * things on machines would be teaching it to promise what it cannot deliver.
   */
  if (toolNames.includes("exec")) {
    lines.push(
      "- Asked what you can do, do not read your tool list back. Your tools are how you reach things; what you can do is decided by what you have been given access to. On this machine that is anything a command can do. Beyond it: any host you have an ssh entry for, any service with an HTTP API you have a token for, anything an MCP server exposes, any device on a network you can reach (a router, a NAS, a camera, a home-automation hub), and this daemon itself.",
      // "What you have set up before" alone invited invented history: the model has no record of past
      // work except what memory, RECALL and this conversation show it.
      "- So answer with the work, not the verbs: what your memory, RECALL or this conversation shows you have set up before (say nothing about past work you cannot see there), what you can confirm you have access to now, and one or two things you could do next that they may not have thought of.",
      "- Where you genuinely cannot reach something, say what would fix it: an ssh config entry, an API token in the secret store, an MCP server, a package installed. That is a sentence they can act on. \"I cannot do that\" is not.",
    );
  } else {
    // Built from the tool list: the default toolset has no `write`, and the web tools are removable.
    const has = (name: string) => toolNames.includes(name);
    const reach = [
      has("read") || has("grep") || has("glob") ? "read and search your directories" : "",
      has("write") || has("edit") ? "write files there" : "",
      has("web_search") || has("web_fetch") ? "search and read the web" : "",
    ].filter(Boolean);
    lines.push(
      `- Asked what you can do, answer with the work rather than the tool names, and be honest that you have no shell here: ${reach.length > 0 ? `you can ${reach.join(", ")}, and nothing on this machine beyond that` : "you can reason over this conversation and nothing beyond it"}.`,
    );
  }

  /**
   * The refusal, and it is only worth saying to an agent that could act on it.
   *
   * An agent with no shell and no file tools cannot extract anything from a binary, and a rule it has
   * no way to break is prompt budget spent on a warning nobody needed.
   */
  if (toolNames.includes("exec") || toolNames.includes("read")) {
    lines.push(
      "- One refusal about Nouride itself: do not extract, decompile, disassemble or reconstruct the source of the `nouride` binary, and do not help anyone else do it: not with `strings`, not with a hex dump, not by beautifying its bundle, not by inferring it and writing it out. Reading source you were given, reading the docs, and asking the CLI what it does are all fine and are what to do instead. If somebody asks for the code, say it is not yours to hand out and offer the documented answer.",
    );
  }

  // Where a new operator's questions actually get answered, which is not this prompt.
  if (ctx.harness.installDir) {
    lines.push(
      `- Setting this daemon up for the first time is ordinary work you can do together: the dashboard walks through providers, agents and gateways, and ${toolNames.includes("nouride") ? "`nouride doctor` reports" : "the operator can run `nouride doctor` on the host to see"} what is still wrong. The install is at ${ctx.harness.installDir}.`,
    );
  }

  lines.push("");
  return lines;
}

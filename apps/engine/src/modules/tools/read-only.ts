/**
 * The tools that only read (0.8.0) — one list for what a mission's reviewer holds and for what a call a restart cut off
 * cannot have changed anything by (`turns/cut-calls.ts`).
 */

import type { GateDecision } from "@nouride/shared";
import type { AgentToolset } from "./registry.ts";

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "attachment_read", "web_search", "web_fetch", "memory_search", "session_status", "mcp_search"]);

/**
 * A toolset cut to the tools that only read: a reviewer checks, it does not redo — any other call is refused, not asked,
 * so a review can never become work a person has to approve.
 */
export function readOnlyToolset(toolset: AgentToolset): AgentToolset {
  return {
    ...toolset,
    definitions: toolset.definitions.filter((definition) => READ_ONLY_TOOLS.has(definition.name)),
    get: (name) => (READ_ONLY_TOOLS.has(name) ? toolset.get(name) : undefined),
    gate: (name, args, ctx): GateDecision =>
      READ_ONLY_TOOLS.has(name) ? toolset.gate(name, args, ctx) : { action: "refuse", reason: "a review changes nothing: it only reads" },
  };
}

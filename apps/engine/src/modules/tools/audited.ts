/**
 * Every tool call written down: who ran what, with which arguments, whether it failed, how long it took (§17.2 item 1).
 *
 * One wrapper for every tool the daemon runs — the built-ins the registry makes (`createBuiltinTools`) and the tools an
 * agent's MCP servers offer (`McpManager`), which went unrecorded until 0.7.4: an issue opened on GitHub through
 * a server left no row saying who asked for it.
 *
 * The row is the audit table's, written as the call returns. What it says rides back on the result
 * (`metadata.audit`) to the executor, which writes it to the turn's event stream as an `audit` row together with
 * the call's `tool_done` — one transaction, so a follower pairs them by `callId` and never sees one without the
 * other (`EventedTurnStore.step`). A call outside a turn — the daemon's own MCP server — leaves the table row only.
 *
 * Two records of one call, on purpose (decided for 0.7.8). The table is the security record: kept
 * `[retention] audit_days`, beside what no turn does — sign-ins, config and access changes, the MCP server's calls —
 * and read by `nouride audit` and `nouride turns show`. The event is the turn's history, kept as long as the turn
 * (`session_days`), and read by whoever follows the stream. Folding one into the other would make a conversation
 * deleted for privacy take its audit trail with it, or keep its arguments as long as the security record is kept.
 */

import { ToolError, createLogger, toUserMessage, type Logger, type Tool, type ToolResult } from "@nouride/shared";
import type { AuditPort } from "@/commons/audit.store.ts";
import { redact } from "@nouride/secrets";

const log = createLogger("tools");

/**
 * A tool's arguments as the audit log may keep them.
 *
 * Two rules, and the first is absolute: **`stdin` is never recorded.** That parameter exists so a
 * credential can reach a command without being written down, and every sink for these arguments is
 * permanent — the exec grant, the audit table, the daemon's own log table. Keeping it would turn
 * `--stdin` into a slower way of doing exactly what it was built to avoid.
 *
 * The rest is redacted rather than dropped. A command line is the most useful thing in this table,
 * so it stays; a credential-shaped run inside one does not. An agent that pastes a token inline has
 * already been told not to, and this is what stops it being permanent when it does anyway.
 */
export function auditableArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "stdin") {
      // Named, not omitted: "there was a value here and it was deliberately not kept" is a different
      // fact from "no value was passed", and an investigation needs to tell them apart.
      out[key] = "[not recorded]";
      continue;
    }
    if (typeof value === "string") {
      out[key] = redact(value).text;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => (typeof item === "string" ? redact(item).text : item));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * `tool`, recording each call as a `tool_exec` row — a result and a throw alike, with the turn's id so its calls can be
 * read by it, and the names of any secrets a command was handed, never a value.
 *
 * A throw is answered here as the error result the model is told — sanitized, the detail in the log — rather than
 * rethrown, so its audit row reaches the stream like any other. The executor's own catch stays, for a tool this did
 * not wrap.
 */
export function audited(name: string, tool: Tool, audit: AuditPort): Tool {
  return {
    ...tool,
    execute: async (args, ctx) => {
      const startedAt = Date.now();
      const recorded = tool.auditArgs ? tool.auditArgs(args, ctx) : auditableArgs(args);
      const entry = { action: "tool_exec", agentId: ctx.agentId, actor: ctx.senderId, gatewayId: ctx.gatewayId, chatId: ctx.chatId, ...(ctx.turnId ? { turnId: ctx.turnId } : {}) };
      const said = (details: Record<string, unknown>): Record<string, unknown> => {
        audit.record({ ...entry, details });
        return { ...(ctx.callId ? { callId: ctx.callId } : {}), ...details };
      };
      let result: ToolResult;
      try {
        result = await tool.execute(args, ctx);
      } catch (err) {
        const details = said({ tool: name, args: recorded, threw: String(err), ms: Date.now() - startedAt });
        logToolThrow(log, name, err, { agent_id: ctx.agentId, turn_id: ctx.turnId });
        // Sanitized: the model gets a usable summary, the log keeps the detail (§17.2 item 5).
        return { content: `Tool "${name}" failed: ${toUserMessage(err)}`, isError: true, metadata: { audit: details } };
      }
      const secrets = Array.isArray(result.metadata?.secrets) ? { secrets: result.metadata.secrets } : {};
      const details = said({ tool: name, args: recorded, error: result.isError === true, ms: Date.now() - startedAt, ...secrets });
      return { ...result, metadata: { ...result.metadata, audit: details } };
    },
  };
}

/**
 * A tool's throw, in the journal at the level it deserves. A `ToolError` is a refusal the tool wrote on purpose — a
 * path outside the workspace, an argument missing — and the model is answered as for any refusal; logged at `error` as
 * "tool threw", every refused read read as a fault in the daemon, and went to the error sinks with it. Anything else
 * thrown is one.
 */
export function logToolThrow(log: Logger, tool: string, err: unknown, ids: { agent_id: string; turn_id?: string | undefined }): void {
  if (err instanceof ToolError) log.warn("tool refused the call", { ...ids, tool, error: String(err) });
  else log.error("tool threw", { ...ids, tool, error: String(err) });
}

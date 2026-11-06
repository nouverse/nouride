/**
 * The stdio transport: a child process speaking newline-delimited JSON.
 *
 * Thin by design — the protocol and the request lifecycle live in `protocol.ts` and `client.ts`, which
 * is why they can be tested without a server on the machine. What is left here is the part that
 * genuinely needs a process: spawn it, read its lines, notice when it dies.
 */

import { createLogger } from "@nouride/shared";
import { spawnLongLived } from "@nouride/runtime";
import type { McpTransport, McpTransportFactory, McpTransportHandlers } from "./client.ts";

const log = createLogger("mcp.stdio");

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  /**
   * Extra environment for the child, merged over a **minimal** inherited set.
   *
   * Not the daemon's whole environment: an MCP server is third-party code, and handing it every
   * credential this process happens to hold is a decision nobody would make deliberately. `PATH` and
   * `HOME` are inherited because a command that cannot be found or cannot read its own config is not
   * a server anyone can use.
   */
  env?: Record<string, string>;
  cwd?: string;
  /** The agent it serves: it runs as that agent's own user where the daemon found the helper, as its commands do. */
  agent?: string;
  /** How long `close` waits after each step — end of input, SIGTERM, SIGKILL. For a test; the defaults are the spec's. */
  closeWaitsMs?: CloseWaits;
}

interface CloseWaits {
  input: number;
  term: number;
  kill: number;
}

/**
 * The MCP spec's order for stopping a stdio server, each wait bounded: close its input, then SIGTERM, then SIGKILL.
 *
 * It was `kill(); await exited` — SIGTERM and a wait with no end. A server that ignores SIGTERM while its input is open
 * (`mcp-atlassian`) never exited, so the wait never ended: `agent reload` awaited it and connected nothing, the next
 * reload found nothing to close and connected, and every such pair left one more server running until the daemon
 * restarted — nine copies, about 100 MB each, after a day of edits (issue #11 on nouride-releases).
 */
const CLOSE_WAITS: CloseWaits = { input: 2_000, term: 3_000, kill: 2_000 };

/**
 * Inherited so the child can be found and can locate its own config. Nothing else carries over.
 *
 * Not `SSH_AUTH_SOCK`, since 0.7.9 (S11): the socket signs with every key the ssh-agent holds, for whoever asks, and
 * every server of every agent got it. The engine puts it in `env` for the servers of an agent that asked for it.
 */
const INHERITED_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"];

export function stdioTransport(options: StdioTransportOptions): McpTransportFactory {
  return (handlers: McpTransportHandlers): McpTransport => {
    const child = spawnLongLived([options.command, ...(options.args ?? [])], {
      env: childEnv(options.env),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.agent ? { agent: options.agent } : {}),
    });

    let closing = false;

    // Both streams are drained for the life of the process. Not awaited — these are the read loops,
    // and the transport's caller is the one holding the conversation.
    void (async () => {
      try {
        for await (const line of child.lines()) handlers.onMessage(line);
      } catch (err) {
        log.debug("stdout reader ended", { command: options.command, error: String(err) });
      }
    })();

    void (async () => {
      try {
        // Read even when nobody wants it: a child whose stderr pipe fills stops writing and then
        // stops responding, which presents as a server that hangs for no reason.
        for await (const line of child.stderrLines()) handlers.onLog?.(line);
      } catch {
        // Nothing to do about a closed stderr, and it is never the interesting failure.
      }
    })();

    void child.exited.then((code) => {
      if (closing) return;
      handlers.onClose(`exited with code ${code}`);
    });

    return {
      send(raw) {
        child.writeLine(raw);
      },
      async close() {
        closing = true;
        // Waited for, so a restart cannot race the old child for the same resources — a server holding a socket or a
        // lock file would otherwise refuse to start and look like a config error. But never without an end.
        const waits = options.closeWaitsMs ?? CLOSE_WAITS;
        const exitedWithin = async (ms: number): Promise<boolean> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), ms)));
          try {
            return await Promise.race([child.exited.then(() => true), late]);
          } finally {
            clearTimeout(timer);
          }
        };
        child.endInput();
        if (await exitedWithin(waits.input)) return;
        child.kill("SIGTERM");
        if (await exitedWithin(waits.term)) return;
        child.kill("SIGKILL");
        if (!(await exitedWithin(waits.kill))) log.warn("an MCP server did not exit after SIGKILL", { command: options.command, pid: child.pid });
      },
    };
  };
}

function childEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * How a server is reached: the transport its block asks for, with its credentials resolved — and a stdio server's user,
 * HOME and folder, and the ssh-agent socket where its agent's pack asked for one. The connections made over it, and
 * what is done when one fails, are `mcp.ts`'s.
 */

import type { McpServerConfig } from "@nouride/shared";
import { sseTransport, stdioTransport, streamableHttpTransport, type McpTransportFactory } from "@nouride/mcp";
import { agentCommandsHaveOwnUsers } from "@nouride/runtime";
import { ownHomeEnv } from "./builtins/exec.ts";
import type { McpLoginPort } from "./mcp.ts";

/** What reaching a server needs of the manager's options. */
interface Reach {
  secrets?: { require(name: string, usedBy: string): string };
  logins?: McpLoginPort;
  privateDir?: (agentId: string) => string;
  timeoutMs?: number;
}

/**
 * The transport a server's config asks for, with its credential resolved.
 *
 * Throws rather than returning null so the caller can report *why* — "needs a url" and "the
 * secret is missing" are different problems with different fixes, and a server that simply
 * vanished from the tool list told the operator neither.
 */
export function transportFor(agentId: string, config: McpServerConfig, reach: Reach): McpTransportFactory {
  if (config.transport === "stdio") {
    if (!config.command) throw new Error("a stdio server needs a command");
    // As the agent's own user where it has one (0.8.1): run as the daemon's, a shell or file server given to one agent
    // read the database, the vault and every other agent's folder — all the wall its commands stand behind. Its HOME
    // and installs are the agent's own, as its commands' are; the server's block still wins, written for that server.
    const own = agentCommandsHaveOwnUsers() ? reach.privateDir?.(agentId) : undefined;
    const env = { ...ownHomeEnv(own), ...config.env, ...secretEnv(config, reach) };
    // Started where the agent can be: the daemon's own folder is closed to its user.
    const cwd = config.cwd ?? own;
    return stdioTransport({
      command: config.command,
      ...(config.args ? { args: config.args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(cwd ? { cwd } : {}),
      agent: agentId,
    });
  }

  if (!config.url) throw new Error(`transport "${config.transport}" needs a url`);

  // A login's credential, or none to find out whether the server wants one (`McpLoginPort.credentialFor`).
  const auth = reach.logins?.credentialFor(agentId, config);
  const options = {
    url: config.url,
    headers: httpHeaders(config, reach),
    ...(auth ? { auth } : {}),
    ...(reach.timeoutMs ? { timeoutMs: reach.timeoutMs } : {}),
  };
  return config.transport === "sse"
    ? sseTransport(options)
    : streamableHttpTransport(options);
}

/**
 * A stdio server's credential variables, resolved from the secret store (`envSecrets`, 0.7.19) — here, once per start,
 * like an http server's header: a secret that is not set stops the start with the variable and the secret named.
 */
function secretEnv(config: McpServerConfig, reach: Reach): Record<string, string> {
  const named = Object.entries(config.envSecrets ?? {});
  if (named.length === 0) return {};
  const secrets = reach.secrets;
  if (!secrets) throw new Error(`env_secrets needs a secret store`);
  return Object.fromEntries(named.map(([variable, name]) => [variable, secrets.require(name, `MCP server "${config.name}" env ${variable}`)]));
}

/**
 * Literal headers from config, plus the credential the secret store holds.
 *
 * The secret is resolved here, once per connect, rather than inside the transport: the transport
 * is in a package that has no business knowing what a secret store is, and a credential that
 * cannot be resolved should stop the connection with a clear message instead of turning into a
 * 401 on every call.
 */
function httpHeaders(config: McpServerConfig, reach: Reach): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers };
  if (!config.authSecret) return headers;

  const secrets = reach.secrets;
  if (!secrets) throw new Error(`auth_secret "${config.authSecret}" needs a secret store`);

  const value = secrets.require(config.authSecret, `MCP server "${config.name}"`);
  if (config.authHeader) headers[config.authHeader] = value;
  else headers.Authorization = `Bearer ${value}`;
  return headers;
}

/**
 * A stdio server, with the ssh-agent socket in its environment when its agent's pack asked for it.
 *
 * `@nouride/mcp` stopped handing the daemon's `SSH_AUTH_SOCK` to every child it starts, so this is the one way a
 * server gets it. A server's own `env` still wins: an operator who named a socket for one server meant that one.
 */
export function withAgentSocket(server: McpServerConfig, sshAgent: boolean): McpServerConfig {
  const socket = process.env.SSH_AUTH_SOCK;
  if (!sshAgent || server.transport !== "stdio" || !socket) return server;
  return { ...server, env: { SSH_AUTH_SOCK: socket, ...server.env } };
}

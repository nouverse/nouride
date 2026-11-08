/**
 * The install's MCP servers as the library and an agent list them (`routes/mcp.ts`), and the form that adds one.
 */

import type { McpServerConfig } from "@nouride/shared";

export interface McpServer {
  name: string;
  transport: McpServerConfig["transport"];
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authHeader?: string;
  /**
   * Whether a credential is stored for this server.
   *
   * A boolean, not the secret's name and certainly not its value: the form needs to know whether to
   * say "replace" or "add", and nothing more than that ever has to reach the browser.
   */
  hasCredential: boolean;
  /** A stdio server's credential variables, each with whether its secret is set — never the secret. Absent before 0.7.19. */
  envSecrets?: { name: string; set: boolean }[];
  /** Live state. `running` false means configured but the daemon has not started it yet. */
  connected: boolean;
  running: boolean;
  tools: number;
  schemaBytes?: number; // what its tools add to every request the agent makes; absent before 0.7.9
  /** It waits for a person to log in — Connect does (0.7.19). Absent before 0.7.19. */
  needsLogin?: boolean;
  /** What its login is, when it has one — never a token. */
  login?: McpLoginView;
  /** Whether this agent uses it. */
  on?: boolean;
  /** The credential this agent uses: the library's, or its own. */
  credential?: "library" | "own";
  /** Whose login it is reached with: the library's, or this agent's own. */
  loginAs?: "library" | "own";
  /** Every agent brings its own credential: the library shares none. */
  perAgent?: boolean;
  /** On an agent's page (0.7.21): the server's tools this agent has, when it chose — absent, all of them. */
  chosenTools?: string[];
  /** When it chose: every tool the server offers, and what the ones left out would add to each request. */
  toolsTotal?: number;
  withheldBytes?: number;
  /** Names its list gives that the server does not offer. */
  unknownTools?: string[];
}

/** A server of the install's library (`GET /mcp/library`, 0.7.19): how it runs, its credential, and who uses it. */
export interface McpLibraryServer {
  name: string;
  transport: McpServerConfig["transport"];
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authHeader?: string;
  perAgent?: boolean;
  /** The library's own credential is stored — never the secret. */
  hasCredential: boolean;
  envSecrets: { name: string; set: boolean }[];
  /** The library's login, when it has one. */
  login?: McpLoginView;
  needsLogin: boolean;
  /** Every agent, whether it uses the server, whether with its own credential, and — when on — how it is doing. */
  agents: { id: string; on: boolean; own: boolean; connected?: boolean; tools?: number; needsLogin?: boolean }[];
}

/** A remote MCP server's login, as the MCP page shows it (0.7.19). */
export interface McpLoginView {
  scope: string | null;
  /** A dashboard account's name, or `cli`. */
  loggedInBy: string;
  loggedInAt: number;
  expiresAt: number | null;
}

export interface McpServerInput {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Where the credential goes when it is not a bearer token, e.g. `X-Api-Key`. */
  authHeader?: string;
  /**
   * The credential itself. Stored under a generated name; never written to `config.toml`.
   *
   * Omitted on an update means "keep the stored one", so editing a URL does not require pasting the
   * key again — the same rule the gateway form follows.
   */
  token?: string;
  /**
   * A stdio server's credential variables, the whole set: a `value` to keep in the secret store, or nothing to keep the
   * one it has. Taken off here, taken off the server. Never written to `config.toml` as values.
   */
  envSecrets?: Record<string, { value?: string }>;
}

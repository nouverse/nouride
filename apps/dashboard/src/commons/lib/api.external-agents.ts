/**
 * External agents' coding CLIs (0.8.1) — `routes/external-agents.ts`: which this box has, one agent's CLI settings,
 * and its sign-in, run on the box and answered from here.
 */

import { control, post, request } from "./api.client";

/** An external agent's coding CLI, on its row of the agents (0.8.1). */
export interface AgentExternal {
  cli: string;
  profile: string;
  /** As the CLI is called; absent before 0.8.1's accounts. */
  name?: string;
  /** Whether its Nouride skills reach the CLI. */
  skills?: boolean;
  /** The model its pack sets the CLI to; null for the CLI's own default. */
  model?: string | null;
  /** The CLI's own default, as its last session named it; null before its first. */
  cliDefault?: string | null;
}

export interface ScannedCli {
  id: string;
  name: string;
  /** Who makes it: "Anthropic". */
  maker?: string;
  command: string;
  installed: boolean;
  version?: string;
  install: string;
  /** Whether a sign-in can be run for it from here. */
  login: boolean;
  loginNote?: string;
}

/** Whether this box can hold a CLI's session: what the agents' commands may hold, and what one needs. */
export interface CliRoom {
  enough: boolean;
  bytes: number;
  needs: number;
}

export interface CliLoginView {
  running: boolean;
  output: string;
  links: string[];
  /** What it exited with; null while it runs. */
  exitCode: number | null;
  /** Ended signed in: exited 0, not stopped, and where it prints a token, the token was taken. */
  signedIn: boolean;
  /** Stopped before it signed in, whatever it exited with. Absent from a build before it was said. */
  stopped?: boolean;
  /** The profile it signs in. */
  profile?: string;
}

/** One sign-in of an agent's CLI, kept for it: whether it is signed in, as the CLI said when asked. */
export interface CliProfile {
  name: string;
  /** The one the agent answers with. */
  inUse: boolean;
  /** Null where the CLI did not get as far as saying. */
  signedIn: boolean | null;
  reason: string | null;
}

export type CliPreset = "folder" | "risky" | "all";

export interface AgentCli {
  cli: string;
  profile: string;
  permissions: CliPreset;
  model: string | null;
  /** The models its CLI offered when its last session opened, suggested in the model field; none before its first. */
  models: { value: string; name?: string }[];
  /** The agent's `[llm] effort`, else `[llm.defaults] effort`; null where neither is set. */
  effort: string | null;
  /** The efforts its CLI offered for the model its last session was on, `current` on the one it is set to; none before its first. */
  efforts: { value: string; name?: string; current?: string }[];
  /** What its effort can be set to here (0.8.7), and the install's `[llm.defaults] effort` that "default" follows. */
  effortChoices: string[];
  effortDefault: string | null;
  /** Why it cannot answer now — not installed, not signed in — or null. */
  unavailable: string | null;
  /** That it cannot, in the page's words (0.8.23); `unavailable` is its CLI's own, under Details. */
  plain?: string | null;
  login: CliLoginView | null;
}

/** One account of a coding CLI, and the agents on it with whether each can answer. */
export interface CliAccountView {
  name: string;
  /** A shared account: whether it is signed in. One sign-in per agent: null — each agent's says. */
  signedIn: boolean | null;
  agents: { id: string; name: string; signedIn: boolean | null }[];
}

export interface CliAccountsView {
  id: string;
  name: string;
  /** Who makes it: "Anthropic". */
  maker?: string;
  installed: boolean;
  version?: string;
  install: string;
  /** Signed in once for every agent on an account, or once per agent. */
  shared: boolean;
  canLogin: boolean;
  loginNote?: string;
  accounts: CliAccountView[];
}

/** A coding CLI as it is listed: who makes it, then its name — "Anthropic: Claude Code" (the owner, 0.8.1). */
export const cliLabel = (cli: { name: string; maker?: string }): string => (cli.maker ? `${cli.maker}: ${cli.name}` : cli.name);

const account = (cli: string, name: string) => `${control}/cli-accounts/${encodeURIComponent(cli)}/${encodeURIComponent(name)}`;

export const externalAgentsApi = {
  /** Asks each CLI on each account's agents, so it takes seconds; `fresh` asks again. */
  cliAccounts: (fresh = false) => request<{ clis: CliAccountsView[] }>(`${control}/cli-accounts${fresh ? "?fresh=1" : ""}`),
  addCliAccount: (cli: string, name: string) => post<{ ok: true }>(`${control}/cli-accounts`, { cli, name }),
  removeCliAccount: (cli: string, name: string) => request<{ ok: true }>(account(cli, name), { method: "DELETE" }),
  startAccountLogin: (cli: string, name: string) => post<{ login: CliLoginView }>(`${account(cli, name)}/login`, {}),
  accountLogin: (cli: string, name: string) => request<{ login: CliLoginView | null }>(`${account(cli, name)}/login`),
  answerAccountLogin: (cli: string, name: string, text: string) => post<{ login: CliLoginView }>(`${account(cli, name)}/login/answer`, { text }),
  stopAccountLogin: (cli: string, name: string) => post<{ ok: true }>(`${account(cli, name)}/login/stop`, {}),
  externalClis: (fresh = false) => request<{ room: CliRoom; clis: ScannedCli[] }>(`${control}/external-clis${fresh ? "?fresh=1" : ""}`),
  agentCli: (id: string) => request<AgentCli>(`${control}/agents/${id}/cli`),
  /** Admin only. An empty model is the key removed. */
  setAgentCli: (id: string, settings: Partial<{ profile: string; permissions: CliPreset; model: string; effort: string }>) => post<{ ok: true }>(`${control}/agents/${id}/cli`, settings),
  /** Asks the CLI on each profile, so it takes seconds; `fresh` asks again rather than take the last answer. */
  agentCliProfiles: (id: string, fresh = false) => request<{ profiles: CliProfile[]; separate: boolean; models: { value: string; name?: string }[] }>(`${control}/agents/${id}/cli/profiles${fresh ? "?fresh=1" : ""}`),
  /** On the profile the agent answers with, or on the one named — a new name is a new profile. */
  startCliLogin: (id: string, profile?: string) => post<{ login: CliLoginView }>(`${control}/agents/${id}/cli/login`, profile ? { profile } : {}),
  answerCliLogin: (id: string, text: string) => post<{ login: CliLoginView }>(`${control}/agents/${id}/cli/login/answer`, { text }),
  stopCliLogin: (id: string) => post<{ ok: true }>(`${control}/agents/${id}/cli/login/stop`, {}),
};

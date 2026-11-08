/**
 * External agents' coding CLIs (0.8.1) — `routes/external-agents.ts`: which this box has, one agent's CLI settings,
 * and its sign-in, run on the box and answered from here.
 */

import { control, post, request } from "./api.client";
import type { AgentCli, CliAccountsView, CliLoginView, CliPreset, CliProfile, CliRoom, ScannedCli } from "@nouride/wire";

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

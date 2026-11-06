/**
 * A coding-CLI agent's own model, set through `agent_configure` (0.8.8). Such an agent has two: its CLI's
 * (`[external] model`), which answers its turns, and its pack's `[llm]`, which answers Nouride's reviews and memory for
 * it. The tool sets the CLI's — the key its CLI tab writes — and only to a model the CLI offers on the account the agent
 * uses, the list that tab offers; `[llm]` stays the dashboard's. Nox asked for Opus and was refused outright: the model
 * was a person's to set on the tab, though its effort was its own.
 *
 * The person in the chat is told, from what to what and on which account: an account's limits are shared by every agent
 * on it, so one agent moving to a larger model spends the others' share too.
 */

import type { CliModel } from "@/commons/daemon-state.ts";

/** What `agent_configure` reads of an agent's coding CLI. */
export interface CliModels {
  /** The CLI's name, as a person reads it: "Claude Code". */
  name: string;
  /** What it offered when its last session opened, on the account in use — the CLI tab's list. */
  offered: CliModel[];
  /** The model that session opened on, as lists name it; null before its first. */
  runsOn: string | null;
}

export interface CliModelChange {
  cli: string;
  account: string;
  from: string;
  to: string;
}

/** The model asked for, against what the CLI offers on the agent's account: the change, or why not. */
export function cliModelChange(model: string, external: { cli: string; profile?: string; model?: string }, cli: CliModels | undefined): CliModelChange | { refused: string } {
  const name = cli?.name ?? external.cli;
  const account = external.profile ?? "default";
  const offered = cli?.offered ?? [];
  if (offered.length === 0) return { refused: `${name} has not said which models it offers on the account "${account}". It says so as a session opens. A person can set it on your CLI tab.` };
  if (!offered.some((entry) => entry.value === model)) {
    return { refused: `"${model}" is not a model ${name} offers on the account "${account}". It offers: ${offered.map((entry) => (entry.name ? `${entry.value} (${entry.name})` : entry.value)).join(", ")}.` };
  }
  return { cli: name, account, from: external.model ?? cli?.runsOn ?? `${name}'s own default`, to: model };
}

/** What the person in the chat is told. */
export function cliModelNotice(agent: string, change: CliModelChange): string {
  return `${agent} changed its ${change.cli} model from ${change.from} to ${change.to}, on the account "${change.account}". Every agent on that account shares its limits.`;
}

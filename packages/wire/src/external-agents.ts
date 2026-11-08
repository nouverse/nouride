/**
 * External agents' coding CLIs (`routes/external-agents.ts`): which this box has, one agent's CLI settings, its
 * sign-in, and the accounts each CLI is signed in on.
 */

import type { CliStanding } from "@nouride/acp";

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
  /** The package that carries it, and the versions of it this Nouride was tested with (0.8.24). */
  package?: string;
  tested?: { lowest: string; highest: string };
  /** The newest published, where the server could ask. */
  newest?: string;
  standing?: CliVersionView;
}

/** Where a coding CLI's version stands (`cliStanding` in `@nouride/acp`). */
export type { CliStanding };

export interface CliVersionView {
  standing: CliStanding;
  /** What an update installs: the newest version this Nouride was tested with. */
  offer?: string;
  /** The newest published, where it is past every version this Nouride was tested with. */
  untested?: string;
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
  /** The version to go back to, where its CLI's new version failed its check (0.8.24). */
  wayBack?: string | null;
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
  package?: string;
  standing?: CliVersionView;
  install: string;
  /** Signed in once for every agent on an account, or once per agent. */
  shared: boolean;
  canLogin: boolean;
  loginNote?: string;
  accounts: CliAccountView[];
}

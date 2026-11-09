/**
 * Coding-CLI accounts (0.8.1): what the Models page lists under Coding CLIs — each CLI, its accounts, and the agents on
 * each with whether they can answer. An agent's account is its `[external] profile`.
 *
 * Two kinds, by what the CLI can do, the same on the page:
 * - **shared** — a CLI with a `sharedLogin` (Claude Code's `setup-token`) signs an account in once; the long-lived token
 *   it prints is kept in the secret store and handed to each agent's CLI on that account as it starts. Every agent on it
 *   answers once it is signed in.
 * - **one sign-in per agent** — any other CLI (Codex's ChatGPT sign-in) has no token to share:
 *   copying one sign-in into several agents' folders would have them refresh it out from under each other, so each
 *   agent on the account signs in once, in its own folder, and the page says which have.
 *
 * Either way the agent runs inside the CLI itself, signed in with the CLI's own sign-in; nothing here takes a sign-in
 * out of a CLI for anything else.
 */

import type { CliRow, CliVersionView } from "@nouride/acp";
import { PROFILE_NAME } from "@nouride/persona";
import type { LoadedAgent } from "@nouride/shared";
import type { CliProfile } from "./profiles.ts";
import type { ScannedCli } from "./scan.ts";

export interface CliAccountView {
  name: string;
  /** A shared account: whether its token is kept. One sign-in per agent: null — each agent's line says. */
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
  /** The package `version` is of, and where that version stands against the ones this Nouride was tested with (0.8.24). */
  package?: string;
  standing?: CliVersionView;
  install: string;
  /** Signed in once for every agent on an account, or once per agent. */
  shared: boolean;
  /** Whether Nouride can run its sign-in here, and what to know beside it. */
  canLogin: boolean;
  loginNote?: string;
  accounts: CliAccountView[];
}

export interface AccountsDeps {
  file?: { load(): Record<string, string[]>; save(accounts: Record<string, string[]>): void };
  /** The secret store, for shared accounts' tokens. Absent: none can be shared (a test's service). */
  tokens?: { get(name: string): string | undefined; set(name: string, value: string): Promise<void>; delete(name: string): Promise<boolean> };
}

/** Where a shared account's token is kept in the secret store: a name of its own, the CLI's and the account's. */
const tokenSecretName = (cli: string, account: string) => `cli-${cli}-${account}`;

const profileOf = (agent: LoadedAgent) => agent.config.external?.profile ?? "default";

export class CliAccounts {
  constructor(private readonly deps: AccountsDeps) {}

  /** A shared account's token, for the CLI of an agent on it; undefined where none is kept. */
  token(row: CliRow, account: string): string | undefined {
    return row.sharedLogin ? this.deps.tokens?.get(tokenSecretName(row.id, account)) : undefined;
  }

  async keepToken(row: CliRow, account: string, token: string): Promise<void> {
    if (!this.deps.tokens) throw new Error("this daemon keeps no secrets");
    await this.deps.tokens.set(tokenSecretName(row.id, account), token);
    this.add(row.id, account);
  }

  /** The accounts added for a CLI on the Models page, which any of its agents may pick. */
  names(cli: string): string[] {
    return this.deps.file?.load()[cli] ?? [];
  }

  add(cli: string, name: string): { ok: true } | { ok: false; error: string } {
    if (!PROFILE_NAME.test(name)) return { ok: false, error: "An account's name is lowercase letters, digits and dashes, at most 24." };
    const kept = this.deps.file?.load() ?? {};
    if (!(kept[cli] ?? []).includes(name)) this.deps.file?.save({ ...kept, [cli]: [...(kept[cli] ?? []), name].sort() });
    return { ok: true };
  }

  /**
   * An account no agent uses, and its token with it — `tokenRemoved` says whether one was kept to remove, and
   * `tokenError` why it stayed: the account is off the list by then, so a store that failed is said, not thrown past the
   * audit row (an account once vanished with its secret still kept). Refused, `users` names the agents that
   * use it, for the dashboard's words at its route (0.8.20).
   */
  async remove(cli: string, name: string, agents: readonly LoadedAgent[]): Promise<{ ok: true; tokenRemoved: boolean; tokenError?: string } | { ok: false; error: string; users: string[] }> {
    const users = agents.filter((agent) => agent.config.external?.cli === cli && profileOf(agent) === name).map((agent) => agent.config.displayName);
    if (users.length > 0) return { ok: false, error: `${users.join(", ")} ${users.length === 1 ? "uses" : "use"} it. Move ${users.length === 1 ? "it" : "them"} to another account first.`, users };
    const kept = this.deps.file?.load() ?? {};
    this.deps.file?.save({ ...kept, [cli]: (kept[cli] ?? []).filter((entry) => entry !== name) });
    try {
      return { ok: true, tokenRemoved: (await this.deps.tokens?.delete(tokenSecretName(cli, name))) ?? false };
    } catch (err) {
      return { ok: true, tokenRemoved: false, tokenError: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Every CLI with its accounts — the ones added, and the ones a pack names — and each account's agents with whether
   * they can answer, as `check` asks the CLI on that agent's account.
   */
  async list(rows: readonly CliRow[], scanned: readonly ScannedCli[], agents: readonly LoadedAgent[], check: (agent: LoadedAgent) => Promise<CliProfile[]>): Promise<CliAccountsView[]> {
    const kept = this.deps.file?.load() ?? {};
    const views: CliAccountsView[] = [];
    for (const row of rows) {
      const scan = scanned.find((entry) => entry.id === row.id);
      const users = agents.filter((agent) => agent.config.external?.cli === row.id);
      const names = [...new Set([...(kept[row.id] ?? []), ...users.map(profileOf)])].sort();
      const accounts: CliAccountView[] = [];
      for (const name of names) {
        const on: CliAccountView["agents"] = [];
        for (const agent of users.filter((entry) => profileOf(entry) === name)) {
          const inUse = (await check(agent)).find((profile) => profile.inUse);
          on.push({ id: agent.config.id, name: agent.config.displayName, signedIn: inUse?.signedIn ?? null });
        }
        accounts.push({ name, signedIn: row.sharedLogin ? this.token(row, name) !== undefined : null, agents: on });
      }
      views.push({
        id: row.id,
        name: row.name,
        ...(row.maker ? { maker: row.maker } : {}),
        installed: scan?.installed ?? false,
        ...(scan?.version ? { version: scan.version } : {}),
        ...(row.package ? { package: row.package } : {}),
        ...(scan?.standing ? { standing: scan.standing } : {}),
        install: row.install,
        shared: Boolean(row.sharedLogin),
        canLogin: Boolean(row.sharedLogin ?? row.login?.length),
        ...(row.loginNote ? { loginNote: row.loginNote } : {}),
        accounts,
      });
    }
    return views;
  }
}

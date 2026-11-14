/**
 * The accounts an agent goes on with when the one it starts on reaches its limit: which may be added, and what is
 * saved. Only accounts signed in once for every agent can be moved to; an agent's first account stays its first.
 */

import type { CliAccountView } from "@nouride/wire";

/** The accounts that can still be added after `listed`: signed in, of this CLI, and not listed already. */
export function addable(accounts: readonly Pick<CliAccountView, "name" | "signedIn">[], listed: readonly string[]): string[] {
  return accounts.filter((account) => account.signedIn === true && !listed.includes(account.name)).map((account) => account.name);
}

/** What is saved: the first account and the ones after it, in order, each once. */
export function accountList(first: string, next: readonly string[]): string[] {
  return [first, ...next.filter((name, index) => name !== first && next.indexOf(name) === index)];
}

/**
 * Every dashboard account is someone in People.
 *
 * A conversation is read by its person (`web/control/whose.ts`), and an account is its person's by `web:<account id>`
 * among their ids. A new account gets one when it is made (`POST /users`); this is for the accounts made before that,
 * and the first admin, made by the boot before any config could be written. Each with no person gets one of its own,
 * named as the account is (`linkAccount`), never somebody already in People by their name.
 *
 * Only where the config is a file: on a fresh install's defaults, writing People would write the config the setup
 * wizard is waiting to write.
 */

import { createLogger, type Person } from "@nouride/shared";
import { accountIdentity, personOf, type LinkResult } from "@/modules/config/settings/identities.ts";

const log = createLogger("boot.account-people");

interface Account {
  id: string;
  username: string;
  displayName: string;
}

export async function personForEachAccount(input: {
  accounts: readonly Account[];
  people: () => readonly Person[];
  link: (params: { account: Account; actor?: string }) => Promise<LinkResult>;
}): Promise<string[]> {
  const made: string[] = [];
  for (const account of input.accounts) {
    if (personOf(input.people(), accountIdentity(account.id))) continue;
    const linked = await input.link({ account, actor: "nouride" });
    if (linked.ok) made.push(account.username);
    else log.warn("an account has no person in People, and one could not be written", { user: account.username, error: linked.error });
  }
  if (made.length > 0) log.info("each account is someone in People now", { made });
  return made;
}

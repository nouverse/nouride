/**
 * `nouride access allow --from <file> --gateway <connection> [--dry-run]`: a whole list of people let in ahead.
 *
 * One sender a line: a phone number for WhatsApp, an account's id elsewhere, and after a comma, a semicolon or a tab
 * the name to keep for them. An empty line and one that starts with `#` are skipped. The connection reads each id its
 * own way (a number with its country code becomes WhatsApp's address of it), and says which lines it could not read.
 *
 * `nouride access allow` took one id a call: ten thousand numbers of a business's own contacts were ten thousand
 * calls, and the other way to let their replies through was `open`, which the daemon refuses beside an agent that can
 * run commands.
 */

import type { AccessImported } from "@nouride/wire";
import { type Client, BOLD, DIM, GREEN, RESET, YELLOW, fail, say, usageError } from "@nouride/cli-kit";
import { sendersIn } from "@nouride/shared";
import { readStdin, readTextFile } from "@nouride/runtime";

/** What a line holds, by where the connection is: said beside the lines that could not be read. */
const HOW = "WhatsApp: a phone number with its country code (+62 812…, not 0812…). Telegram and Discord: an account's id or its @username.";

const USAGE = "nouride access allow --from <file|-> --gateway <connection> [--dry-run]";

const count = (n: number) => n.toLocaleString("en-US");

export async function allowFrom(client: Client, asked: { from: string | undefined; gateway: string | undefined; dryRun: boolean }): Promise<void> {
  const { from, gateway, dryRun } = asked;
  if (!from || !gateway) usageError(`usage: ${USAGE}`, "e.g. nouride access allow --from numbers.txt --gateway whatsapp:main --dry-run");

  let text: string;
  try {
    text = from === "-" ? await readStdin() : await readTextFile(from);
  } catch (err) {
    if ((err as { code?: unknown })?.code !== "EACCES") return fail(`${from} is not a file here.`);
    // On a server, root's `nouride` runs as the service account, which may not read root's own files.
    return fail(
      `Cannot read ${from}: permission denied for ${process.env.USER || "this account"}, the account this command runs as.`,
      `Hand it over on standard input: nouride access allow --from - --gateway ${gateway}${dryRun ? " --dry-run" : ""} < ${from}`,
    );
  }
  const senders = sendersIn(text);
  if (senders.length === 0) fail(`${from === "-" ? "The list" : from} names nobody.`, "One sender a line; a name may follow after a comma.");

  const done = await client.post<AccessImported>("/access/import", { gateway, senders, dryRun });
  const kept = done.added + done.already;
  const parts = [
    `${count(done.added)} new`,
    ...(done.already ? [`${count(done.already)} in already`] : []),
    ...(done.blocked ? [`${count(done.blocked)} blocked, left out`] : []),
    ...(done.duplicates ? [`${count(done.duplicates)} said twice`] : []),
    ...(done.invalid.count ? [`${count(done.invalid.count)} could not be read`] : []),
  ].join(" · ");
  if (kept === 0 && done.blocked === 0) {
    fail(`None of the ${count(done.read)} lines is a sender on ${gateway}.`, `For example: ${done.invalid.examples.slice(0, 3).join(", ")}. ${HOW}`);
  }
  say(dryRun ? `${YELLOW}○${RESET} would allow ${BOLD}${count(done.added)}${RESET} on ${gateway} ${DIM}(${parts}; nothing was written)${RESET}` : `${GREEN}✓${RESET} allowed ${BOLD}${count(done.added)}${RESET} on ${gateway} ${DIM}(${parts})${RESET}`);
  if (done.invalid.count) {
    say(`${DIM}  could not be read, for example: ${done.invalid.examples.join(", ")}${done.invalid.count > done.invalid.examples.length ? ", …" : ""}${RESET}`);
    say(`${DIM}  ${HOW}${RESET}`);
  }
  if (!dryRun && done.added) say(`${DIM}  Approved without a code; revoke or block any of them like any other.${RESET}`);
}

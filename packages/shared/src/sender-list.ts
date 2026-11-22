/**
 * A list of people as somebody writes one, read into its lines: what `nouride access allow --from` and the Access
 * page's "Let in a list" both hand the daemon, so a file reads the same wherever it is given.
 *
 * One sender a line: their id as written, and after a comma, a semicolon or a tab the name to keep for them, which is
 * everything after that first mark. An empty line and one that starts with `#` are passed over, and a spreadsheet's
 * export works as it is: its quotes are taken off a cell. What an id means is the connection's to say
 * (`Gateway.senderIdOf`), not this file's.
 */

/** The senders a list names, a line each: its id as written, and the name after it where one is given. */
export function sendersIn(text: string): { id: string; name?: string }[] {
  const senders: { id: string; name?: string }[] = [];
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cut = line.search(/[,;\t]/);
    // A spreadsheet's export wraps a cell in quotes.
    const unquoted = (cell: string) => cell.trim().replace(/^"(.*)"$/, "$1").trim();
    const id = unquoted(cut < 0 ? line : line.slice(0, cut));
    const name = cut < 0 ? "" : unquoted(line.slice(cut + 1));
    if (id) senders.push({ id, ...(name ? { name } : {}) });
  }
  return senders;
}

/**
 * The running daemon's config, kept to what the loader makes of its file — the one way a save reaches it.
 *
 * Every writer used to mirror its own change into the config object by hand, and the mirrors drifted from the loader
 * with nothing to show it until a restart: a WhatsApp connection saved from the dashboard took Telegram's reconnect
 * timings and a session directory resolved without its `~`, an edit to one moved its ws bridge into the process, and
 * a session directory once became `String(undefined)`. Now a save that lands is read back by the loader's own steps
 * (`readConfigText`), and what it changed is put into the running copy here. No writer mirrors anything.
 *
 * Only what the save changed — the loader's reading of the file before it against its reading after. The running copy
 * is what the daemon booted with plus every save since, and a hand edit to the file waits for the restart it always
 * needed: an unrelated save must not make a new `data_dir` half true while the database is still open under the old.
 *
 * In place, never by replacement. Parts of the daemon hold a section rather than the whole config — the reflection
 * engine `[skills.learning]`, the exec tool `[security.exec]`, the scheduler and its store `[cron]`, the provider registry
 * `[providers]`, the agent registry `[skills] off` — and a section replaced would leave each reading the old one for
 * the life of the process. A list is one value, as the loader merges it: what the file now says, in the same array.
 */

import { createLogger, type GlobalConfig } from "@nouride/shared";
import { sameValue } from "./edit-check.ts";
import { readConfigText } from "./global/index.ts";

const log = createLogger("config");

type Table = Record<string, unknown>;

/**
 * Make `running` say what `after` — the loader's reading of the file just written at `path` — says, wherever it
 * differs from the file as it was before the save (`before`, its text). A file that did not load before the save, a
 * hand edit under a running daemon, leaves nothing to tell the save's change from the rest: the running copy is then
 * made to say all of `after`.
 */
export function followFile(running: GlobalConfig, input: { path: string; before: string; after: GlobalConfig }): void {
  let previous: GlobalConfig;
  try {
    previous = readConfigText(input.before, input.path);
  } catch (err) {
    log.warn("the config file did not load before this save: the running daemon now holds all of it", {
      path: input.path,
      error: err instanceof Error ? err.message : String(err),
    });
    previous = running;
  }
  follow(running as unknown as Table, previous as unknown as Table, input.after as unknown as Table);
}

/** `live` made to say what `next` says wherever `next` differs from `previous` — every table kept, and changed in place. */
function follow(live: Table, previous: Table, next: Table): void {
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const was = previous[key];
    const now = next[key];
    if (sameValue(was, now)) continue;
    if (!(key in next)) {
      delete live[key];
      continue;
    }
    const held = live[key];
    if (isTable(was) && isTable(now) && isTable(held)) follow(held, was, now);
    // The items that did not change stay the objects they were, so whatever holds one still holds what the list says.
    else if (Array.isArray(now) && Array.isArray(held)) held.splice(0, held.length, ...now.map((item, at) => (sameValue(item, held[at]) ? held[at] : item)));
    else live[key] = now;
  }
}

/** A table of the config — not a list, and not a TOML date, which is a value. */
function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

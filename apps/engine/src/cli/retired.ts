/**
 * The CLI's old spellings, refused by name for one release.
 *
 * 0.7.x read each beside the spelling that replaced it, untaught, so a script or a cron job written against an older
 * release went on working (`docs/DEPLOY.md` § The upgrade window). 0.8.0 reads none of them. `grammar.ts` refuses a
 * flag or a word a command does not read, but "does not take --isolated" leaves whoever wrote the script to find out
 * what it became — so through 0.8.x each is refused with exit 2 naming what to write instead, before the daemon is
 * asked anything. 0.9.0 deletes this file, and an old spelling is then a word the command does not read like any other.
 */

import { usageError } from "@/cli/ui.ts";

/** An old flag and what replaced it — named only where the form reads the replacement: `cron add`, not `cron update`. */
const FLAGS: Readonly<Record<string, string>> = {
  "--isolated": "--session isolated",
  "--token-stdin": "--stdin",
  "--key-stdin": "--stdin",
  "--value-stdin": "--stdin",
};

/** An old action, as `command action`, what replaced it, and — where the old word promised more — what it does not do. */
const ACTIONS: Readonly<Record<string, { now: string; hint?: string }>> = {
  // `approve` could be read as either answer, and was read as the narrower one.
  "approvals approve": { now: "approvals allow-once" },
  // It printed "forgot sam" while every conversation and fact about them stayed (0.7.4).
  "people forget": {
    now: "people remove",
    hint: "It takes somebody out of People; what memory keeps about them stays until `nouride memory forget <key>`.",
  },
};

const READ_UNTIL = "Read through 0.7.x; 0.8.0 takes only the new spelling.";

/**
 * Exit 2 when what was given is an old spelling of `command`'s, naming what to write instead; nothing otherwise. A word
 * where the command has no such action, or a flag the form does not read (`what` is the form, `reads` its flags).
 */
export function refuseRetired(
  command: string,
  given: { action: string } | { flag: string; what: string; reads: readonly string[] },
): void {
  if ("action" in given) {
    const retired = ACTIONS[`${command} ${given.action}`];
    if (!retired) return;
    usageError(`\`nouride ${command} ${given.action}\` is gone: write \`nouride ${retired.now}\` instead.`, retired.hint ?? READ_UNTIL);
  }
  const now = FLAGS[given.flag];
  if (now && given.reads.includes(now.split(" ")[0]!)) {
    usageError(`\`${given.what}\` no longer takes ${given.flag}: write ${now} instead.`, READ_UNTIL);
  }
}

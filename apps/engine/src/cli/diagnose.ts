/**
 * Turning a rejected request into a sentence that names the actual problem.
 *
 * Extracted from the CLI so it can be tested. The message this replaces cost a real debugging session:
 * three installs existed on one machine, a stale daemon from one of them held the shared default port,
 * and `nouride doctor` from a different directory said *"The daemon rejected the control token — delete
 * data/.control-token and restart it."* The token was fine. Deleting it and restarting would have
 * produced a second failure (the port is taken) with no relation to the first.
 */

/**
 * A 401 from the control API, explained.
 *
 * Two genuinely different situations arrive as the same status code, and the difference is the whole
 * diagnosis:
 *
 * - **A different install answered.** Its data directory is not ours, so its token is not ours. Nothing
 *   is broken; the CLI is pointed at a stranger. Fixed by stopping that daemon or moving this one's port.
 * - **The same install rejected us.** Then the token really is stale — written by a previous boot, or
 *   edited — and replacing it is the fix.
 *
 * `daemonInstall` is undefined when `/health` could not be read. That is not the same as a match: it
 * means unknown, and the message says so rather than guessing at the more convenient of the two.
 */
export function unauthorizedMessage(opts: {
  baseUrl: string;
  /** Fingerprint of the data directory this CLI resolved. */
  localInstall: string;
  /** Fingerprint the daemon reports, or undefined if `/health` did not answer. */
  daemonInstall: string | undefined;
  /** Where this CLI read its token, for a hint that names a real file. */
  tokenPath: string;
}): { message: string; hint: string } {
  const { baseUrl, localInstall, daemonInstall, tokenPath } = opts;

  if (daemonInstall !== undefined && daemonInstall !== localInstall) {
    return {
      message: `The daemon at ${baseUrl} belongs to a different Nouride install.`,
      hint:
        `It is not the daemon for ${tokenPath.replace(/\/\.control-token$/, "")}, so its token is not ` +
        `the one here. Every install uses the same default port, so the first one started wins it. ` +
        `Stop that daemon, or set PORT for this one.`,
    };
  }

  if (daemonInstall === undefined) {
    return {
      message: `The daemon at ${baseUrl} rejected the control token.`,
      hint:
        `Its health endpoint did not answer, so whether it is even this install is unknown: an older ` +
        `daemon predates the check. If it is another install, stop it; if it is this one, delete ` +
        `${tokenPath} and restart it.`,
    };
  }

  return {
    message: "The daemon rejected the control token.",
    hint: `It is this install, so the token is stale. Delete ${tokenPath} and restart the daemon.`,
  };
}

/**
 * The chat id of a cron run that does not use a person's conversation — `session: "isolated"` or
 * `"fresh"` — and the way back from it to the job.
 *
 * `cron:<jobId>` is an address on no platform. A turn there is fine; a *reply* there is not, so whatever
 * sends one has to know where the job delivers instead (`Voice.reply`).
 */
const PREFIX = "cron:";

export function cronSessionChat(jobId: string): string {
  return `${PREFIX}${jobId}`;
}

/** The job behind a cron session's chat id, or null for any other chat. */
export function cronJobOfChat(chatId: string): string | null {
  return chatId.startsWith(PREFIX) && chatId.length > PREFIX.length ? chatId.slice(PREFIX.length) : null;
}

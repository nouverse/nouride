/**
 * Where a scheduled job's turn runs and where its output goes — four answers that have to agree.
 *
 * Pure, and apart from the scheduler that reads them: which conversation a turn appends to, whether it
 * reads one at all, and where its answer is delivered are decisions about the *job*, and two of them
 * once disagreed — an isolated job recorded "dispatched" and sent its answer nowhere. Read together here
 * they can be checked against each other without a timer or a store in the way.
 */

import type { Job, JobTarget } from "@nouride/shared";
import { cronSessionChat } from "./session.ts";

/** A conversation, as a session key's two halves: the gateway instance and the chat in it. */
export interface CronSessionRef {
  gatewayId: string;
  chatId: string;
}

/**
 * Where a job's output goes.
 *
 * The override is all-or-nothing, and the store refuses a half-specified one — a delivery naming
 * a chat but not a gateway would resolve against the target's gateway, which is a different
 * conversation than the one that was asked for.
 */
export function deliveryTarget(job: Job): JobTarget {
  return job.delivery.gatewayId && job.delivery.chatId
    ? { gatewayId: job.delivery.gatewayId, chatId: job.delivery.chatId }
    : job.target;
}

/**
 * Which conversation's history the turn runs against.
 *
 * `isolated` and `fresh` keep the same gateway — so markdown, attachments and progress all behave as
 * they would anywhere else on that platform — and change only the chat id. A session key is
 * `(agent, gateway, chat)`, so that is the whole of what "not the human's conversation" needs to be.
 * The difference between those two is what `runCronTurn` does with the row it finds there, not where
 * it looks.
 */
export function sessionFor(job: Job): CronSessionRef {
  return runsOnChatHistory(job)
    ? job.target
    : { gatewayId: job.target.gatewayId, chatId: cronSessionChat(job.id) };
}

/**
 * Whether this job's turn belongs to the conversation a person is reading.
 *
 * Two decisions hang off it and they have to agree. It picks the session key above, and it is the
 * *only* mode allowed to use the fire-and-forget dispatch path — because the pipeline answers into
 * the conversation a message came from, and for the other modes that conversation is `cron:<jobId>`,
 * an id no platform can deliver to. When those two disagreed, an isolated job with `announce`
 * delivery recorded `"dispatched"` as a success and sent its answer nowhere.
 */
export function runsOnChatHistory(job: Job): boolean {
  return job.session === "chat";
}

/**
 * Whether the turn reads a history and writes one back.
 *
 * False only for `fresh`, which is the point of that mode: a daily report gains nothing from
 * remembering yesterday's, it only pays to send it and then pays again to summarize it once the
 * window fills.
 */
export function carriesHistory(job: Job): boolean {
  return job.session !== "fresh";
}

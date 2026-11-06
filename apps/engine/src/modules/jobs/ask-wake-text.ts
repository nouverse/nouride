/**
 * What the daemon says when an ask that moved to the background ends (0.7.19) — the line it posts itself, the message
 * that wakes the asking agent with the answer, and what its reply then owes.
 *
 * The agent woken is the one that asked, never the one asked: it is the one talking to the person, and the other agent
 * only ever worked behind the chat (`ask_agent`'s header). And the person has often moved on by the time a deploy or an
 * audit is done — so before the answer, the message says what it is the answer to: who was asked, when, and in what
 * words. The rules a helper's wake-up learned hold here too (`helper-wake-text.ts`): the daemon states a failure itself,
 * the requirement travels to the tail of the turn, and an agent that already passed this on may say nothing at all.
 */

import { localTime, safeTimeZone } from "@/commons/clock.ts";
import { renderHandoff } from "@/modules/tools/handoff.ts";
import { goalLine } from "@/modules/tools/builtins/delegate-brief.ts";
import type { JobCompletion, JobRecord } from "./jobs.store.ts";
import { MISSION_GATEWAY_ID } from "@/modules/missions/gateway.ts";
import { duration, type WakeChain } from "./wake-text.ts";
import { SAY_NOTHING } from "@/commons/silence.ts";

/** The agent asked — from the row, or from its job line when an older row lost the rest. */
function asked(job: JobRecord): string {
  return job.ask?.agent ?? /^ask ([^:]+):/.exec(job.command)?.[1] ?? "the agent you asked";
}

/** The ask, on one line: enough to know which one, short enough to stay out of the answer's way. */
function excerpt(job: JobRecord, max = 160): string {
  return job.ask ? goalLine({ goal: job.ask.task }, max) : job.command;
}

/**
 * The one line the daemon posts itself, before the asking agent's turn: for an ask that stopped short, was stopped at
 * this install's limit, or was cut off by a restart. Nothing for one that was answered — passing it on is the agent's —
 * and nothing for one a person or the agent stopped: somebody decided that, and has usually just said so.
 */
export function askFailureNotice({ job, stop }: JobCompletion): string | null {
  const who = asked(job);
  if (stop?.by === "deadline") {
    return `⏱️ ${who}'s work in the background on ${job.id} was stopped after ${duration(stop.limitMs)}, this install's limit for a background job (\`[security] job_max_ms\`). It had not finished.`;
  }
  if (job.status === "interrupted") return `⚠️ ${who}'s work in the background on ${job.id} was interrupted by a restart and is not resumed.`;
  if (job.status !== "failed") return null;
  const why = job.report?.reason ? `: ${job.report.reason}` : "";
  return `⚠️ ${who} stopped before finishing ${job.id}${why}.`;
}

/** What the reply must open with, delivered at the tail of the turn (`TurnRequest.owedReport`), where it is read last. */
export function askReportRequirement({ job, stop }: JobCompletion): string | null {
  const who = asked(job);
  if (stop?.by === "deadline" || job.status === "failed") {
    return (
      `The answer that woke this turn is from ${who}, who did NOT finish what you asked. What this reply must open with, in` +
      " the person's language: what you had asked, what got done and what did not, and what you propose. Only after those" +
      " may you mention anything else."
    );
  }
  if (job.status === "interrupted") {
    return (
      `${who} was cut off by a restart while working on what you asked, and is not resumed. Open with what you had asked` +
      " and what it had got done, in the person's language, and offer to ask again."
    );
  }
  if (job.status === "succeeded") {
    return (
      `${who}'s answer to what you asked woke this turn. Pass it on to the person, in their language, BEFORE anything else` +
      ", and say first what it is the answer to: they may have moved on since."
    );
  }
  return null;
}

/**
 * The message that wakes the asking agent: what it asked and when, then the answer, then what to do with it.
 *
 * `timeZone` is the daemon's, so "at 14:05" is the clock the person reads; `now` is when the wake-up is written, for how
 * long ago that was.
 */
export function askWakeMessage(completion: JobCompletion, context: { timeZone: string; now: number; chain?: WakeChain }): string {
  const { job, tail } = completion;
  const who = asked(job);
  const at = localTime(job.startedAt, safeTimeZone(context.timeZone)).time;
  const ago = duration(Math.max(0, context.now - job.startedAt));
  const exhausted = context.chain !== undefined && context.chain.limit > 0 && context.chain.position >= context.chain.limit;
  return [
    "[System event: not a message from a person. Nobody is waiting on a reply.]",
    `@${job.agentId}`,
    `${heading(completion, who)} what you asked at ${at} (${ago} ago), in the background as ${job.id}:`,
    `"${excerpt(job)}"`,
    "",
    `${who}'s handoff:`,
    job.report ? renderHandoff(job.report) : "(nothing came back)",
    "",
    instruction(completion, who, job.gatewayId === MISSION_GATEWAY_ID),
    // What it had done, from its log, when a restart cut it off before it could say.
    ...(job.status === "interrupted" && tail ? ["", "Its log, to where it stopped:", "```", tail, "```"] : []),
    `\nFull log: ${job.logPath}`,
    ...(exhausted
      ? [
          `\n[This is wake-up ${context.chain!.position} in a chain with no message from a person in it, and the limit for this` +
            ` install is ${context.chain!.limit}. Report this result, then STOP: do not start any further background work until` +
            ` somebody replies. Say plainly that you are pausing and why.]`,
        ]
      : []),
  ].join("\n");
}

/** How it ended, as the first words the asking agent reads — the words before "what you asked at …". */
function heading({ job, stop }: JobCompletion, who: string): string {
  if (stop?.by === "deadline") return `${who} was stopped by the daemon after ${duration(stop.limitMs)}, this install's limit for a background job (\`[security] job_max_ms\`), before it finished`;
  switch (job.status) {
    case "succeeded":
      return `The answer from ${who} has arrived, to`;
    case "killed":
      return `${who} was stopped before it finished`;
    case "interrupted":
      return `${who} was interrupted by a restart before it finished`;
    default:
      return job.report?.status === "requires_human" ? `${who} stopped at an approval nobody gave, on` : `${who} stopped before it finished`;
  }
}

/**
 * The close of the wake-up, by how it ended. In the person's language, every time, and context first: the person may be
 * in the middle of something else, and an answer with no question in front of it reads as the agent changing the subject.
 */
function instruction({ job, stop }: JobCompletion, who: string, inMission: boolean): string {
  const close = "\n\nNo greeting, no name, no \"what else can I help with\".";
  // A mission's turn has no person reading its reply (A15): "pass this on to the person now" sent the answer nowhere.
  if (job.status === "succeeded" && inMission) {
    return (
      `This turn is the mission's: nobody reads its reply. Use ${who}'s answer in the work. What the person needs from it` +
      " goes in the mission's report when it ends, in their language, with what you asked and what came back."
    );
  }
  if (stop?.by === "deadline") {
    return (
      `The daemon has already posted that it stopped ${who}. Nobody in the conversation decided it: it ran out of time.` +
      ` Say FIRST, in the person's language, what you had asked and what got done and what is not, from the handoff, and` +
      ` what you propose. Do not ask again with the same task: it would be stopped at the same limit. Split it into` +
      ` pieces that each finish sooner, or ask the person, since raising the limit is the operator's call.` +
      close
    );
  }
  if (job.status === "succeeded") {
    return (
      "Pass THIS answer on to the person now, in their language. Translate it, do not paste it:" +
      "\n1. What it is the answer to: what you asked, and when. They may have moved on to something else since." +
      `\n2. What ${who} found or did, and anything in it they need to know or decide.` +
      "\n3. Only then, if you are starting a next step, what it is." +
      `\nIf you already passed on this exact answer, ${SAY_NOTHING}.` +
      close
    );
  }
  if (job.status === "killed") {
    return (
      `Somebody stopped it (the person, or you). If that has just been said, ${SAY_NOTHING}. Otherwise say in` +
      ` one line, in the person's language, that ${who}'s work on it was stopped and what it had got done, from the handoff.` +
      close
    );
  }
  if (job.status === "interrupted") {
    return (
      `A restart cut ${who} off, and an ask is not resumed. Tell the person, in their language, what you had asked and` +
      ` what ${who} had got done (from the handoff and its log below), and that it stopped there. If it is still needed,` +
      ` ask ${who} again with \`ask_agent\`, saying in the task what was already done.` +
      close
    );
  }
  return (
    `${who} did NOT finish. The daemon has already posted that it stopped short, so do not repeat that line. What this` +
    " reply must open with, in the person's language: what you had asked, what got done and what did not, from the" +
    ` handoff, and what you propose (ask again with a better task, do the rest yourself, or ask the person). If ${who}` +
    " stopped at an approval, say which call is waiting. Only after those may you mention anything else." +
    close
  );
}

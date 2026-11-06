/**
 * What the daemon says when a background helper ends (0.7.15) — the line it posts itself, the message that wakes the
 * agent with the helper's handoff, and what the agent's reply then owes.
 *
 * A command's wake-up (`wake-text.ts`) is about an exit code and a log; a helper's is about a report somebody asked for.
 * The rules a command's text learned the hard way hold here too, and are kept: the daemon states a failure itself and
 * the agent says what it means; the requirement travels to the tail of the turn, where the model reads it last; and an
 * agent that just said what happened may say nothing at all. What is new is the language: the handoff is in English,
 * because the brief was, and the person hears it in theirs.
 */

import { renderHandoff } from "@/modules/tools/handoff.ts";
import { goalLine, renderBrief } from "@/modules/tools/builtins/delegate-brief.ts";
import type { JobCompletion, JobRecord } from "./jobs.store.ts";
import { duration, type WakeChain } from "./wake-text.ts";
import { SAY_NOTHING } from "@/commons/silence.ts";

/** The helper by id and goal, as every line here names it. */
function named(job: JobRecord): string {
  return `${job.id} ("${job.brief ? goalLine(job.brief) : job.command}")`;
}

/** How long it ran, when that is known. */
function ran(job: JobRecord): string {
  return job.endedAt ? ` after ${duration(job.endedAt - job.startedAt)}` : "";
}

/**
 * The one line the daemon posts itself, before the agent's turn: for a helper that stopped short, was stopped at this
 * install's limit, or was cut off by a restart. Nothing for one that finished — the report is the agent's to give — and
 * nothing for one a person or the agent stopped: somebody decided that, and has usually just said so.
 */
export function helperFailureNotice({ job, stop }: JobCompletion): string | null {
  if (stop?.by === "deadline") {
    return `⏱️ Background helper ${named(job)} was stopped after ${duration(stop.limitMs)}, this install's limit for a background job (\`[security] job_max_ms\`). It had not finished.`;
  }
  if (job.status === "interrupted") return `⚠️ Background helper ${named(job)} was interrupted by a restart and is not resumed.`;
  if (job.status !== "failed") return null;
  const why = job.report?.reason ? `: ${job.report.reason}` : "";
  return `⚠️ Background helper ${named(job)} stopped before it finished its work${why}.`;
}

/**
 * What the reply must open with, delivered at the tail of the turn (`TurnRequest.owedReport`) — where it is read last,
 * which is the difference that made a command's failures get reported at all.
 */
export function helperReportRequirement({ job, stop }: JobCompletion): string | null {
  if (stop?.by === "deadline" || job.status === "failed") {
    return (
      "The background helper that woke this turn did NOT finish its work. What this reply must open with, in the" +
      " person's language: what it got done and what it did not, from its handoff, and what you propose. Only after" +
      " those may you mention work you have just started."
    );
  }
  if (job.status === "interrupted") {
    return (
      "The background helper that woke this turn was cut off by a restart and is not resumed. Open with what it had" +
      " done and that it stopped there, in the person's language, and offer to start it again."
    );
  }
  if (job.status === "succeeded") {
    return (
      "A background helper's result woke this turn. Report what it found or did to the person, in their language," +
      " BEFORE anything else you mention."
    );
  }
  return null;
}

/** The message that wakes the agent: the helper's handoff, and what to do with it. */
export function helperWakeMessage(completion: JobCompletion, chain?: WakeChain): string {
  const { job, tail, stop } = completion;
  const report = job.report ? renderHandoff(job.report) : "(it handed nothing back)";
  const exhausted = chain !== undefined && chain.limit > 0 && chain.position >= chain.limit;
  return [
    "[System event: not a message from a person. Nobody is waiting on a reply.]",
    `@${job.agentId}`,
    `Background helper ${named(job)} ${outcomeOf(completion)}${stop ? "" : ran(job)}.`,
    "",
    "Its handoff:",
    report,
    "",
    instruction(completion),
    // Its brief, where starting it again is on the table: a new helper begins from it, with what this one did added.
    ...(job.brief && job.status !== "succeeded" && !(job.status === "killed" && !stop) ? ["", "Its brief:", renderBrief(job.brief)] : []),
    // What it had done, from its own log, when a restart cut it off before it could say.
    ...(job.status === "interrupted" && tail ? ["", "Its log, to where it stopped:", "```", tail, "```"] : []),
    `\nFull log: ${job.logPath}`,
    ...(exhausted
      ? [
          `\n[This is wake-up ${chain!.position} in a chain with no message from a person in it, and the limit for this` +
            ` install is ${chain!.limit}. Report this result, then STOP: do not start any further background work until` +
            ` somebody replies. Say plainly that you are pausing and why.]`,
        ]
      : []),
  ].join("\n");
}

function outcomeOf({ job, stop }: JobCompletion): string {
  if (stop?.by === "deadline") return `was stopped by the daemon after ${duration(stop.limitMs)}, this install's limit for a background job (\`[security] job_max_ms\`), before it finished`;
  switch (job.status) {
    case "succeeded":
      return "finished";
    case "killed":
      return "was stopped before it finished";
    case "interrupted":
      return "was interrupted by a restart before it finished";
    default:
      return job.report?.status === "requires_human" ? "stopped at an approval nobody gave" : "stopped before it finished its work";
  }
}

/**
 * The close of the wake-up, by how it ended.
 *
 * In the person's language, every time: the handoff is in English because the brief was, and pasted as it is it reads
 * as the agent switching languages mid-conversation. Each helper is reported as it arrives — one still running is
 * said to be, not waited for (owner, 2026-10-18: "kalau selesai 1 ya proses 1, lalu menunggu lagi").
 */
function instruction({ job, stop }: JobCompletion): string {
  const close = "\n\nNo greeting, no name, no \"what else can I help with\".";
  if (stop?.by === "deadline") {
    return (
      "The daemon has already posted that it stopped this helper. Nobody in the conversation decided it: it ran out of" +
      " time. Say FIRST, in the person's language, what it got done and what is not done, from its handoff, and what" +
      " you propose. Do not start it again with the same brief: it would be stopped at the same limit. Split the work" +
      " into pieces that each finish sooner, or ask the person, since raising the limit is the operator's call." +
      close
    );
  }
  if (job.status === "succeeded") {
    return (
      "Report THIS result to the person now, in their language. Translate the handoff, do not paste it:" +
      "\n1. What it found or did, and how it went." +
      "\n2. Anything in it they need to know or decide." +
      "\n3. Only then, if you are starting a next step, what it is." +
      "\nIf another helper is still running, say it is still going and that you will report it when it finishes. Do" +
      ` not wait for it to report this one. If you already reported this exact result, ${SAY_NOTHING}.` +
      close
    );
  }
  if (job.status === "killed") {
    return (
      `Somebody stopped it (the person, or you). If that has just been said, ${SAY_NOTHING}. Otherwise say in` +
      " one line, in the person's language, that it was stopped and what it had got done, from its handoff." +
      close
    );
  }
  if (job.status === "interrupted") {
    return (
      "A restart cut it off, and a helper is not resumed. Tell the person, in their language, what it had got done" +
      " (from its handoff and its log below), and that it stopped there. If the work is still needed, start it again" +
      " with `delegate`, from its brief below, adding to `context` what this one already did." +
      close
    );
  }
  return (
    "It did NOT finish its work. The daemon has already posted that it stopped short, so do not repeat that line." +
    " What this reply must open with, in the person's language: what it got done and what it did not, from its" +
    " handoff, and what you propose (start it again with a better brief, do the rest yourself, or ask the person). If" +
    " it stopped at an approval, say which call is waiting: approved later, it can run then. Only after those may you" +
    " mention work you have just started." +
    close
  );
}

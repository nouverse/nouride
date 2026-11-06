/**
 * What the daemon says when a background job ends — the line it posts itself, the message that wakes the agent, and
 * what the agent's reply then owes.
 *
 * Text, apart from the store that keeps the rows: each sentence here is a correction of something an agent did on a
 * live box, and the reasons are kept beside the sentence they explain. `JobStore` decides what happened to a job;
 * this decides how it is said.
 */

import type { JobCompletion, JobRecord, JobStop } from "./jobs.store.ts";
import { oomKillNote } from "@/modules/tools/builtins/exec-hints.ts";
import { SAY_NOTHING } from "@/commons/silence.ts";

/**
 * The one line the daemon says itself when a job fails — or is stopped at this install's time limit.
 *
 * Asking the model to report a failure did not work, and the evidence is unambiguous: the instruction
 * was in the prompt — `Report THIS job, before anything else… This job FAILED — say so` — and the
 * agent answered with "lagi ngejalanin test voice cloning, gw kabarin nanti". The failure was never
 * mentioned. That is the second wording to fail at this, and a third would be a third guess.
 *
 * So the responsibility moves. **The daemon states the fact; the agent says what it means.** A fact
 * the daemon already holds should never depend on a model choosing to pass it on — that is the same
 * rule as "never write out a result you did not get back", pointed the other way. A job the deadline
 * stopped is such a fact: nobody in the conversation decided it, and the work did not finish.
 *
 * Deliberately one line and deliberately not the whole log: enough to know something broke and roughly
 * what, with the agent's turn arriving right behind it to explain. A successful job gets no line at
 * all — success is what the agent's report is for, and a notice per finished job is the noise that
 * gets a channel muted.
 */
export function jobFailureNotice(completion: JobCompletion): string | null {
  const { job, tail, stop } = completion;
  if (stop?.by === "deadline") {
    const last = logLines(tail ?? "").at(-1);
    return [
      `⏱️ Background job ${job.id} was stopped after ${limitOf(stop)}, this install's limit for a background job (\`[security] job_max_ms\`). It had not finished.`,
      `\n\`${job.command.slice(0, 160)}\``,
      last ? `\n(output ends at) ${last.slice(0, 300)}` : "",
    ].join("");
  }
  if (job.status !== "failed" && job.status !== "interrupted") return null;

  const ran = ranFor(job);
  const what =
    job.status === "interrupted"
      ? "was interrupted by a restart"
      : `failed with exit code ${job.exitCode ?? "unknown"}`;

  const why = failureLine(tail ?? "");

  return [
    `⚠️ Background job ${job.id} ${what}${ran}`,
    `\n\`${job.command.slice(0, 160)}\``,
    why === null
      ? ""
      : why.looksLikeError
        ? `\n${why.line}`
        : // Said out loud rather than dressed up as a diagnosis. An ssh session killed mid-transcode
          // ends on "[3/4] Extracting audio…", and presenting that as the reason would be inventing
          // one — the honest answer is that the output stops there.
          `\n(no error text; output ends at) ${why.line}`,
  ].join("");
}

/**
 * How long it ran, as a phrase, or nothing at all.
 *
 * `endedAt ? … : 0` was here, and it reported a 41-minute clone as "after 0s" — because the record it
 * was handed had no end time, and zero is what a missing number looks like when you give it a
 * default. A duration nobody measured is not zero seconds; it is unknown, and saying nothing is the
 * only honest way to say so.
 */
function ranFor(job: JobRecord): string {
  if (!job.endedAt) return "";
  const seconds = Math.round((job.endedAt - job.startedAt) / 1000);
  return seconds > 0 ? ` after ${seconds}s` : "";
}

/** The limit a job was stopped at, as the person who set it would say it — `1h 0m`, not `3600000`. */
function limitOf(stop: JobStop): string {
  return duration(stop.limitMs);
}

/** `12m 30s`, `1h 4m`, `45s` — how a person says it. Under a second, in milliseconds: `0s` would be a wrong number. */
export function duration(ms: number): string {
  if (ms > 0 && ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/**
 * Lines that are noise in every log, not information about this failure.
 *
 * One entry, earned: `ProtectHome=read-only` in the systemd unit means ssh could never write
 * `~/.ssh/known_hosts`, so every ssh job opened with this warning — before 0.7.17, and still for an ssh not run
 * through `.nouride/bin`, whose wrapper keeps new host keys in HOME. It is harmless — ssh
 * proceeds — but it is the *first* line of the tail, which is how it nearly became the headline of a
 * CUDA failure, and why this function looks at the last line rather than the first.
 */
const LOG_NOISE = [/^Failed to add the host to the list of known hosts/i];

/**
 * Lines that only restate the exit code the notice already reports.
 *
 * Not noise — they are true, and they are the fallback when a tool failed without saying why. They are
 * just never the *best* line available, and the notice has room for one.
 */
const EXIT_CODE_SUMMARY =
  /exited with (?:code|status)\s*\d+|\bError\s+\d+\s*$|exit(?:ed)? code:?\s*\d+\s*$|\*\*\*\s*\[/i;

/**
 * Text that reads like something going wrong.
 *
 * Deliberately not clever. A tool that prints its own diagnosis is the common case, and the words it
 * uses are these; anything subtler than a word list would be guessing about output we have not seen.
 */
const ERROR_WORDS =
  /\b(error|fatal|failed|failure|cannot|can't|unable|not found|no such|denied|refused|timed? out|traceback|exception|panic|abort|EPERM|EACCES|ENOENT|ECONN|killed)\b|^\s*at\s+\S+:\d+/i;

/** A log tail's lines, as a person would read them: no colour codes, no blank lines, no known noise. */
function logLines(tail: string): string[] {
  return (
    stripAnsi(tail)
      // `\r` too. `git clone` redraws one line — "Updating files: 33% (225165/668037)" — thousands of
      // times without ever ending it, so a tail split on newlines alone is a single line of pure
      // progress, and quoting 300 characters of it says nothing at all.
      .split(/[\r\n]+/)
      .map((line) => line.trimEnd().trim())
      .filter((line) => line.length > 0)
      .filter((line) => !LOG_NOISE.some((pattern) => pattern.test(line)))
  );
}

/**
 * The line of a log tail most likely to say *why*, or null when there is nothing to show.
 *
 * The **last** error-looking line, not the first. A failure reports itself at the end; the top of a
 * tail is a banner, a warning on the way in, or the start of a build that got further than this one.
 *
 * `looksLikeError: false` is not a failure of this function — it is the answer for a process that was
 * killed rather than one that complained. Both of those happen, and the caller says which it got
 * instead of presenting a progress line as a cause.
 */
function failureLine(tail: string): { line: string; looksLikeError: boolean } | null {
  const lines = logLines(tail);
  if (lines.length === 0) return null;

  /**
   * Two passes, because the loudest error line is usually the least useful one.
   *
   * A task runner ends by restating the exit code — `error: script "build" exited with code 1`, or
   * `make: *** [all] Error 1`. That matches every error-word test and adds nothing the headline of the
   * notice does not already say, while the line that explains it sits two lines above:
   *
   *     failed to move executable to D:\projects\app\dist\app.exe: EPERM
   *     error: script "build" exited with code 1
   *
   * So the cause is looked for first, and the summary is the fallback rather than the answer.
   */
  const pick = (accept: (line: string) => boolean): string | null => {
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      if (accept(lines[at]!)) return lines[at]!;
    }
    return null;
  };

  const cause =
    pick((line) => ERROR_WORDS.test(line) && !EXIT_CODE_SUMMARY.test(line)) ??
    pick((line) => ERROR_WORDS.test(line));
  if (cause) return { line: cause.slice(0, 300), looksLikeError: true };

  return { line: lines[lines.length - 1]!.slice(0, 300), looksLikeError: false };
}

/**
 * Control sequences out, before a chat message is built from the text.
 *
 * Not cosmetic. A build tool writing colour to what it thinks is a terminal put
 * `\u001b[35m[3/4]\u001b[39m \u001b[1mExtracting audio…` into a Telegram message verbatim, where the
 * escapes are not invisible — they are the message. Covers CSI (colour, cursor) and OSC (window
 * title, hyperlinks), which is everything these logs actually contain.
 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- the point of this function
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
}

export interface WakeChain {
  /** Which wake-up this is, counting from 1, since the last time a person said anything. */
  position: number;
  /** The configured ceiling. 0 means there is none. */
  limit: number;
}

/**
 * What this turn's **final message** must do, however the turn gets there.
 *
 * Separate from `jobWakeMessage` because of where each one lands. The wake message is the turn's
 * opening prompt; this is delivered last, in the wrap-up call, and the difference between the two
 * positions turned out to be the whole bug.
 *
 * The evidence, pulled off a live box: of 18 failed jobs, the agent mentioned the failure in exactly
 * **one** — the one turn that called no tools at all. Every other reply was some version of "…sedang
 * berjalan di background, nanti gw kabarin". That is not the model ignoring an instruction, it is the
 * model obeying a *later* one: starting a background job returns `finishTurn: "background_started"`,
 * and the wrap-up prompt for that case says "confirm what is now running in the background… say you
 * will follow up when it finishes". Written at the tail of the context, it replaced a reporting
 * instruction sitting hundreds of tool-result tokens back.
 *
 * So the requirement travels to the tail too. Three rewordings of the opening prompt could not fix a
 * problem that was never about wording.
 *
 * `null` when there is nothing owed: a job the agent deliberately killed (it has usually just said so),
 * and a job with its own `on_complete` instruction (the agent asked to be told what to do next, and
 * two instructions in one prompt is how a model picks the easier one) — unless the deadline stopped it,
 * when that instruction no longer applies and the report is owed like any other.
 */
export function jobReportRequirement(completion: JobCompletion): string | null {
  const { job, stop } = completion;
  if (stop?.by === "deadline") {
    return (
      "The background job that woke this turn was stopped by the daemon at this install's time limit for a" +
      " background job, and did NOT finish. The daemon has already posted that, so do not repeat the limit." +
      " What this reply must open with: what that leaves undone, from its output, and what you propose instead." +
      " Only after those may you mention work you have just started."
    );
  }
  if (job.onComplete) return null;

  if (job.status === "failed" || job.status === "interrupted") {
    return (
      "The background job that woke this turn did NOT succeed. The daemon has already posted the" +
      " exit code and the failing output to the chat, so do not repeat those. What is missing, and" +
      " what this reply must open with: WHY it failed, in your own words (the cause, not the exit" +
      " code), and what you are doing about it. Only after those may you mention work you have just" +
      " started. Opening with newly started work is the specific mistake this rule exists to stop."
    );
  }

  if (job.status === "succeeded") {
    return (
      "The background job that woke this turn finished successfully. Say what finished and how it" +
      " went BEFORE mentioning anything you have just started. One reply carries both, in that" +
      " order: \"<what finished> is done (result), now <what is running>\"."
    );
  }

  return null;
}

/**
 * How a report of a job's end closes. The person's language named here, as an asked agent's answer and a helper's result
 * name it: with nothing said, a job's English output was reported in English to a person writing Indonesian (Nix's DM,
 * 0.8.7) — the one reply of the evening in another language.
 */
const REPORT_CLOSE = `\n\nWrite it in the person's language, whatever language the output above is in. No greeting, no name, no "what else can I help with".`;

/**
 * The message that wakes the agent when a job ends.
 *
 * Written as an event the agent is being told about, not as a user speaking, and it says what is
 * available next — the log path, so a failure can be investigated with `read` rather than guessed at.
 */
export function jobWakeMessage(completion: JobCompletion, chain?: WakeChain): string {
  const { job, tail, stop, oomKills } = completion;
  const outcome =
    stop?.by === "deadline"
      ? // Not `${outcome}${ranFor(job)}`: "…had not finished after 3605s" reads as though it finished then.
        `was stopped by the daemon after ${limitOf(stop)}, this install's limit for a background job (\`[security] job_max_ms\`), before it finished`
      : job.status === "succeeded"
        ? "finished successfully"
        : job.status === "killed"
          ? "was stopped"
          : job.status === "interrupted"
            ? "was interrupted by a restart"
            : `failed with exit code ${job.exitCode ?? "unknown"}`;

  /**
   * Which outcomes may not go unreported.
   *
   * Not simply "did not succeed". A job the agent **killed** is a thing somebody decided to do, and it
   * has usually just been described in the message before this one — the original note on this
   * function records exactly that: the agent killed a job, reported the outcome, and then reported it
   * again as though asked. So `killed` keeps the ordinary instruction, silence included.
   *
   * `interrupted` is in, though nothing failed: a restart took the work, the person is waiting on a
   * result that is not coming, and nobody else is going to mention it.
   *
   * Caught by the existing test for `killed` — my first version treated every non-success as a
   * failure and made the agent announce its own deliberate stop as one.
   */
  const mustReport = job.status === "failed" || job.status === "interrupted";

  /**
   * The chain, when it has run long enough to be worth saying out loud.
   *
   * Delivered *with* the outcome rather than instead of it: the reason this exists is that a failure
   * went unreported, so a ceiling that suppressed the wake-up would be the same bug wearing a budget.
   * What it stops is the agent starting more work, not the agent reporting.
   */
  const exhausted = chain !== undefined && chain.limit > 0 && chain.position >= chain.limit;
  const chainNote = exhausted
    ? `\n\n[This is wake-up ${chain.position} in a chain with no message from a person in it, and the` +
      ` limit for this install is ${chain.limit}. Report this result, then STOP: do not start any further` +
      ` background work until somebody replies. Say plainly that you are pausing and why.]`
    : "";

  // The closing instruction is the whole difference between a report and a conversation.
  //
  // It used to say "tell whoever started it what happened", and the model read that as *reply to
  // them* — so a job finishing produced "Aman Gading, ... Ada hal lain yang bisa dibantu?", a
  // conversational answer to a message nobody had sent. Worse when the agent had just killed the job
  // itself: it had already reported the outcome just before, then reported it again as
  // though asked.
  //
  // The fix was "post one short line" — which went too far the other way. The model then suppressed
  // everything useful: what the output means, whether something needs attention, what a next step
  // would be if the person cares. That is feedback, not agentic continuation — and a job completion
  // with no context is worse than no message at all.
  //
  // The right framing: read the output, tell them what matters (status + anything worth acting on),
  // stay quiet only if there is genuinely nothing to add. No greeting, no "what else", no re-running.
  // Naming what this is — a system event, with nobody waiting on a reply — and explicitly allowing
  // silence is what makes the difference. The empty turn is handled: a system-originated turn that
  // produces no text sends nothing at all.
  return [
    `[System event: not a message from a person. Nobody is waiting on a reply.]`,
    `\n@${job.agentId}`,
    `\nBackground job ${job.id} ${outcome}${stop ? "" : ranFor(job)}: \`${job.command}\``,
    tail ? `\nLast output:\n\`\`\`\n${tail}\n\`\`\`` : "\n(no output)",
    `\nFull log: ${job.logPath}`,
    oomKills ? `\n${oomKillNote(oomKills)}` : "",
    stop?.by === "deadline"
      ? deadlineInstruction(job)
      : job.onComplete
        ? // Explicit opt-in instruction: the agent asked to be told what to do next, so tell it
          // directly rather than leaving it to infer from context. Framed as an instruction, not
          // a suggestion, so the model acts rather than reports.
          `\n\nInstruction for this completion: ${job.onComplete}` +
          `\nDo not re-run the job unless the instruction above says to. No greeting, no name.`
        : /**
           * No opt-in: report the completion. **This job, not the next one.**
           *
           * The instruction used to say "post a brief summary of what happened", and that is the bug this
           * rewrite is about. Watched live over nine consecutive wake-ups during an install: each turn
           * started the next step and described *that*, so every message read "still running, I'll tell
           * you when it's done" and the completion the wake-up existed to deliver was dropped every time.
           * Two of those jobs had **failed with exit code 1**, with the error in the prompt, and the person
           * was told the download was in progress.
           *
           * The model was not disobeying. From inside that turn the newest thing that "happened" is the
           * job it just launched, and the old wording did not distinguish the completion it was woken for
           * from anything else it did. So the order is now explicit and the failure case is not optional.
           */
          (mustReport
            ? /**
               * The fact is already in the chat — `jobFailureNotice` posted it before this turn began,
               * because two versions of "please report the failure" did not work.
               *
               * The first attempt at this branch said "do not restate it", and the model obeyed exactly:
               * the ⚠️ line landed, and the agent's next message was "Lagi meng-upgrade PyTorch ke build
               * CUDA 12.8 di background" — no mention of what it was upgrading *for*. Correct work, and it
               * read like the failure never happened.
               *
               * So the ask is not silence about the failure, it is the **link**: the reaction comes first
               * and the new step second, in one message. What must not be repeated is the exit code and
               * the log; what must be said is the cause, in the agent's own words, joined to the fix.
               */
              `\n\nThe one-line fact is already in the chat: the daemon posted it just before this turn.` +
              ` Do not repeat the exit code and do not paste the log again.` +
              `\n\nWhat is missing is the REACTION, and it comes FIRST, before any new work you mention:` +
              `\n1. WHY it failed, in your own words. Name the cause, not the exit code: a missing` +
              ` dependency, the wrong GPU architecture, a bad path, a wrong flag. Read the output and say` +
              ` which.` +
              `\n2. What you are doing about it, or that you are not, and why.` +
              `\n3. Only after those two, the step you have started, if you started one.` +
              `\n\nOne message, in that order: "failed because <cause>, so I am <fix>. Now <step> is` +
              ` running." Never announce new work without saying what it is a response to: a message that` +
              ` opens with the next step is the bug this instruction exists to stop.`
            : ``) +
          (mustReport ? `` : `\n\nReport THIS job, before anything else, in this order:` +
            `\n1. What finished and how it went. Name the outcome.`) +
            (mustReport
              ? ``
              : `\n2. Anything notable in the output: what was created or changed, warnings worth knowing.` +
                `\n3. Only then, if you are doing something next, say what it is. One message, both facts:` +
                ` "step done (result), now doing X", not a fresh announcement that replaces the result.`) +
            (mustReport
              ? `\n\nRetrying: if the output makes the fix obvious, you may retry once, but say what you are` +
                ` changing and why, in the same message. Do not re-run the same command unchanged, and do not` +
                ` retry silently.`
              : `\n\nIf you reported this exact outcome already, from its output after it ended, and the output` +
                ` holds nothing new, ${SAY_NOTHING}. A result you wrote while it was still running` +
                ` was a guess: report the real one now. Do not re-run the job unless they ask.`) +
            REPORT_CLOSE,
    chainNote,
  ].join("");
}

/**
 * The close of a wake-up for a job the deadline stopped — its own branch, because neither of the others is true of it.
 *
 * Not the failure branch: nothing in the command failed, and "retry once" is the one move certain to be stopped at
 * the same limit. Not the ordinary one: nobody in the conversation decided this, so silence is not allowed, and a
 * job's `on_complete` ("deploy when done") must not be acted on — the work did not get done.
 */
function deadlineInstruction(job: JobRecord): string {
  return (
    `\n\nThe daemon has already posted that it stopped this job. Nobody in the conversation decided it and nothing` +
    ` in the command failed: it ran out of time.` +
    (job.onComplete
      ? ` Its instruction for when it finished ("${job.onComplete}") does not apply: it did not finish.`
      : ``) +
    `\n\nSay FIRST, in your own words, what this means for the work (how far it got, from its output, and what is` +
    ` not done) and what you propose. Do not simply run it again: it would be stopped at the same limit. If it is a` +
    ` server meant to keep running, start it with \`service: true\`; if the work needs longer, split it into steps` +
    ` that each finish sooner, or ask the person: raising the limit is the operator's call.` +
    REPORT_CLOSE
  );
}

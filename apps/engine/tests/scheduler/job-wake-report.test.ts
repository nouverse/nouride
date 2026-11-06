/**
 * What happens when a background job finishes — and who says it.
 *
 * Watched twice on a live install, and the second time is the interesting one. First: nine consecutive
 * wake-ups where the agent described the job it had just *started* rather than the one that had
 * finished, two of which had failed with exit code 1 while the person was told the download was in
 * progress. The wording was rewritten to demand the report explicitly.
 *
 * Then it happened again, with the new instruction sitting in the prompt: job failed, exit code 1,
 * `Report THIS job, before anything else… This job FAILED — say so`, and the agent's entire reply was
 * "lagi ngejalanin test voice cloning, gw kabarin nanti".
 *
 * Two wordings, two failures. A third would have been a third guess, so the responsibility moved
 * instead: **the daemon states the fact, the agent says what it means.** A fact this process already
 * holds must not depend on a model choosing to pass it on — the same rule as "never write out a result
 * you did not get back", pointed the other way.
 *
 * That worked, and exposed the other half. With the ⚠️ line landing reliably, the agent's own reply
 * became "Lagi meng-upgrade PyTorch ke build CUDA 12.8" — the correct response to the CUDA error it
 * had just been shown, with no word about the error. "Do not restate it" had removed the failure from
 * the reply rather than removing the duplicate. So the agent's half is now an ordering rather than a
 * topic list: the cause, then the fix, then the step. Both halves are pinned below.
 */

import { describe, expect, test } from "bun:test";
import type { JobCompletion, JobRecord } from "@/modules/jobs/jobs.store.ts";
import { jobFailureNotice, jobReportRequirement, jobWakeMessage } from "@/modules/jobs/wake-text.ts";

function completion(over: Partial<JobRecord> = {}, tail = "all good"): JobCompletion {
  return {
    job: {
      id: "job_1",
      agentId: "nouva",
      gatewayId: "telegram:bot",
      chatId: "5550001111",
      command: "bash -lc 'uv pip install torch'",
      cwd: "/w",
      status: "succeeded",
      pid: null,
      exitCode: 0,
      logPath: "/w/job_1.log",
      startedAt: 1_000,
      endedAt: 6_000,
      onComplete: null,
      kind: "command",
      brief: null,
      ask: null,
      report: null,
      turnId: null,
      senderId: null,
      ...over,
    },
    tail,
  };
}

describe("a job that failed", () => {
  const failed = () =>
    jobWakeMessage(
      completion({ status: "failed", exitCode: 1 }, "Failed to add the host\nRuntimeError: CUDA out of memory"),
    );

  test("the daemon states the failure itself, in one line", () => {
    /**
     * Two versions of "please report the failure" were written into this prompt and neither held. The
     * second was watched failing live: the instruction was in the prompt, the job had failed with exit
     * code 1, and the agent's whole reply was "lagi ngejalanin test voice cloning, gw kabarin nanti".
     *
     * So the fact stopped being the model's job. A fact the daemon already holds must not depend on a
     * model choosing to pass it on.
     */
    const notice = jobFailureNotice(
      completion({ status: "failed", exitCode: 1 }, "Warning: added the host\nRuntimeError: CUDA out of memory"),
    );

    expect(notice).toContain("failed with exit code 1");
    expect(notice).toContain("job_1");
    // The LAST meaningful line, not the first: a failure reports itself at the end, and the first line
    // is usually a banner or a warning on the way in — which is how an ssh known_hosts warning would
    // have become the headline of a CUDA failure.
    expect(notice).toContain("CUDA out of memory");
    expect(notice).not.toContain("Warning: added the host");
  });

  test("the line it quotes is the one that says why, not the last one printed", () => {
    /**
     * Live tail, exactly as it arrived. The build failed at the top and the *last* error line is the
     * runner's own summary, which says nothing:
     */
    const notice = jobFailureNotice(
      completion(
        { status: "failed", exitCode: 1 },
        [
          "$ bun build --compile src/cli.ts",
          "  [15ms]  minify  -98.41 KB",
          "failed to move executable to D:\\projects\\nouclip\\dist\\nouclip.exe: EPERM",
          'error: script "build" exited with code 1',
        ].join("\n"),
      ),
    );

    // Either of the last two lines is "an error line". The useful one is named, and the summary that
    // only repeats the exit code is not what a person needs to read.
    expect(notice).toContain("EPERM");
  });

  test("a process killed mid-step says so, instead of dressing progress up as a cause", () => {
    /**
     * `ssh … nouclip auto`, exit 255 after 135 seconds. The remote died during transcription and
     * printed no error at all, so the end of the tail is a progress line:
     *
     *     [3/4] Extracting audio and generating word-level timestamps...
     *
     * Quoting that under a "failed" headline reads as a diagnosis, and it is not one. This is the case
     * the first version of this function got wrong on a live box.
     */
    const notice = jobFailureNotice(
      completion(
        { status: "failed", exitCode: 255 },
        "\u001b[35m[2/4]\u001b[39m Converting aspect ratio...\n\u001b[35m[3/4]\u001b[39m \u001b[1mExtracting audio...\u001b[22m",
      ),
    );

    expect(notice).toContain("no error text");
    expect(notice).toContain("Extracting audio");
    // And the terminal colour codes are gone. Invisible in a terminal; in a Telegram message they are
    // the message — this went out to a real chat reading `[35m[3/4] [39m [1mExtracting audio`.
    expect(notice).not.toContain("\u001b");
    expect(notice).not.toContain("[35m");
  });

  test("the known_hosts warning every ssh job prints is not treated as the failure", () => {
    /**
     * `ProtectHome=read-only` in our own systemd unit means ssh can never write known_hosts, so this
     * line opens the log of every ssh job on the box. It is noise, and it is *first* — which is how it
     * came within one heuristic of being reported as the cause of a CUDA error.
     */
    const notice = jobFailureNotice(
      completion(
        { status: "failed", exitCode: 1 },
        "Failed to add the host to the list of known hosts (/home/nouride/.ssh/known_hosts).\nRuntimeError: CUDA out of memory",
      ),
    );

    expect(notice).toContain("CUDA out of memory");
    expect(notice).not.toContain("known hosts");
  });

  test("an interrupted job is posted too — the work is incomplete and nobody else will say so", () => {
    expect(jobFailureNotice(completion({ status: "interrupted" }))).toContain("interrupted by a restart");
  });

  test("nothing is posted for a success or a deliberate stop", () => {
    // Success is what the agent's report is for, and a notice per finished job is the noise that gets
    // a channel muted. A killed job is something somebody decided to do.
    expect(jobFailureNotice(completion())).toBeNull();
    expect(jobFailureNotice(completion({ status: "killed" }))).toBeNull();
  });

  test("the reaction comes first, and the new step second", () => {
    /**
     * The shape asked for, after watching the previous wording land badly:
     *
     *     ⚠️ Background job … failed with exit code 1 after 61s
     *        …cudaErrorNoKernelImageForDevice…
     *     Lagi meng-upgrade PyTorch ke build CUDA 12.8 di background.
     *
     * The upgrade *was* the right response to that error, and nothing in the message said so. "Do not
     * restate it" had removed the failure from the reply entirely instead of removing the duplicate.
     *
     * So what is pinned is the ordering: cause, then fix, then the step — and the explicit ban on a
     * message that opens with the new work.
     */
    const text = failed();

    expect(text).toContain("REACTION, and it comes FIRST");
    expect(text).toContain("WHY it failed, in your own words");
    expect(text).toContain("Only after those two, the step you have started");
    expect(text).toContain("Never announce new work without saying what it is a response to");

    // The cause is wanted; the exit code and the log are not — those are the daemon's line already.
    expect(text).toContain("Do not repeat the exit code");
    // And neither of the two wordings that failed before it.
    expect(text).not.toContain("This job FAILED — say so");
    expect(text).not.toContain("Do not restate it");
  });

  test("the order is stated as an order, not as a list of topics", () => {
    // A model given three equal bullet points picks the easiest. The failure mode both times was the
    // *sequence* collapsing, so the sequence is what the wording has to carry.
    const text = failed();
    const reaction = text.indexOf("REACTION");
    const step = text.indexOf("the step you have started");
    expect(reaction).toBeGreaterThan(-1);
    expect(step).toBeGreaterThan(reaction);
  });

  test("allows one retry, and only a stated one", () => {
    // "untuk laporan dan mencoba lagi" — a failure the agent can fix should be fixable, but silently
    // re-running the same command is how a failed step becomes a loop nobody can see.
    const text = failed();
    expect(text).toContain("retry once");
    expect(text).toContain("Do not re-run the same command unchanged");
    expect(text).toContain("do not retry silently");
  });

  test("never offers silence as an option", () => {
    expect(failed()).not.toContain('reply with only "." (it is not sent)');
  });

  test("carries the output the agent needs to interpret it", () => {
    const text = failed();
    expect(text).toContain("CUDA out of memory");
    expect(text).toContain("Full log:");
  });
});

describe("a job that succeeded", () => {
  test("is reported first, and next steps come after", () => {
    const text = jobWakeMessage(completion());

    expect(text).toContain("finished successfully");
    expect(text).toContain("Report THIS job, before anything else");
    // The shape asked for, so one message carries both facts instead of replacing one with the other.
    expect(text).toContain("step done (result), now doing X");
  });

  test("may stay quiet only when it has already been reported and nothing is new", () => {
    const text = jobWakeMessage(completion());
    expect(text).toContain('reply with only "." (it is not sent)');
    expect(text).not.toContain("This job FAILED");
  });
});

describe("the language it is reported in", () => {
  // Nix's DM on 0.8.7: a job's English `du` output was reported in English to a person writing Indonesian, and read as a
  // message from somewhere else. An asked agent's answer and a helper's result named the person's language; this did not.
  test("the person's, whatever the output's — a success, a failure and a job the deadline stopped alike", () => {
    const close = "Write it in the person's language, whatever language the output above is in.";
    expect(jobWakeMessage(completion())).toContain(close);
    expect(jobWakeMessage(completion({ status: "failed", exitCode: 1 }))).toContain(close);
    expect(jobWakeMessage({ ...completion({ status: "killed" }), stop: { by: "deadline", limitMs: 1_800_000 } })).toContain(close);
  });
});

describe("the unattended chain", () => {
  test("says nothing about the chain while there is budget left", () => {
    // Nine wake-ups in a row was a legitimate nine-step install. A budget note on every one of them
    // would be prompt spent on a limit nobody is near.
    const text = jobWakeMessage(completion(), { position: 9, limit: 100 });
    expect(text).not.toContain("do not start any further");
  });

  test("at the limit, tells the agent to report and stop", () => {
    const text = jobWakeMessage(completion(), { position: 100, limit: 100 });

    expect(text).toContain("wake-up 100");
    expect(text).toContain("do not start any further");
    // And the result is still in the message. A ceiling that suppressed the wake-up would hide exactly
    // the failures it was added alongside.
    expect(text).toContain("finished successfully");
    expect(text).toContain("Report THIS job");
  });

  test("a failure at the limit is still reported as a failure", () => {
    const text = jobWakeMessage(completion({ status: "failed", exitCode: 2 }), {
      position: 120,
      limit: 100,
    });

    expect(text).toContain("REACTION, and it comes FIRST");
    expect(text).toContain("do not start any further");
  });

  test("a limit of zero is no limit", () => {
    // For an install that wants an agent working unattended for a day, which is what this daemon is for.
    expect(jobWakeMessage(completion(), { position: 5_000, limit: 0 })).not.toContain(
      "do not start any further",
    );
  });

  test("and no chain information at all reads as before", () => {
    expect(jobWakeMessage(completion())).not.toContain("do not start any further");
  });
});

describe("an explicit on_complete instruction still wins", () => {
  test("because the agent asked to be told what to do next", () => {
    const text = jobWakeMessage(completion({ onComplete: "run the tests in the cloned directory" }));

    expect(text).toContain("run the tests in the cloned directory");
    // The fallback reporting instruction is not also appended: two instructions in one prompt is how
    // a model picks the easier one.
    expect(text).not.toContain("Report THIS job, before anything else");
  });
});

describe("what the turn owes at the end, wherever the last word comes from", () => {
  /**
   * The measurement that produced this: of 18 failed jobs on one box, the agent mentioned the failure
   * in **one** — and that one was the only turn that called no tools.
   *
   * Every other reply was a version of "…sedang berjalan di background, nanti gw kabarin", which is
   * not this prompt's wording at all. It is `wrapUpPrompt("background_started")`, appended at the tail
   * when a turn starts a job of its own, and at the tail it beats anything the opening prompt said.
   */
  test("a failure asks for the cause first and the new work after", () => {
    const owed = jobReportRequirement(completion({ status: "failed", exitCode: 1 }));

    expect(owed).toContain("did NOT succeed");
    expect(owed).toContain("WHY it failed, in your own words");
    expect(owed).toContain("Opening with newly started work");
    // The daemon's ⚠️ line already carries these, and repeating them is the duplicate we started from.
    expect(owed).toContain("do not repeat those");
  });

  test("a success asks for the result before the next step", () => {
    // Swallowed by the same override: nine consecutive successful installs were each announced as the
    // next step starting, so the person never learned that any of them finished.
    expect(jobReportRequirement(completion())).toContain("finished successfully");
    expect(jobReportRequirement(completion())).toContain("BEFORE mentioning anything you have just started");
  });

  test("a job the agent killed owes nothing", () => {
    // It has usually just said so in the message before this one.
    expect(jobReportRequirement(completion({ status: "killed" }))).toBeNull();
  });

  test("and neither does one with its own on_complete instruction", () => {
    // The agent asked to be told what to do next. Two instructions in one prompt is how a model picks
    // the easier one — which is the whole lesson of this file.
    expect(jobReportRequirement(completion({ onComplete: "run the tests" }))).toBeNull();
  });
});

/**
 * A job that died with the daemon.
 *
 * The case this whole path exists for — nobody but the daemon knows the work stopped — and the one
 * that reported nothing at all. Read off a live box: a `git clone` that had been running 41 minutes
 * was announced as **"failed with exit code unknown after 0s"**, no ⚠️ notice was posted, and the
 * agent was handed no obligation to say anything.
 *
 * `interruptOrphaned` reads the rows before it updates them, which it must. It also *returned* them
 * that way, still saying `running` — and every test downstream is a test for `failed` or
 * `interrupted`, so all of them quietly answered no.
 */
describe("a job interrupted by a restart", () => {
  const orphan = () =>
    completion(
      { status: "interrupted", exitCode: null, startedAt: 1_000, endedAt: 2_459_000 },
      "Updating files:  33% (225165/668037)",
    );

  test("is named as interrupted, not as a failure with an unknown code", () => {
    const text = jobWakeMessage(orphan());
    expect(text).toContain("was interrupted by a restart");
    expect(text).not.toContain("exit code unknown");
  });

  test("carries the time it actually ran", () => {
    // 41 minutes, reported as 0s. Zero is what a missing number looks like when it is given a default.
    expect(jobWakeMessage(orphan())).toContain("after 2458s");
  });

  test("says nothing about duration when there is none to say", () => {
    // Rather than inventing one. A record with no end time is unmeasured, not instantaneous.
    const text = jobWakeMessage(completion({ status: "failed", exitCode: 1, endedAt: null }));
    expect(text).not.toContain("after 0s");
    expect(text).toContain("failed with exit code 1");
  });

  test("posts the notice and owes the report, like any other unfinished work", () => {
    expect(jobFailureNotice(orphan())).toContain("interrupted by a restart");
    expect(jobReportRequirement(orphan())).toContain("did NOT succeed");
  });
});

describe("a log that redraws one line forever", () => {
  test("a carriage return ends a line, so progress does not become the report", () => {
    /**
     * Verbatim from the tail of that clone. `git` writes progress with `\r` and never a newline, so
     * split on newlines alone the whole 41 minutes is one line — and the 300 characters quoted from it
     * are three fragments of a percentage.
     */
    const tail =
      "Cloning into '/tmp/winget-pkgs'...\r" +
      "Updating files:  33% (225137/668037)\rUpdating files:  33% (225151/668037)\r" +
      "fatal: unable to write file: No space left on device";

    const notice = jobFailureNotice(completion({ status: "failed", exitCode: 128 }, tail));
    expect(notice).toContain("No space left on device");
    expect(notice).not.toContain("Updating files");
  });

  test("and when progress is genuinely all there is, it quotes one frame of it", () => {
    // A process killed mid-clone leaves nothing else. One line marked as "no error text" is honest;
    // 300 characters of concatenated percentages is not even readable.
    const notice = jobFailureNotice(
      completion({ status: "failed", exitCode: 137 }, "Updating files:  33% (225137/668037)\rUpdating files:  33% (225165/668037)"),
    );
    expect(notice).toContain("no error text");
    expect(notice).toContain("(225165/668037)");
    expect(notice).not.toContain("(225137/668037)");
  });
});

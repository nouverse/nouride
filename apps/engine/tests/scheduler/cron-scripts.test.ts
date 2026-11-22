/**
 * A script a job keeps (`JobScript`): its text is the job's, written to a file of each run's own and run by the program
 * the step names. Held here: what it reads and what it hands on, what a failure of it reads as, that nothing of the
 * text is left behind or shown to the program, the rules a script is held to when it is saved, who is written down as
 * having written it, and what is asked of the machine before a job with one is made. The programs are real ones, run
 * by `sh`, as in `cron-steps.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { CronSection, Job, JobPayload, JobStep, JobTarget } from "@nouride/shared";
import { AuditLog } from "@/commons/audit.store.ts";
import { migrate } from "@/db/index.ts";
import { CronStore, type JobInput } from "@/modules/cron/cron.store.ts";
import { SCRIPT_MAX_BYTES } from "@/modules/cron/job-command.ts";
import { proposalCard } from "@/modules/cron/proposals.ts";
import { CronScheduler, type CronExecutors, type JobTurnRequest, type JobTurnResult } from "@/modules/cron/scheduler.ts";
import { assertScriptsRun, scriptFactsOf, scriptsOf, type ScriptFacts } from "@/modules/cron/scripts.ts";
import { stepsFrom } from "@/modules/cron/step-input.ts";
import { CronValidationError } from "@/modules/cron/validate.ts";
import { eventually } from "../wait.ts";

const DIR = mkdtempSync(join(tmpdir(), "nouride-tmp-cron-scripts-"));
const TMP = join(DIR, "scratch");

const CONFIG: CronSection = {
  enabled: true,
  minIntervalMs: 1000,
  maxJobs: 20,
  runRetentionDays: 14,
  catchupWindowMs: 60_000,
  failStreakLimit: 3,
  quietHours: "",
  unattendedApproval: "auto",
  commandTimeoutMs: 5000,
};

let db: SqliteDb;
let store: CronStore;
let audit: AuditLog;

type Exits = Pick<JobStep, "then" | "whenFailed" | "whenEmpty" | "name">;
/** A step that is a script, run by `sh` unless it says otherwise. */
const script = (id: string, text: string, more: Exits & { run?: string[]; about?: string; secrets?: string[] } = {}): JobStep => {
  const { run, about, secrets, ...exits } = more;
  return { id, kind: "command", argv: run ?? ["sh"], script: { text, about: about ?? `does ${id}`, ...(secrets ? { secrets } : {}) }, ...exits };
};
const sh = (id: string, line: string, exits: Exits = {}): JobStep => ({ id, kind: "command", argv: ["sh", "-c", line], ...exits });
const ask = (id: string, message: string, exits: Exits = {}): JobStep => ({ id, kind: "agentTurn", message, ...exits });
const say = (id: string, text: string, exits: Exits = {}): JobStep => ({ id, kind: "systemEvent", text, ...exits });

function hands(answers: Record<string, JobTurnResult> = {}, overrides: Partial<CronExecutors> = {}) {
  const delivered: { target: JobTarget; text: string }[] = [];
  const turns: JobTurnRequest[] = [];
  const sandboxed: Pick<Job, "agentId" | "payload">[] = [];
  const executors: CronExecutors = {
    runTurn: async (request) => {
      turns.push(request);
      return answers[request.job.agentId] ?? { text: "turn output" };
    },
    dispatchTurn: () => true,
    deliver: async (target, text) => {
      delivered.push({ target, text });
      return { ok: true };
    },
    commandSandbox: (job) => {
      sandboxed.push(job);
      return { cwd: DIR, env: { PATH: process.env.PATH ?? "", TMPDIR: TMP } };
    },
    ...overrides,
  };
  return { scheduler: new CronScheduler({ store, config: CONFIG, executors }), delivered, turns, sandboxed };
}

function job(steps: JobStep[], overrides: Partial<JobInput> = {}): Job {
  return store.create({
    agentId: "nouva",
    name: "morning",
    trigger: { kind: "every", everyMs: 60_000 },
    payload: { kind: "steps", steps },
    target: { gatewayId: "telegram:main", chatId: "12345" },
    createdBy: "tester",
    ...overrides,
  });
}

const went = (jobId: string) => store.runs(jobId)[0]!.steps?.map((step) => `${step.id}:${step.status}`);
const refusal = (make: () => unknown): string => {
  try {
    make();
  } catch (err) {
    if (err instanceof CronValidationError) return err.message;
    throw err;
  }
  return "";
};

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  db = openDatabase(join(DIR, "t.db"));
  migrate(db);
  audit = new AuditLog(db);
  store = new CronStore({ db, config: CONFIG, timezone: "UTC", audit, now: () => Date.parse("2026-08-18T10:00:00Z") });
});

afterEach(() => {
  db.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe("a script a job keeps is run from its text", () => {
  test("the text is written out and run by the step's program, and what it prints is the run's", async () => {
    const made = job([script("count", 'n=0\nfor word in one two three; do n=$((n + 1)); done\necho "counted $n"')]);
    const { scheduler, delivered } = hands();

    const outcome = await scheduler.runNow(made.id, "tester");

    expect(outcome).toMatchObject({ status: "success", result: "counted 3" });
    expect(delivered.map((d) => d.text)).toEqual(["counted 3"]);
    expect(went(made.id)).toEqual(["count:done"]);
  });

  test("the program gets the script's file as its last argument, after its own", async () => {
    // `sh -e <file>`: the program's own argument first, so a line that fails ends the script there.
    const made = job([script("strict", "false\necho not reached", { run: ["sh", "-e"] })]);
    const { scheduler } = hands();

    const outcome = await scheduler.runNow(made.id, "tester");

    expect(outcome.status).toBe("error");
    expect(outcome.result).toContain("exit 1");
    expect(outcome.result).not.toContain("not reached");
  });

  test("it reads what the step before said on its standard input, and a line of arguments does not", async () => {
    const made = job([sh("find", "printf 'three issues open'"), script("shout", "tr a-z A-Z"), sh("old", "cat; echo 'read nothing'")]);
    const { scheduler } = hands();

    await scheduler.runNow(made.id, "tester");

    const steps = store.runs(made.id)[0]!.steps!;
    expect(steps[1]).toMatchObject({ id: "shout", status: "done", said: "THREE ISSUES OPEN" });
    // The command in the field keeps the input it had: none. Given the step before's words it would have printed them.
    expect(steps[2]).toMatchObject({ id: "old", status: "done", said: "read nothing" });
  });

  test("a webhook's body no step has read is the script's to read, before what a step said", async () => {
    const made = job([script("first", "cat"), script("second", "cat")], { trigger: { kind: "webhook" } });
    const { scheduler } = hands();

    await scheduler.runNow(made.id, "webhook", { body: '{"ref":"main"}' });

    const steps = store.runs(made.id)[0]!.steps!;
    expect(steps[0]).toMatchObject({ id: "first", said: '{"ref":"main"}' });
    // Read once: the second reads what the first printed, which here is the same words by another road.
    expect(steps[1]).toMatchObject({ id: "second", said: '{"ref":"main"}' });
  });

  test("printing nothing is having nothing to say, and the run ends there quietly", async () => {
    const made = job([script("quiet", "true"), say("tell", "never sent")]);
    const { scheduler, delivered } = hands();

    const outcome = await scheduler.runNow(made.id, "tester");

    expect(outcome.status).toBe("success");
    expect(went(made.id)).toEqual(["quiet:empty"]);
    expect(delivered).toEqual([]);
  });

  test("a non-zero exit is the step's failure, with what the script wrote as the reason", async () => {
    const made = job([script("save", 'echo "the service said no" >&2\nexit 3')]);
    const { scheduler } = hands();

    const outcome = await scheduler.runNow(made.id, "tester");

    expect(outcome.status).toBe("error");
    // With no name of its own, the step is called by what its script is said to do.
    expect(outcome.result).toBe('step 1 of 1, the script "does save" failed: exit 3\nthe service said no');
  });

  test("a program that is not on the machine is a failure that names it", async () => {
    const made = job([script("save", "print('hi')", { run: ["no-such-program-here"] })]);
    const { scheduler } = hands();

    const outcome = await scheduler.runNow(made.id, "tester");

    expect(outcome.status).toBe("error");
    expect(outcome.result).toContain("exit 127");
    expect(outcome.result).toContain("no-such-program-here");
  });

  test("the program is not shown the text it is run from, and its file is gone when it ends", async () => {
    // The text travels to the shell that writes it out in a variable: taken away before the program starts.
    const made = job([script("look", 'env | grep -c NOURIDE_SCRIPT || true\ncase "$0" in "$TMPDIR"/nouride-script.*/script) echo "ran from a file of its run";; *) echo "ran from $0";; esac')]);
    const { scheduler } = hands();

    await scheduler.runNow(made.id, "tester");

    expect(store.runs(made.id)[0]!.steps![0]!.said).toBe("0\nran from a file of its run");
    // The run's own folder, made in the agent's temporary folder (itself made where it was not there), and removed.
    expect(readdirSync(TMP)).toEqual([]);
  });

  test("a script that fails leaves no file behind either", async () => {
    const made = job([script("bad", "exit 9")]);
    const { scheduler } = hands();

    await scheduler.runNow(made.id, "tester");

    expect(readdirSync(TMP)).toEqual([]);
  });

  test("the sandbox is asked for the script with the command, so the secrets it names can be handed", async () => {
    const made = job([script("post", "echo sent", { secrets: ["notion_token"] })]);
    const { scheduler, sandboxed } = hands();

    await scheduler.runNow(made.id, "tester");

    expect(sandboxed).toHaveLength(1);
    expect(sandboxed[0]!.payload).toMatchObject({ kind: "command", argv: ["sh"], script: { secrets: ["notion_token"] } });
  });

  test("a job that is one script runs it, and reads the body of the call that set it off", async () => {
    const made = store.create({
      agentId: "nouva",
      name: "hook",
      trigger: { kind: "webhook" },
      payload: { kind: "command", argv: ["sh"], script: { text: "tr a-z A-Z", about: "shouts what it is sent" }, then: "deliver" },
      target: { gatewayId: "telegram:main", chatId: "12345" },
      createdBy: "tester",
    });
    const { scheduler, delivered } = hands();

    const outcome = await scheduler.runNow(made.id, "webhook", { body: "pushed to main" });

    expect(outcome).toMatchObject({ status: "success", result: "PUSHED TO MAIN" });
    expect(delivered.map((d) => d.text)).toEqual(["PUSHED TO MAIN"]);
  });

  test("a script among steps started together reads what the step before said", async () => {
    const made = job([sh("find", "printf 'red green'"), { id: "both", kind: "parallel", steps: [{ id: "up", kind: "command", name: "Up", argv: ["sh"], script: { text: "tr a-z A-Z", about: "shouts" } }, { id: "n", kind: "command", name: "Count", argv: ["sh"], script: { text: "wc -w | tr -d ' '", about: "counts" } }] }]);
    const { scheduler, delivered } = hands();

    await scheduler.runNow(made.id, "tester");

    expect(delivered[0]!.text).toBe("**Up**\nRED GREEN\n\n**Count**\n2");
  });
});

describe("a step after one that failed is still given the work", () => {
  test("an agent's step reads why the step before failed, and what that step had been handed", async () => {
    const made = job([sh("sum", "printf 'four mails, one urgent'"), script("save", "echo 'no route to the service' >&2; exit 1", { name: "Save it", whenFailed: "next" }), ask("tell", "Tell them how it went.")]);
    const { scheduler, turns } = hands();

    await scheduler.runNow(made.id, "tester");

    const message = turns[0]!.message;
    expect(message).toContain('Step 2 of 3, "Save it" ran before this step and failed.');
    expect(message).toContain("no route to the service");
    expect(message).toContain("What the failed step had been handed, from the command `sh -c printf 'four mails, one urgent'`, is below: the work as it stood before the failure.");
    expect(message).toContain("four mails, one urgent");
  });

  test("a script after a failure reads the work, never the failure's own words", async () => {
    const made = job([sh("sum", "printf 'four mails'"), script("save", "exit 1", { whenFailed: "next" }), script("keep", "cat")]);
    const { scheduler } = hands();

    await scheduler.runNow(made.id, "tester");

    expect(store.runs(made.id)[0]!.steps![2]).toMatchObject({ id: "keep", status: "done", said: "four mails" });
  });

  test("a run that goes on past a failure to its end says the work, with the failure under it", async () => {
    const made = job([sh("sum", "printf 'four mails, one urgent'"), script("save", "echo 'the service said no' >&2; exit 1", { name: "Save it", whenFailed: "next" }), { id: "ok", kind: "approval", ask: "Go on anyway?" }]);
    const { scheduler, delivered } = hands();

    const parked = await scheduler.runNow(made.id, "tester");
    expect(parked.status).toBe("waiting");
    const run = store.runs(made.id)[0]!;
    scheduler.answerRun(run.id, true, "Mira", "dashboard");
    // The answer takes the run up again on its own time.
    await eventually(() => store.runs(made.id)[0]!.status === "success", 4_000, "the run to end");

    expect(delivered.map((d) => d.text)).toEqual(['four mails, one urgent\n\n⚠️ Step 2 of 3, "Save it" failed: exit 1\nthe service said no']);
    expect(store.runs(made.id)[0]).toMatchObject({ status: "success" });
  });

  test("two failures in a row keep the work the first one was handed", async () => {
    const made = job([sh("sum", "printf 'the work'"), script("a", "exit 1", { whenFailed: "next" }), script("b", "exit 2", { whenFailed: "next" }), script("keep", "cat")]);
    const { scheduler } = hands();

    await scheduler.runNow(made.id, "tester");

    expect(store.runs(made.id)[0]!.steps![3]).toMatchObject({ id: "keep", said: "the work" });
  });

  test("with nothing before the failed step, the step after it has the failure alone, as it had", async () => {
    const made = job([script("save", "echo 'refused' >&2; exit 1", { name: "Save it", whenFailed: "next" }), ask("tell", "Tell them.")]);
    const { scheduler, turns } = hands();

    await scheduler.runNow(made.id, "tester");

    expect(turns[0]!.message).toContain('Step 1 of 2, "Save it" ran before this step and failed.');
    expect(turns[0]!.message).not.toContain("had been handed");
  });
});

describe("what a script must be, said when the job is saved", () => {
  const one = (script: Record<string, unknown>, argv: unknown[] = ["sh"]): JobPayload => ({ kind: "steps", steps: stepsFrom([{ kind: "command", argv, script }]) });
  const make = (payload: JobPayload) => store.create({ agentId: "nouva", name: "n", trigger: { kind: "manual" }, payload, target: { gatewayId: "telegram:main", chatId: "1" }, createdBy: "tester" });

  test("it needs its text, and a line of what it does", () => {
    expect(refusal(() => make(one({ text: "  ", about: "x" })))).toBe("step 1: a script needs its text.");
    expect(refusal(() => make(one({ text: "echo hi", about: " " })))).toContain("step 1: a script says what it does, in a line (`about`)");
  });

  test("the program that runs it is one word", () => {
    expect(refusal(() => make(one({ text: "echo hi", about: "greets" }, [])))).toBe("step 1: a command needs an argv array.");
    expect(refusal(() => make(one({ text: "echo hi", about: "greets" }, ["sh -c"])))).toContain("a script names the program that runs it, one word");
  });

  test("a text longer than the machine starts a program with is refused with both numbers", () => {
    const long = "#".repeat(SCRIPT_MAX_BYTES + 1);
    expect(refusal(() => make(one({ text: long, about: "too long" })))).toContain(`a script is at most ${SCRIPT_MAX_BYTES} bytes, the most this machine starts a program with, and this one is ${SCRIPT_MAX_BYTES + 1}`);
    // Counted in bytes, as the machine counts: three for each of these.
    expect(refusal(() => make(one({ text: "€".repeat(SCRIPT_MAX_BYTES / 3), about: "fits" })))).toBe("");
    expect(refusal(() => make(one({ text: "€".repeat(SCRIPT_MAX_BYTES / 3 + 1), about: "does not" })))).toContain("bytes");
  });

  test("a NUL in the text is refused: the rest would never reach its file", () => {
    expect(refusal(() => make(one({ text: "echo a\0echo b", about: "cut" })))).toContain("holds a NUL byte");
  });

  test("its secrets are names", () => {
    expect(refusal(() => make(one({ text: "echo", about: "x", secrets: ["notion token"] })))).toContain("a script's `secrets` are the names of secrets its agent holds");
    expect(refusal(() => make(one({ text: "echo", about: "x", secrets: ["notion_token", "gh.token-2"] })))).toBe("");
  });

  test("a change to a job that is one command is held to the same rules", () => {
    const made = make({ kind: "command", argv: ["sh"], script: { text: "echo hi", about: "greets" }, then: "deliver" });
    expect(refusal(() => store.update(made.id, { payload: { kind: "command", argv: ["sh"], script: { text: "", about: "greets" }, then: "deliver" } }, "tester"))).toBe("a script needs its text.");
  });
});

describe("who wrote a script is written down by the daemon", () => {
  const by = (found: Job | null) => scriptsOf(found!.payload).map((one) => one.command.script.by);

  test("whoever makes the job wrote its scripts, whatever the caller sent", () => {
    // `by` in what a caller sends is not read: nobody signs a script with another's name.
    const steps = stepsFrom([{ id: "a", kind: "command", argv: ["sh"], script: { text: "echo a", about: "says a", by: "agent:nix" } }]);
    const made = job(steps, { createdBy: "agent:nouva" });
    expect(by(made)).toEqual(["agent:nouva"]);
  });

  test("saving a job keeps who wrote a script whose text is as it was, and signs a changed one with who changed it", () => {
    const made = job([script("a", "echo a"), script("b", "echo b")], { createdBy: "agent:nouva" });
    const changed = store.update(made.id, { payload: { kind: "steps", steps: [script("a", "echo a"), script("b", "echo B")] } }, "web:mira");
    expect(by(changed)).toEqual(["agent:nouva", "web:mira"]);
  });

  test("a change an agent proposes keeps who wrote the text it leaves alone", () => {
    const made = job([script("a", "echo a")], { createdBy: "web:mira" });
    const proposed = job([script("a", "echo a"), script("b", "echo b")], { createdBy: "agent:nouva", proposal: { by: "nouva", gatewayId: "telegram:main", chatId: "12345", for: "u1", at: 1, replaces: made.id } });
    expect(by(proposed)).toEqual(["web:mira", "agent:nouva"]);
  });

  test("the audit log keeps a script whole, when the job is made and when its text is changed", () => {
    const made = job([script("a", "echo first")], { createdBy: "agent:nouva" });
    store.update(made.id, { payload: { kind: "steps", steps: [script("a", "echo second")] } }, "web:mira");
    audit.stop();
    const texts = db.prepare<{ details: string }>("SELECT details FROM audit_log WHERE action IN ('cron_create', 'cron_update')").all().map((row) => row.details);
    expect(texts.some((text) => text.includes("echo first") && text.includes("agent:nouva"))).toBe(true);
    expect(texts.some((text) => text.includes("echo second") && text.includes("web:mira"))).toBe(true);
  });
});

describe("what is asked of the machine before a job with a script is made", () => {
  const facts = (over: Partial<ScriptFacts> = {}): ScriptFacts => ({ secrets: () => ["notion_token"], hasProgram: async () => true, ...over });
  const steps = (more: Parameters<typeof script>[2] = {}): JobPayload => ({ kind: "steps", steps: [sh("x", "true"), script("save", "echo", more)] });
  const said = async (run: Promise<void>): Promise<string> => run.then(() => "", (err: unknown) => (err instanceof CronValidationError ? `${err.field}: ${err.message}` : String(err)));

  test("a program that is not there is named, with the step", async () => {
    const refused = await said(assertScriptsRun("nouva", steps({ run: ["python3"] }), facts({ hasProgram: async () => false })));
    expect(refused).toBe("steps: step 2: `python3` is not on this machine for nouva's commands, so the script could not run: write it for a program that is (`sh` always is), or install that one.");
  });

  test("a secret its agent does not hold is named", async () => {
    const refused = await said(assertScriptsRun("nouva", steps({ secrets: ["notion_token", "gh_token"] }), facts()));
    expect(refused).toBe("steps: step 2: the script names `gh_token`, which nouva's commands are not handed: an admin adds a secret to an agent on its page.");
  });

  test("a job whose scripts can run, or with none, passes", async () => {
    expect(await said(assertScriptsRun("nouva", steps({ secrets: ["notion_token"] }), facts()))).toBe("");
    expect(await said(assertScriptsRun("nouva", { kind: "steps", steps: [sh("x", "true")] }, facts({ hasProgram: async () => false })))).toBe("");
  });

  test("the machine is asked where a job's command would run: `sh` is there, a made-up name is not", async () => {
    const real = scriptFactsOf({ secrets: () => [], sandbox: () => ({ cwd: DIR, env: { PATH: process.env.PATH ?? "" } }) });
    expect(await real.hasProgram("nouva", "sh")).toBe(true);
    expect(await real.hasProgram("nouva", "no-such-program-here")).toBe(false);
    // An agent that is not loaded has no place to look in.
    expect(await scriptFactsOf({ secrets: () => null, sandbox: () => null }).hasProgram("gone", "sh")).toBe(false);
  });
});

describe("a script on the card a person turns it on from", () => {
  const card = (text: string, more: { secrets?: string[] } = {}): string => {
    const made = job([script("save", text, { about: "Adds the summary to the notes page", ...more })], { createdBy: "agent:nouva", proposal: { by: "nouva", gatewayId: "telegram:main", chatId: "12345", for: "u1", at: 1 } });
    return proposalCard(made, "every minute", { buttons: true });
  };

  test("says what it is said to do, what runs it, how long it is and what it is handed, then its text whole", () => {
    const shown = card('curl -s "$URL"\necho done', { secrets: ["notion_token"] });
    // A list of one is said as the one thing it is: no "in order", no number.
    expect(shown).toContain("Does: Adds the summary to the notes page. With nothing to say, the run ends there.\n   a script run by `sh` on this machine, with no model: 2 lines, handed $NOTION_TOKEN\n```\ncurl -s \"$URL\"\necho done\n```\nResults: here");
    expect(shown).not.toContain("in order, each handed");
  });

  test("what is said of a script step stands before its text: nothing follows the end of its fence, where a chat app reads no sentence", () => {
    const made = job(
      [
        script("check", "curl -sf https://shop.example.com/health", { about: "Asks the shop whether it answers.", onlyChanged: true, whenFailed: "next" } as never),
        script("save", "cat > last.txt", { about: "Keeps what it was handed" }),
        { id: "tell", kind: "systemEvent", text: "Done." },
      ],
      { createdBy: "agent:nouva", proposal: { by: "nouva", gatewayId: "telegram:main", chatId: "12345", for: "u1", at: 1 } },
    );
    const shown = proposalCard(made, "every minute", { buttons: true });
    expect(shown).toContain("Does: in order, each handed what the one before said:\n1. Asks the shop whether it answers. It goes on only when this differs from the last run. If it fails, the run goes to step 2. With nothing to say, the run ends there.\n   a script run by `sh` on this machine, with no model: 1 line\n```\ncurl -sf https://shop.example.com/health\n```\n2. Keeps what it was handed. With nothing to say, the run ends there.\n   a script run by `sh` on this machine, with no model: 1 line\n```\ncat > last.txt\n```\n3. sends the text \"Done.\"");
    // Every fence's end is a line of its own.
    expect(shown.split("\n").filter((line) => line.includes("```") && line !== "```")).toEqual([]);
  });

  test("a text too long for a message is not shown in part", () => {
    const shown = card("echo line\n".repeat(400));
    expect(shown).toContain("400 lines");
    expect(shown).toContain("(Its text is too long for a message: read it on the Automations page before you turn it on.)");
    expect(shown).not.toContain("echo line");
  });

  test("a fence in the text does not end the card's own", () => {
    const shown = card("cat <<'EOF'\n```\nEOF");
    expect(shown.split("```").length).toBe(3);
  });
});

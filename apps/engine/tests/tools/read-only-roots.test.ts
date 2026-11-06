/**
 * Reading a background job's log without being able to destroy it.
 *
 * `exec` answers `Live log: <dataDir>/jobs/<id>.log` the moment it starts something in the background,
 * and `read` refused that path — the tool named a file its own sandbox would not open. Observed on a
 * real run, immediately after the agent started a server and tried to check it.
 *
 * The obvious fix, adding the directory to `workspaceRoots`, would also let the agent truncate the log
 * of a job that is still running. So the roots split by intent, and these tests are about that split
 * holding in both directions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeTextFileAtomic } from "@nouride/runtime";
import { toUserMessage, type ToolContext } from "@nouride/shared";
import { editTool, rootsFor, writeTool, createReadTool } from "@/modules/tools/builtins/files.ts";
import { globTool, grepTool } from "@/modules/tools/builtins/search.ts";

const readTool = createReadTool();

let root: string;
let workspace: string;
let jobLogs: string;

beforeEach(async () => {
  root = join(tmpdir(), `nouride-roroots-${Math.floor(performance.now() * 1000)}`);
  workspace = join(root, "workspace");
  jobLogs = join(root, "jobs");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(jobLogs, { recursive: true });
  await writeTextFileAtomic(join(jobLogs, "job_1.log"), "listening on :3000\nready\n");
  await writeTextFileAtomic(join(workspace, "notes.md"), "mine\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    agentId: "nouva",
    sessionId: "s",
    chatId: "c",
    gateway: "web",
    gatewayId: "web:dashboard",
    senderId: "u",
    workspaceDir: workspace,
    agentDir: workspace,
    workspaceRoots: [workspace],
    readOnlyRoots: [jobLogs],
    signal: new AbortController().signal,
  } as ToolContext;
}

describe("read-only roots", () => {
  test("read reaches a job log", () => {
    expect(rootsFor(ctx(), "read")).toContain(jobLogs);
  });

  test("write does not", () => {
    expect(rootsFor(ctx(), "write")).not.toContain(jobLogs);
  });

  test("the agent can follow the log of a job it started", async () => {
    const result = await readTool.execute({ path: join(jobLogs, "job_1.log") }, ctx());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("listening on :3000");
  });

  test("but cannot overwrite it while the job is still writing", async () => {
    const result = await writeTool
      // The executor turns a thrown ToolError into a result with `toUserMessage`, so that — not the
      // internal message — is what the model actually reads.
      .execute({ path: join(jobLogs, "job_1.log"), content: "" }, ctx())
      .catch((err: unknown) => ({ content: toUserMessage(err), isError: true }));

    expect(result.isError).toBe(true);
    // And it distinguishes the two situations, because "readable but not writable" is something the
    // agent can act on and "outside the directories you may use" is not.
    expect(result.content).toContain("readable but not writable");
  });

  test("nor edit it", async () => {
    const result = await editTool
      .execute(
        { path: join(jobLogs, "job_1.log"), old_string: "ready", new_string: "gone" },
        ctx(),
      )
      .catch((err: unknown) => ({ content: toUserMessage(err), isError: true }));
    expect(result.isError).toBe(true);
  });

  test("discovery follows what read can open", async () => {
    // `glob` returning a path the next `read` refuses is the same bug one layer up, and this codebase
    // has hit that shape twice.
    const globbed = await globTool.execute({ pattern: "**/*.log" }, ctx());
    expect(globbed.content).toContain("job_1.log");

    const grepped = await grepTool.execute({ pattern: "listening" }, ctx());
    expect(grepped.content).toContain("job_1.log");
  });

  test("an agent with no read-only roots is unaffected", () => {
    const plain = { ...ctx(), readOnlyRoots: undefined } as ToolContext;
    expect(rootsFor(plain, "read")).toEqual([workspace]);
    expect(rootsFor(plain, "write")).toEqual([workspace]);
  });

  test("a read-only root does not become a way out of the sandbox", async () => {
    // The directory is reachable; its parent is not, and nor is anything beside it.
    const outside = join(root, "elsewhere.txt");
    await writeTextFileAtomic(outside, "secret");

    const result = await readTool
      .execute({ path: outside }, ctx())
      .catch((err: unknown) => ({ content: toUserMessage(err), isError: true }));
    expect(result.isError).toBe(true);
  });
});

describe("grep context", () => {
  test("returns surrounding lines with the match marked", async () => {
    // A match in a log or a stack trace is rarely the interesting line — the interesting one is just
    // above or below it, and without context the agent reads the file to find out.
    await writeTextFileAtomic(
      join(workspace, "app.log"),
      ["starting", "connecting to db", "FATAL: refused", "giving up", "bye"].join("\n"),
    );

    const result = await grepTool.execute({ pattern: "FATAL", context: 1 }, ctx());
    expect(result.content).toContain("connecting to db");
    expect(result.content).toContain("giving up");
    // The match is marked, so the model can tell which line it asked about.
    expect(result.content).toContain("> 3 |");
    expect(result.content).not.toContain("starting");
  });

  test("no context asked for is the old one-line-per-match shape", async () => {
    await writeTextFileAtomic(join(workspace, "app.log"), "a\nFATAL\nb\n");
    const result = await grepTool.execute({ pattern: "FATAL" }, ctx());
    expect(result.content).not.toContain("|");
  });

  test("an unreasonable context is capped rather than refused", async () => {
    // A model asking for 500 lines of context wants the file, and handing it back through a match
    // list is the expensive way to read one.
    await writeTextFileAtomic(
      join(workspace, "big.log"),
      Array.from({ length: 200 }, (_, i) => (i === 100 ? "NEEDLE" : `line ${i}`)).join("\n"),
    );
    const result = await grepTool.execute({ pattern: "NEEDLE", context: 500 }, ctx());
    expect(result.content).toContain("NEEDLE");
    expect(result.content.split("\n").length).toBeLessThan(30);
  });
});

/**
 * The other directory the daemon hands the agent a path to.
 *
 * `llm/spill.ts` writes a tool result too large for the context to
 * `<data_dir>/tool-output/<session>/<call>.txt` and the excerpt tells the model to open it with `read`
 * and an offset. That instruction is worth exactly as much as the sandbox's willingness to honour it —
 * and the job-log case above is the same bug, found live, on a path the tool itself had just printed.
 */
describe("spilled tool output", () => {
  let spilled: string;
  let file: string;

  beforeEach(async () => {
    spilled = join(root, "tool-output");
    mkdirSync(join(spilled, "ses_1"), { recursive: true });
    file = join(spilled, "ses_1", "call_1.txt");
    await writeTextFileAtomic(file, "line 1\nline 2\nline 3\n");
  });

  const spillCtx = () => ({ ...ctx(), readOnlyRoots: [jobLogs, spilled] }) as ToolContext;

  test("read opens the file the excerpt pointed at", async () => {
    const result = await readTool.execute({ path: file }, spillCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("line 2");
  });

  test("read honours an offset into it, which is how the excerpt says to use it", async () => {
    // "Open it with `read` and an offset" has to be true, not encouraging. A file the agent can open
    // only from the top is a file it cannot get the middle of — the one part the excerpt withheld.
    const result = await readTool.execute({ path: file, offset: 2, limit: 1 }, spillCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("line 2");
    expect(result.content).not.toContain("line 1");
  });

  test("grep narrows it, which is the other thing the excerpt suggests", async () => {
    const result = await grepTool.execute({ pattern: "line 3", path: spilled }, spillCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("call_1.txt");
  });

  test("the agent cannot overwrite what the harness wrote", async () => {
    // Read-only for the same reason the job logs are: the file is the daemon's record of what a tool
    // actually produced, and an agent that can rewrite it can rewrite the evidence it is reasoning
    // from — while a still-running turn may spill more into the same directory.
    // The sandbox throws and the executor turns that into an `isError` result — the same shape the
    // tests above use, so a refusal reads the same way whichever tool produced it.
    const refuse = (p: Promise<{ isError?: boolean }>) =>
      p.catch((err: unknown) => ({ content: toUserMessage(err), isError: true }));

    expect((await refuse(writeTool.execute({ path: file, content: "rewritten" }, spillCtx()))).isError).toBe(true);
    expect(
      (await refuse(editTool.execute({ path: file, old_string: "line 1", new_string: "nope" }, spillCtx()))).isError,
    ).toBe(true);
    // Still the harness's bytes.
    const after = await readTool.execute({ path: file }, spillCtx());
    expect(after.content).toContain("line 1");
  });

  test("without the root, the path the excerpt names is refused", async () => {
    // The failure this whole file exists to catch: a tool that prints a path its own sandbox will not
    // open. Proving the refusal is what makes the acceptance above mean something.
    const result = await readTool
      .execute({ path: file }, ctx())
      .catch((err: unknown) => ({ content: toUserMessage(err), isError: true }));

    expect(result.isError).toBe(true);
    expect(result.content).toBeTruthy();
  });
});

/**
 * The read limit, and the instruction it used to contradict.
 *
 * Over 256KB `read` refused the file outright — and said "use offset and limit", which the same check
 * then ignored. Found live by the feature that made it matter: `llm/spill.ts` hands the model a path to
 * a spilled tool result with exactly that instruction, and every spill worth making is bigger than
 * 256KB. Every one of those pointers was dead on arrival.
 */
describe("reading a file bigger than the read limit", () => {
  let big: string;
  const LINES = 200_000;

  beforeEach(async () => {
    big = join(root, "tool-output", "ses_1", "big.txt");
    mkdirSync(join(root, "tool-output", "ses_1"), { recursive: true });
    await writeTextFileAtomic(
      big,
      Array.from({ length: LINES }, (_, i) => `value ${i + 1}`).join("\n"),
    );
  });

  const bigCtx = () =>
    ({ ...ctx(), readOnlyRoots: [jobLogs, join(root, "tool-output")] }) as ToolContext;

  test("a windowed read succeeds at any file size", async () => {
    // The regression, in one assertion. 1.4MB of text, three lines asked for, three lines returned.
    const result = await readTool.execute({ path: big, offset: 100_000, limit: 3 }, bigCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("value 100000");
    expect(result.content).toContain("value 100002");
    expect(result.content).not.toContain("value 1\n");
  });

  test("a whole-file read is still refused, and now says why in terms that are true", async () => {
    // "Give me all of it" on a multi-megabyte file is the request the ceiling exists to refuse. What
    // changed is that the message no longer names a remedy the tool ignores.
    const result = await readTool.execute({ path: big }, bigCtx());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("whole-file read limit");
    expect(result.content).toContain("offset and limit");
  });

  test("an offset with no limit is capped on what it returns, not refused", async () => {
    // Otherwise it is a whole-file read wearing an offset. Cut rather than refused, because the offset
    // says the agent knows where it is going — and the cut line says where to continue from.
    const result = await readTool.execute({ path: big, offset: 2 }, bigCtx());

    expect(result.isError).toBeFalsy();
    expect(result.content.length).toBeLessThan(300 * 1024);
    expect(result.content).toContain("continue with offset");
  });

  test("a small file is unaffected in either mode", async () => {
    const small = join(jobLogs, "job_1.log");

    const whole = await readTool.execute({ path: small }, bigCtx());
    const part = await readTool.execute({ path: small, offset: 2, limit: 1 }, bigCtx());

    expect(whole.content).toContain("listening on :3000");
    expect(part.content.trim()).toBe("ready");
  });
});

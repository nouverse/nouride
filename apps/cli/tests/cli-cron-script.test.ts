/**
 * `nouride cron add` for a job that keeps a script, and for one that tells once and stops by itself; and the list's
 * word for a job that is off because it did what it was set to. The daemon reads and refuses all of it, so what is
 * held here is what the CLI sends, and what it says of the answer.
 */

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@nouride/cli-kit";
import { cron } from "../src/commands/cron.ts";

const RED = "\u001b[31m";
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nouride-cli-script-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function client(answers: Record<string, unknown> = {}) {
  const posts: { path: string; body: unknown }[] = [];
  const made = {
    get: async <T>(path: string) => (answers[path] ?? {}) as T,
    post: async <T>(path: string, body?: unknown) => {
      posts.push({ path, body });
      return (answers[path] ?? { job: { id: "cron_1", name: "watch" } }) as T;
    },
  } as unknown as Client;
  return { made, posts };
}

/** What a command printed, with its colours, and the code it ended the process with where it did. */
async function ran(run: () => Promise<void>): Promise<{ code: number | undefined; raw: string; text: string }> {
  const lines: string[] = [];
  const err = spyOn(console, "error").mockImplementation((line?: unknown) => void lines.push(String(line ?? "")));
  const log = spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(String(line ?? "")));
  let code: number | undefined;
  const exit = spyOn(process, "exit").mockImplementation(((given?: number) => {
    code = given;
    throw new Error("exit");
  }) as never);
  try {
    await run();
  } catch {
    // The command ended the process, which the double turns into a throw.
  } finally {
    exit.mockRestore();
    err.mockRestore();
    log.mockRestore();
  }
  const raw = lines.join("\n");
  return { code, raw, text: plain(raw) };
}

const WHERE = ["--agent", "nouva", "--gateway", "telegram:main", "--chat", "1"];

test("`add --script` sends the file's text as it is, with what runs it, what it does and the secrets it is handed; the program alone is its line", async () => {
  const file = join(dir, "check.py");
  const text = 'import sys\n\nprint("done" if "done" in sys.stdin.read() else "")\n';
  writeFileSync(file, text);
  const { made, posts } = client();

  await ran(() => cron(made, ["add", "--name", "watch", "--every", "30m", "--script", file, "--run", "python3", "--about", "Says done once the file holds it.", "--secrets", "notes_key, mail.key", ...WHERE]));

  expect(posts).toHaveLength(1);
  expect(posts[0]!.path).toBe("/cron");
  expect((posts[0]!.body as { payload: unknown }).payload).toEqual({ kind: "command", argv: ["python3"], script: { text, about: "Says done once the file holds it.", secrets: ["notes_key", "mail.key"] }, then: "deliver" });
});

test("with no `--run` it is a shell script; no secrets named, none are sent; `--then agent` hands what it printed to the agent", async () => {
  const file = join(dir, "check.sh");
  writeFileSync(file, "df -h / | tail -1\n");
  const { made, posts } = client();

  await ran(() => cron(made, ["add", "--name", "room", "--manual", "--script", file, "--about", "Says how full the disk is.", "--then", "agent", ...WHERE]));

  expect((posts[0]!.body as { payload: unknown }).payload).toEqual({ kind: "command", argv: ["sh"], script: { text: "df -h / | tail -1\n", about: "Says how full the disk is." }, then: "agentTurn" });
});

test("a script takes the place of `--command`, and a list of steps takes the place of both", async () => {
  const file = join(dir, "check.sh");
  writeFileSync(file, "echo ok\n");
  const steps = join(dir, "steps.json");
  writeFileSync(steps, JSON.stringify([{ kind: "systemEvent", text: "hello" }]));
  const { made, posts } = client();

  await ran(() => cron(made, ["add", "--name", "a", "--manual", "--command", "echo no", "--script", file, "--about", "Says ok.", ...WHERE]));
  await ran(() => cron(made, ["add", "--name", "b", "--manual", "--script", file, "--about", "Says ok.", "--steps", steps, ...WHERE]));

  expect((posts[0]!.body as { payload: { argv: string[]; script?: unknown } }).payload).toMatchObject({ argv: ["sh"], script: { text: "echo ok\n" } });
  expect((posts[1]!.body as { payload: { kind: string } }).payload.kind).toBe("steps");
});

test("a script's file that cannot be read is refused before anything is sent, as misuse", async () => {
  const { made, posts } = client();
  const said = await ran(() => cron(made, ["add", "--name", "x", "--manual", "--script", join(dir, "nowhere.sh"), "--about", "x", ...WHERE]));
  expect(said.code).toBe(2);
  expect(said.text).toContain("cannot read");
  expect(said.text).toContain("--script takes a file holding the script's text");
  expect(posts).toEqual([]);
});

test("`--once` and `--for` are sent as the marks the daemon reads, the length as it was typed; without them neither is sent", async () => {
  const { made, posts } = client();
  await ran(() => cron(made, ["add", "--name", "watch", "--every", "10m", "--text", "it is done", "--once", "--for", "6h", ...WHERE]));
  await ran(() => cron(made, ["add", "--name", "plain", "--every", "10m", "--text", "hello", ...WHERE]));
  await ran(() => cron(made, ["add", "--name", "quiet", "--every", "10m", "--text", "hello", "--quiet", "--for", "1d", ...WHERE]));

  expect((posts[0]!.body as { delivery: unknown }).delivery).toEqual({ mode: "announce", once: true, lasts: "6h" });
  expect((posts[1]!.body as { delivery: unknown }).delivery).toEqual({ mode: "announce" });
  expect((posts[2]!.body as { delivery: unknown }).delivery).toEqual({ mode: "none", lasts: "1d" });
});

test("the usage says each of them", async () => {
  const { made } = client();
  const said = await ran(() => cron(made, ["add"]));
  expect(said.code).toBe(2);
  for (const words of ["--script <file> --about <words>", "--run <program>", "sh (the default), python3, bun", "--secrets <name,name>", "--once", "tell once, then turn itself off", "--for <6h>", "stop by itself after that long"]) expect(said.text).toContain(words);
});

test("the list says why a job is off, in red only where something went wrong: one that told, lasted its time or fired did what it was set to", async () => {
  const job = (name: string, disabledReason: string) => ({
    id: `cron_${name}`,
    name,
    enabled: false,
    disabledReason,
    trigger: { kind: "every", everyMs: 600_000 },
    describes: "every 10m",
    agentId: "nouva",
    target: { gatewayId: "telegram:main", chatId: "1" },
    session: "fresh",
    payload: { kind: "systemEvent", text: "x" },
    runCount: 3,
    failCount: 0,
  });
  const { made } = client({ "/cron": { timezone: "UTC", jobs: [job("told", "told"), job("ended", "ended"), job("fired", "fired"), job("broke", "failed 5 times in a row")] } });

  const said = await ran(() => cron(made, ["list"]));

  const lineOf = (reason: string) => said.raw.split("\n").find((line) => line.includes(`next `) && plain(line).endsWith(`next ${reason}`)) ?? "";
  expect({ told: lineOf("told").includes(RED), ended: lineOf("ended").includes(RED), fired: lineOf("fired").includes(RED), broke: lineOf("failed 5 times in a row").includes(RED) }).toEqual({ told: false, ended: false, fired: false, broke: true });
  // Each is said, whatever its colour.
  for (const reason of ["told", "ended", "fired", "failed 5 times in a row"]) expect(said.text).toContain(`next ${reason}`);
});

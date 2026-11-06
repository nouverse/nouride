/**
 * The CLI as a program reads it (D4, D5, D11, D12, D14).
 *
 * A flag in either spelling, `--` respected, one name for stdin; an exit code that tells asking wrongly (2) from
 * failing (1); `--json` on any command; a doctor that reads what the daemon and the disk already know; a hint that
 * names the supervisor this machine has; and a restart that can be waited for. The exit codes are asserted on the
 * real CLI, spawned, because a code is only real at the process boundary.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterOptions, bareArgs, flagValue, hasFlag, normalizeArgv, takeFlag } from "@/cli/args.ts";
import { restartHint, startHint } from "@/cli/client.ts";
import { followFrom } from "@/cli/commands/logs.ts";
import { installFingerprint } from "@/modules/web/health.ts";
import { credentialChecks, databaseCheck, diskCheck, guardedFiles, healthIssues, modeChecks, packagesCheck } from "@/cli/commands/doctor-checks.ts";
import { progressOf, waitBack, waitUntilBack, type Seen } from "@/cli/wait-back.ts";
import { openDatabase } from "@nouride/runtime";
import { migrate } from "@/db/index.ts";
import { DaemonStateStore } from "@/commons/daemon-state.store.ts";
import { plain, runCli, spawnCli } from "../cli-harness.ts";
import { eventually } from "../helpers.ts";
import { sleep } from "../wait.ts";

const dir = mkdtempSync(join(tmpdir(), "nouride-cli-"));
const FREE_DISK = join(import.meta.dir, "fixtures/free-disk.ts");
let server: Server;
let port = 0;
/** Which install the stand-in says it is — "up"'s own, unless a test makes it another's. */
let answerAs = "";
/** What its `/health` says: up, unless a test has it starting — as boot answers, 503 and the step it is on. */
let starting = false;
/** Requests that carried a control token, which a stranger on the port must never see. */
let tokensSeen = 0;
/** What `nouride events -f` asked the stream for, and whether the stand-in refuses it. */
let streamAsked: string[] = [];
let refuseStream = false;
/** The pages `nouride events` asked for. */
let pagesAsked: string[] = [];
/** The stand-in's log ring: the old daemon's, nobody there, or a new daemon numbering from 1 again. */
let logsPhase: "before" | "down" | "after" = "before";
const logLine = (seq: number, message: string) => ({ seq, timestamp: "2026-10-17T08:00:00.000Z", level: "info", component: "daemon", message });

beforeAll(async () => {
  // A stand-in for the daemon: the control API answers two routes, `/health` one.
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers["x-nouride-token"]) tokensSeen += 1;
    if (req.url === "/api/control/jobs") return void res.end(JSON.stringify({ jobs: [] }));
    if (req.url === "/api/control/status") return void res.end(JSON.stringify({ gateways: [], agents: [] }));
    // What nginx answers for a daemon that is restarting behind it.
    if (req.url?.startsWith("/api/control/sessions")) {
      res.statusCode = 502;
      res.setHeader("content-type", "text/html");
      return void res.end("<html><body><h1>502 Bad Gateway</h1></body></html>");
    }
    if (req.url?.startsWith("/api/control/events/stream?")) {
      streamAsked.push(req.url);
      if (refuseStream) {
        res.statusCode = 401;
        return void res.end(JSON.stringify({ error: "a control token is required" }));
      }
      res.setHeader("content-type", "text/event-stream");
      // Held open, as a stream is: the test ends the follower.
      return void res.write(`retry: 3000\n\nevent: hello\ndata: {"version":"1.1","oldest":1,"latest":12,"epoch":"e"}\n\n`);
    }
    if (req.url?.startsWith("/api/control/events?")) {
      pagesAsked.push(req.url);
      const row = { seq: 12, at: Date.UTC(2026, 9, 16, 9, 30, 5), turnId: "turn_abcdef12", agentId: "nouva", kind: "tool", data: { text: "exec bun test" } };
      return void res.end(JSON.stringify({ events: req.url.includes("turn=turn_abcdef12") ? [row] : [], next: 12 }));
    }
    if (req.url?.startsWith("/api/control/logs?")) {
      // A daemon going down mid-restart: the connection is dropped, as a stopped process's would be refused.
      if (logsPhase === "down") return void req.socket.destroy();
      const since = Number(new URL(req.url, "http://x").searchParams.get("since") ?? "-1");
      if (logsPhase === "before") return void res.end(JSON.stringify({ entries: since < 5000 ? [logLine(5000, "before the restart")] : [], oldest: 1, latest: 5000 }));
      const fresh = [logLine(1, "starting again"), logLine(2, "booted again")].filter((line) => line.seq > since);
      return void res.end(JSON.stringify({ entries: since >= 5000 ? [] : fresh, oldest: 1, latest: 2 }));
    }
    if (req.url === "/health" && starting) {
      res.statusCode = 503;
      return void res.end(JSON.stringify({ status: "starting", phase: "loading agents", version: "0.7.4", uptime: 1, install: answerAs }));
    }
    if (req.url === "/health") return void res.end(JSON.stringify({ status: "ok", version: "0.7.4", uptime: 5, install: answerAs }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not here" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  mkdirSync(join(dir, "up", "data"), { recursive: true });
  writeFileSync(join(dir, "up", "data", ".control-token"), "token\n", { mode: 0o640 });
  writeFileSync(join(dir, "up", "config.toml"), `[daemon]\ndata_dir = "${join(dir, "up", "data")}"\n\n[dashboard]\nport = ${port}\n`);
  answerAs = installFingerprint(join(dir, "up", "data"));
  // An install whose daemon is not running: nothing listens on its port.
  mkdirSync(join(dir, "down", "data"), { recursive: true });
  writeFileSync(join(dir, "down", "data", ".control-token"), "token\n", { mode: 0o640 });
  writeFileSync(join(dir, "down", "config.toml"), `[daemon]\ndata_dir = "${join(dir, "down", "data")}"\n\n[dashboard]\nport = 9\n`);
  // A config that says things about itself — a key nothing reads, a floor worth a second look — on "up"'s data, which
  // the stand-in answers for, and on a data directory nobody answers for.
  const remarks = "[security]\nfoo_bar = 1\n\n[cron]\nmin_interval_ms = 1000\n";
  mkdirSync(join(dir, "noisy"), { recursive: true });
  writeFileSync(join(dir, "noisy", "config.toml"), `[daemon]\ndata_dir = "${join(dir, "up", "data")}"\n\n[dashboard]\nport = ${port}\n\n${remarks}`);
  mkdirSync(join(dir, "noisy-down", "data"), { recursive: true });
  writeFileSync(join(dir, "noisy-down", "config.toml"), `[daemon]\ndata_dir = "${join(dir, "noisy-down", "data")}"\n\n[dashboard]\nport = 9\n\n${remarks}`);
  // One that does not load at all.
  mkdirSync(join(dir, "broken"), { recursive: true });
  writeFileSync(join(dir, "broken", "config.toml"), "[queue]\nmax_concurrent_per_agent = 0\n");
  // One whose daemon is on its first start: the port answers, and there is no token yet. And one never started at all.
  mkdirSync(join(dir, "booting", "data"), { recursive: true });
  writeFileSync(join(dir, "booting", "config.toml"), `[daemon]\ndata_dir = "${join(dir, "booting", "data")}"\n\n[dashboard]\nport = ${port}\n`);
  mkdirSync(join(dir, "fresh", "data"), { recursive: true });
  writeFileSync(join(dir, "fresh", "config.toml"), `[daemon]\ndata_dir = "${join(dir, "fresh", "data")}"\n\n[dashboard]\nport = 9\n`);
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The CLI, for real, against `install` — from outside the checkout and without what its `.env` put in this process
 * (`PORT` would outrank the install's own port), so the install's config is the whole of what it reads.
 */
function cli(install: "up" | "down" | "noisy" | "noisy-down" | "broken" | "booting" | "fresh", ...rest: (string | Record<string, string>)[]): Promise<{ code: number; out: string; err: string }> {
  const args = rest.filter((arg): arg is string => typeof arg === "string");
  const extra = Object.assign({}, ...rest.filter((arg): arg is Record<string, string> => typeof arg !== "string"));
  return runCli(args, { cwd: dir, config: join(dir, install, "config.toml"), env: extra });
}

describe("argv (D14)", () => {
  test("--flag=value reads as --flag value — up to --, after which nothing is a flag", () => {
    const argv = normalizeArgv(["turns", "--limit=5", "--agent=ren", "--", "--then=x"]);
    expect(argv).toEqual(["turns", "--limit", "5", "--agent", "ren", "--", "--then=x"]);
    expect(flagValue(argv, "--limit")).toBe("5");
    expect(flagValue(argv, "--then")).toBeUndefined();
    expect(hasFlag(["check", "--", "ls", "--help"], "--help")).toBe(false);
    // A value may start with a dash when it is written with `=`.
    expect(flagValue(normalizeArgv(["cron", "add", "--message=--dry"]), "--message")).toBe("--dry");
  });

  test("--json is taken off wherever it stands before --, and left after it", () => {
    const argv = ["--json", "jobs", "--json", "--", "--json"];
    expect(takeFlag(argv, "--json")).toBe(true);
    expect(argv).toEqual(["jobs", "--", "--json"]);
    expect(takeFlag(["jobs"], "--json")).toBe(false);
  });

  test("the words without their flags, and everything after -- as words", () => {
    expect(bareArgs(["restore", "--force", "--", "--odd-name.db"])).toEqual(["restore", "--odd-name.db"]);
    expect(afterOptions(["check", "--", "rm", "-rf", "/"])).toEqual(["rm", "-rf", "/"]);
    expect(afterOptions(["check", "rm"])).toBeNull();
  });

});

describe("exit codes and --json (D5)", () => {
  test("asking wrongly is 2 — an unknown command or action, a missing or malformed argument", async () => {
    expect(await cli("down", "bogus")).toMatchObject({ code: 2, err: expect.stringContaining('Unknown command "bogus"') });
    const typo = await cli("down", "jobs", "lst");
    expect(typo.code).toBe(2);
    expect(typo.err).toContain('`nouride jobs` has no "lst"');
    expect(typo.err).toContain("nouride jobs log|kill <id>");
    expect((await cli("down", "cron", "rm")).code).toBe(2);
    expect((await cli("down", "logs", "--lines=many")).code).toBe(2);
    expect((await cli("down", "agent", "frobnicate", "ren")).code).toBe(2);
  });

  test("a count that is not one is asking wrongly — not quietly read as the default", async () => {
    expect((await cli("up", "turns", "--limit=abc")).code).toBe(2);
    expect((await cli("up", "events", "--limit", "-1")).code).toBe(2);
    expect((await cli("up", "memory", "episodes", "--limit", "x")).code).toBe(2);
  });

  test("another install's daemon on the port is refused, and is never sent this install's token", async () => {
    const own = answerAs;
    answerAs = "0123456789ab";
    tokensSeen = 0;
    try {
      const other = await cli("up", "jobs");
      expect(other.code).toBe(1);
      expect(other.err).toContain("belongs to another install (0123456789ab)");
      expect(other.err).toContain("its token was not sent");
      expect(tokensSeen).toBe(0);
    } finally {
      answerAs = own;
    }
    // And this install's own daemon gets it, as before.
    expect((await cli("up", "jobs")).code).toBe(0);
    expect(tokensSeen).toBeGreaterThan(0);
  });

  test("PORT, which any web project's .env sets, does not move the CLI — NOURIDE_PORT does", async () => {
    expect((await cli("up", "jobs", { PORT: "9" })).code).toBe(0);
    expect((await cli("up", "jobs", { NOURIDE_PORT: "9" })).err).toContain("Cannot reach the daemon at http://localhost:9");
  });

  test("a daemon that is not there is 1, with how to start it here", async () => {
    // A HOME of its own: on a Mac with Nouride installed, the hint is launchd's — rightly — and this run is not that Mac.
    const down = await cli("down", "jobs", { HOME: dir });
    expect(down.code).toBe(1);
    expect(down.err).toContain("Cannot reach the daemon");
    // This host's own way: systemd's on a box with the unit — the checkout an agent codes in on the live box (0.8.5) —
    // else `nouride start`. Which one each host gets is `startHint`'s, below (D11).
    expect(down.err).toContain(startHint({ launchd: join(dir, "Library", "LaunchAgents", "none.plist") }));
  });

  test("a daemon on its first start is waited for until it writes its token — not taken for one that never ran", async () => {
    // 0.7.10's e2e: `/health` answered `starting`, and the CLI said "No control token found … Start the daemon once".
    const own = answerAs;
    const data = join(dir, "booting", "data");
    answerAs = installFingerprint(data);
    starting = true;
    try {
      const child = spawnCli(["jobs"], { cwd: dir, config: join(dir, "booting", "config.toml") });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      const code = new Promise<number | null>((resolve) => child.on("close", resolve));
      await eventually(() => plain(err).includes("nouride is starting (loading agents); waiting for its control token"), 10_000, "the wait said");
      // Its control plane comes up: the token, then the port answering as ready.
      writeFileSync(join(data, ".control-token"), "token\n", { mode: 0o640 });
      starting = false;
      expect(await code).toBe(0);
      expect(plain(out)).toContain("no background jobs");
      expect(plain(err)).not.toContain("No control token found");
    } finally {
      answerAs = own;
      starting = false;
      rmSync(join(data, ".control-token"), { force: true });
    }
  });

  test("and one that never ran is still told how to start it here", async () => {
    const never = await cli("fresh", "jobs");
    expect(never.code).toBe(1);
    expect(never.err).toContain("No control token found");
    expect(never.err).toContain("which the daemon writes the first time it starts");
  });

  test("--json is one object on stdout: the daemon's answer, or what went wrong", async () => {
    expect(JSON.parse((await cli("up", "--json", "jobs")).out)).toEqual({ ok: true, data: { jobs: [] }, error: null, hint: null });
    expect(JSON.parse((await cli("down", "version", "--json")).out)).toMatchObject({ ok: true, data: { version: expect.any(String) } });

    const wrong = await cli("down", "--json", "jobs", "lst");
    expect(wrong.code).toBe(2);
    expect(JSON.parse(wrong.out)).toMatchObject({ ok: false, data: null, error: '`nouride jobs` has no "lst".' });
    const gone = await cli("down", "--json", "jobs");
    expect(gone.code).toBe(1);
    expect(JSON.parse(gone.out)).toMatchObject({ ok: false, error: expect.stringContaining("Cannot reach the daemon") });
  });

  test("and refused for a command that keeps the terminal rather than answering once", async () => {
    expect(await cli("down", "--json", "chat")).toMatchObject({ code: 2, out: expect.stringContaining("not available for `nouride chat`") });
    expect((await cli("down", "--json", "logs", "-f")).code).toBe(2);
  });

  test("a call missing what it needs prints its usage and exits 2 — it used to be a success", async () => {
    // The `nouride` tool marks a result as an error only on a non-zero exit, so each of these reached the model as done.
    const asked: string[][] = [
      ["cron", "add"],
      ["cron", "update", "job_1"],
      ["mcp", "add"],
      ["mcp-server", "token", "create"],
      ["secret", "set"],
      ["people", "set", "sam"],
      ["access", "allow", "nobody"],
      ["webhook", "add"],
      ["provider", "add"],
      ["skills", "search"],
      ["skills", "install"],
      ["skills", "on", "pdf"],
      ["memory", "set", "facts"],
    ];
    const runs = await Promise.all(asked.map((words) => cli("down", "--json", ...words)));
    runs.forEach((run, at) => {
      expect({ asked: asked[at], code: run.code }).toEqual({ asked: asked[at], code: 2 });
      expect(JSON.parse(run.out)).toMatchObject({ ok: false, error: expect.stringContaining("nouride") });
    });
  });

  test("a bare group is its help, said as help; a restore that names no snapshot is asking wrongly", async () => {
    // `lint-cli-exit-code-guard`: `nouride db` printed a copy of its usage with 0 and nothing to say it was help, and
    // `db restore` with no file printed the list with 0. Help is an answer when it says so — `--json` carries `help`.
    const db = await cli("down", "db");
    expect(db.code).toBe(0);
    expect(db.out).toContain("nouride db restore <file>");
    expect(JSON.parse((await cli("down", "--json", "db")).out)).toMatchObject({ ok: true, data: { help: expect.stringContaining("nouride db backup") } });
    expect(JSON.parse((await cli("down", "--json", "config")).out)).toMatchObject({ ok: true, data: { help: expect.stringContaining("nouride config check") } });
    const restore = await cli("down", "db", "restore");
    expect(restore.code).toBe(2);
    expect(restore.err).toContain("usage: nouride db restore <file>");
    expect(restore.err).toContain("There are no snapshots to put back yet");
  });

  test("an agent restarting without --then is told how, exit 2 — the daemon is not restarted", async () => {
    const restart = await cli("up", "restart", { NOURIDE_AGENT_ID: "nouva" });
    expect(restart.code).toBe(2);
    expect(restart.err).toContain("--then");
    const gateway = await cli("up", "gateway", "restart", "telegram:nouva", { NOURIDE_AGENT_ID: "nouva" });
    expect(gateway.code).toBe(2);
    expect(gateway.err).toContain("--then");
  });

  test("`memory backfill`, the import of 0.5 and 0.6 captures gone in 0.8.0, is an action memory does not have — exit 2", async () => {
    // `up`: a daemon answers, so a 2 is the CLI's own refusal and not a route that is not there any more.
    for (const words of [["memory", "backfill", "/srv/old/.nouride/memories"], ["memory", "backfill", "/srv/old/.nouride/memories", "--dry-run"]]) {
      const run = await cli("up", ...words);
      expect({ words, code: run.code }).toEqual({ words, code: 2 });
      expect(run.err).toContain('`nouride memory` has no "backfill"');
    }
    expect((await cli("up", "memory", "--help")).out).not.toContain("backfill");
  });

  test("a flag the command does not read is refused, exit 2, naming it — before the daemon is asked anything", async () => {
    // Found in 0.7.9's e2e: `pass` reads no flag, so `--dry-run` was dropped and a real pass ran. `down`: nothing
    // answers on its port, so a 2 here is the refusal, not a failure to connect.
    const pass = await cli("down", "memory", "pass", "--dry-run");
    expect(pass.code).toBe(2);
    expect(pass.err).toContain("`nouride memory pass` does not take --dry-run");
    expect(JSON.parse((await cli("down", "--json", "memory", "pass", "--dry-run")).out)).toMatchObject({ ok: false, error: expect.stringContaining("--dry-run") });
    // The action that reads it still takes it, and a flag's value is a value, not a flag: `--arg -y`.
    expect((await cli("down", "memory", "forget", "sam", "--anonymize")).code).toBe(1);
    expect((await cli("down", "mcp", "add", "--agent", "a", "--name", "fs", "--command", "npx", "--arg", "-y", "--arg", "pkg")).code).toBe(1);
  });

  test("what a proxy answers instead of the daemon is a failure said as one, and still one envelope", async () => {
    const html = await cli("up", "sessions");
    expect(html.code).toBe(1);
    expect(html.err).toContain("did not answer: something in front of it did, with 502 text/html");
    expect(html.err).not.toContain("SyntaxError");
    const json = await cli("up", "--json", "sessions");
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, error: expect.stringContaining("502") });
  });

  test("words after -- are a command's own: policy check -- ls --help asks about ls --help", async () => {
    const run = await cli("down", "policy", "check", "--", "ls", "--help");
    expect(run.code).toBe(0);
    expect(run.out).toContain("$ ls --help");
  });
});

describe("nouride events", () => {
  test("a page of the stream, oldest first, and the cursor to ask from next", async () => {
    const page = await cli("up", "events", "--turn", "turn_abcdef12");
    expect(page.code).toBe(0);
    expect(page.out).toContain("#12 09:30:05 tool        abcdef12 nouva exec bun test");
    expect(page.out).toContain("next: --since 12");
  });

  test("a conversation is a chat on one connection, so either alone is asking wrongly; following is not one answer", async () => {
    expect((await cli("up", "events", "--gateway", "telegram:main")).code).toBe(2);
    expect((await cli("up", "events", "-f", "--json")).code).toBe(2);
  });
});

describe("doctor (D4)", () => {
  test("providers: a fresh install with none is sent to setup, not asked to set one of an empty list", () => {
    // Seen on 0.8.0's Docker run: "Set one of: . See .env.example." before setup had written a profile.
    expect(credentialChecks([])).toEqual([{ level: "bad", message: "no provider profile yet, so no agent can answer", hint: "Finish setting it up: open the dashboard, or run `nouride setup`." }]);
    const none = credentialChecks([{ name: "nougate", hasCredential: false }]);
    expect(none[0]).toMatchObject({ level: "bad", hint: "Set one of: nougate. See .env.example." });
    expect(none[1]).toMatchObject({ level: "warn", message: 'provider "nougate" has no credential' });
    expect(credentialChecks([{ name: "nougate", hasCredential: true }, { name: "ollama", hasCredential: false }]).map((c) => c.level)).toEqual(["ok", "warn"]);
  });

  test("free disk against the daemon's own threshold", () => {
    expect(diskCheck(5 * 1024 ** 3, 1024)).toMatchObject({ level: "ok" });
    expect(diskCheck(300 * 1024 ** 2, 1024)).toMatchObject({ level: "bad", message: expect.stringContaining("300 MB free") });
    expect(diskCheck(null, 1024).level).toBe("ok");
  });

  test("the database's own quick_check, and a file that is not a database fails it", () => {
    const path = join(dir, "broken.db");
    writeFileSync(path, "not a database at all, just text that is long enough to have a header");
    const { checkDatabaseFile } = require("@nouride/runtime") as typeof import("@nouride/runtime");
    expect(databaseCheck(path, true, checkDatabaseFile)).toMatchObject({ level: "bad" });
    expect(databaseCheck(path, false, checkDatabaseFile).level).toBe("ok");
  });

  test("a secret's file more open than the daemon makes it is a warning, and --fix narrows it", () => {
    const data = join(dir, "modes");
    mkdirSync(join(data, "credentials"), { recursive: true });
    writeFileSync(join(data, ".control-token"), "t");
    writeFileSync(join(data, "secrets.json"), "{}");
    chmodSync(join(data, ".control-token"), 0o644);
    chmodSync(join(data, "secrets.json"), 0o600);
    chmodSync(join(data, "credentials"), 0o755);
    const io = { mode: (path: string) => { try { return statSync(path).mode & 0o7777; } catch { return null; } }, chmod: (path: string, mode: number) => (chmodSync(path, mode), true) };
    const files = guardedFiles(data, join(data, "credentials"));

    const seen = modeChecks(files, io, false);
    expect(seen.map((check) => check.message)).toEqual([
      `the control token is mode 0644, more open than 0640 (${join(data, ".control-token")})`,
      `the credentials directory is mode 0755, more open than 0700 (${join(data, "credentials")})`,
    ]);
    expect(seen.every((check) => check.level === "warn")).toBe(true);

    expect(modeChecks(files, io, true).every((check) => check.level === "ok")).toBe(true);
    expect(io.mode(join(data, ".control-token"))).toBe(0o640);
    expect(io.mode(join(data, "credentials"))).toBe(0o700);
    // Tighter than the daemon makes it is not a finding.
    chmodSync(join(data, ".control-token"), 0o600);
    expect(modeChecks(files, io, false)).toEqual([expect.objectContaining({ level: "ok" })]);
  });

  test("the package service: its backend, or the refusal of one that speaks another protocol — not 'did not answer'", async () => {
    const answering = (detail: string, status: "ok" | "refused" | "failed") => ({
      packageBackend: async () => (status === "ok" ? "apt" : null),
      askPackages: async () => ({ status, detail, installs: [], removes: [], output: "" }),
    });
    expect(await packagesCheck(answering("protocol=1 backend=apt", "ok"))).toEqual({ level: "ok", message: "system packages: on (apt)" });
    const older = await packagesCheck(answering("the package service on this box speaks protocol 2 … re-run install.sh with --allow-packages", "refused"));
    expect(older).toMatchObject({ level: "warn", message: expect.stringContaining("re-run install.sh") });
    expect(await packagesCheck(answering("could not reach the package service", "failed"))).toMatchObject({ message: "system packages: the service is set up but did not answer" });
  });

  test("what /health counts as wrong: a dead gateway is a fault, the rest worth a look", () => {
    expect(healthIssues(["telegram:main: dead", "sqlite wal 90MB exceeds threshold"]).map((check) => check.level)).toEqual(["bad", "warn"]);
  });

  test("lists what the last boot said about the setup, one line per thing with its agents — daemon or not", async () => {
    const said = (key: string, agent: string) => ({ key, message: "exec_secrets.github_token is unscoped", data: { agent_id: agent }, since: 1_000 });
    // The database a stopped daemon left, its row as a boot writes it (`daemon_state`, 0.8.18).
    const dbPath = join(dir, "down", "data", "nouride.db");
    const db = openDatabase(dbPath);
    await migrate(db);
    new DaemonStateStore(db).set("advisories", JSON.stringify({ version: 1, said: [said("a", "nouva"), said("b", "nix")] }));
    db.close();
    try {
      const run = await cli("down", "doctor", "--json");
      const results = JSON.parse(run.out).data.results as { level: string; message: string }[];
      expect(results).toContainEqual({ level: "warn", message: "exec_secrets.github_token is unscoped (nouva, nix)" });
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  /**
   * Doctor on the down install, with the free disk it reads stood in for (`fixtures/free-disk.ts`). It read the
   * machine's: a CI runner with 540 MB free said "2 problem(s)" where these say one, four reds on 2026-10-29.
   */
  const doctorWithFreeDisk = (mb: number) =>
    runCli(["doctor", "--json"], { cwd: dir, config: join(dir, "down", "config.toml"), env: { FAKE_FREE_DISK_MB: String(mb) }, preload: FREE_DISK });

  test("--json carries every result, and is not ok while one is a problem", async () => {
    const run = await doctorWithFreeDisk(50 * 1024);
    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.out);
    expect(envelope).toMatchObject({ ok: false, error: "1 problem(s)", data: { problems: 1 } });
    expect(envelope.data.results.map((result: { message: string }) => result.message)).toEqual(
      expect.arrayContaining(["disk: 50 GB free in the data directory", expect.stringContaining("Cannot reach the daemon")]),
    );
  });

  test("a disk under the threshold is a problem of its own, whatever the machine running the test has left", async () => {
    const run = await doctorWithFreeDisk(540);
    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.out);
    expect(envelope).toMatchObject({ ok: false, error: "2 problem(s)", data: { problems: 2 } });
    expect(envelope.data.results).toContainEqual(expect.objectContaining({ level: "bad", message: "disk: 540 MB free in the data directory, under the 1024 MB threshold" }));
  });
});

describe("what a config says about itself (cli-config-warnings-every-command)", () => {
  /** A person's terminal: the CLI's own floor, `warn`, rather than the harness's `error` — under which nothing shows. */
  const terminal = { LOG_LEVEL: "warn" };

  test("is not said by a command that asks the daemon something or reads the install: its stderr stays empty", async () => {
    // `nouride status` printed the file's unknown keys and advisories on every run, as JSON lines, above its answer.
    for (const words of [["jobs"], ["db", "list"], ["policy", "check", "ls"]]) {
      const run = await cli("noisy", ...words, terminal);
      expect({ words, code: run.code, err: run.err }).toEqual({ words, code: 0, err: "" });
    }
  });

  test("is listed by config check and doctor, as lines of their own — and under --json, in their answer", async () => {
    const check = await cli("noisy", "config", "check", terminal);
    expect(check).toMatchObject({ code: 0, err: "" });
    expect(check.out).toContain("! unknown config key ignored (key: security.foo_bar)");
    expect(check.out).toContain("! [cron] min_interval_ms is under a minute (min_interval_ms: 1000)\n  an agent can schedule");
    expect(JSON.parse((await cli("noisy", "--json", "config", "check", terminal)).out).data.notes).toEqual([
      { message: "unknown config key ignored", detail: "key: security.foo_bar" },
      { message: "[cron] min_interval_ms is under a minute", detail: "min_interval_ms: 1000", hint: "an agent can schedule a recurring model call at this cadence" },
    ]);

    const doctor = await cli("noisy-down", "--json", "doctor", terminal);
    expect(doctor.err).not.toContain("unknown config key");
    expect(JSON.parse(doctor.out).data.results).toContainEqual({ level: "warn", message: "config: unknown config key ignored (key: security.foo_bar)" });
  });

  test("a config that does not load is still said, and is a failure", async () => {
    const run = await cli("broken", "jobs", terminal);
    expect(run.code).toBe(1);
    expect(run.err).toContain("max_concurrent_per_agent must be at least 1");
  });

  test("and every command loads it quietly, through the one read the CLI has — the next one written too", () => {
    const cliDir = join(import.meta.dir, "../../src/cli");
    const sources = (readdirSync(cliDir, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".ts"))
      .map((file) => ({ file, text: readFileSync(join(cliDir, file), "utf8") }));
    const calls = sources.flatMap(({ file, text }) => [...text.matchAll(/loadGlobalConfig\(([^)]*)\)/g)].map((m) => ({ file, args: m[1]! })));
    // Read in one place, quietly — and a file this user may not read is one line there, not a stack trace
    // (`unreadable-config.test.ts`): `db`, `doctor` and `stop` read it themselves and printed one until 0.8.13.
    expect(calls.map((call) => call.file)).toEqual(["load-config.ts"]);
    expect(calls.filter((call) => !call.args.includes("quiet: true"))).toEqual([]);
    // The client, `stop`, `setup`, `doctor`, `db`, `pkg`, `tools`, `users`, `service`, `update --rollback`, `gateway rename`.
    expect(sources.filter(({ text }) => /\bloadConfig\(/.test(text)).length).toBeGreaterThanOrEqual(11);
  });
});

describe("`nouride events -f` (1.1)", () => {
  /** The follower, for as long as it takes the stand-in to see its stream asked for — then ended, as a person would. */
  async function follow(...args: string[]): Promise<{ code: number | null; err: string }> {
    const child = spawnCli(["events", "-f", ...args], { cwd: dir, config: join(dir, "up", "config.toml") });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    const closed = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    const until = Date.now() + 10_000;
    while (streamAsked.length === 0 && Date.now() < until) await sleep(25);
    const ended = await Promise.race([closed, new Promise<"running">((resolve) => setTimeout(() => resolve("running"), 300))]);
    if (ended === "running") child.kill();
    return { code: ended === "running" ? null : ended, err: plain(err) };
  }

  test("a page with no cursor is the newest one — a bare `nouride events` printed the oldest rows kept", async () => {
    pagesAsked = [];
    await cli("up", "events");
    await cli("up", "events", "--since", "3");
    expect(pagesAsked[0]).toContain("newest=1");
    expect(pagesAsked[1]).toContain("since=3");
    expect(pagesAsked[1]).not.toContain("newest=1");
  });

  test("follows from now, not from the first row there is, and asks for the control frames", async () => {
    streamAsked = [];
    refuseStream = false;
    const run = await follow();
    expect(run.code).toBeNull();
    expect(streamAsked[0]).toContain("tail=1");
    expect(streamAsked[0]).toContain("frames=1");
    expect(streamAsked[0]).not.toContain("since=");
  });

  test("a stream the daemon refuses ends the follow, with why — not a retry every three seconds for ever", async () => {
    streamAsked = [];
    refuseStream = true;
    try {
      const run = await follow("--since", "5");
      expect(streamAsked[0]).toContain("since=5");
      expect(run.code).toBe(1);
      expect(run.err).toContain("the event stream was refused");
    } finally {
      refuseStream = false;
    }
  });
});

describe("`nouride logs -f` across a restart (D17)", () => {
  test("goes on through the moment nobody answers, and picks the new daemon up from its first line", async () => {
    // It used `get`, which exits on an unreachable daemon: `logs -f` ended with "Cannot reach the daemon" at the
    // first poll of every restart it was there to follow. Seen on the live box in 0.7.10's end-to-end run.
    logsPhase = "before";
    const child = spawnCli(["logs", "-f"], { cwd: dir, config: join(dir, "up", "config.toml") });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    let exited = false;
    child.on("close", () => (exited = true));
    try {
      await eventually(() => out.includes("before the restart"), 10_000);
      logsPhase = "down";
      await sleep(2_500);
      expect(exited).toBe(false);
      logsPhase = "after";
      await eventually(() => out.includes("booted again"), 10_000);
      expect(plain(out)).toContain("(the daemon restarted)");
      expect(plain(out)).toContain("starting again");
      expect(plain(out)).toContain("booted again");
      expect(exited).toBe(false);
    } finally {
      child.kill();
      logsPhase = "before";
    }
  }, 30_000);

  test("a sequence that went back is a new daemon: followed from its first line, boot included", () => {
    // Before: asked for lines after the old daemon's 5000, the new one answered nothing until it passed 5000.
    expect(followFrom(5000, { latest: 12 })).toEqual({ since: 0, restarted: true });
    expect(followFrom(5000, { latest: 5003 })).toEqual({ since: 5003, restarted: false });
    expect(followFrom(5000, { latest: 5000 })).toEqual({ since: 5000, restarted: false });
  });
});

describe("how to start it here (D11)", () => {
  const file = (name: string) => {
    const path = join(dir, name);
    writeFileSync(path, "");
    return path;
  };
  const none = join(dir, "absent");

  test("the supervisor the unit file names — not a second, unsupervised daemon", () => {
    expect(startHint({ systemd: file("nouride.service"), launchd: none, container: none })).toContain("sudo systemctl start nouride");
    expect(startHint({ systemd: none, launchd: file("tech.nouverse.nouride.plist"), container: none })).toContain("launchctl kickstart");
    expect(startHint({ systemd: none, launchd: none, container: file("dockerenv") })).toContain("docker compose up -d");
    expect(startHint({ systemd: none, launchd: none, container: none })).toContain("nouride start");
  });

  test("and to restart it — what `nouride setup` beside a running daemon says next (0.8.15)", () => {
    expect(restartHint({ systemd: file("nouride.service"), launchd: none, container: none })).toBe("sudo systemctl restart nouride");
    expect(restartHint({ systemd: none, launchd: file("tech.nouverse.nouride.plist"), container: none })).toBe("launchctl kickstart -k gui/$(id -u)/tech.nouverse.nouride");
    expect(restartHint({ systemd: none, launchd: none, container: file("dockerenv") })).toBe("docker compose restart nouride   (from the host)");
    expect(restartHint({ systemd: none, launchd: none, container: none })).toBe("nouride stop, then nouride start");
  });
});

describe("--wait (D12)", () => {
  const before = { uptime: 600 };

  test("where a restart is, from one look at /health", () => {
    expect(progressOf(before, { reachable: true, status: "ok", uptime: 601 }, false)).toEqual({ kind: "waiting" });
    expect(progressOf(before, { reachable: false }, false)).toEqual({ kind: "down" });
    expect(progressOf(before, { reachable: true, status: "shutting_down" }, false)).toEqual({ kind: "down" });
    expect(progressOf(before, { reachable: true, status: "starting", phase: "connecting gateways" }, true)).toEqual({ kind: "starting", phase: "connecting gateways" });
    expect(progressOf(before, { reachable: true, status: "ok", uptime: 2, version: "0.7.4" }, true)).toMatchObject({ kind: "back", version: "0.7.4" });
    // Quicker than a poll: never seen to go, but younger than the process asked to.
    expect(progressOf(before, { reachable: true, status: "ok", uptime: 1 }, false)).toMatchObject({ kind: "back" });
  });

  /** A clock that moves only when the wait sleeps, and looks that come from a script. */
  function scripted(looks: Seen[]) {
    let t = 0;
    const said: string[] = [];
    return {
      said,
      deps: {
        look: async () => looks.shift() ?? looks.at(-1) ?? { reachable: false },
        say: (line: string) => void said.push(line),
        now: () => t,
        sleep: async (ms: number) => void (t += ms),
        timeoutMs: 10_000,
      },
    };
  }

  test("each change said once, and back when the new process answers", async () => {
    const run = scripted([
      { reachable: true, status: "ok", uptime: 600 },
      { reachable: true, status: "ok", uptime: 601 },
      { reachable: false },
      { reachable: true, status: "starting", phase: "loading agents" },
      { reachable: true, status: "starting", phase: "connecting gateways" },
      { reachable: true, status: "starting", phase: "connecting gateways" },
      { reachable: true, status: "ok", uptime: 1, version: "0.7.4" },
    ]);
    expect(await waitUntilBack(before, run.deps)).toMatchObject({ back: true, version: "0.7.4" });
    expect(run.said.map((line) => line.replace(/^\d+s\s+/, ""))).toEqual([
      "still the old process, finishing what is running before it restarts",
      "stopped",
      "starting: loading agents",
      "starting: connecting gateways",
      "back, 0.7.4",
    ]);
  });

  test("not back by the end of the wait is said, not waited on forever", async () => {
    const run = scripted([{ reachable: false }]);
    expect(await waitUntilBack(before, run.deps)).toMatchObject({ back: false, last: { kind: "down" } });
  });

  test("an update named by its tag, v0.7.4, that comes back on 0.7.4 took", async () => {
    const run = scripted([{ reachable: false }, { reachable: true, status: "ok", uptime: 1, version: "0.7.4" }]);
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await waitBack({ reachable: true, uptime: 600 }, "http://unused", { version: "v0.7.4" }, run.deps);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      log.mockRestore();
    }
  });

  test("an update that comes back on the old version fails, exit 1", async () => {
    const run = scripted([{ reachable: false }, { reachable: true, status: "ok", uptime: 1, version: "0.7.3" }]);
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(waitBack({ reachable: true, uptime: 600 }, "http://unused", { version: "0.7.4" }, run.deps)).rejects.toThrow("exit 1");
      expect(String(error.mock.calls[0]?.[0])).toContain("on 0.7.3: the update to 0.7.4 did not take");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

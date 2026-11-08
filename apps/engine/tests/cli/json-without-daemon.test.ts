/**
 * `--json` from the commands that answer without a daemon: one object on stdout, carrying what the lines were
 * printed from.
 *
 * The envelope's `data` is the daemon's last answer unless a command hands it one, and these talk to no daemon — so
 * `config schema --json` answered `data: null` with no schema in it, and `db list` no snapshots. What the code they
 * run logs went to stdout too, so `db backup --json` printed a log line and then the answer, two objects, which is
 * how this was found: backing a box up with it before an upgrade. Spawned, as the exit codes are only real there.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecorded } from "@/boot/last-run.ts";
import { VERSION } from "@/cli/version.ts";
import type { PackageAnswer } from "nouride-system-packages";
import { pkgAnswer } from "@/cli/commands/pkg.ts";
import { spawnCli } from "../cli-harness.ts";

const dir = mkdtempSync(join(tmpdir(), "nouride-json-"));

beforeAll(async () => {
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  // An install whose daemon is not running: nothing listens on its port.
  writeFileSync(join(dir, "config.toml"), `[daemon]\ndata_dir = "${data}"\nagents_dir = "${join(dir, "agents")}"\n\n[dashboard]\nport = 9\n`);
  writeFileSync(join(dir, "broken.toml"), "[daemon\n");
  // Migrated and recorded, as a daemon that has run leaves it: `gateway rename` refuses a schema this build has not
  // brought up to date, and `config check` data no version is recorded on.
  (await openRecorded(data, VERSION)).close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Envelope {
  ok: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
  hint: string | null;
}

/** The CLI against this install, at `LOG_LEVEL` when given — otherwise the CLI's own floor. */
function cli(args: string[], logLevel?: string): Promise<{ code: number; answer: Envelope; err: string }> {
  const child = spawnCli(["--json", ...args], { cwd: dir, config: join(dir, "config.toml"), env: logLevel ? { LOG_LEVEL: logLevel } : {} });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  return new Promise((resolve) =>
    child.on("close", (code) => {
      // Stdout as a program reads it: one line, one object — nothing logged before it. Said with the command, its
      // code and its stderr when it is not: a full-suite run once got nothing at all from one of nine at once.
      const lines = out.split("\n").filter((line) => line.trim());
      expect({ args, lines: lines.length, ...(lines.length === 1 ? {} : { code, err: err.slice(-800) }) }).toEqual({ args, lines: 1 });
      resolve({ code: code ?? -1, answer: JSON.parse(lines[0]!) as Envelope, err });
    }),
  );
}

describe("--json without a daemon (D5)", () => {
  test("what the work logs goes to stderr, and stdout is the answer alone", async () => {
    const backup = await cli(["db", "backup"], "info");
    expect(backup.code).toBe(0);
    expect(backup.answer).toMatchObject({ ok: true, data: { path: expect.stringMatching(/\.db$/), bytes: expect.any(Number) } });
    expect(backup.err).toContain('"message":"database backed up"');
  });

  test("each answers with what its lines were printed from", async () => {
    await cli(["db", "backup"]);
    const [list, verify, check, schema, explain, rules, gated, ungated, rename] = await Promise.all([
      cli(["db", "list"]),
      cli(["db", "verify"]),
      cli(["config", "check"]),
      cli(["config", "schema", "daemon"]),
      cli(["config", "explain", "daemon.data_dir"]),
      cli(["policy"]),
      cli(["policy", "check", "--", "rm", "-rf", "/"]),
      cli(["policy", "check", "--", "ls"]),
      cli(["gateway", "rename", "telegram:a", "telegram:b"]),
    ]);

    expect((list.answer.data?.snapshots as unknown[]).length).toBeGreaterThan(0);
    expect(verify.answer.data).toMatchObject({ ok: true, path: join(dir, "data", "nouride.db") });
    expect(check.answer.data).toMatchObject({ starts: true, source: join(dir, "config.toml"), gateways: [] });
    expect(schema.answer.data).toMatchObject({ title: expect.stringContaining("daemon"), properties: expect.any(Object) });
    expect(explain.answer.data).toMatchObject({ path: "daemon.data_dir", type: "string" });
    expect((rules.answer.data?.alwaysAsks as unknown[]).length).toBeGreaterThan(0);
    expect(gated.answer.data).toMatchObject({ command: ["rm", "-rf", "/"], class: "delete", asks: { careful: true, balanced: false, trusted: false } });
    expect(ungated.answer.data).toMatchObject({ command: ["ls"], class: null, asks: { careful: "once", balanced: false, trusted: false } });
    expect(rename.answer.data).toMatchObject({ from: "telegram:a", to: "telegram:b", applied: false });
    for (const run of [list, verify, check, schema, explain, rules, gated, ungated, rename]) expect(run.code).toBe(0);
  }, 30_000);

  test("a failure is an envelope too, and its code says which kind", async () => {
    const [noKey, noSection, broken, noPath, noIds] = await Promise.all([
      cli(["config", "explain", "daemon.nope"]),
      cli(["config", "schema", "nope"]),
      cli(["config", "check", join(dir, "broken.toml")]),
      cli(["config", "explain"]),
      cli(["gateway", "rename"]),
    ]);

    // Done and failed: 1. These printed their reason with nothing on stdout under --json — `exitProcess` after
    // lines `--json` does not print.
    expect(noKey).toMatchObject({ code: 1, answer: { ok: false, error: "no such key: daemon.nope", hint: expect.stringContaining("daemon.data_dir") } });
    expect(noSection).toMatchObject({ code: 1, answer: { ok: false, error: "no such section: nope" } });
    expect(broken).toMatchObject({ code: 1, answer: { ok: false, error: expect.stringContaining("this configuration would NOT start") } });
    // Asked wrongly: 2. Both printed their usage and exited 1 and 0.
    expect(noPath).toMatchObject({ code: 2, answer: { ok: false, error: "usage: nouride config explain <path>" } });
    expect(noIds).toMatchObject({ code: 2, answer: { ok: false, error: expect.stringContaining("usage: nouride gateway rename") } });
  }, 30_000);

  test("service answers with what it found, and its refusals are failures — they printed ok:true and exited 0", async () => {
    const [status, root, kind] = await Promise.all([
      cli(["service", "status"]),
      cli(["service", "install", "--user", "root", "--kind", "systemd"]),
      cli(["service", "install", "--user", "nouride", "--kind", "bogus"]),
    ]);
    // No daemon on this port: the shell's own process, said so.
    expect(status).toMatchObject({ code: 0, answer: { ok: true, data: { supervisor: expect.any(String), fromDaemon: false } } });
    // Refused to write a unit for root without --privileged: a refusal, 1, and nothing written.
    expect(root).toMatchObject({ code: 1, answer: { ok: false, error: expect.stringContaining("root") } });
    // A kind it does not know was written as a launchd plist once; now it is asking wrongly.
    expect(kind).toMatchObject({ code: 2, answer: { ok: false, error: "--kind bogus: expected systemd, launchd or procd" } });
  }, 30_000);

  test("a systemd unit comes with the helper's two, serving the folders this config names", async () => {
    const out = mkdtempSync(join(tmpdir(), "nouride-units-"));
    try {
      const written = await cli(["service", "install", "--user", "nouride", "--kind", "systemd", "--dir", out]);
      expect(written).toMatchObject({ code: 0, answer: { ok: true, data: { helper: [join(out, "nouride-run.socket"), join(out, "nouride-run@.service")] } } });
      const service = readFileSync(join(out, "nouride-run@.service"), "utf-8");
      // `.nouride` is the data directory's parent: the folders moved out of it sit beside it (`boot/kept-folders.ts`).
      expect(service).toContain(`--reads ${join(dir, "agents")} --reads ${join(dir, "jobs")} --reads ${join(dir, "attachments")} --reads ${join(dir, "tool-output")}`);
      expect(service).toContain(`--credentials ${join(dir, "credentials")} --service-user nouride`);
      expect(readFileSync(join(out, "nouride-run.socket"), "utf-8")).toContain("SocketGroup=nouride");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 30_000);

  test("pkg answers with the service's own answer, and a refusal's reason as the error", () => {
    // Only this half: `nouride pkg` needs the plugin and its root socket, which no checkout has.
    const planned: PackageAnswer = { status: "ok", detail: "1 to install", installs: ["jq"], removes: [], output: "" };
    expect(pkgAnswer(planned)).toEqual(planned);
    const refused: PackageAnswer = { ...planned, status: "refused", detail: "openssh-server is protected" };
    expect(pkgAnswer(refused)).toMatchObject({ status: "refused", error: "refused: openssh-server is protected" });
  });
});

/**
 * What each coding CLI was tested with, and what is out (0.8.24, v0.8.24 item 1): each built-in row names its package and
 * the lowest and highest versions this release was tested with; the newest published is read from the npm registry at
 * most once a day and on Check again, and nothing is said of it when the registry is not reached. The scan carries
 * where each installed CLI stands, and `nouride agents scan` and `nouride doctor` say it in the same words. Over fake
 * registry answers: a newer version out, the same, a version below the lowest, one above the highest, no network.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BUILT_IN_CLIS, cliStanding, type CliRow } from "@nouride/acp";
import type { Client } from "@nouride/cli-kit";
import { cliVersionChecks, scanClis } from "@/cli/commands/external-clis.ts";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { NewestVersions, type NewestRead } from "@/modules/external-agents/newest.ts";
import type { ScannedCli } from "@/modules/external-agents/scan.ts";
import { plain } from "../cli-harness.ts";

const TESTED = { lowest: "0.95.0", highest: "0.100.0" };
const ROW = { ...BUILT_IN_CLIS[0]!, package: "@agentclientprotocol/claude-agent-acp", tested: TESTED } as CliRow;

/** A registry that answers each package's `latest` as `answers` says: a version, a status, or no network. */
function registry(answers: Record<string, string | number | "offline">) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    const name = decodeURIComponent(String(url).replace("https://registry.npmjs.org/", "").replace(/\/latest$/, ""));
    asked.push(name);
    const answer = answers[name];
    if (answer === "offline" || answer === undefined) throw new TypeError("fetch failed: getaddrinfo EAI_AGAIN registry.npmjs.org");
    if (typeof answer === "number") return new Response("{}", { status: answer });
    return new Response(JSON.stringify({ name, version: answer }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

/** The service with one CLI at `version` and the registry above; its clock moved by hand. */
function service(version: string | null, answers: Record<string, string | number | "offline">) {
  const reg = registry(answers);
  let now = Date.parse("2026-11-08T10:00:00Z");
  const kept: { read: NewestRead | null } = { read: null };
  const newest = new NewestVersions({ fetch: reg.fetchImpl, now: () => now, kept: { load: () => kept.read, save: (read) => void (kept.read = read) } });
  const agents = new ExternalAgents({
    workspaceDir: () => "/nowhere",
    secretsFor: () => ({}),
    sessions: { load: () => ({}), save: () => {} },
    rows: () => [ROW],
    scan: async (row) => ({ id: row.id, name: row.name, command: row.command, install: row.install, login: true, package: row.package!, tested: row.tested!, installed: version !== null, ...(version ? { version } : {}) }),
    newest,
    now: () => now,
  });
  return { agents, asked: reg.asked, kept, later: (ms: number) => void (now += ms) };
}

const HOUR = 60 * 60_000;

describe("where a CLI's version stands", () => {
  test("against the tested range and the newest out: older, an update, up to date, newer", () => {
    expect(cliStanding("0.90.0", TESTED, "0.101.0")).toEqual({ standing: "older", offer: "0.100.0", untested: "0.101.0" });
    expect(cliStanding("0.97.0", TESTED, "0.100.0")).toEqual({ standing: "update", offer: "0.100.0" });
    expect(cliStanding("0.100.0", TESTED, "0.100.0")).toEqual({ standing: "current" });
    expect(cliStanding("0.100.0", TESTED, "0.101.0")).toEqual({ standing: "current", untested: "0.101.0" });
    expect(cliStanding("0.101.0", TESTED, "0.101.0")).toEqual({ standing: "newer" });
    // No registry: what is out is said of the tested versions alone, which are out already.
    expect(cliStanding("0.95.0", TESTED)).toEqual({ standing: "update", offer: "0.100.0" });
    expect(cliStanding("0.95.0", TESTED, "0.95.0")).toEqual({ standing: "update", offer: "0.100.0" });
  });

  test("a pre-release sorts below its release, numbers compare as numbers, and another shape is no verdict", () => {
    expect(cliStanding("0.101.1-preview.7", { lowest: "0.95.0", highest: "0.101.1" })).toEqual({ standing: "update", offer: "0.101.1" });
    expect(cliStanding("0.100.0", { lowest: "0.99.9", highest: "0.99.9" })).toEqual({ standing: "newer" });
    expect(cliStanding("0.100.0-preview.3", TESTED)).toEqual({ standing: "update", offer: "0.100.0" });
    expect(cliStanding("latest", TESTED)).toBeNull();
  });

  test("the built-in rows name their package and a tested range, lowest at or below highest", () => {
    for (const row of BUILT_IN_CLIS) {
      expect(row.package).toStartWith("@agentclientprotocol/");
      expect(row.install).toContain(row.package!);
      expect(["update", "current"]).toContain(cliStanding(row.tested!.lowest, row.tested!)!.standing);
    }
  });
});

describe("the scan, on fake registry answers", () => {
  test("a newer version out: the installed one at the newest tested is up to date, and the untested one is named", async () => {
    const { agents } = service("0.100.0", { [ROW.package!]: "0.101.0" });
    const [cli] = await agents.scan();
    expect(cli).toMatchObject({ package: ROW.package, tested: TESTED, newest: "0.101.0", standing: { standing: "current", untested: "0.101.0" } });
  });

  test("the same as installed, below the lowest, above the highest", async () => {
    expect((await service("0.100.0", { [ROW.package!]: "0.100.0" }).agents.scan())[0]).toMatchObject({ newest: "0.100.0", standing: { standing: "current" } });
    expect((await service("0.90.0", { [ROW.package!]: "0.100.0" }).agents.scan())[0]).toMatchObject({ standing: { standing: "older", offer: "0.100.0" } });
    expect((await service("0.102.0", { [ROW.package!]: "0.102.0" }).agents.scan())[0]).toMatchObject({ standing: { standing: "newer" } });
  });

  test("unreachable, or an answer that is not a version: nothing said of the newest", async () => {
    for (const answer of ["offline", 503, "not-a-version"] as const) {
      const [cli] = await service("0.97.0", { [ROW.package!]: answer }).agents.scan();
      expect(cli!.newest).toBeUndefined();
      expect(cli!.standing).toEqual({ standing: "update", offer: "0.100.0" });
    }
  });

  test("the registry asked at most once a day, and again on Check again; a restart reads what was kept", async () => {
    const box = service("0.97.0", { [ROW.package!]: "0.100.0" });
    await box.agents.scan();
    await box.agents.scan(true);
    box.later(23 * HOUR);
    await box.agents.scan();
    expect(box.asked).toHaveLength(1);
    await box.agents.scan(false, true);
    expect(box.asked).toHaveLength(2);
    box.later(25 * HOUR);
    await box.agents.scan();
    expect(box.asked).toHaveLength(3);
    // A restart: a new reader on the kept read, within its day, asks nothing.
    const again = new NewestVersions({ fetch: registry({}).fetchImpl, kept: { load: () => box.kept.read, save: () => {} }, now: () => box.kept.read!.at + HOUR });
    expect(await again.of([ROW.package!])).toEqual({ [ROW.package!]: "0.100.0" });
  });

  test("the Models page's list carries each standing and the package, and its Check again asks the registry afresh", async () => {
    const box = service("0.97.0", { [ROW.package!]: "0.100.0" });
    const [view] = await box.agents.accountList([]);
    expect(view).toMatchObject({ id: "claude-code", package: ROW.package, version: "0.97.0", standing: { standing: "update", offer: "0.100.0" } });
    await box.agents.accountList([]);
    expect(box.asked).toHaveLength(1);
    await box.agents.accountList([], true);
    expect(box.asked).toHaveLength(2);
  });

  test("a CLI not installed is not asked about: a box with none asks the registry nothing", async () => {
    const box = service(null, { [ROW.package!]: "0.100.0" });
    const [cli] = await box.agents.scan();
    expect(box.asked).toEqual([]);
    expect(cli!.standing).toBeUndefined();
  });
});

describe("`nouride agents scan` and `nouride doctor` say the same", () => {
  let lines: string[] = [];
  let log: ReturnType<typeof spyOn>;
  beforeEach(() => {
    lines = [];
    log = spyOn(console, "log").mockImplementation((line?: unknown) => void lines.push(plain(String(line ?? ""))));
  });
  afterEach(() => log.mockRestore());

  const cli = (version: string, newest?: string): ScannedCli => ({
    id: "claude-code",
    name: "Claude Code",
    command: "claude-agent-acp",
    install: ROW.install,
    login: true,
    installed: true,
    version,
    package: ROW.package!,
    tested: TESTED,
    ...(newest ? { newest } : {}),
    standing: cliStanding(version, TESTED, newest)!,
  });

  test("each standing in a line, a warning where the version is one to look at", async () => {
    const said = [cli("0.100.0", "0.101.0"), cli("0.97.0", "0.100.0"), cli("0.90.0"), cli("0.102.0")];
    expect(cliVersionChecks(said)).toEqual([
      { level: "ok", message: "coding CLI claude-code: 0.100.0, the newest this Nouride was tested with (0.95.0 to 0.100.0); 0.101.0 is out, not yet tested with this Nouride" },
      { level: "ok", message: "coding CLI claude-code: 0.100.0 is out, the newest this Nouride was tested with (0.95.0 to 0.100.0); this is 0.97.0" },
      { level: "warn", message: "coding CLI claude-code: 0.90.0 is older than this Nouride supports (tested with 0.95.0 to 0.100.0): update it to 0.100.0" },
      { level: "warn", message: "coding CLI claude-code: 0.102.0 is newer than this Nouride was tested with (0.95.0 to 0.100.0): it runs, untested" },
    ]);
    const client = { get: async () => ({ room: { enough: true, bytes: 0, needs: 0 }, clis: said }) } as unknown as Client;
    await scanClis(client);
    for (const check of cliVersionChecks(said)) expect(lines).toContain(`    ${check.message.replace("coding CLI claude-code: ", "")}`);
  });

  test("a person's own CLI, with no tested range, gets no line", () => {
    expect(cliVersionChecks([{ id: "mine", name: "Mine", command: "mine-acp", install: "", login: false, installed: true, version: "1.0.0" }])).toEqual([]);
  });
});

/**
 * What each coding CLI was tested with, and what is out (0.8.24, v0.8.24 item 1): each built-in row names its package and
 * the lowest and highest versions this release was tested with; the newest published is read from the npm registry at
 * most once a day and on Check again, and nothing is said of it when the registry is not reached. The scan carries
 * where each installed CLI stands, and `nouride agents scan` and `nouride doctor` say it in the same words. Over fake
 * registry answers: a newer version out, the same, a version below the lowest, one above the highest, no network.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BUILT_IN_CLIS, cliStanding, type CliRow } from "@nouride/acp";
import { cliNamed, cliPartsChecks, cliVersionChecks, type Client } from "@nouride/cli-kit";
import { scanClis } from "../../../cli/src/commands/external-clis.ts";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { NewestVersions, type NewestRead } from "@/modules/external-agents/newest.ts";
import type { ScannedCli } from "@/modules/external-agents/scan.ts";
import { plain } from "../cli-harness.ts";

const TESTED = { lowest: "0.95.0", highest: "0.100.0" };
/** The row without the CLI it carries: the connector's own versions alone are asked about. Carried ones have tests of their own below. */
const { carries: _carries, ...CONNECTOR_ONLY } = BUILT_IN_CLIS[0]!;
const ROW = { ...CONNECTOR_ONLY, package: "@agentclientprotocol/claude-agent-acp", tested: TESTED } as CliRow;

/** A version, a status, no network, or a whole description of one version as the registry gives it. */
type Answer = string | number | "offline" | Record<string, unknown>;

/**
 * A registry that answers as `answers` says, by package for its `latest` and by `package@version` for one version of it:
 * a version, a status, no network, or the version's whole description.
 */
function registry(answers: Record<string, Answer>) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    const path = decodeURIComponent(String(url).replace("https://registry.npmjs.org/", ""));
    const name = path.endsWith("/latest") ? path.slice(0, -"/latest".length) : path.replace(/\/([^/]+)$/, "@$1");
    asked.push(name);
    const answer = answers[name];
    if (answer === "offline" || answer === undefined) throw new TypeError("fetch failed: getaddrinfo EAI_AGAIN registry.npmjs.org");
    if (typeof answer === "number") return new Response("{}", { status: answer });
    return new Response(JSON.stringify(typeof answer === "string" ? { name, version: answer } : answer), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

/** The service with one CLI at `version` and the registry above; its clock moved by hand. `row`: another row than the connector's alone. */
function service(version: string | null, answers: Record<string, Answer>, row: CliRow = ROW, own?: string) {
  const reg = registry(answers);
  let now = Date.parse("2026-11-08T10:00:00Z");
  const kept: { read: NewestRead | null } = { read: null };
  const newest = new NewestVersions({ fetch: reg.fetchImpl, now: () => now, kept: { load: () => kept.read, save: (read) => void (kept.read = read) } });
  const agents = new ExternalAgents({
    workspaceDir: () => "/nowhere",
    secretsFor: () => ({}),
    sessions: { load: () => ({}), save: () => {} },
    rows: () => [row],
    scan: async (scanned) => ({ id: scanned.id, name: scanned.name, command: scanned.command, install: scanned.install, login: true, package: scanned.package!, tested: scanned.tested!, installed: version !== null, ...(version ? { version } : {}), ...(own ? { parts: [{ kind: "cli" as const, name: "Claude Code", version: own }] } : {}) }),
    newest,
    now: () => now,
  });
  return { agents, asked: reg.asked, kept, later: (ms: number) => void (now += ms) };
}

const HOUR = 60 * 60_000;

describe("where a CLI's version stands", () => {
  test("against the tested range and what is out: too old, an update, up to date, newer than tested", () => {
    expect(cliStanding("0.97.0", TESTED, { version: "0.100.0" })).toEqual({ standing: "update", offer: "0.100.0" });
    expect(cliStanding("0.100.0", TESTED, { version: "0.100.0" })).toEqual({ standing: "current" });
    expect(cliStanding("0.101.0", TESTED, { version: "0.101.0" })).toEqual({ standing: "newer" });
    // No registry: what is out is said of the tested versions alone, which are out already.
    expect(cliStanding("0.95.0", TESTED)).toEqual({ standing: "update", offer: "0.100.0" });
    expect(cliStanding("0.100.0", TESTED)).toEqual({ standing: "current" });
    // The registry behind the newest tested (a version withdrawn): what it says is out is what is out.
    expect(cliStanding("0.95.0", TESTED, { version: "0.95.0" })).toEqual({ standing: "current" });
    // And behind what is installed: an older version is never offered as an update.
    expect(cliStanding("0.99.0", TESTED, { version: "0.98.0" })).toEqual({ standing: "current" });
    expect(cliStanding("0.101.0", TESTED, { version: "0.100.0" })).toEqual({ standing: "newer" });
  });

  test("the newest out is what an update installs, past the tested versions or not, and that is said", () => {
    // 0.101.0 out and the box on the newest tested read "up to date" with nothing offered: a newer model in the CLI
    // then reached it only with a Nouride release.
    expect(cliStanding("0.100.0", TESTED, { version: "0.101.0" })).toEqual({ standing: "update", offer: "0.101.0", offerUntested: true });
    expect(cliStanding("0.90.0", TESTED, { version: "0.101.0" })).toEqual({ standing: "older", offer: "0.101.0", offerUntested: true });
    // Already past the tested ones, and a newer one out still: offered again.
    expect(cliStanding("0.101.0", TESTED, { version: "0.102.0" })).toEqual({ standing: "update", offer: "0.102.0", offerUntested: true });
    // Too old with nothing newer said: the standing stays, and the words name the newest tested.
    expect(cliStanding("0.90.0", TESTED, { version: "0.90.0" })).toEqual({ standing: "older" });
  });

  test("the CLI's own version an update brings, and a newer CLI nothing carries yet", () => {
    const out = { version: "0.107.0", carries: "2.1.323", own: "2.1.325" };
    expect(cliStanding("0.100.0", TESTED, out, "2.1.316")).toEqual({ standing: "update", offer: "0.107.0", offerUntested: true, brings: "2.1.323", ahead: "2.1.325" });
    // On the newest connector: nothing to update, and the CLI's own newest is out all the same.
    expect(cliStanding("0.107.0", { lowest: "0.95.0", highest: "0.107.0" }, out, "2.1.323")).toEqual({ standing: "current", ahead: "2.1.325" });
    // A newer connector with the same CLI inside brings no newer CLI, and none is claimed.
    expect(cliStanding("0.106.0", { lowest: "0.95.0", highest: "0.107.0" }, { version: "0.107.0", carries: "2.1.323", own: "2.1.323" }, "2.1.323")).toEqual({ standing: "update", offer: "0.107.0" });
    // What the newest connector carries not said (a range, not one version): nothing is said of a CLI ahead of it.
    expect(cliStanding("0.107.0", { lowest: "0.95.0", highest: "0.107.0" }, { version: "0.107.0", own: "2.1.325" }, "2.1.323")).toEqual({ standing: "current" });
  });

  test("a pre-release sorts below its release, numbers compare as numbers, and another shape is no verdict", () => {
    expect(cliStanding("0.101.1-preview.7", { lowest: "0.95.0", highest: "0.101.1" })).toEqual({ standing: "update", offer: "0.101.1" });
    expect(cliStanding("0.100.0", { lowest: "0.99.9", highest: "0.99.9" })).toEqual({ standing: "newer" });
    expect(cliStanding("0.100.0-preview.3", TESTED)).toEqual({ standing: "update", offer: "0.100.0" });
    expect(cliStanding("latest", TESTED)).toBeNull();
  });

  test("the built-in rows that were tried name their package and a tested range, lowest at or below highest", () => {
    // An experimental one names no tested range (`packages/acp/tests/clis.test.ts`).
    for (const row of BUILT_IN_CLIS.filter((one) => !one.experimental)) {
      expect(row.package).toStartWith("@agentclientprotocol/");
      expect(row.install).toContain(row.package!);
      expect(["update", "current"]).toContain(cliStanding(row.tested!.lowest, row.tested!)!.standing);
    }
  });
});

describe("the scan, on fake registry answers", () => {
  test("a newer version out, past the tested ones: an update, offered and said as untested", async () => {
    const { agents } = service("0.100.0", { [ROW.package!]: "0.101.0" });
    const [cli] = await agents.scan();
    expect(cli).toMatchObject({ package: ROW.package, tested: TESTED, newest: "0.101.0" });
    expect(cli!.standing).toEqual({ standing: "update", offer: "0.101.0", offerUntested: true });
  });

  test("where the row names the CLI it carries: what the newest connector carries, and the CLI's own newest", async () => {
    const carrying = { ...ROW, carries: { name: "Claude Code", package: "@fake/sdk", field: "fakeCodeVersion" } } as CliRow;
    const answers = {
      // The newest connector pins one version of the SDK, as claude-agent-acp does.
      [ROW.package!]: { version: "0.107.0", dependencies: { "@fake/sdk": "0.3.323", zod: "4.6.7" } },
      "@fake/sdk@0.3.323": { version: "0.3.323", fakeCodeVersion: "2.1.323" },
      "@fake/sdk": { version: "0.3.325", fakeCodeVersion: "2.1.325" },
    };
    const box = service("0.100.0", answers, carrying, "2.1.316");
    const [cli] = await box.agents.scan();
    expect(cli!.standing).toEqual({ standing: "update", offer: "0.107.0", offerUntested: true, brings: "2.1.323", ahead: "2.1.325" });
    expect(box.asked.sort()).toEqual([ROW.package!, "@fake/sdk", "@fake/sdk@0.3.323"]);
    // The CLI installed is the one the newest connector carries: the update brings no newer CLI, and none is claimed.
    expect((await service("0.100.0", answers, carrying, "2.1.323").agents.scan())[0]!.standing).toEqual({ standing: "update", offer: "0.107.0", offerUntested: true, ahead: "2.1.325" });
    // Kept with the read: a restart within the day asks nothing and says the same.
    const again = new NewestVersions({ fetch: registry({}).fetchImpl, kept: { load: () => box.kept.read, save: () => {} }, now: () => box.kept.read!.at + HOUR });
    expect(await again.of([{ package: ROW.package!, carries: carrying.carries! }])).toEqual({ [ROW.package!]: { version: "0.107.0", carries: "2.1.323", own: "2.1.325" } });
  });

  test("a connector that names a range of its CLI, not one version, says nothing of what it carries", async () => {
    const carrying = { ...ROW, carries: { name: "Codex", package: "@fake/codex", field: "version" } } as CliRow;
    const box = service("0.100.0", { [ROW.package!]: { version: "0.107.0", dependencies: { "@fake/codex": "^0.165.0" } }, "@fake/codex": "0.166.0" }, carrying, "0.165.2");
    // The CLI's own newest is read, and with nothing said of what an update carries, nothing is claimed of it.
    expect((await box.agents.scan())[0]!.standing).toEqual({ standing: "update", offer: "0.107.0", offerUntested: true });
    expect(box.asked.sort()).toEqual([ROW.package!, "@fake/codex"]);
  });

  test("a read kept from before the carried CLIs were read is read again, not taken for a day", async () => {
    const carrying = { ...ROW, carries: { name: "Claude Code", package: "@fake/sdk", field: "fakeCodeVersion" } } as CliRow;
    const box = service("0.100.0", { [ROW.package!]: "0.100.0", "@fake/sdk": { version: "0.3.325", fakeCodeVersion: "2.1.325" } }, carrying);
    // What an older release kept: the connector's newest and nothing of the CLI it carries.
    box.kept.read = { at: Date.parse("2026-11-08T09:00:00Z"), asked: [ROW.package!], versions: { [ROW.package!]: "0.100.0" } };
    const fresh = new NewestVersions({ fetch: registry({ [ROW.package!]: "0.100.0", "@fake/sdk": { version: "0.3.325", fakeCodeVersion: "2.1.325" } }).fetchImpl, kept: { load: () => box.kept.read, save: (read) => void (box.kept.read = read) }, now: () => Date.parse("2026-11-08T10:00:00Z") });
    expect(await fresh.of([{ package: ROW.package!, carries: carrying.carries! }])).toEqual({ [ROW.package!]: { version: "0.100.0", own: "2.1.325" } });
    expect(box.kept.read.carried).toEqual({ [ROW.package!]: { newest: "2.1.325" } });
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
    expect(await again.of([{ package: ROW.package! }])).toEqual({ [ROW.package!]: { version: "0.100.0" } });
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
    standing: cliStanding(version, TESTED, newest ? { version: newest } : {})!,
  });

  test("each standing in a line, a warning where the version is one to look at", async () => {
    const said = [cli("0.100.0", "0.101.0"), cli("0.97.0", "0.100.0"), cli("0.90.0"), cli("0.102.0")];
    expect(cliVersionChecks(said)).toEqual([
      { level: "ok", message: "coding CLI claude-code: 0.101.0 is out; this is 0.100.0. It is past the versions this Nouride was tested with (0.95.0 to 0.100.0), and offered all the same" },
      { level: "ok", message: "coding CLI claude-code: 0.100.0 is out; this is 0.97.0" },
      { level: "warn", message: "coding CLI claude-code: 0.90.0 is older than this Nouride supports (tested with 0.95.0 to 0.100.0): update it to 0.100.0" },
      { level: "warn", message: "coding CLI claude-code: 0.102.0 is newer than this Nouride was tested with (0.95.0 to 0.100.0): it runs, untested" },
    ]);
    const client = { get: async () => ({ room: { enough: true, bytes: 0, needs: 0 }, clis: said }) } as unknown as Client;
    await scanClis(client);
    for (const check of cliVersionChecks(said)) expect(lines).toContain(`    ${check.message.replace("coding CLI claude-code: ", "")}`);
  });

  test("up to date says whether the registry said so, and names what an update brings and what nothing carries yet", () => {
    expect(cliVersionChecks([cli("0.100.0", "0.100.0")])[0]!.message).toBe("coding CLI claude-code: 0.100.0, the newest out");
    // The registry not reached: the newest tested, said as that, never as the newest out.
    expect(cliVersionChecks([cli("0.100.0")])[0]!.message).toBe("coding CLI claude-code: 0.100.0, the newest this Nouride was tested with (0.95.0 to 0.100.0); what is out was not read");
    const parts = [{ kind: "cli" as const, name: "Claude Code", version: "2.1.316" }];
    const update: ScannedCli = { ...cli("0.100.0", "0.107.0"), parts, standing: cliStanding("0.100.0", TESTED, { version: "0.107.0", carries: "2.1.323", own: "2.1.325" }, "2.1.316")! };
    expect(cliVersionChecks([update])[0]!.message).toBe("coding CLI claude-code: 0.107.0 is out, with Claude Code 2.1.323; this is 0.100.0. It is past the versions this Nouride was tested with (0.95.0 to 0.100.0), and offered all the same");
    const ahead: ScannedCli = { ...cli("0.100.0", "0.100.0"), parts, standing: cliStanding("0.100.0", TESTED, { version: "0.100.0", carries: "2.1.316", own: "2.1.325" }, "2.1.316")! };
    expect(cliVersionChecks([ahead])[0]!.message).toBe("coding CLI claude-code: 0.100.0, the newest out; Claude Code 2.1.325 is out, and nothing that carries it yet");
    // Too old, and the newest out is past the tested ones: that one is named, not the newest tested.
    expect(cliVersionChecks([cli("0.90.0", "0.101.0")])[0]).toEqual({ level: "warn", message: "coding CLI claude-code: 0.90.0 is older than this Nouride supports (tested with 0.95.0 to 0.100.0): update it to 0.101.0. It is past the versions this Nouride was tested with (0.95.0 to 0.100.0), and offered all the same" });
  });

  test("a person's own CLI, with no tested range, gets no line", () => {
    expect(cliVersionChecks([{ id: "mine", name: "Mine", command: "mine-acp", install: "", login: false, installed: true, version: "1.0.0" }])).toEqual([]);
  });
});

describe("what a CLI runs on, in `agents scan` and `doctor`", () => {
  let lines: string[];
  let spy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    lines = [];
    spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(plain(args.join(" "))));
  });
  afterEach(() => spy.mockRestore());

  const scanned = (node: { version?: string; tooOld?: boolean }): ScannedCli => ({
    id: "claude-code",
    name: "Claude Code",
    command: "claude-agent-acp",
    install: ROW.install,
    login: true,
    installed: true,
    version: "0.107.0",
    package: ROW.package!,
    parts: [
      { kind: "cli", name: "Claude Code", package: "@anthropic-ai/claude-agent-sdk", version: "2.1.323" },
      { kind: "connector", name: "@agentclientprotocol/claude-agent-acp", package: "@agentclientprotocol/claude-agent-acp", version: "0.107.0" },
      { kind: "runtime", name: "Node.js", needs: ">=22", ...node },
      { kind: "dependency", name: "@agentclientprotocol/sdk", package: "@agentclientprotocol/sdk", version: "2.6.0" },
      { kind: "dependency", name: "zod", package: "zod" },
    ],
  });

  test("the CLI's own version and its connector's are each named, with the runtime and the rest", async () => {
    const cli = scanned({ version: "24.15.0", tooOld: false });
    expect(cliNamed(cli)).toBe("Claude Code 2.1.323, in claude-agent-acp 0.107.0");
    expect(cliPartsChecks([cli])).toEqual([
      { level: "ok", message: "coding CLI claude-code: Claude Code 2.1.323, in claude-agent-acp 0.107.0" },
      { level: "ok", message: "coding CLI claude-code: Node.js 24.15.0 (claude-agent-acp asks for >=22)" },
      // A dependency whose version the files did not say is said as that, never given a number.
      { level: "ok", message: "coding CLI claude-code: with @agentclientprotocol/sdk 2.6.0, zod (version not read)" },
    ]);
    await scanClis({ get: async () => ({ room: { enough: true, bytes: 0, needs: 0 }, clis: [cli] }) } as unknown as Client);
    expect(lines[0]).toBe("● claude-code Claude Code 2.1.323, in claude-agent-acp 0.107.0");
    expect(lines).toContain("    Node.js 24.15.0 (claude-agent-acp asks for >=22)");
    expect(lines).toContain("    with @agentclientprotocol/sdk 2.6.0, zod (version not read)");
  });

  test("a Node under what the connector asks for is a warning", () => {
    expect(cliPartsChecks([scanned({ version: "20.11.1", tooOld: true })])[1]).toEqual({ level: "warn", message: "coding CLI claude-code: Node.js 20.11.1 is older than claude-agent-acp asks for (>=22): update Node.js" });
  });

  test("a CLI whose parts were not read keeps the line it had, and gets none of these", async () => {
    const own: ScannedCli = { id: "mine", name: "Mine", command: "mine-acp", install: "", login: false, installed: true, version: "1.0.0" };
    expect(cliNamed(own)).toBeNull();
    expect(cliPartsChecks([own])).toEqual([]);
    await scanClis({ get: async () => ({ room: { enough: true, bytes: 0, needs: 0 }, clis: [own] }) } as unknown as Client);
    expect(lines).toEqual(["● mine Mine · mine-acp 1.0.0"]);
  });

  test("a CLI built in but not yet run on a real account is said to be Experimental, installed or not", async () => {
    const grok: ScannedCli = { id: "grok", name: "Grok Build", command: "grok", install: "curl x.example.test | bash", login: true, installed: true, version: "1.0.92", experimental: true };
    await scanClis({ get: async () => ({ room: { enough: true, bytes: 0, needs: 0 }, clis: [grok, { ...grok, id: "cursor", name: "Cursor CLI", installed: false }] }) } as unknown as Client);
    expect(lines).toEqual([
      "● grok Grok Build · grok 1.0.92 Experimental",
      "    Not yet tried on a real account: it may not answer, or answer only in part.",
      "○ cursor Cursor CLI, not installed: curl x.example.test | bash Experimental",
      "    Not yet tried on a real account: it may not answer, or answer only in part.",
    ]);
  });
});

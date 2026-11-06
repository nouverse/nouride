/**
 * Coding-CLI accounts (0.8.1): a CLI with a shared sign-in signs an account in once — its token kept in the secret
 * store, never shown — and every agent on the account then answers; any other CLI's account is signed in once per
 * agent. The owner wanted one place for sign-ins, apart from which account an agent uses.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import type { LoadedAgent } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { spawnInteractive } from "@nouride/runtime";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { CliAccounts } from "@/modules/external-agents/accounts.ts";
import { cliAccountsState } from "@/commons/daemon-state.ts";
import { stateRows } from "../helpers.ts";
import { eventually } from "../wait.ts";

const FAKE_SETUP = join(import.meta.dir, "fixtures/fake-setup-token.ts");
const FAKE_RAW_SETUP = join(import.meta.dir, "fixtures/fake-raw-setup-token.ts");
const FAKE_CLI = join(import.meta.dir, "fixtures/fake-cli.ts");
const services: ExternalAgents[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SHARED: CliRow = {
  id: "fake",
  name: "Fake CLI",
  command: process.execPath,
  args: [FAKE_CLI],
  install: "it is a test",
  versionArgs: ["--version"],
  profileEnv: "FAKE_HOME",
  instructionFile: "AGENTS.md",
  // Signed in where the variable carries the account's token.
  status: ["-e", "process.exit(process.env.FAKE_TOKEN ? 0 : 1)"],
  sharedLogin: { args: [FAKE_SETUP], env: "FAKE_TOKEN", tokenPrefix: "fk-tok-" },
};
const PER_AGENT: CliRow = { ...SHARED, id: "solo", name: "Solo CLI", sharedLogin: undefined, login: ["login"], status: ["-e", "process.exit(1)"] } as CliRow;
/** One whose sign-in is a terminal UI in raw mode, as Claude Code's `setup-token` is. */
const RAW: CliRow = { ...SHARED, id: "raw", name: "Raw CLI", sharedLogin: { args: [FAKE_RAW_SETUP], env: "FAKE_TOKEN", tokenPrefix: "fk-tok-" } };
const RAW_NO_TOKEN: CliRow = { ...RAW, id: "bare", name: "Bare CLI", sharedLogin: { args: [FAKE_RAW_SETUP, "--no-token"], env: "FAKE_TOKEN", tokenPrefix: "fk-tok-" } };

/** On pipes, unless `terminal`: then in `script(1)`'s terminal, as the daemon runs a sign-in. */
function setup(terminal = false) {
  const dir = mkdtempSync(join(tmpdir(), "external-accounts-"));
  dirs.push(dir);
  const secrets = new Map<string, string>();
  const audits: { action: string; actor?: string; details?: Record<string, unknown> }[] = [];
  const service = new ExternalAgents({
    rows: () => [SHARED, PER_AGENT, RAW, RAW_NO_TOKEN],
    workspaceDir: () => dir,
    secretsFor: () => ({}),
    sessions: { load: () => ({}), save: () => {} },
    scan: async (row) => ({ id: row.id, name: row.name, command: row.command, installed: true, version: "1.0", install: row.install, login: true }),
    // Pipes: what it exits with is its own.
    ...(terminal ? {} : { interactive: (cmd: string[], opts: Parameters<typeof spawnInteractive>[1]) => spawnInteractive(cmd, { ...opts, tty: false }) }),
    accounts: {
      file: cliAccountsState(stateRows()),
      tokens: { get: (name) => secrets.get(name), set: async (name, value) => void secrets.set(name, value), delete: async (name) => secrets.delete(name) },
    },
    audit: { record: (entry) => void audits.push(entry) },
  });
  services.push(service);
  const agent = (id: string, cli: string, profile: string) => {
    mkdirSync(privateWorkspace(dir, id), { recursive: true });
    return { config: { id, displayName: id[0]!.toUpperCase() + id.slice(1), external: { cli, profile } }, persona: { identity: "" }, dir } as unknown as LoadedAgent;
  };
  return { service, secrets, agent, audits };
}

describe("coding-CLI accounts", () => {
  test("a shared account signs in once: its token kept, never shown, and every agent on it can answer", async () => {
    const { service, secrets, agent, audits } = setup();
    const agents = [agent("nix", "fake", "team"), agent("nox", "fake", "team")];
    const before = (await service.accountList(agents)).find((cli) => cli.id === "fake")!;
    expect(before.shared).toBe(true);
    expect(before.accounts).toEqual([{ name: "team", signedIn: false, agents: [{ id: "nix", name: "Nix", signedIn: false }, { id: "nox", name: "Nox", signedIn: false }] }]);

    service.startAccountLogin("fake", "team", "ada");
    await eventually(() => (service.login("@fake/team")?.output ?? "").includes("paste the code"), 10_000, "the sign-in to ask for its code");
    expect(service.login("@fake/team")?.links).toEqual(["https://login.example.test/token?c=1"]);
    await service.answerLogin("@fake/team", "CODE123");
    // The first part of the token, on its own: already hidden.
    await eventually(() => (service.login("@fake/team")?.output ?? "").includes("Your token"), 10_000, "the token's first part");
    expect(service.login("@fake/team")!.output).not.toContain("AAAABBBB");
    await service.answerLogin("@fake/team", "more");
    // Its second part too, which arrives without the prefix in front of it: it showed on the page (0.8.1).
    await eventually(() => (service.login("@fake/team")?.output ?? "").includes("Store it safely"), 10_000, "the token's second part");
    expect(service.login("@fake/team")!.output).not.toContain("CCCCDDDD");
    await eventually(() => service.login("@fake/team")?.running === false, 10_000, "the sign-in to end");
    await eventually(() => secrets.has("cli-fake-team"), 4_000, "the token kept");
    expect(secrets.get("cli-fake-team")).toBe("fk-tok-AAAABBBBCCCCDDDDEEEEFFFF");
    // What the page sees has no token in it, even where it arrived in two pieces.
    const shown = service.login("@fake/team")!.output;
    expect(shown).not.toContain("AAAABBBB");
    expect(shown).not.toContain("CCCCDDDD");
    expect(shown).toContain("[saved to Nouride's secret store]");

    // Audited with who started it, the CLI and the account — and no part of the token (0.8.9, HARDENING §8).
    await eventually(() => audits.length > 0, 4_000, "the sign-in audited");
    expect(audits).toEqual([{ action: "cli_account_signed_in", actor: "ada", details: { cli: "fake", account: "team" } }]);
    for (const part of ["fk-tok", "AAAABBBB", "CCCCDDDD", "EEEEFFFF"]) expect(JSON.stringify(audits)).not.toContain(part);

    const after = (await service.accountList(agents, true)).find((cli) => cli.id === "fake")!;
    expect(after.accounts).toEqual([{ name: "team", signedIn: true, agents: [{ id: "nix", name: "Nix", signedIn: true }, { id: "nox", name: "Nox", signedIn: true }] }]);
  });

  test("a sign-in drawn in raw mode gets its answer as Enter: the code is taken, and the token kept, never shown (0.8.8)", async () => {
    // Ended with a line feed, Claude Code's `setup-token` took the code into its field and never submitted it.
    const { service, secrets, agent } = setup(true);
    service.startAccountLogin("raw", "team", "ada");
    await eventually(() => (service.login("@raw/team")?.output ?? "").includes("Paste code here if prompted >"), 10_000, "the sign-in to ask for its code");
    // Each space drawn as a jump to a column, read as a space.
    expect(service.login("@raw/team")!.output).toContain(" Open https://login.example.test/token?c=1 and sign in");
    expect(service.login("@raw/team")!.links).toEqual(["https://login.example.test/token?c=1"]);
    await service.answerLogin("@raw/team", "CODE123");
    await eventually(() => service.login("@raw/team")?.running === false, 10_000, "the sign-in to end");
    const view = service.login("@raw/team")!;
    expect(view).toMatchObject({ exitCode: 0, signedIn: true, stopped: false });
    // Drawn over the prompt's row with a cell skipped: read as a stream, its tail showed without its prefix.
    expect(view.output).not.toContain("AAAABBBB");
    expect(view.output).toContain(" [saved to Nouride's secret store]\n Store it safely.");
    await eventually(() => secrets.has("cli-raw-team"), 4_000, "the token kept");
    expect(secrets.get("cli-raw-team")).toBe("fk-tok-AAAABBBBCCCCDDDDEEEEFFFF");
    const after = (await service.accountList([agent("nix", "raw", "team")], true)).find((cli) => cli.id === "raw")!;
    expect(after.accounts[0]).toMatchObject({ name: "team", signedIn: true });
  });

  test("a code it turns down says so on the page, Enter alone asks again, and the right one then signs in (0.8.8)", async () => {
    const { service, secrets } = setup(true);
    service.startAccountLogin("raw", "team", "ada");
    await eventually(() => (service.login("@raw/team")?.output ?? "").includes("Paste code here if prompted >"), 10_000, "the code asked for");
    await service.answerLogin("@raw/team", "nope");
    await eventually(() => (service.login("@raw/team")?.output ?? "").includes(" OAuth error: Request failed with status code 400"), 10_000, "the refusal");
    expect(service.login("@raw/team")).toMatchObject({ running: true, signedIn: false });
    expect(service.login("@raw/team")!.output).toContain(" Press Enter to retry.");
    await service.answerLogin("@raw/team", "");
    await eventually(() => !(service.login("@raw/team")?.output ?? "").includes("OAuth error"), 10_000, "it to ask again");
    expect(service.login("@raw/team")!.output).toContain(" Paste code here if prompted >");
    await service.answerLogin("@raw/team", "CODE123");
    await eventually(() => service.login("@raw/team")?.running === false, 10_000, "the sign-in to end");
    expect(service.login("@raw/team")).toMatchObject({ exitCode: 0, signedIn: true });
    await eventually(() => secrets.has("cli-raw-team"), 4_000, "the token kept");
  });

  test("one that ends 0 with no token in what it printed is not signed in, and says nothing was kept (0.8.8)", async () => {
    // The page showed nothing at all, as though it had worked, and the account stayed signed out.
    const { service, secrets, audits } = setup(true);
    service.startAccountLogin("bare", "team", "ada");
    await eventually(() => (service.login("@bare/team")?.output ?? "").includes("Paste code here if prompted >"), 10_000, "the code asked for");
    await service.answerLogin("@bare/team", "CODE123");
    await eventually(() => service.login("@bare/team")?.running === false, 10_000, "the sign-in to end");
    const view = service.login("@bare/team")!;
    expect(view).toMatchObject({ exitCode: 0, signedIn: false, stopped: false });
    expect(view.output).toContain("Nouride found no token in what it printed, so nothing was kept. Start the sign-in again.");
    expect(secrets.size).toBe(0);
    // Nothing kept, nothing audited as signed in.
    expect(audits).toEqual([]);
  });

  test("a wrong code keeps nothing", async () => {
    const { service, secrets } = setup();
    service.startAccountLogin("fake", "team", "ada");
    await eventually(() => (service.login("@fake/team")?.output ?? "").includes("paste the code"), 10_000, "the code asked for");
    await service.answerLogin("@fake/team", "nope");
    await eventually(() => service.login("@fake/team")?.running === false, 10_000, "the sign-in to end");
    expect(secrets.size).toBe(0);
  });

  test("a CLI with no shared sign-in is signed in per agent: its account says so, and refuses a shared one", async () => {
    const { service, agent } = setup();
    const solo = (await service.accountList([agent("coder", "solo", "work")])).find((cli) => cli.id === "solo")!;
    expect(solo.shared).toBe(false);
    expect(solo.accounts).toEqual([{ name: "work", signedIn: null, agents: [{ id: "coder", name: "Coder", signedIn: false }] }]);
    expect(() => service.startAccountLogin("solo", "work", "ada")).toThrow("Solo CLI signs in once per agent, on the agent's Brain tab");
  });

  test("an account is added before any agent uses it, and removed only once none does", async () => {
    const { service, secrets, agent } = setup();
    expect(service.accounts.add("fake", "Not A Name")).toEqual({ ok: false, error: "An account's name is lowercase letters, digits and dashes, at most 24." });
    expect(service.accounts.add("fake", "spare")).toEqual({ ok: true });
    expect((await service.accountList([])).find((cli) => cli.id === "fake")!.accounts.map((account) => account.name)).toEqual(["spare"]);
    secrets.set("cli-fake-spare", "fk-tok-x");
    const nix = agent("nix", "fake", "spare");
    expect(await service.accounts.remove("fake", "spare", [nix])).toEqual({ ok: false, error: "Nix uses it. Move it to another account first.", users: ["Nix"] });
    expect(await service.accounts.remove("fake", "spare", [])).toEqual({ ok: true, tokenRemoved: true });
    expect(secrets.has("cli-fake-spare")).toBe(false);
    // Removed again, nothing was kept to remove — what the audit row says (0.8.9).
    expect(await service.accounts.remove("fake", "spare", [])).toEqual({ ok: true, tokenRemoved: false });
  });

  test("a token the store would not delete is said, not thrown: the account is off the list already (Nox's review, N5)", async () => {
    const file = cliAccountsState(stateRows());
    const accounts = new CliAccounts({ file, tokens: { get: () => "fk-tok-x", set: async () => {}, delete: async () => { throw new Error("secrets.json: read-only file system"); } } });
    accounts.add("fake", "spare");
    expect(await accounts.remove("fake", "spare", [])).toEqual({ ok: true, tokenRemoved: false, tokenError: "secrets.json: read-only file system" });
    expect(file.load()).toEqual({ fake: [] });
  });

  test("an account added on the Models page is one each agent of its CLI may pick", async () => {
    const { service, agent } = setup();
    service.accounts.add("fake", "team");
    const nix = agent("nix", "fake", "default");
    expect((await service.profiles(nix)).map((profile) => [profile.name, profile.inUse])).toEqual([["default", true], ["team", false]]);
  });
});

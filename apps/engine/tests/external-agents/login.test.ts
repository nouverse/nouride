/**
 * Signing an external agent's CLI in (0.8.1), against a sign-in started as a real process in a terminal: it runs in
 * the agent's folder with the agent's profile, its link is read out of what it draws, a typed line is its input, and
 * a sign-in that succeeds clears the agent's "not signed in" so its next turn starts the CLI again.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRow } from "@nouride/acp";
import type { LoadedAgent } from "@nouride/shared";
import { privateWorkspace } from "@nouride/persona";
import { spawnInteractive } from "@nouride/runtime";
import { ExternalAgents } from "@/modules/external-agents/index.ts";
import { CliLogin } from "@/modules/external-agents/login.ts";
import { returnAddress } from "@/modules/external-agents/callback.ts";
import { eventually } from "../wait.ts";

const FAKE_LOGIN = join(import.meta.dir, "fixtures/fake-login.ts");
const services: ExternalAgents[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(row: Partial<CliRow> = {}, pipes = false) {
  const dir = mkdtempSync(join(tmpdir(), "external-login-"));
  dirs.push(dir);
  mkdirSync(privateWorkspace(dir, "coder"), { recursive: true });
  const service = new ExternalAgents({
    rows: () => [{ id: "fake", name: "Fake CLI", command: process.execPath, args: ["acp"], install: "it is a test", versionArgs: ["--version"], profileEnv: "FAKE_HOME", instructionFile: "AGENTS.md", login: [FAKE_LOGIN], ...row }],
    workspaceDir: () => dir,
    secretsFor: () => ({}),
    sessions: { load: () => ({}), save: () => {} },
    // Pipes, not a terminal: what it exits with is its own, as on Linux, where `script(1)` passes a killed child's 0 on.
    ...(pipes ? { interactive: (cmd: string[], opts: Parameters<typeof spawnInteractive>[1]) => spawnInteractive(cmd, { ...opts, tty: false }) } : {}),
  });
  services.push(service);
  const agent = { config: { id: "coder", displayName: "Coder", external: { cli: "fake", profile: "work" } }, dir } as unknown as LoadedAgent;
  return { service, agent, folder: privateWorkspace(dir, "coder") };
}

describe("an external agent's sign-in", () => {
  test("runs in the agent's folder on its profile, shows the link, and a right code signs it in", async () => {
    const { service, agent, folder } = setup();
    service.setUnavailable("coder", "Fake CLI is not signed in");
    service.startLogin(agent);
    await eventually(() => (service.login("coder")?.output ?? "").includes("paste the code"), 10_000, "the sign-in to ask for its code");
    const view = service.login("coder")!;
    expect(view.output).toContain(`cwd=${realpathSync(folder)}`);
    expect(view.output).toContain(`profile=${join(folder, ".cli", "fake", "work")}`);
    // What the terminal drew it with is gone; the link is read out whole.
    expect(view.output).not.toContain("\x1b[");
    expect(view.links).toEqual(["https://login.example.test/device?c=1"]);
    expect(view.running).toBe(true);
    // Started twice, it is the same sign-in.
    expect(service.startLogin(agent).running).toBe(true);

    await service.answerLogin("coder", "CODE123");
    await eventually(() => service.login("coder")?.running === false, 10_000, "the sign-in to end");
    expect(service.login("coder")?.exitCode).toBe(0);
    await eventually(() => service.unavailable("coder") === null, 4_000, "the agent to be available again");
  });

  test("the address a browser sign-in ended on, pasted back, is opened on the box, where the sign-in waits for it", async () => {
    // From the person's own machine the page on the box's 127.0.0.1 does not load; typed into the sign-in, the address
    // would be a line of input it does not read.
    const { service, agent } = setup({ login: [FAKE_LOGIN, "--returns"] }, true);
    service.startLogin(agent);
    await eventually(() => (service.login("coder")?.links ?? []).length > 0, 10_000, "the sign-in link");
    const back = new URL(service.login("coder")!.links[0]!).searchParams.get("redirect_uri")!;
    await service.answerLogin("coder", `${back}?state=s1&code=OK`);
    await eventually(() => service.login("coder")?.running === false, 10_000, "the sign-in to end");
    expect(service.login("coder")).toMatchObject({ exitCode: 0, stopped: false });
    expect(service.login("coder")!.output).toContain("Opened the address on this box: 200");
  });

  test("on another profile it signs that one in, says which, and leaves the agent's own as it was (0.8.1)", async () => {
    // The Brain tab lists an agent's profiles and adds one: a sign-in names the profile it is for.
    const { service, agent, folder } = setup();
    service.setUnavailable("coder", "Fake CLI is not signed in");
    expect(service.startLogin(agent, "spare").profile).toBe("spare");
    await eventually(() => (service.login("coder")?.output ?? "").includes("paste the code"), 10_000, "the sign-in to ask for its code");
    expect(service.login("coder")?.output).toContain(`profile=${join(folder, ".cli", "fake", "spare")}`);
    await service.answerLogin("coder", "CODE123");
    await eventually(() => service.login("coder")?.running === false, 10_000, "the sign-in to end");
    expect(service.login("coder")).toMatchObject({ exitCode: 0, profile: "spare" });
    // The agent answers on `work`, which nobody signed in.
    expect(service.unavailable("coder")).toBe("Fake CLI is not signed in");
  });

  test("a wrong code ends it unsigned, and the agent stays as it was", async () => {
    const { service, agent } = setup();
    service.setUnavailable("coder", "Fake CLI is not signed in");
    service.startLogin(agent);
    await eventually(() => (service.login("coder")?.output ?? "").includes("paste the code"), 10_000, "the sign-in to ask for its code");
    await service.answerLogin("coder", "nope");
    await eventually(() => service.login("coder")?.running === false, 10_000, "the sign-in to end");
    expect(service.login("coder")?.exitCode).toBe(3);
    expect(service.unavailable("coder")).toBe("Fake CLI is not signed in");
    await expect(service.answerLogin("coder", "CODE123")).rejects.toThrow("the sign-in has ended");
  });

  test("one stopped before it signs in is never a sign-in, even where it exits 0", async () => {
    const { service, agent } = setup({}, true);
    service.setUnavailable("coder", "Fake CLI is not signed in");
    service.startLogin(agent);
    await eventually(() => (service.login("coder")?.output ?? "").includes("paste the code"), 10_000, "the sign-in to ask for its code");
    service.stopLogin("coder");
    await eventually(() => service.login("coder")?.running === false, 10_000, "the sign-in to end");
    expect(service.login("coder")).toMatchObject({ stopped: true, exitCode: 0 });
    expect(service.unavailable("coder")).toBe("Fake CLI is not signed in");
  });

  test("a CLI with no sign-in to run says what to do instead", () => {
    const { service, agent } = setup({ login: undefined, loginNote: "Sign in with an API key." });
    expect(() => service.startLogin(agent)).toThrow("Fake CLI has no sign-in Nouride can run. Sign in with an API key.");
  });
});

test("a long sign-in whose kept end would start inside a token starts after it, its tail not shown (0.8.1)", () => {
  // Kept by its last 16,000 characters: a cut inside a token dropped its prefix, and the rest no longer read as one.
  const chunks = [`${"x".repeat(15_990)}fk-tok-ZZZZZZZZZZ`, `ZZZZZZZZZZ\n${".".repeat(15_990)}`];
  const proc = { drain: () => chunks.shift() ?? "", exited: new Promise<number>(() => {}), write: () => {}, kill: () => {} };
  const login = new CliLogin(proc as never, "fk-tok-");
  login.view();
  const shown = login.view().output;
  expect(shown).not.toContain("Z");
  expect(shown.length).toBeLessThanOrEqual(16_000);
});

describe("a pasted address", () => {
  const printed = "Open https://accounts.example.test/auth?redirect_uri=http%3A%2F%2F127.0.0.1%3A57757%2F&state=s and sign in";
  test("is opened only where the sign-in named it as where the browser returns, on loopback", () => {
    expect(returnAddress("http://127.0.0.1:57757/?state=s&code=X", printed)?.port).toBe("57757");
    expect(returnAddress("http://localhost:57757/?code=X", printed)?.hostname).toBe("localhost");
    expect(returnAddress("http://127.0.0.1:18254/api/control/x", printed)).toBeNull();
    expect(returnAddress("http://192.0.2.7:57757/?code=X", printed)).toBeNull();
    expect(returnAddress("file:///etc/passwd", printed)).toBeNull();
    expect(returnAddress("4/abc-code", printed)).toBeNull();
  });
});

/**
 * Boot's half of each agent running as its own user (`boot/agent-users.ts`): the helper found and put in front of
 * every agent's command, then each agent made ready — its user, its credentials grant, its own `~/.ssh` — and what no
 * agent may read closed. The helper is a stand-in that records what it was asked and runs the command as given.
 */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asItsAgent, runAgentCommandsThrough } from "@nouride/runtime";
import { addLogSink, holdLines } from "@nouride/shared";
import { refreshHelper, settleAgentUsers } from "@/boot/agent-users.ts";
import { keptFolders } from "@/boot/kept-folders.ts";
import { DEFAULT_CONFIG } from "@/modules/config/defaults.ts";
import { fakeAgent } from "../helpers.ts";

const dirs: string[] = [];
const home = process.env.HOME;
afterEach(() => {
  runAgentCommandsThrough(null);
  process.env.HOME = home;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function world() {
  const root = mkdtempSync(join(tmpdir(), "nouride-agent-users-"));
  dirs.push(root);
  chmodSync(root, 0o750);
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.dataDir = join(root, "data");
  config.daemon.agentsDir = join(root, "agents");
  config.daemon.workspaceDir = join(root, "workspace");
  config.memory.dir = join(root, "memory");
  // Each agent's own folder and job folder, which the real helper makes at its first command.
  const made = ["nouva", "nox"].flatMap((id) => [join(root, "workspace/private", id), join(root, "jobs", id)]);
  for (const dir of [config.memory.dir, join(config.daemon.agentsDir, ".git"), join(root, "home/.ssh"), ...made]) mkdirSync(dir, { recursive: true });
  chmodSync(config.memory.dir, 0o755);
  // The daemon's own ssh config: the hosts, then what it added for its own HOME.
  writeFileSync(join(root, "home/.ssh/config"), "Host proxmox\n    User root\n\nHost *\n    ControlPath ${HOME}/.ssh/cm-%C\n\n# Added by Nouride (0.7.17): what ssh read before\nMatch all\n    Include /home/nouride/.ssh/config\n");
  process.env.HOME = join(root, "home");
  // The helper's stand-in: what it was asked, then the command after `--` as it is.
  const log = join(root, "helper.log");
  const helper = join(root, "nouride-run");
  writeFileSync(helper, `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = groups ] && exit 0\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`, { mode: 0o755 });
  const users = { through: "socket" as const, binary: helper, socket: "/run/x.sock", folders: { workspace: config.daemon.workspaceDir, reads: [], credentials: "" } };
  return { root, config, log, users };
}

test("found, every agent's command goes through the helper; each agent is made ready with its grant and its own ssh", async () => {
  const { root, config, log, users } = world();
  const nouva = fakeAgent({ config: { ...fakeAgent().config, id: "nouva" } });
  const nox = fakeAgent({ config: { ...fakeAgent().config, id: "nox", credentials: false } });
  const boot = await settleAgentUsers({ config, kept: keptFolders(config), agent: () => undefined, find: async () => ({ users, reason: "found" }) });
  expect(asItsAgent(["ls"], "nouva", "/w").cmd.slice(0, 2)).toEqual([users.binary, "exec"]);
  await boot.ready([nouva, nox]);
  const asked = readFileSync(log, "utf-8");
  // Readied where its commands start, so a folder on the way it cannot pass is said at boot, not at its first message.
  expect(asked).toContain(`--agent nouva --cwd ${join(root, "workspace/shared")} --landlock off -- true`);
  // `.nouride`, passed through by every agent's own user, and listed by none.
  expect(statSync(root).mode & 0o007).toBe(0o001);
  expect(asked).toContain("groups --socket /run/x.sock --agent nouva --group nr-creds");
  expect(asked).toMatch(/groups --socket \/run\/x\.sock --agent nox\n/);
  const config0 = join(root, "workspace/private/nouva/.ssh/config");
  // ssh's connection socket under the agent's own HOME ran past what a Unix socket may be: a short one, its own.
  expect(readFileSync(config0, "utf-8")).toBe("Host proxmox\n    User root\n\nHost *\n    ControlPath /tmp/cm-%i-%C\n");
  expect(statSync(config0).mode & 0o777).toBe(0o600);
  // Its own Python env, light: the shared env's packages importable through a `.pth`, and a pip that is its own env's.
  if (existsSync("/usr/bin/python3")) {
    const env = join(root, "workspace/private/nouva/.local/opt/python");
    const version = readdirSync(join(env, "lib")).find((name) => name.startsWith("python3."))!;
    expect(readFileSync(join(env, "lib", version, "site-packages/nouride-shared.pth"), "utf-8")).toMatch(new RegExp(`^${join(root, "opt/python")}/lib/python3\\.\\d+/site-packages\\n$`));
    expect(readFileSync(join(env, "bin/pip"), "utf-8")).toBe(`#!${env}/bin/python3\nimport sys\nfrom pip._internal.cli.main import main\nsys.exit(main())\n`);
  }
  // One seeded with the long path before is brought to the short one, and nothing else in it changes.
  writeFileSync(config0, "Host mine\n    ControlPath ${HOME}/.ssh/cm-%C\n");
  await boot.ready([nouva]);
  expect(readFileSync(config0, "utf-8")).toBe("Host mine\n    ControlPath /tmp/cm-%i-%C\n");
  // A second boot leaves what the agent has made of it alone.
  writeFileSync(config0, "Host mine\n");
  await boot.ready([nouva]);
  expect(readFileSync(config0, "utf-8")).toBe("Host mine\n");
  // The vault and the packs' history: nobody's but the daemon's.
  expect(statSync(config.memory.dir).mode & 0o007).toBe(0);
});

test("an id that cannot be a user's name is said, and nothing is asked of the helper for it", async () => {
  const { config, log, users } = world();
  const boot = await settleAgentUsers({ config, kept: keptFolders(config), agent: () => undefined, find: async () => ({ users, reason: "found" }) });
  await boot.ready([fakeAgent({ config: { ...fakeAgent().config, id: "Nouva_2" } })]);
  expect(existsSync(log)).toBe(false);
});

test("a grant that could not be set is said as what happens: the agent's commands still run as its own user", async () => {
  // It said they were refused until fixed, where nothing refuses them — and the agent went unseeded for it.
  const { root, config, users } = world();
  writeFileSync(users.binary, `#!/bin/sh\n[ "$1" = groups ] && { echo "usermod: cannot lock /etc/group" >&2; exit 1; }\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`, { mode: 0o755 });
  const boot = await settleAgentUsers({ config, kept: keptFolders(config), agent: () => undefined, find: async () => ({ users, reason: "found" }) });
  const release = holdLines();
  await boot.ready([fakeAgent({ config: { ...fakeAgent().config, id: "nouva", credentials: false } })]);
  const said = release().map((line) => `${line.message} ${JSON.stringify(line.data ?? {})}`);
  expect(said.filter((line) => line.includes("refused until"))).toEqual([]);
  expect(said.filter((line) => line.startsWith("an agent's credentials grant could not be set: its commands run as its own user"))).toHaveLength(1);
  expect(said.join("\n")).toContain("usermod: cannot lock /etc/group");
  // Ready all the same: its own ssh config, as any agent ready as its own user gets.
  expect(existsSync(join(root, "workspace/private/nouva/.ssh/config"))).toBe(true);
});

const saidReady: string[][] = [];
addLogSink((entry) => void (entry.message === "agents ready as their own users" && saidReady.push(entry.data?.agents as string[])));

test("each agent is said ready once; a reload readies it again without saying so (0.8.8, the live box)", async () => {
  // Approving a skill reloads every pack, and each reload readied its agent and said so: three drafts approved were
  // twenty-one lines in the log, all saying what boot had said.
  const { config, log, users } = world();
  const [nouva, nox] = ["nouva", "nox"].map((id) => fakeAgent({ config: { ...fakeAgent().config, id } }));
  const boot = await settleAgentUsers({ config, kept: keptFolders(config), agent: () => undefined, find: async () => ({ users, reason: "found" }) });
  saidReady.length = 0;
  await boot.ready([nouva!, nox!]);
  const asked = readFileSync(log, "utf-8").length;
  await boot.ready([nouva!]);
  await boot.ready([nox!]);
  expect(saidReady).toEqual([["nouva", "nox"]]);
  expect(readFileSync(log, "utf-8").length).toBeGreaterThan(asked);
});

test("not found, commands run as the daemon's user and nothing is closed", async () => {
  const { config } = world();
  await settleAgentUsers({ config, kept: keptFolders(config), agent: () => undefined, find: async () => ({ users: null, reason: "not Linux" }) });
  expect(asItsAgent(["ls"], "nouva", "/w")).toEqual({ cmd: ["ls"] });
  expect(statSync(config.memory.dir).mode & 0o007).toBe(0o005);
});

test("a daemon that is root brings its helper up to the release's — from a copy that is root's, and only when it differs", async () => {
  const { root } = world();
  const install = join(root, "srv");
  mkdirSync(join(install, "run"), { recursive: true });
  writeFileSync(join(install, "run/nouride-run"), "v2");
  const binary = join(root, "lib/nouride-run/nouride-run");
  // A copy another account could have written is never put where root runs it.
  expect(await refreshHelper(install, { binary, ownerOf: () => 1000 })).toBe(false);
  expect(existsSync(binary)).toBe(false);
  expect(await refreshHelper(install, { binary, ownerOf: () => 0 })).toBe(true);
  expect({ text: readFileSync(binary, "utf-8"), mode: statSync(binary).mode & 0o777 }).toEqual({ text: "v2", mode: 0o755 });
  expect(await refreshHelper(install, { binary, ownerOf: () => 0 })).toBe(false);
});

test("each agent gets its own copy of the shared HOME's logins once — not its caches, its programs or the sessions' history", async () => {
  const { root, config, users } = world();
  const shared = join(root, "home");
  const put = (path: string, text: string, mode = 0o644) => {
    mkdirSync(join(shared, path, ".."), { recursive: true });
    writeFileSync(join(shared, path), text, { mode });
  };
  put(".gitconfig", "[user]\n\tname = Nouva\n");
  put(".config/gh/hosts.yml", "github.com: {}\n", 0o600);
  put(".claude/settings.json", "{}");
  put(".claude/projects/p/history.jsonl", "{}");
  put(".cache/big", "x");
  put(".local/bin/claude", "#!/bin/sh\n", 0o755);
  const boot = await settleAgentUsers({ config, kept: keptFolders(config), agent: () => undefined, find: async () => ({ users, reason: "found" }) });
  const nouva = fakeAgent({ config: { ...fakeAgent().config, id: "nouva" } });
  await boot.ready([nouva]);
  const own = join(root, "workspace/private/nouva");
  expect(readFileSync(join(own, ".config/gh/hosts.yml"), "utf-8")).toBe("github.com: {}\n");
  expect(readFileSync(join(own, ".claude/settings.json"), "utf-8")).toBe("{}");
  expect(existsSync(join(own, ".claude/projects"))).toBe(false);
  expect(existsSync(join(own, ".cache"))).toBe(false);
  expect(existsSync(join(own, ".local/bin/claude"))).toBe(false);
  // Its .gitconfig, and a repository another agent made in shared/ is one it may carry on.
  const gitconfig = readFileSync(join(own, ".gitconfig"), "utf-8");
  expect(gitconfig).toContain("name = Nouva");
  if (existsSync("/usr/bin/git")) expect(gitconfig).toContain("directory = *");
  // Nothing left in the job folder it came through.
  expect(existsSync(join(root, "jobs/nouva/.home-seed.tar"))).toBe(false);
  // Once: what the agent made of its copy is its own.
  writeFileSync(join(own, ".config/gh/hosts.yml"), "mine\n");
  await boot.ready([nouva]);
  expect(readFileSync(join(own, ".config/gh/hosts.yml"), "utf-8")).toBe("mine\n");
  // The shared HOME: passed through to its programs, and its logins closed to the agents' users.
  expect(statSync(shared).mode & 0o007).toBe(0o001);
  expect(statSync(join(shared, ".gitconfig")).mode & 0o007).toBe(0);
});

test("one agent made ready twice at once — boot's and a reload's — has its HOME seeded once", async () => {
  // Both at once packed one tarball, each cutting the other's, and the seeded mark could be lost to it.
  const { root, config, log, users } = world();
  writeFileSync(join(root, "home/.gitconfig"), "[user]\n\tname = Nouva\n");
  const boot = await settleAgentUsers({ config, kept: keptFolders(config), agent: () => undefined, find: async () => ({ users, reason: "found" }) });
  const nouva = fakeAgent({ config: { ...fakeAgent().config, id: "nouva" } });
  await Promise.all([boot.ready([nouva]), boot.ready([nouva])]);
  expect(readFileSync(log, "utf-8").split("\n").filter((line) => line.includes("tar -xf"))).toHaveLength(1);
  expect(existsSync(join(root, "workspace/private/nouva/.nouride-seeded"))).toBe(true);
});

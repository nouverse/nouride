/**
 * Each agent's commands as that agent's own user, `nr-<agent>` (0.8.0, `@nouride/isolation`): found once at boot, said
 * once in the journal, and the reason when not — commands that run as the daemon's user are never passed off as
 * isolated. `doctor` asks the same question the same way.
 *
 * Then every agent made ready before a message can arrive: its user and folders (a first command, `true`, makes them),
 * and whether its user reads the credentials directory (`[security] credentials`). An agent loaded later — made from
 * the dashboard, a pack pulled in — is made ready when it loads.
 */

import {
  clientPrefix,
  findAgentUsers,
  groupsCommand,
  HELPER_BINARY,
  HELPER_SOCKET,
  putCommand,
  type AgentUsers,
  type AgentUsersFinding,
  type HelperFolders,
} from "@nouride/isolation";
import {
  copyFileAtomic,
  dirname,
  ensureDir,
  fileExists,
  fileExistsSync,
  fileOwner,
  isRoot,
  join,
  listDir,
  readFileBytes,
  readTextFileIfExists,
  runAgentCommandsThrough,
  removePath,
  runCommand,
  setFileMode,
  statFile,
} from "@nouride/runtime";
import { privateWorkspace, sharedWorkspace } from "@nouride/persona";
import { createLogger, type GlobalConfig, type LoadedAgent } from "@nouride/shared";
import type { KeptFolders } from "@/boot/kept-folders.ts";
import { pythonEnvDir } from "@/modules/toolchain/env.ts";
import { agentsOwnHome } from "@/modules/toolchain/facts.ts";
import { SHARED_HOME_TOOLS, shareTools } from "@/modules/toolchain/shared-tools.ts";

const log = createLogger("daemon");

/** The group the helper hands an agent's user for the credentials directory. */
const CREDENTIALS_GROUP = "nr-creds";

/** An id that can be a user's name, as the helper has it (`valid_agent` in `request.rs`). */
export function canHaveOwnUser(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,28}$/.test(id) && !["root", "shared", "skills"].includes(id);
}

/** What the helper serves, from this config: what `nouride service install` writes into its unit, and boot asks back. */
export function helperFolders(config: GlobalConfig, kept: KeptFolders): HelperFolders {
  return { workspace: config.daemon.workspaceDir, reads: [config.daemon.agentsDir, kept.jobs, kept.attachments, kept.toolOutput], credentials: kept.credentials };
}

/**
 * Whether agents' commands can run as their own users here, and why — for boot and `doctor` alike. `root` is whether
 * the daemon is: this process at boot, the data directory's owner for `doctor`, which an operator may run with sudo.
 */
export async function findHelper(folders: HelperFolders, root: boolean = isRoot()): Promise<AgentUsersFinding> {
  return findAgentUsers({
    platform: process.platform,
    inContainer: (await fileExists("/.dockerenv")) || (await fileExists("/run/.containerenv")),
    root,
    folders,
    binaryPresent: fileExistsSync(HELPER_BINARY),
    socketPresent: fileExistsSync(HELPER_SOCKET),
    info: () => runCommand([HELPER_BINARY, "info", "--socket", HELPER_SOCKET], { cwd: "/", env: {}, timeoutMs: 10_000, maxOutputBytes: 4096 }),
  });
}

const SANDBOX = { cwd: "/", env: { PATH: "/usr/bin:/bin" }, timeoutMs: 30_000, maxOutputBytes: 4096 };

/**
 * One agent's user and folders made, and its credentials grant set to what its pack says. The reason its commands
 * cannot run as its own user, when they cannot. The first command starts where its commands start, the shared
 * workspace: a folder on the way it cannot pass is said here, at boot, and not at its first message.
 */
async function makeReady(users: AgentUsers, agent: LoadedAgent, prefix: (agent: string, cwd: string) => string[], cwd: string): Promise<string | null> {
  const id = agent.config.id;
  if (!canHaveOwnUser(id)) return `"${id}" cannot be a user's name (lowercase letters, digits and dashes, at most 29); rename agents/${id}`;
  const made = await runCommand([...prefix(id, cwd), "true"], SANDBOX);
  if (made.exitCode !== 0) return made.stderr.trim() || `exit ${made.exitCode}`;
  const groups = agent.config.credentials === false ? [] : [CREDENTIALS_GROUP];
  const granted = await runCommand(groupsCommand(users, id, groups), SANDBOX);
  // Said as what it is: its commands run as its own user regardless, and nothing refuses them. A user the helper makes
  // has no grant until this one is set.
  if (granted.exitCode !== 0) {
    log.warn("an agent's credentials grant could not be set: its commands run as its own user with the grant it already had (none, for a new one)", {
      agent: id,
      credentials: groups.length > 0,
      problem: granted.stderr.trim() || `exit ${granted.exitCode}`,
    });
  }
  return null;
}

/** Where the daemon's own ssh config ends and what it added for itself begins (`boot/ssh-config.ts`). */
const DAEMONS_OWN_SSH = "# Added by Nouride (0.7.17):";

/**
 * Its own `~/.ssh` — the hosts set up before each agent had a HOME of its own, seeded from the shared one when it has
 * none, so `ssh <alias>` keeps working. As the agent, `0600`, so ssh accepts it and the agent adds hosts to it. Not
 * what the daemon added for its own HOME: an `Include` of a home no agent may read.
 */
async function seedSsh(id: string, home: string, prefix: (agent: string) => string[]): Promise<void> {
  const shared = process.env.HOME ? join(process.env.HOME, ".ssh") : null;
  if (!shared) return;
  for (const name of ["config", "known_hosts"]) {
    const text = await readTextFileIfExists(join(shared, name)).catch(() => null);
    if (!text) continue;
    const own = name === "config" ? shortControlPaths(text.split(DAEMONS_OWN_SSH)[0]!.trimEnd() + "\n") : text;
    const into = join(home, ".ssh", name);
    // A config seeded with the long path before is brought to the short one; nothing else the agent wrote changes.
    const short = `s|^\\([[:space:]]*ControlPath[[:space:]]\\{1,\\}\\)\\$[{]HOME[}]/.ssh/cm-%C$|\\1${SHORT_CONTROL_PATH}|`;
    const script = `umask 077; mkdir -p "\${0%/*}"; if [ -e "$0" ]; then sed '${short}' "$0" > "$0.short" && cat "$0.short" > "$0"; rm -f "$0.short"; else cat > "$0"; fi`;
    await runCommand([...prefix(id), "sh", "-c", script, into], { ...SANDBOX, stdin: own });
  }
}

/**
 * Where ssh keeps a connection to reuse: `/tmp/cm-<uid>-<hash>`, short and the agent's own. Under its HOME the socket's
 * path ran past what a Unix socket may be — `…/workspace/private/nouva/.ssh/cm-<40 hex>.<16>` — and every `ssh <alias>`
 * failed before connecting (live, 2026-10-24). `%i` keeps two agents reaching one host apart.
 */
const SHORT_CONTROL_PATH = "/tmp/cm-%i-%C";

/** A config's `ControlPath` under HOME, made the short one. */
function shortControlPaths(config: string): string {
  return config.replace(/^(\s*ControlPath\s+)(?:\$\{HOME\}|~|%d)\/\S*$/gm, `$1${SHORT_CONTROL_PATH}`);
}

/** What the shared HOME holds that is not a cache or a program — or what is seeded on its own (`.ssh`). */
const NOT_SEEDED = new Set([".cache", ".npm", ".bun", ".ssh", ".bash_history", ...SHARED_HOME_TOOLS]);
/** Inside `.claude`, the sessions run there and their caches — history, not settings. */
const CLAUDE_HISTORY = ["projects", "sessions", "shell-snapshots", "cache", "backups", "downloads", "todos", "statsig"];
/** In an agent's HOME once it has been seeded, so it is seeded once. */
const SEEDED = ".nouride-seeded";

/**
 * Its own copy of the logins and settings every agent used while they shared the daemon's HOME — `gh`, `.gitconfig`,
 * a kube config, Claude Code's — once, at its first start as its own user: nothing an agent reached the day before is
 * out of reach the day after. Not the caches, and not the programs, which stay in the shared HOME for every agent to
 * run (`toolchain/shared-tools.ts`). Carried through a tarball in the agent's own job folder, the one place the daemon
 * writes and the agent reads. And git's `safe.directory` opened: a repository another agent made in `shared/` is one
 * it is meant to carry on — handover is what that folder is for, and what one agent leaves there another runs anyway.
 */
async function seedHome(id: string, home: string, shared: string, stage: string, prefix: (agent: string) => string[]): Promise<void> {
  if (statFile(join(home, SEEDED)) !== null) return;
  const entries = (statFile(shared) ? listDir(shared) : []).map((entry) => entry.name).filter((name) => !NOT_SEEDED.has(name));
  const tarball = join(stage, ".home-seed.tar");
  if (entries.length > 0) {
    const exclude = CLAUDE_HISTORY.map((dir) => `--exclude=./.claude/${dir}`);
    const packed = await runCommand(["tar", "-cf", tarball, ...exclude, ...entries.map((name) => `./${name}`)], { ...SANDBOX, cwd: shared, timeoutMs: 300_000 });
    if (packed.exitCode !== 0) {
      removePath(tarball);
      log.warn("an agent's own HOME could not be given the shared one's logins", { agent: id, error: packed.stderr.trim().slice(-300) });
      return;
    }
  }
  const script = [
    entries.length > 0 ? 'tar -xf "$0" -C "$HOME"' : "true",
    "command -v git >/dev/null && { git config --global --get-all safe.directory | grep -qx '[*]' || git config --global --add safe.directory '*'; }",
    `: > "$HOME/${SEEDED}"`,
  ].join(" && ");
  const seeded = await runCommand([...prefix(id), "sh", "-c", script, tarball], { ...SANDBOX, env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 300_000 });
  removePath(tarball);
  if (seeded.exitCode !== 0) log.warn("an agent's own HOME could not be given the shared one's logins", { agent: id, error: seeded.stderr.trim().slice(-300) });
}

/**
 * The daemon's HOME, where every agent's programs and logins were: passed through to the programs, which every agent
 * runs (`SHARED_HOME_TOOLS`), and closed to everything else in it — the logins, now each agent's own copy.
 */
async function shareHome(home: string): Promise<void> {
  openToPassing(home);
  const tools = new Set<string>(SHARED_HOME_TOOLS);
  closeToOthers(listDir(home).filter((entry) => !tools.has(entry.name)).map((entry) => join(home, entry.name)));
  const shared = await shareTools(SHARED_HOME_TOOLS.map((dir) => join(home, dir)));
  if (!shared.ok) log.warn("the programs in the shared HOME could not be made every agent's to run", { problem: shared.problem });
}

/**
 * Its own Python env, `~/.local/opt/python` — first on its PATH (`ownUserEnv`) — where the shared one is the daemon's
 * to change. Light: no pip of its own, the shared env's packages (pip with them) importable through a `.pth`, so what was
 * installed for every agent still imports and `pip install` puts what this agent adds in its own. Made once, as the
 * agent; where there is no python3, nothing.
 */
const AGENT_PYTHON = [
  'env="$0"; shared="$1"',
  '[ -x "$env/bin/python3" ] && exit 0',
  "command -v python3 >/dev/null || exit 0",
  'python3 -m venv --without-pip --system-site-packages "$env"',
  "site=$(\"$env/bin/python3\" -c 'import sysconfig; print(sysconfig.get_path(\"purelib\"))')",
  "version=$(\"$env/bin/python3\" -c 'import sys; print(\"%d.%d\" % sys.version_info[:2])')",
  'echo "$shared/lib/python$version/site-packages" > "$site/nouride-shared.pth"',
  "for p in pip pip3; do printf '#!%s\\nimport sys\\nfrom pip._internal.cli.main import main\\nsys.exit(main())\\n' \"$env/bin/python3\" > \"$env/bin/$p\"; chmod 755 \"$env/bin/$p\"; done",
].join("\n");

async function makePython(id: string, home: string, shared: string, prefix: (agent: string) => string[]): Promise<void> {
  const made = await runCommand([...prefix(id), "sh", "-ec", AGENT_PYTHON, join(home, ".local", "opt", "python"), shared], { ...SANDBOX, timeoutMs: 120_000 });
  if (made.exitCode !== 0) log.warn("an agent's own Python env could not be made", { agent: id, error: made.stderr.trim().slice(-300) });
}

/** A folder every agent's own user passes through and lists nothing in: `--x` for others, and nothing more. */
function openToPassing(path: string): void {
  const mode = statFile(path)?.mode;
  if (mode !== undefined && (mode & 0o007) !== 0o001) setFileMode(path, (mode & ~0o007) | 0o001);
}

/** What no agent's command may read, closed to everyone but the daemon: the memory vault, the packs' git history. */
function closeToOthers(paths: readonly string[]): void {
  for (const path of paths) {
    const mode = statFile(path)?.mode;
    if (mode !== undefined && (mode & 0o007) !== 0) setFileMode(path, mode & ~0o007);
  }
}

/**
 * A daemon that is root — a Box — keeps its helper current from its own install: `nouride update` swaps `run/` with the
 * rest (`SWAPPED`), and nothing else would bring the root copy forward. Only a copy that is root's: one another account
 * could have written is never put where root runs it. Whether it was replaced.
 */
export async function refreshHelper(installDir: string, o: { binary?: string; ownerOf?: (path: string) => number | null } = {}): Promise<boolean> {
  const source = join(installDir, "run", "nouride-run");
  const binary = o.binary ?? HELPER_BINARY;
  if ((o.ownerOf ?? fileOwner)(source) !== 0) return false;
  const next = await readFileBytes(source);
  const current = fileExistsSync(binary) ? await readFileBytes(binary) : null;
  if (current && current.length === next.length && current.every((byte, i) => byte === next[i])) return false;
  ensureDir(dirname(binary));
  copyFileAtomic(source, binary);
  setFileMode(binary, 0o755);
  return true;
}

export interface AgentUsersBoot {
  finding: AgentUsersFinding;
  /** Every loaded agent, made ready: run at boot, and again for an agent when it loads. */
  ready(agents: readonly LoadedAgent[]): Promise<void>;
}

/**
 * Found, said, and put in front of every agent's command from now on. `landlock` and the agent's declared roots are
 * read at each command, so a config reload or a pack edit takes effect without a restart.
 */
export async function settleAgentUsers(input: {
  config: GlobalConfig;
  kept: KeptFolders;
  agent: (id: string) => LoadedAgent | undefined;
  /** How the helper is found; a test's own. */
  find?: (folders: HelperFolders) => Promise<AgentUsersFinding>;
}): Promise<AgentUsersBoot> {
  if (isRoot() && (await refreshHelper(dirname(dirname(input.config.daemon.dataDir))))) log.info("the helper was brought up to this release's", { binary: HELPER_BINARY });
  const finding = await (input.find ?? findHelper)(helperFolders(input.config, input.kept));
  const users = finding.users;
  if (!users) {
    log.warn("agents' commands run as the daemon's own user", { reason: finding.reason });
    return { finding, ready: async () => {} };
  }
  const landlock = () => input.config.security.exec.landlock ?? "auto";
  const confine = (id: string) => ({ landlock: landlock(), writable: input.agent(id)?.config.workspaceRoots ?? [] });
  runAgentCommandsThrough({
    prefix: (id, cwd, pidFile) => clientPrefix(users, id, { ...(cwd ? { cwd } : {}), pidFile, ...confine(id) }),
    put: (id, path) => putCommand(users, id, path, confine(id)),
  });
  log.info("each agent's commands run as its own user", {
    through: users.through,
    ...(finding.version ? { helper: finding.version } : {}),
    ...(finding.landlock ? { landlock: `${landlock()}; this kernel: ${finding.landlock}` } : {}),
  });
  const prefix = (id: string, cwd = "/") => clientPrefix(users, id, { cwd, landlock: "off", writable: [] });
  closeToOthers([input.config.memory.dir, join(input.config.daemon.agentsDir, ".git")]);
  // `.nouride`, which every agent passes through to its folders: install.sh opens it so, and this keeps it so.
  openToPassing(dirname(input.config.daemon.dataDir));
  // The daemon's HOME, where a service unit's agents all were: its programs every agent's to run, its logins seeded.
  const sharedHome = agentsOwnHome(input.config.daemon.dataDir);
  if (sharedHome) void shareHome(sharedHome);
  const readyOne = async (agent: LoadedAgent): Promise<string | null> => {
    const problem = await makeReady(users, agent, prefix, sharedWorkspace(input.config.daemon.workspaceDir));
    const home = privateWorkspace(input.config.daemon.workspaceDir, agent.config.id);
    if (!problem && sharedHome) await seedHome(agent.config.id, home, sharedHome, join(input.kept.jobs, agent.config.id), prefix);
    if (!problem) await seedSsh(agent.config.id, home, prefix);
    if (!problem) await makePython(agent.config.id, home, pythonEnvDir(dirname(input.config.daemon.dataDir)), prefix);
    return problem;
  };
  /**
   * Each agent made ready one at a time. Boot's is not waited on and a reload readies its agent again, and two at once
   * packed its HOME seed into the one tarball together, each cutting the other's: the seeded mark was never written,
   * and the next start extracted the shared HOME over the agent's own files. The second waits, then finds it seeded.
   */
  const readying = new Map<string, Promise<unknown>>();
  /**
   * Each agent said ready once. A reload readies its agent again, and approving a skill reloads every pack: three drafts
   * approved were twenty-one lines saying nothing new (0.8.8, the live box). A problem is said every time.
   */
  const said = new Set<string>();
  return {
    finding,
    ready: async (agents) => {
      const started = Date.now();
      const problems = await Promise.all(
        agents.map(async (agent) => {
          const id = agent.config.id;
          const mine = (readying.get(id) ?? Promise.resolve()).catch(() => {}).then(() => readyOne(agent));
          readying.set(id, mine);
          return [id, await mine] as const;
        }),
      );
      for (const [agent, problem] of problems) {
        if (problem) log.warn("an agent's commands cannot run as its own user: they are refused until this is fixed", { agent, problem });
      }
      const ready = problems.filter(([agent, problem]) => !problem && !said.has(agent)).map(([agent]) => agent);
      for (const agent of ready) said.add(agent);
      if (ready.length > 0) log.info("agents ready as their own users", { agents: ready, ms: Date.now() - started });
    },
  };
}

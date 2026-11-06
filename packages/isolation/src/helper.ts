/**
 * Where `nouride-run` is, how the daemon reaches it, and whether it may (`root/nouride-run`, the RFC's §2).
 *
 * Decided once, at boot, from what can be read: the platform, whether this is a container, whether the daemon is root,
 * whether the helper is installed, and what the helper says it serves. Every answer comes with a reason a person can
 * act on, said at boot and by `doctor` — commands that run beside the daemon are never passed off as isolated.
 */

/** Root's, outside the install: a binary the service user could replace would be root's for the taking. */
export const HELPER_BINARY = "/usr/local/lib/nouride-run/nouride-run";
export const HELPER_SOCKET = "/run/nouride-run.sock";
/** The protocol this daemon speaks — the helper's `info` names its own. */
const PROTOCOL = "1";

/**
 * The folders the helper's rules cover, from the daemon's config. Written into its unit (`helperUnits`) and asked back
 * at boot: a helper serving other folders than the config names would make folders nobody reads.
 */
export interface HelperFolders {
  /** `shared/`, every agent's; `private/<agent>`, each one's own. */
  workspace: string;
  /** The daemon's folders whose `<agent>` folder that agent's commands read: its pack, its jobs' logs, its attachments, its tools' long output. */
  reads: string[];
  /** Read by the agents granted `nr-creds`. */
  credentials: string;
}

/** How an agent's commands reach their own user, as boot found it. */
export type AgentUsers =
  /** Through the root helper's socket: the daemon runs sandboxed, as its service user. */
  | { through: "socket"; binary: string; socket: string; folders: HelperFolders }
  /** The helper's rules in the client's own process: the daemon is root (a Box), with nothing to ask. */
  | { through: "local"; binary: string; folders: HelperFolders };

/** `[security.exec] landlock` — `landlock.rs` in the helper. */
export type LandlockMode = "off" | "auto" | "require";

export interface ClientOptions {
  /** Where the command starts; the client's own working directory when absent. */
  cwd?: string;
  /** Where the client writes the command's pid once it runs — the daemon reads the command's activity by it. */
  pidFile?: string;
  landlock: LandlockMode;
  /** Folders beyond its own the agent's commands write — its declared roots. */
  writable: readonly string[];
}

function where(users: AgentUsers): string[] {
  if (users.through === "socket") return ["--socket", users.socket];
  const { workspace, reads, credentials } = users.folders;
  return ["--local", "--workspace", workspace, ...reads.flatMap((dir) => ["--reads", dir]), "--credentials", credentials, "--service-user", "root"];
}

/** The client's command line, in front of an agent's command. */
export function clientPrefix(users: AgentUsers, agent: string, o: ClientOptions): string[] {
  return [
    users.binary,
    "exec",
    ...where(users),
    "--agent",
    agent,
    ...(o.cwd ? ["--cwd", o.cwd] : []),
    ...(o.pidFile ? ["--pid-file", o.pidFile] : []),
    "--landlock",
    o.landlock,
    ...o.writable.flatMap((dir) => ["--writable", dir]),
    "--",
  ];
}

/** The command that writes its stdin to `path` as `agent` — whole, or not at all (`put.rs`). */
export function putCommand(users: AgentUsers, agent: string, path: string, o: Pick<ClientOptions, "landlock" | "writable">): string[] {
  return [...clientPrefix(users, agent, { cwd: "/", ...o }), users.binary, "put", "--to", path];
}

/** The command that sets an agent's grantable groups to exactly `groups` (`op: groups`). */
export function groupsCommand(users: AgentUsers, agent: string, groups: readonly string[]): string[] {
  return [users.binary, "groups", ...where(users), "--agent", agent, ...groups.flatMap((group) => ["--group", group])];
}

export interface HelperInfo {
  version: string;
  protocol: string;
  folders: HelperFolders;
  /** `abi <n>`, or `none — <why>`: the kernel's Landlock, for boot and `doctor` to say. */
  landlock: string;
}

/** `info`'s answer, `key=value` a line; null for anything else. */
function parseInfo(text: string): HelperInfo | null {
  const fields = new Map(
    text
      .split("\n")
      .map((line) => line.match(/^([a-z]+)=(.*)$/))
      .filter((match) => match !== null)
      .map((match) => [match[1]!, match[2]!] as const),
  );
  const version = fields.get("version");
  const protocol = fields.get("protocol");
  const workspace = fields.get("workspace");
  if (!version || !protocol || !workspace) return null;
  const reads = fields.get("reads") ?? "";
  return {
    version,
    protocol,
    folders: { workspace, reads: reads ? reads.split(":") : [], credentials: fields.get("credentials") ?? "" },
    landlock: fields.get("landlock") ?? "",
  };
}

export interface AgentUsersFinding {
  users: AgentUsers | null;
  /** Said at boot and by `doctor`: why commands run as their agents, or why they do not. */
  reason: string;
  /** The helper's own version, where it answered. */
  version?: string;
  /** The kernel's Landlock as the helper found it, where it answered. */
  landlock?: string;
}

/** What boot can read without asking anything, and the one question it asks: the helper's `info`. */
export interface AgentUsersFacts {
  platform: string;
  inContainer: boolean;
  root: boolean;
  /** The folders this config names, absolute — the helper must serve the same ones. */
  folders: HelperFolders;
  binaryPresent: boolean;
  socketPresent: boolean;
  info: () => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

const BESIDE = "agents' commands run as the daemon's user";
const AGAIN = "run install.sh again";

/** The first folder the helper serves differently from the config, said; null when they agree. */
function folderMismatch(served: HelperFolders, named: HelperFolders): string | null {
  if (served.workspace !== named.workspace) return `the workspace ${served.workspace}, and this config names ${named.workspace}`;
  if (served.reads.join(":") !== named.reads.join(":")) return `the folders ${served.reads.join(", ") || "(none)"}, and this config names ${named.reads.join(", ")}`;
  if (served.credentials !== named.credentials) return `the credentials directory ${served.credentials || "(none)"}, and this config names ${named.credentials}`;
  return null;
}

export async function findAgentUsers(facts: AgentUsersFacts): Promise<AgentUsersFinding> {
  if (facts.platform !== "linux") return { users: null, reason: `not Linux, so ${BESIDE}` };
  if (facts.inContainer) return { users: null, reason: `in a container: the container is the boundary, and ${BESIDE}` };
  if (!facts.binaryPresent) return { users: null, reason: `${HELPER_BINARY} is not installed: ${AGAIN}; until then ${BESIDE}` };
  if (facts.root) {
    return {
      users: { through: "local", binary: HELPER_BINARY, folders: facts.folders },
      reason: "the daemon is root: each agent's commands run as its own user, by the helper's rules, in-process",
    };
  }
  if (!facts.socketPresent) return { users: null, reason: `${HELPER_SOCKET} is not there: nouride-run.socket is not running (${AGAIN}); ${BESIDE}` };
  const answer = await facts.info();
  const info = answer.exitCode === 0 ? parseInfo(answer.stdout) : null;
  if (!info) return { users: null, reason: `the helper did not answer as one should (${answer.stderr.trim() || `exit ${answer.exitCode}`}); ${BESIDE}` };
  const found = { version: info.version, landlock: info.landlock };
  if (info.protocol !== PROTOCOL) {
    return { users: null, ...found, reason: `the helper speaks protocol ${info.protocol} and this daemon ${PROTOCOL}: ${AGAIN}; ${BESIDE}` };
  }
  const mismatch = folderMismatch(info.folders, facts.folders);
  if (mismatch) return { users: null, ...found, reason: `the helper serves ${mismatch}: ${AGAIN} after changing them; ${BESIDE}` };
  return {
    users: { through: "socket", binary: HELPER_BINARY, socket: HELPER_SOCKET, folders: facts.folders },
    ...found,
    reason: "each agent's commands run as its own user (nr-<agent>)",
  };
}

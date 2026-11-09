/**
 * The coding CLIs built in (0.8.1: Claude Code and Codex — omp left out, 2026-10-26: it has no sign-in of its own, only a
 * provider's key; Antigravity taken out, 2026-10-27: its ACP server stopped in its own start-up on the test box, and its
 * CLI has no ACP mode), as data.
 *
 * A row says how the CLI is started in its ACP mode, pointed at a profile, kept from updating itself, put in each of
 * the three presets, signed in on a box with no browser, and how it says it is signed out. Nothing that drives a CLI
 * names one: a person's own CLI is a row of the same shape (`[[external_clis]]`), and gets everything a built-in one
 * does except the promise that it was tried. Each fact here was observed on the CLI's own release (2026-10-26) unless
 * the comment says otherwise.
 */

/** The three presets: free in its folder, ask for what is risky, ask for everything. */
export type CliPreset = "folder" | "risky" | "all";

export interface CliRow {
  id: string;
  name: string;
  /** The program the scan looks for, and what starts its ACP mode with `args`. */
  command: string;
  args: readonly string[];
  /** How a person installs it — Nouride ships no CLI. */
  install: string;
  /**
   * The npm package that carries it (0.8.24): its newest version is read from the registry, and an update installs it.
   * Absent: a person's own CLI, updated the way it was installed.
   */
  package?: string;
  /**
   * The versions of `package` this release of Nouride was tried with, lowest and highest (0.8.24): below the lowest it is
   * older than Nouride supports, above the highest newer than it was tested with (`versions.ts`). Each is a version that
   * ran Nouride's turns, named where it ran; a version is added here only after that.
   */
  tested?: { lowest: string; highest: string };
  /** Prints its version. */
  versionArgs: readonly string[];
  /** The variable that points it at a profile folder (its sign-in and settings), made before it starts. Absent: HOME. */
  profileEnv?: string;
  /** Files a new profile starts with — settings that keep it from updating itself, or from a keyring a box lacks. */
  profileFiles?: Readonly<Record<string, string>>;
  /** Set on every start. */
  env?: Readonly<Record<string, string>>;
  /** Each preset as the CLI's session mode (`session/set_mode`). A preset it has no mode for leaves its default. */
  modes?: Partial<Record<CliPreset, string>>;
  /**
   * Nouride relies on its `_session/steering` (0.8.24): a new version whose handshake no longer offers it fails the check
   * an update runs (`handshake.ts`). Absent: a CLI that never offered it is driven without it.
   */
  steering?: boolean;
  /** Its instruction file, in the folder it works in. */
  instructionFile: string;
  /**
   * Its own instruction file in its profile folder, read whatever folder it works in — Codex's `CODEX_HOME/AGENTS.md`,
   * its global instructions. Where a CLI has one, Nouride's block goes there instead of the agent's folder: a mission
   * works in a person's repository, where the block is not written, and Codex reads `AGENTS.md` from that repository's
   * root down only — so in a mission it answered without the agent's persona (0.8.1–0.8.3). Absent: the agent's folder,
   * which Claude Code reads from a mission inside it too.
   */
  profileInstructionFile?: string;
  /** Who makes it, said beside its name where CLIs are listed: "Anthropic: Claude Code". */
  maker?: string;
  /**
   * Where it reads its own skills, whatever folder it works in, in its profile folder (`<dir>/<name>/SKILL.md`): the
   * agent's Nouride skills are copied there. Not a project's skills folder: the agent's folder is its HOME, and Claude
   * Code reads no project skills where it works in HOME (its own log, on the box: `project=[]`). Absent: they do not
   * reach it.
   */
  skillsDir?: string;
  /**
   * It fills `${VAR}` in an MCP server's headers from its own environment (Claude Code does — checked on the box, 2.1.309):
   * Nouride's bearer then goes in its environment, which only the agent's own user reads, and not in the headers, which
   * reach its command line — where any user on the box read one agent's token and could call Nouride as it (0.8.1).
   */
  mcpEnvHeaders?: boolean;
  /** Run in a terminal on the box to sign in: it prints a link, and a code where the flow has one. Absent: none works. */
  login?: readonly string[];
  /** Said beside the sign-in, for what the terminal does not cover. */
  loginNote?: string;
  /**
   * A sign-in one account makes once and every agent on it uses (0.8.1): its words, run in a terminal, end by printing
   * a long-lived token — the CLI's own, for machines with no browser — that begins with `tokenPrefix`; the CLI takes it
   * from `env` when it starts. Absent: each agent signs in on its own (its `login`, in its own profile).
   */
  sharedLogin?: { args: readonly string[]; env: string; tokenPrefix: string };
  /**
   * Words that say whether its profile is signed in, exiting 0 when it is. Absent: a session it opens or refuses says —
   * which a CLI that opens one signed out (Claude Code's adapter does) gets wrong.
   */
  status?: readonly string[];
  /** Words in a refusal that mean "not signed in or not set up", beyond the protocol's -32000. */
  signedOut?: readonly string[];
}

export const BUILT_IN_CLIS: readonly CliRow[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    maker: "Anthropic",
    command: "claude-agent-acp",
    args: [],
    install: "npm i -g @agentclientprotocol/claude-agent-acp (Node 22 or later; it carries Claude Code itself)",
    package: "@agentclientprotocol/claude-agent-acp",
    // 0.95.0 answers the owner's agents on the box, and 0.100.0 the e2e VM's Claude, each the version there on 2026-11-08.
    tested: { lowest: "0.95.0", highest: "0.100.0" },
    versionArgs: ["--version"],
    profileEnv: "CLAUDE_CONFIG_DIR",
    // v1 pinned: the adapter also serves a draft v2 to a client that asks. No claude.ai connectors: a profile signed in
    // with a claude.ai account loaded that account's Gmail, Drive and Docs tools — reaching outside Nouride's gate and
    // audit, where an agent's MCP servers go through it (the live box, 0.8.1; the switch is Claude Code's own).
    env: { CLAUDE_AGENT_ACP_PROTOCOL: "v1", DISABLE_AUTOUPDATER: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
    modes: { folder: "bypassPermissions", risky: "acceptEdits", all: "default" },
    steering: true,
    instructionFile: "CLAUDE.md",
    // CLAUDE_CONFIG_DIR/skills: its user skills, read in any folder — a mission's repository too.
    skillsDir: "skills",
    mcpEnvHeaders: true,
    // Prints a link; the browser cannot reach the box's callback, so it asks for the code the page then shows.
    login: ["--cli", "auth", "login", "--claudeai"],
    // Measured on the box (2026-10-26): exit 0 on a signed-in profile, 1 on one never signed in.
    status: ["--cli", "auth", "status"],
    // `claude setup-token`: Claude Code's own long-lived sign-in for a machine with no browser, read from the variable.
    sharedLogin: { args: ["--cli", "setup-token"], env: "CLAUDE_CODE_OAUTH_TOKEN", tokenPrefix: "sk-ant-oat01-" },
    loginNote: "Signs in with a Claude subscription.",
  },
  {
    id: "codex",
    name: "Codex",
    maker: "OpenAI",
    command: "codex-acp",
    args: [],
    install: "npm i -g @agentclientprotocol/codex-acp (it carries Codex itself)",
    package: "@agentclientprotocol/codex-acp",
    // 2.3.0 on the box, and 2.5.0 the e2e VM's Codex, each the version there on 2026-11-08.
    tested: { lowest: "2.3.0", highest: "2.5.0" },
    versionArgs: ["--version"],
    // The folder must exist before it starts, or the handshake itself fails.
    profileEnv: "CODEX_HOME",
    profileFiles: { "config.toml": 'check_for_update_on_startup = false\ncli_auth_credentials_store = "file"\n' },
    modes: { folder: "agent-full-access", risky: "agent", all: "read-only" },
    steering: true,
    instructionFile: "AGENTS.md",
    // A person's own override file beside it is read in its place, as Codex's documentation says.
    profileInstructionFile: "AGENTS.md",
    // CODEX_HOME/skills: its user skills (its own binary reads them there, 0.164); its `.system` folder is its own.
    skillsDir: "skills",
    // A link and a one-time code; device-code sign-in has to be switched on in the ChatGPT account's security settings.
    login: ["cli", "login", "--device-auth"],
    loginNote: "Signs in with ChatGPT. Turn on device-code sign-in in your ChatGPT security settings first.",
  },
];

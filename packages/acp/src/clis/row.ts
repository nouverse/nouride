/**
 * The shape every coding CLI is held to, built in or a person's own (`[[external_clis]]`): one row says how the CLI is
 * started in its ACP mode, pointed at a profile, kept from updating itself, put in each of the three presets, signed in
 * on a box with no browser, how it says it is signed out, and how its account's use is read. Nothing that drives a CLI
 * names one. A built-in CLI is one file in this folder exporting its row, listed in `index.ts`: adding one is that file
 * and that line (`docs/CODING_CLIS.md`). Each fact a row states was observed on the CLI's own release unless its
 * comment says otherwise.
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
   * Installed by its maker's own script, not a package: the script's address, and where under the installing
   * user's HOME it leaves the CLI (`binary`; `folder`: the CLI is the whole folder that file is in, not the file alone).
   * `nouride agents install <id>` runs it as `nouride tools run` installs, copies the CLI into the install's shared
   * `opt/<id>` and links it into its `bin` as `command`, where every agent's user runs it: the installers put it in
   * their own user's HOME, which no agent's user reads, and the card had no Set it up for it. Absent: a package, or a
   * person's own CLI.
   */
  script?: { url: string; binary: string; folder?: true };
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
  /**
   * The CLI `package` carries: which of its dependencies is the CLI itself, and the field of that dependency's
   * `package.json` that holds the CLI's version. `package` is the connector, and its version is not the CLI's: the
   * dashboard read claude-agent-acp 0.100.0, said "up to date", and the Claude Code inside it, 2.1.316, knew no model
   * newer ones had (seen on a live box). The one fact about a CLI's parts a row states; the rest is read from the
   * files installed (`parts.ts`). Absent: a person's own CLI, whose command is taken to be the CLI.
   */
  carries?: { name: string; package: string; field: string };
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
  /**
   * Takes a message mid-prompt as a second `session/prompt` into the session, from this version on: the running prompt
   * answers at once and the new one goes on with the work, its answer the turn's (Antigravity's, seen on the live box).
   * Not while it waits on a permission: it refuses the prompt then, and the message is the turn's next prompt.
   */
  steerByPrompt?: { since: string };
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
  /**
   * Its sign-in's files, under its profile folder (or HOME where it has none), where they are known: the only files an
   * account signed in on the Models page hands its agents, and takes back renewed (`account-sign-in.ts`). Absent: what
   * its sign-in wrote, but its databases, logs and conversations. Antigravity's sign-in wrote its conversations'
   * database too, which, handed to every agent on the account and taken back, would have mixed theirs.
   */
  signInFiles?: readonly string[];
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
  /**
   * How its connector marks a message refused for a limit of the account, in the refusal's `data`: the field and the
   * value that say so, and where it says one, the dotted path to when the limit ends, in seconds since 1970. Read from
   * the data alone, never from the sentence beside it: an account is marked and the agent moved to its next
   * (`external-agents/rotation.ts`). Absent: its refusals say nothing of the kind, and no account is ever marked.
   */
  limit?: { key: string; value: string; resets?: string };
  /**
   * What its connector says of the account's use in a session update while it works, read into the one shape
   * (`CliUse`): so an agent that asked to (`[external] move_at`) moves to its next account before a message is refused,
   * and the account's card shows it between reads. Null: the update says none. Absent: it says nothing of the kind.
   */
  use?: (update: unknown, now: number) => CliUse | null;
  /**
   * Where its connector says that a tool call is not the agent's own but a helper's that the CLI started itself (a
   * subagent), in the call's `_meta`: the key there, and under it the field that names the call that started the
   * helper. A helper started in the background goes on after that call has ended, and the CLI keeps the prompt open
   * for it: a message for the agent then waits for no command of the agent's, and goes in at once. Absent: every
   * call is the agent's own.
   */
  helper?: { meta: string; parent: string };
  /**
   * How its connector says that the CLI's own turn has ended, whatever the prompt then does: a usage update that
   * carries this field. A connector may keep the prompt unanswered long after it, for helpers the CLI started in the
   * background (Claude Code's does, for a client that has not told it otherwise). Read with `helper`: a chat's turn
   * then ends where the agent's own work ended, and the helpers go on behind it. Absent: only a prompt's answer ends
   * a turn.
   */
  ended?: { usage: string };
  /**
   * Not yet run on a real account: offered with an Experimental label where CLIs are listed and picked, and it names no
   * `tested` versions. Its start, its handshake and its sign-in were seen on a machine with no account; a turn was not.
   */
  experimental?: true;
  /**
   * Built in after its id was free for a person's own `[[external_clis]]` row: an install may hold one, older than this
   * row perhaps, so theirs is kept in this one's place, said at load, rather than refused at the upgrade, which stopped
   * the daemon over what worked. Absent: an own row of its id is refused, read as if it were the one tried here.
   */
  ownKept?: true;
  /**
   * The sign-in methods its handshake offers that it is told to use, in order, when it refuses a session as signed out
   * (`authenticate`, the protocol's own): the first one offered is sent and the session asked for again, once. Some CLIs
   * open no session until told how their sign-in is to be read, even with one kept. Absent: never sent.
   */
  authenticate?: readonly string[];
  /**
   * How its account's use is asked for at any time, not only as it works: an address its maker answers with the
   * account's token, or a method of its own over the protocol while it runs. Read into one shape for every CLI
   * (`CliUse`), by the parse beside it. Absent: what it says while it works (`use`) is all there is.
   */
  readUse?: UseReader;
}

/** Whether an update is of a helper the CLI started itself, as its connector marks one (`CliRow.helper`). */
export function helpersUpdate(helper: CliRow["helper"], update: object): boolean {
  const all = (update as { _meta?: unknown })._meta;
  const meta = helper && all && typeof all === "object" ? (all as Record<string, unknown>)[helper.meta] : undefined;
  const startedBy = meta && typeof meta === "object" ? (meta as Record<string, unknown>)[helper!.parent] : undefined;
  return typeof startedBy === "string" && startedBy !== "";
}

/** One window of a limit: the share used in percent, how long the window is in minutes, and when it starts again in ms. */
export interface UseWindow {
  usedPercent: number;
  minutes: number | null;
  resetsAt: number | null;
}

/** A limit of an account: its id and name as the maker says them, the models it counts where it is some models' alone. */
export interface UseLimit {
  id: string;
  label: string;
  models?: readonly string[];
  windows: readonly UseWindow[];
}

/** An account's use, one shape for every CLI: its limits with their windows, and whether credits beyond them are left. */
export interface CliUse {
  limits: readonly UseLimit[];
  creditsLeft?: boolean;
}

/** Where an account's token is read: a variable its shared sign-in sets, or a file in its profile folder at a path. */
export type UseToken = { env: string } | { file: string; path: readonly string[] };

/** A request for an account's use, and the parse of its answer into `CliUse` (null: the answer says none). */
export type UseReader =
  | {
      kind: "http";
      method: "GET" | "POST";
      url: string;
      /** The token, sent as `Authorization: Bearer`, from the first of these that holds one. */
      token: readonly UseToken[];
      headers?: Readonly<Record<string, string>>;
      /** Headers whose values are read from the profile folder's files, as a token is. */
      fileHeaders?: Readonly<Record<string, { file: string; path: readonly string[] }>>;
      body?: string;
      parse: (answer: unknown, now: number) => CliUse | null;
    }
  | {
      kind: "acp";
      /** A method of the CLI's own, asked on a connection that is open. */
      method: string;
      parse: (answer: unknown, now: number) => CliUse | null;
    };

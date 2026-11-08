import type { ApprovalPreview } from "../approval-preview.ts";
/**
 * What a call sends off the machine (0.8.0, `Tool.sendsOut`): in words for the second look, and where, by key — what a
 * person's *always for this job* names. `to` is empty when the tool cannot say where; such a call is never allowed always.
 */
export interface SendsOut {
  what: string;
  /** `chat:<gateway>:<chat>`, `mcp:<tool>`, `host:<name>`, `mail:<address>`, `git:<remote>`. */
  to: readonly string[];
}

/** Tool execution and the approval gate — §7 SPEC, TD-010. */

import type { ApprovalLevel } from "./agent.ts";
import type { ApprovalDecision } from "./config.ts";
import type { ChatType, GatewayName } from "./envelope.ts";
import type { AudioRefPart, ImageRefPart, ToolDefinition } from "./llm.ts";

export interface ToolContext {
  agentId: string;
  sessionId: string;
  chatId: string;
  /**
   * The turn the call belongs to: what its `tool_exec` audit row, the usage of a helper or a peer it starts,
   * and its log lines are joined by. Absent outside a recorded turn — a cron run, a test.
   */
  turnId?: string;
  /** The call this is — unique within its turn — so what records it can be paired with its result. */
  callId?: string;
  /**
   * When the turn has to have answered by — so a `delegate` helper started from this call can wrap up before it
   * rather than die on the turn's abort with nothing to hand back. Absent for a turn with no clock.
   */
  deadlineAt?: number;
  /**
   * The most one foreground `exec` command may wait when it is not the usual 240 seconds: in a helper working in the
   * background (0.7.15), which runs every command in the foreground on a clock of its own. Set by the helper's
   * toolset, never by the model; absent everywhere else.
   */
  commandMaxMs?: number;
  /** Platform, for wording. */
  gateway: GatewayName;
  /** Connection instance, for anything that has to find the same session again. */
  gatewayId: string;
  senderId: string;
  /**
   * The name the sender goes by in this chat, as the platform says it — for words a tool records as theirs (`work`'s
   * `tell`, 0.8.10) where People names nobody. Absent where the turn has none.
   */
  senderName?: string;
  /**
   * Whether this is a one-to-one chat or a room.
   *
   * On the context because a tool can behave differently in the two and cannot otherwise tell. The
   * caller that needs it is the agent-to-agent bus: a room's handover is an @mention the platform
   * delivers, a DM's is a peer turn run behind the chat, and the second has to know not to quote a
   * message id nobody in the conversation is looking at.
   */
  chatType: ChatType;
  /**
   * Set only when `exec` is being driven by the `nouride` tool rather than by the model.
   *
   * `exec` refuses this daemon's own CLI — see `reachesOwnCli` — and the CLI tool reaches the same
   * sandbox by forwarding through `exec`, so it needs a way to say "this one is me".
   *
   * On the context and not in the arguments, because arguments are written by the model and this
   * must not be: a field the model can set is a field the model can use to take the closed door
   * back. Nothing outside the executor builds a `ToolContext`.
   */
  ownCliTool?: true;
  /**
   * Set only for a call an external agent's coding CLI made over MCP (`LentTools.call`, 0.8.11): its reply carries text
   * alone, so a tool that would hand back a picture or a sound gives the file's path instead, as a message's files go to
   * a CLI; and what a tool does to the agent's commands reaches the CLI's own shell only when its process starts again.
   * Never set by the model.
   */
  lent?: true;
  /**
   * Set only by the daemon for a mission's check (0.8.7): the command is handed none of the agent's secrets bound to
   * its program — those bound to every command it still gets, as every command does. A check reads a result; handed a
   * bound credential it asks a person (`credential-out`), nobody is there to answer, and it is refused — so no `git`
   * check of an agent with a token bound to `git` ever ran, and its mission went round. On the context, not in the
   * arguments, for the reason `ownCliTool` is.
   */
  checkOnly?: true;
  /**
   * Set only by the daemon in a turn another agent asked for (`ask_agent`, 0.8.8): that agent's id. A background job
   * started here reports its end to it, never to this agent (`job-wakes.ts` `reportsTo`) — so `exec` moves no command to
   * the background by itself, and says so of one it was asked to. On 0.8.7 an asked agent's `du` went to the background
   * on its own, its turn ended promising to follow up, and the result reached the agent that asked: three times in one
   * evening it stopped mid-work. On the context, not in the arguments, for the reason `ownCliTool` is.
   */
  askedBy?: string;
  /**
   * Where work happens: the agent's default directory, and what a relative path resolves against.
   *
   * `data/workspace/<agent>/`, created at boot. **Nobody configures this** — an agent that cannot do
   * anything until someone declares a directory is an agent that does not work out of the box, and the
   * first person to hit that wrote a root pointing at a directory that did not exist, then spent a
   * while watching the agent fail to find a file in plain sight.
   *
   * Under `data/` rather than in the persona pack because this is mutable output: the pack is
   * config-as-code and git-tracked, and build artefacts do not belong in it.
   */
  workspaceDir: string;
  /**
   * The persona pack: `agents/<id>/`, where `IDENTITY.md` and `MEMORY.md` live.
   *
   * Split from `workspaceDir` because the two were the same field and that conflated config with
   * output — `MEMORY.md` was being reached through something called "workspace", and moving the
   * workspace would have moved the agent's memory with it.
   */
  agentDir: string;
  /**
   * Every directory this agent may reach — `workspaceDir` plus its configured roots.
   *
   * A path is accepted if it resolves within *any* of these. Checked on the resolved path, so
   * `../` and absolute spellings normalize before comparison.
   */
  workspaceRoots: string[];
  /**
   * Directories the agent may read and search, but never write.
   *
   * Kept apart from `workspaceRoots` rather than folded into it, because "may look at" and "may
   * change" are different permissions and one list can only express one of them. The case that forced
   * the split: `exec` starts a background job and hands back `Live log: <dataDir>/jobs/<id>.log`, and
   * `read` then refused it — the tool advertised a path its own sandbox would not open. Widening the
   * writable roots instead would let an agent truncate the log of a job that is still running, which
   * is the one file it most needs to be able to trust.
   */
  readOnlyRoots?: string[];
  /**
   * The folders whose files are the agent's own — `shared/`, its private folder, its declared roots. Where each agent's
   * commands run as its own user, a file a tool writes there is written as that agent (`writeAgentFile`), so it has one
   * owner; its pack and the conversation's attachments stay the daemon's to write.
   */
  ownFolders?: string[];
  /**
   * The agent's own folder, `private/<id>/`: its commands' HOME where each agent's commands run as its own user (0.8.0).
   * Absent where the turn has none — a subagent context assembled by hand, a test.
   */
  privateDir?: string;
  /**
   * The agent's disposable directory, inside `privateDir`.
   *
   * Carried on the context for one reason: `exec` hands it to every child process as `TMPDIR`, which
   * is the only part of "put throwaway files in the scratchpad" that does not depend on the model
   * agreeing. `mktemp`, Python's `tempfile`, `ffmpeg` and everything else that asks the environment
   * where to write then lands there by default instead of in `/tmp`.
   *
   * Optional because a context without one is not broken — a child simply gets the environment it got
   * before, which is no `TMPDIR` at all.
   */
  scratchpadDir?: string;
  /**
   * Where this call's output goes if it is too big to hand back whole.
   *
   * Set by the executor when it can spill, and only a path — nothing is created until a tool writes
   * to it. A tool that streams (`exec`) uses it to put a large output on disk *as it arrives*, so the
   * daemon never holds the whole thing; it then says so with `ToolResult.spooled`. A tool that ignores
   * it loses nothing: its result is spilled after the fact, from memory, the way every result is.
   */
  spoolPath?: string;
  /**
   * How many characters of this call's result the model will see before the rest is spilled.
   *
   * For a tool whose result is several things — five pages, ten files. The spill keeps a result's
   * head and tail, which is right for one log and wrong for a batch: the items in the middle would
   * vanish from the excerpt while the model believed it had them all. A tool that knows the figure can
   * give each item its share and say which ones it cut. Absent outside the executor.
   */
  resultChars?: number;
  /**
   * The outside content this turn has already read — the tools whose results carried it (a fetched page, a search,
   * an MCP server's answer, a file somebody sent: `ToolResult.untrusted`), and what its own prompt carried (a
   * forwarded message, a webhook's payload: `MessageEnvelope.outsideContent`). Set by the executor; absent while there
   * is none. What a turn writes after reading it may have been written *by* it, so a memory write in such a turn is
   * marked as one, and waits for a person (`Tool.keepsInPrompt`).
   */
  untrustedRead?: readonly string[];
  /**
   * Where a run of a scheduled job sends what it has to say — its job's chat (0.8.0). Set only for such a run: a send
   * anywhere else is asked first, at every approval level, since nobody is watching and the job named this one.
   */
  sendsTo?: { gatewayId: string; chatId: string };
  /** What a person allowed this job's runs to send without asking again — `Job.allowed`'s keys (0.8.0). */
  allowed?: readonly string[];
  /**
   * Work nobody watches that this call is part of — what it is for, its job, and the level the turn's calls are answered
   * at. Set by the executor for such a turn, so a helper the call starts runs under the same guards (0.8.1): without it,
   * a scheduled run's helper had no second look and its agent's own level, `trusted` included.
   */
  unattended?: { goal: string; jobId?: string; level: ApprovalLevel };
  /**
   * The request a person's yes let this call run on, and what it showed them (0.8.13): what a tool whose write depends
   * on what was approved checks against — the persona tool, whether the file is still the one the diff was made from.
   */
  approved?: { id: string; preview?: ApprovalPreview };
  signal: AbortSignal;
}

/** A result whose full text is already on disk; `content` holds only its two ends. */
export interface SpooledOutput {
  /** The file, or null when it could not be written — then `content` is all that is left. */
  path: string | null;
  /** Characters and lines of the whole output, measured, not estimated from the excerpt. */
  chars: number;
  lines: number;
}

export interface ToolResult {
  /** Text handed back to the model. Errors go here too — the model adapts better than we do. */
  content: string;
  isError: boolean;
  /** Not sent to the model; for the audit log and the dashboard. */
  metadata?: Record<string, unknown>;
  /**
   * The content came from outside — written by whoever wrote the page, the server, the file — and is marked
   * as data in `content`. The executor remembers it for the rest of the turn (`ToolContext.untrustedRead`).
   */
  untrusted?: true;
  /** Present when the tool already put its full output on disk. See `ToolContext.spoolPath`. */
  spooled?: SpooledOutput;
  /**
   * Pictures this call put in front of the model.
   *
   * A tool result is text on the wire — OpenAI's `tool` role takes a string and nothing else — so a
   * tool that opens an image cannot hand the image back through `content`. It names the file here
   * instead, and the executor turns it into a message the model can actually see. Refs, not bytes:
   * `resolveImages` reads them for the one request that needs them.
   *
   * The alternative was what `attachment_read` used to do — ask a vision model and return its prose.
   * That is a lossy transcription standing where the thing itself could have stood, and for anything
   * about layout, colour or position it is not merely worse, it is unusable: prose has no
   * coordinates. An agent asked to judge a design got three different descriptions of one screenshot
   * and then wrote a pixel-counting script.
   */
  media?: (ImageRefPart | AudioRefPart)[];
}

export interface Tool {
  definition: ToolDefinition;
  /** Default when the agent config does not override it. */
  requiresApproval: boolean;
  /**
   * Safe to run at the same time as other parallel-safe calls in the same batch.
   *
   * Opt-in, and false by default, because the question is "could two of these interfere" and the safe
   * answer for anything unexamined is yes. A read cannot; `write` and `edit` obviously can; `exec` can
   * do anything at all. An MCP tool is somebody else's code and gets the default.
   *
   * The harness is the only thing that can know this — which is the argument for typed tools over a
   * shell in the first place. A `grep` and a `git push` are the same opaque command string to a bash
   * tool, so a harness holding only that string has to serialize both.
   *
   * Being marked does not mean a call *will* run in parallel: the executor only groups consecutive
   * marked calls that also cannot stop for an approval. See `executor/tool-batching.ts`.
   */
  parallelSafe?: boolean;
  /**
   * Its result is content to be kept exactly, a file's lines (0.8.17): never made smaller by kind before it enters the
   * context (`llm/output-by-kind.ts`). An agent edits by the exact text it read, and a JSON file read without its
   * spaces, or a repeated line counted, would be text the file does not hold.
   */
  verbatim?: true;
  /**
   * Decide per *call*: run, ask, or refuse.
   *
   * Some tools are only conditionally dangerous — `exec` running `ls` and `exec` running
   * `rm -rf` are the same tool name — so a gate that can only be all-or-nothing per name forces
   * a choice between an unusable agent and an unguarded one.
   *
   * Optional. A tool without one inherits the agent's `approval_required` list: on the list means
   * ask, off it means run. `exec` implements it and delegates to `@nouride/policy`.
   */
  gate?(args: Record<string, unknown>, ctx: ToolContext): GateDecision;
  /**
   * What is wrong with these arguments, in words the model can correct the call from — or nothing.
   *
   * Asked by the executor before the gate, the way arguments that are not one JSON object are answered: a call that
   * cannot be made is said to the model at once, rather than put to a person who approves it only for it to fail. Set
   * by an MCP tool, which holds a call to the schema its server declared; a built-in checks its own in `execute`.
   */
  checkArguments?(args: Record<string, unknown>): string | undefined;
  /**
   * What this tool writes is read by every later prompt — `MEMORY.md`, a person's record and notes. After a turn has
   * read outside content (`ToolContext.untrustedRead`), a call to it waits for a person's yes, as a change to this
   * daemon's own state does, instead of being written in silence — at every approval level but `trusted`. A function
   * when only some calls write: `person_notes` without `change` reads.
   */
  keepsInPrompt?: true | ((args: Record<string, unknown>) => boolean);
  /**
   * The entry of the fixed list this call is on (`HardlineClass`), or null — for a tool with no gate of its own: asked
   * every time and never granted, before anything else the registry decides. `agent_configure` writing the agent's own
   * `config.toml` is one; `exec` decides its own (`Tool.gate`).
   */
  fixedList?(args: Record<string, unknown>, ctx: ToolContext): { class: HardlineClass; reason: string } | null;
  /**
   * What the person deciding is shown, where the arguments' shape says too little (`buildApprovalPreview` reads `path`,
   * `content`, `old_string`, `command`): the `persona` tool's diff against the file as it stands (0.8.8). Null: the
   * shape's preview.
   */
  preview?(args: Record<string, unknown>, ctx: ToolContext): ApprovalPreview | null;
  /**
   * Held back from the model: left out of the definitions it is sent, and a call to it — a name it remembers, or makes
   * up — answered with this sentence, as an error, by `checkArguments` before any gate. An MCP tool an agent's `tools`
   * list leaves out (0.7.21); kept rather than dropped so the refusal can name the setting instead of "unknown tool".
   */
  withheld?: string;
  /**
   * What the audit log keeps of a call's arguments, in place of them — for a tool whose argument is somebody's words
   * rather than an instruction: `send_message` keeps where it went and how long it was, not the message, which lives
   * in the conversation it was sent to and goes when that does. Absent: the arguments, redacted (`auditableArgs`).
   */
  auditArgs?(args: Record<string, unknown>, ctx: ToolContext): Record<string, unknown>;
  /**
   * What this call sends off the machine to someone else, in words — a message to another chat, an MCP server's write,
   * a command that posts over the network — or null when it sends nothing out (0.8.0). Declared by the tool, never read
   * from its name: what work nobody watches is given a second look at before it does (`tools/second-look.ts`).
   */
  sendsOut?(args: Record<string, unknown>, ctx: ToolContext): SendsOut | null;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * What always asks (0.8.0): one fixed list, the vocabulary `@nouride/policy`'s classifier answers in.
 *
 * A call in one of these is asked *allow once* only and never remembered, through whichever tool does it. `careful`
 * asks every class; `balanced` only the ones in `BALANCED_ASKS` (`@nouride/policy`); `trusted` none. Declared once,
 * here, because two copies of this union drifted silently: `shared` imports nothing, and `policy` reads it from here.
 */
export type HardlineClass =
  /** A `config.toml` changed — the daemon's, the agent's own, or another agent's. A pack's `skills.toml` and `mcp.toml` are not. */
  | "config"
  /** Someone given access — a pairing approved, a person or an admin added, the allowlist — or answered for. */
  | "access"
  /** The daemon stopped, killed or uninstalled. A restart is not. */
  | "stop"
  /** A stored secret replaced or deleted. */
  | "secret"
  /**
   * A credential leaving: a credential file sent off the machine, a command handed a secret it is bound to, a
   * credential sent in chat used after outside content (the secret guard).
   */
  | "credential-out"
  /** The daemon's own state reached where agents run as the daemon's user and no file permission stands in front of it. */
  | "own-state"
  /** The daemon replaced — an update or a downgrade. */
  | "replace"
  /** The daemon's database read or written: every agent's conversations. */
  | "database"
  /** Deleted for good outside the workspace: a recursive or wide `rm`, `mkfs`, `dd`, a dropped database. */
  | "delete"
  /** Infrastructure torn down: `terraform destroy`, `pct destroy`, `kubectl delete`. Creating and changing are not. */
  | "teardown"
  /** A scheduled job created or changed that runs without asking. */
  | "unattended"
  /** An interactive session started: what is typed into it is not a command any check sees. */
  | "interactive"
  /** A remote's history rewritten — `git push --force` and its kin. An ordinary push is not. */
  | "force-push"
  /**
   * Work nobody watches — a scheduled job's run, a mission — sending somewhere its job did not name, or what the second
   * look held (0.8.0). Asked at every level, `trusted` too: nobody is there to see it happen.
   */
  | "unwatched"
  /**
   * A program installed or updated for every agent, as the daemon's user (`nouride tools run`, 0.8.1): its install
   * scripts run as the user that owns every pack, the database and the secret store. Asked at every level, `trusted`
   * too — on the live box the orchestrator, trusted, read another agent's pack through it, which nothing else let it.
   */
  | "shared-tools"
  /**
   * This machine's packages changed through `nouride-pkg`, as root: `nouride pkg install|remove|upgrade` (0.8.15). The
   * 0.8.0 list left it out, and an agent at `balanced` changed packages with nobody asked — found when Nouride's image
   * turned the service on. Asked at `careful` and `balanced`, and answered in a chat by an admin only; `trusted` does not
   * ask, and the agent says what it installs.
   */
  | "system-packages"
  /**
   * An agent's own `SOUL.md`, `IDENTITY.md` or `AGENTS.md` changed (0.8.8, the `persona` tool): who it is, its
   * confirmation rules and its boundaries. Asked at every level, `trusted` too, and answered in a chat by an admin only:
   * a turn talked into loosening its own rules would otherwise leave no one to see it. And a folder added to or taken
   * from its skill roots (0.8.24, `skill_root`): the skills it brings are instructions in the agent's prompt too.
   */
  | "persona"
  /**
   * Who People says a person is changed through this daemon's own CLI (0.8.9): `nouride people set|remove`, and
   * `nouride access approve <code> --as <key>|--me`, which links the sender to that person. An admin is a person in
   * People holding an admin's dashboard account, so a chat id linked to their entry answers what only an admin may.
   * Asked at every level, `trusted` too, and answered in a chat by an admin only.
   */
  | "people";

/** A tool's `gate` asking a human. */
export interface GateAsk {
  action: "ask";
  /** Whether `allow-always` may write a durable grant for this call. */
  grantable: boolean;
  /** On the fixed list (`HardlineClass`): asked every time and never remembered. */
  hardline?: boolean;
  /**
   * Which entry of the fixed list. The approval level reads it: `balanced` asks only some (`BALANCED_ASKS`), and a
   * question with no class is one `balanced` and `trusted` answer by themselves.
   */
  hardlineClass?: HardlineClass;
  /** Why a human is being asked, phrased for someone deciding in a chat. */
  reason: string;
  /**
   * Everything needed to persist a grant, precomputed.
   *
   * Carried on the decision so the approval gate never has to know how a command identity is
   * built — and so the key that was looked up is provably the key that gets stored.
   */
  grant?: ExecGrantPayload;
  /**
   * The same, for a tool whose grant is a directory rather than a command.
   *
   * A separate field rather than a union so a consumer that only understands exec grants keeps
   * compiling and simply never persists one — the failure mode is "asks again", not "grants wrongly".
   */
  toolGrant?: ToolGrantPayload;
}

/**
 * What a tool's `gate` decided.
 *
 * `ask` carries `grantable` because the answer's *meaning* depends on it: an `allow-always` on a
 * non-grantable call runs once and persists nothing, and the operator has to be told that rather
 * than silently getting less than they clicked for.
 */
export type GateDecision =
  | { action: "run"; via: "ceiling" | "allowlist" | "grant"; grantKey?: string }
  | GateAsk
  /**
   * Refused. `unasked` is the question this stands in for when the only reason is that nobody could be
   * asked, so an approval level that answers it by itself still can — see `PolicyOutcome` in `@nouride/policy`.
   */
  | { action: "refuse"; reason: string; unasked?: GateAsk };

/** The durable-grant payload an `exec` ask carries. Shaped by `@nouride/policy`'s key derivation. */
export interface ExecGrantPayload {
  grantKey: string;
  agentId: string;
  argv: string[];
  cwd: string;
  fileSha256?: string;
  /** Snapshot of the policy in force, for the audit trail. Never part of the key. */
  policy: unknown;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRequest {
  id: string;
  agentId: string;
  chatId: string;
  gateway: GatewayName;
  tool: string;
  /** Shown to the human in full — a truncated command is not something anyone can approve. */
  params: Record<string, unknown>;
  /**
   * The summary a human decides from, computed when the request was made.
   *
   * Absent for rows written before previews existed, and for parameters with no summary worth storing —
   * a renderer falls back to `params` in both cases.
   */
  preview?: ApprovalPreview;
  status: ApprovalStatus;
  requestedAt: number;
  resolvedAt?: number;
  resolvedBy?: string;
  /**
   * The sender whose turn asked, while the request is pending. Kept by the process that asked rather than in the
   * table, and handed to the next one when a restart keeps the request (`approvals-kept.ts`); a request kept after
   * a crash has none, and then in a room only an admin may answer. In a room it decides who may answer.
   */
  requestedBy?: string;
  /**
   * The entry of the fixed list it was asked under, when it is on one — computed where the class is still in hand and
   * stored with the row (0.8.9). Who may answer reads it: `persona` and `people` are an admin's alone.
   */
  hardlineClass?: HardlineClass;
  /**
   * Whether `allow-always` is on offer for this request.
   *
   * Carried on the request, not just used to build the prompt, so every surface — chat, CLI,
   * dashboard — offers the same three answers and can explain a downgrade after the fact.
   */
  grantable?: boolean;
  /**
   * Whether the `balanced` approval level may answer this without a human.
   *
   * Read by the drain that runs when `/approvals balanced` is set, which used to read `grantable`
   * for it. The two questions are different — `allow-always` versus "stop asking me" — and they only
   * gave the same answer while auto-approval excluded every hardline class.
   */
  autoCoverable?: boolean;
  /** Why approval is needed, phrased for someone deciding in a chat. */
  reason?: string;
  /** Which of the three answers resolved it. Absent while pending. */
  decision?: ApprovalDecision;
  timeoutMs: number;
  /**
   * Pending, and not put in front of anybody in its chat yet: it waits behind the question that chat shows (one at a
   * time, `approval-floor.ts`). The dashboard lists every pending request, so it says which of them the chat has not
   * seen — they looked like prompts lost on their way to the chat.
   */
  queued?: boolean;
}

export interface SandboxOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /**
   * The turn's deadline, or another caller-owned cancellation.
   *
   * Distinct from `timeoutMs`: that is the command's own wall-clock ceiling. This aborts the child
   * because the work around it ended — the turn timed out, the user reset the chat, or shutdown is
   * draining. Without it a foreground command can keep the conversation key occupied long after the
   * turn that asked for it has already been abandoned.
   */
  signal?: AbortSignal;
  /**
   * Kernel-enforced ceilings on the child.
   *
   * The timeout bounds wall-clock and `maxOutputBytes` bounds what is read; neither stops a command
   * that allocates until the machine swaps. Those are the failures that take the host down rather
   * than the turn.
   */
  limits?: { memoryMb?: number; cpuSeconds?: number };
  /**
   * Written to the child's stdin, then closed.
   *
   * The only way to hand a command a value that must not be written down. Every argument a tool
   * receives is kept: in the exec grant, in the audit log, and in this daemon's own log table — all
   * three permanently. A credential in `cmd` is therefore a credential on disk forever, which is why
   * `nouride mcp add --stdin` and `nouride secret set --stdin` exist and why their
   * inline forms are documented as the worse choice.
   *
   * Absent means stdin is `"ignore"`, which is what a sandboxed command should get: a child that
   * inherits a terminal can block forever waiting for input nobody is there to type. Bytes for a file written as an
   * agent (`writeFileAsAgent`), which may not be text.
   */
  stdin?: string | Uint8Array;
  /** Explicit allowlist. The daemon's own environment is never inherited (§17.1). */
  env: Record<string, string>;
  /**
   * Hand the output over as it arrives instead of collecting it.
   *
   * Set, the runner holds nothing: each chunk is decoded (a UTF-8 character split across two reads is
   * joined, never replaced) and passed here in arrival order, `stdout` and `stderr` alike, and the
   * result's `stdout`/`stderr` come back empty. `maxOutputBytes` is then the caller's to enforce —
   * the runner keeps draining the pipe either way, because a pipe nobody reads is a child blocked on
   * write, and one that is closed is a child killed by SIGPIPE partway through its work.
   */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  /**
   * The agent whose command this is, from the turn, the job or the cron entry that started it — never from anything the
   * model wrote. Run as that agent's own user where the daemon found the helper (0.8.0); absent for the daemon's own
   * commands, which run as the daemon.
   */
  agent?: string;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Killed because the caller's abort signal fired, not because `timeoutMs` elapsed. */
  aborted?: boolean;
  truncated: boolean;
  durationMs: number;
  /**
   * What it was doing when the timeout killed it — set only then. The quiet time is always known;
   * data and CPU only where the host reports them (Linux), null elsewhere.
   */
  activity?: { quietForMs: number; bytesMoved: number | null; cpuSeconds: number | null };
  /**
   * Processes the kernel stopped for memory among the agents' commands while this one ran (0.7.19) — set only when it
   * did. Its own exit may not show it: a pipeline's code is its last command's, read from what was cut short.
   */
  oomKills?: number;
}

/**
 * The durable-grant payload a non-`exec` ask carries.
 *
 * Scoped to a directory rather than a command identity. See `toolGrantKey` for why that is the only
 * scope under which "always allow this tool" is a bounded answer rather than a policy change.
 */
export interface ToolGrantPayload {
  grantKey: string;
  agentId: string;
  tool: string;
  scopeDir: string;
}

/**
 * `nouride` — the daemon's own CLI, offered as one tool instead of copied into the prompt.
 *
 * ## Why this exists
 *
 * The prompt used to carry a hand-written list of every `nouride` command: ~1,500 tokens, on every
 * request and every tool iteration. The harness now sits in its own cacheable block, so on the
 * Anthropic path a re-add would be billed at a tenth after the first request — but the OpenAI path
 * this install actually uses has only implicit prefix caching, and 1,500 tokens of context window is
 * spent whatever the invoice says.
 * It was a copy of what `nouride help` already prints, so it went stale the moment a verb was added —
 * `people set` and `cron update` existed in the CLI and not in the prompt within a day of shipping.
 *
 * Worse, it told the agent to do something the sandbox refuses. "Run it from <installDir>" cannot be
 * done through `exec`: `resolveCwd` bounds `cwd` to the workspace roots, and the install directory is
 * not one of them. The only way through was `sh -lc "cd … && nouride …"`.
 *
 * One tool fixes all three. It costs a fixed ~60 tokens, it sets the working directory itself, and it
 * grows on its own — a new CLI verb appears in `nouride help` with nothing to edit here.
 *
 * ## Why it is an adapter and not an implementation
 *
 * Everything that makes `exec` safe has to apply unchanged: the argv-array rule, the env allowlist,
 * the timeout and output cap, `blocked` patterns, the ask/grant policy, and the hardline classes —
 * including the one that stops `nouride cron add --command` from ever becoming a standing grant. A
 * second copy of that decision is exactly the drift this whole change exists to remove, so this maps
 * its arguments onto `exec`'s and forwards both `gate` and `execute` to the real tool.
 *
 * The narrowing is the point: `argv[0]` is always `nouride`, so an agent can be given the daemon's
 * control surface **without** being given a general shell. That is what a pack which withholds
 * `exec` needs — before this, such an agent could not schedule a reminder at all.
 *
 * (This used to name `WIZARD_TOOLS` as the example and say it withholds `exec`. Both halves went
 * stale: the wizard now derives its list from the live registry, and `exec` is in it.)
 */

import type { Tool, ToolContext } from "@nouride/shared";
import { notAnInstall } from "@/modules/toolchain/installers.ts";
import { dispatchedArgv } from "@/cli/args.ts";

export interface NourideCliOptions {
  /** The real `exec` tool. Its gate and sandbox are used verbatim. */
  exec: Tool;
  /**
   * Where the CLI is run from, which is how it finds the install *and* its control token.
   *
   * `cli/client.ts` resolves `dataDir/.control-token` relative to the working directory, so this is
   * also the reason the agent never needs to read that file — and must not, since it is a credential
   * path the gate will stop on.
   */
  installDir: string;
  /**
   * The executable, as an absolute path — **not** the bare name.
   *
   * `nouride` is on `PATH` as a symlink (`/usr/local/bin/nouride -> /srv/nouride/nouride`), so a bare
   * name would resolve through whatever install owns that symlink. On a box running two installs
   * that is the wrong daemon, silently: the command succeeds and edits somebody else's config. The
   * caller resolves the binary belonging to *this* install and passes it here, or does not offer the
   * tool at all.
   */
  command: string;
  /**
   * Whether this agent installs and updates the programs every agent runs (`nouride tools run`): the orchestrator,
   * unless its pack says `[security] shared_tools = false` (`toolchain/shared-tools.ts`). Absent: nobody.
   */
  changesSharedTools?: (agentId: string) => boolean;
}

/** Why `nouride tools` is not this agent's — said before anything is asked, so nobody approves a call that is refused. Its last sentence takes the gate's full stop. */
const NOT_THE_ORCHESTRATOR =
  "Only the orchestrator installs and updates the programs every agent runs (`nouride tools run`). " +
  "What you install yourself (npm i -g, pip, cargo install) lands in your own HOME, on your PATH. " +
  "To have something installed for every agent, ask the orchestrator";

/**
 * Why an agent does not make, change or turn on a scheduled job or a webhook here (0.8.0): it proposes one with
 * `schedule`, and a person turns it on from its card — read in words, not as a command line to approve.
 */
const PROPOSE_INSTEAD =
  "An agent does not make, change or turn on scheduled jobs and webhooks directly: propose one with `schedule`, and a " +
  "person turns it on from its card. To change a job, propose it again with `replaces` set to its id";

/** `exec`'s longest foreground command (`timeout_ms` above): what an install is given when it does not say. */
const INSTALL_TIMEOUT_MS = 240_000;

/**
 * The words the CLI will run, as it reads them (`dispatchedArgv`): read as given, a `--json` anywhere before `--` stood
 * where the verb was looked for, and `["--json", "tools", "run", …]` passed every refusal below while the CLI ran it.
 */
function cliArgv(args: Record<string, unknown>): string[] | null {
  return Array.isArray(args.args) ? dispatchedArgv(args.args.map(String)).argv : null;
}

/** `tools run …`: a program installed for every agent. */
function installs(argv: readonly string[]): boolean {
  return argv[0] === "tools" && argv[1] === "run";
}

/** `cron add|update|enable` and `webhook add|rotate` — what would make or widen scheduled work without a card. */
function schedulesDirectly(argv: readonly string[]): boolean {
  const [verb, action] = argv;
  if (verb === "cron") return action === "add" || action === "update" || action === "enable";
  if (verb === "webhook" || verb === "webhooks") return action === "add" || action === "rotate";
  return false;
}

export function createNourideCliTool(options: NourideCliOptions): Tool {
  const refused = (args: Record<string, unknown>, ctx: ToolContext): string | null => {
    const argv = cliArgv(args);
    if (!argv) return null;
    if (schedulesDirectly(argv)) return PROPOSE_INSTEAD;
    if (argv[0] !== "tools") return null;
    if (options.changesSharedTools?.(ctx.agentId) !== true) return NOT_THE_ORCHESTRATOR;
    // What the command would refuse, refused before anyone is asked to approve it.
    const at = argv.indexOf("--");
    return installs(argv) && at >= 0 ? notAnInstall(argv.slice(at + 1)) : null;
  };
  /**
   * The install directory added as a permitted working directory — for this tool only.
   *
   * `resolveCwd` bounds `cwd` to the agent's workspace roots, and the install directory is not one,
   * which is why the prompt's old "run it from <installDir>" was refused. Widening `exec` itself
   * would hand every command a new place to run; widening the context this one tool forwards keeps it
   * to the one directory the CLI needs. `workspaceRoots` is read by nothing else in `exec.ts` — only
   * `resolveCwd` — so this grants a cwd and nothing more.
   *
   * It grants no new *reads* either: workspace roots bound where a command runs, never what the
   * process it spawns may open. An `exec` that wanted this directory's files could already name them
   * by absolute path.
   */
  const withInstallRoot = (ctx: ToolContext): ToolContext => ({
    ...ctx,
    workspaceRoots: [...ctx.workspaceRoots, options.installDir],
    /**
     * And the one thing `exec` cannot work out for itself: this call is the tool, not the model.
     *
     * `exec` refuses this daemon's own CLI and points here — see `reachesOwnCli`. Without this flag
     * the redirect would be a circle, because the argv forwarded below is precisely what that rule
     * is looking for. On the context rather than in the forwarded arguments, so the model cannot
     * write it.
     */
    ownCliTool: true,
  });

  /**
   * Who is calling, for the two commands that schedule their own way back.
   *
   * `nouride update --start --then "…"` and `nouride restart --then "…"` need an agent, a gateway
   * and a chat to aim the follow-up turn at. The CLI has always read them from the environment when
   * the flags are absent, and nothing ever set them — so the agent had to spell all three out, and
   * the run that forgot failed *after* its approval was granted. It then retried with the flags,
   * paying a second interruption for one update.
   *
   * The daemon knows all three without being told: they are on the `ToolContext` this tool is
   * called with. Passed as an object rather than spread into the environment here, so `exec` can
   * filter it to these three names — a tool that could set arbitrary environment variables on a
   * child process is a different thing entirely.
   */
  const callerEnv = (ctx: ToolContext): Record<string, string> => ({
    NOURIDE_AGENT_ID: ctx.agentId,
    NOURIDE_GATEWAY_ID: ctx.gatewayId,
    NOURIDE_CHAT_ID: ctx.chatId,
  });

  /** One place that turns this tool's arguments into `exec`'s, used by both gate and execute. */
  const asExecArgs = (args: Record<string, unknown>, ctx: ToolContext): Record<string, unknown> => ({
    caller_env: callerEnv(ctx),
    command: [options.command, ...(Array.isArray(args.args) ? args.args.map(String) : [])],
    cwd: options.installDir,
    // An install takes longer than a command's 30 seconds: `npm i -g` of a coding CLI was cut off at them on the live
    // box, reported as failed, and finished all the same (0.8.1). The longest a foreground command may have, unless asked.
    ...(typeof args.timeout_ms === "number" ? { timeout_ms: args.timeout_ms } : installs(cliArgv(args) ?? []) ? { timeout_ms: INSTALL_TIMEOUT_MS } : {}),
    ...(typeof args.background === "boolean" ? { background: args.background } : {}),
    ...(typeof args.on_complete === "string" ? { on_complete: args.on_complete } : {}),
    /**
     * The one field that is not written down anywhere.
     *
     * Two CLI commands read a credential from stdin rather than from a flag — `secret set
     * --stdin` and `mcp add --stdin` — because every argument this tool receives is kept
     * permanently in three places: the exec grant, the audit table and the daemon's log table. Until
     * this existed the prompt told the agent to pipe a value in, which it could not do: the sandbox
     * ran every command with `stdin: "ignore"`, so the advice was unfollowable and the inline flag
     * was the only path that worked.
     */
    ...(typeof args.stdin === "string" ? { stdin: args.stdin } : {}),
  });

  return {
    // Inherited rather than declared, so the two tools cannot disagree about whether running a
    // command needs an approval.
    requiresApproval: options.exec.requiresApproval,

    definition: {
      name: "nouride",
      description:
        "Control the Nouride daemon you run inside: agents, gateways, approvals, grants, scheduled " +
        "jobs, webhooks, people, access, memory, skills, providers, secrets, MCP servers, db, update, " +
        "logs, audit, config and more. " +
        'Arguments as an array, no leading `nouride`, no shell syntax: ["cron", "--all"]. ' +
        "Run `help` for the full command list: it comes from the daemon, so it is never stale.",
      parameters: {
        type: "object",
        properties: {
          args: {
            type: "array",
            items: { type: "string" },
            description: 'Arguments after `nouride`, e.g. ["agents"] or ["cron", "--all"]',
          },
          stdin: {
            type: "string",
            description:
              "A value fed to the command's stdin instead of its arguments: the only field here " +
              "that is never recorded. Use it for every credential: `secret set --stdin`, " +
              "`provider add --stdin`, `gateway add --stdin`, `mcp add --stdin`. A `$TMP_SECRET_…` " +
              "handle here is replaced by its value. Never put a credential in `args`: those are kept forever.",
          },
          timeout_ms: {
            type: "integer",
            description: "Milliseconds before a foreground command is killed. Default: the daemon's tool timeout (30000 unless configured); max 240000.",
          },
          /**
           * Forwarded, because `exec` has them and an agent is now told to come here instead: a long `db backup` or
           * `update` should not hold the turn.
           *
           * Not for `logs --follow`, which this used to name as the example. A follower never exits on its own —
           * `exec-timeout.ts` already tells the agent so — and backgrounded it held one of the agent's four job slots
           * for an hour, and held `update --start` behind it. `logs -n` answers what a look at the log needs.
           */
          background: {
            type: "boolean",
            description:
              "Run without waiting, for a command that takes minutes and then ends, like a long `db backup`. You get a job id immediately and are told when it finishes.",
          },
          on_complete: {
            type: "string",
            description:
              "What to do when a backgrounded command finishes. Only set it when there is a clear next action.",
          },
        },
        required: ["args"],
      },
    },

    /**
     * Forwarded, including the hardline flags.
     *
     * `exec`'s gate returns `hardline` and `hardlineClass`, and the executor reads them to decide
     * whether auto-approval may answer. Rebuilding the decision here would drop them — the exact bug
     * `exec.gate` has a forty-line comment about, twice.
     */
    ...(options.exec.gate
      ? {
          gate: (args: Record<string, unknown>, ctx: ToolContext) => {
            const reason = refused(args, ctx);
            return reason ? { action: "refuse" as const, reason } : options.exec.gate!(asExecArgs(args, ctx), withInstallRoot(ctx));
          },
        }
      : {}),

    async execute(args, ctx) {
      if (!Array.isArray(args.args) || args.args.length === 0) {
        // Not silently turned into bare `nouride`, which prints usage and looks like it worked.
        return { content: '`args` must be a non-empty array, e.g. ["help"].', isError: true };
      }
      const reason = refused(args, ctx);
      if (reason) return { content: `${reason}.`, isError: true };
      const result = await options.exec.execute(asExecArgs(args, ctx), withInstallRoot(ctx));
      return { ...result, content: withoutColour(result.content) };
    },
  };
}

/**
 * The CLI colours its output for a terminal whether or not one is there, and the model read `\x1b[32m●\x1b[0m` in
 * every line of `nouride provider` — tokens that say nothing to it (live, 2026-10-20). Taken out here, where the
 * output stops being a terminal's.
 */
function withoutColour(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

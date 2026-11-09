/**
 * `exec` — run a command, sandboxed.
 *
 * The guarantees come from `@nouride/runtime`'s `runCommand` (TD-010): argv array so
 * there is no shell to inject into, an explicit environment so the daemon's API keys are
 * not inherited, a hard timeout, and a capped output buffer.
 */

import type { ExecPolicySection, GateAsk, GateDecision, SandboxOptions, Tool, ToolContext } from "@nouride/shared";
import { agentCommandsHaveOwnUsers, dirExists, join, resolveWithin, runCommand, type TextFilter } from "@nouride/runtime";
import type { TransientSecrets } from "@nouride/secrets";
import { autoApprovable, decideExec, sendDestinations, sendsOverNetwork, type ExecPolicy, type PolicyAsk } from "@nouride/policy";
import { foregroundTimeoutFor, isService, isShellScript, shouldAutoBackground } from "./exec-background.ts";
import { OutputCapture } from "./exec-output.ts";
import { findBlocked } from "./exec-blocked.ts";
import { jobStarted } from "./exec-started.ts";
import { execHint, oomKillNote } from "./exec-hints.ts";
import { foregroundWait, timeoutAdvice } from "./exec-timeout.ts";
import { followerIn, followerRefusal } from "./exec-follow.ts";
import { OWN_INSTALL_REFUSAL, writesOwnInstall } from "./exec-own-install.ts";
import { ownUserEnv, TOOLCHAIN_ENV_NAMES } from "@/modules/toolchain/env.ts";
import { secretGate, withoutBound, type ChildEnv } from "@/modules/tools/exec-secrets.ts";
import { grantBinding } from "@/modules/tools/exec-binding.ts";
import { HANDLE_IN_ARGV, heldForCommand, heldValues, notHeld, SecretGuard, withHeldValues } from "@/modules/tools/held-secrets.ts";
import { ownSecretCommandRefusal, ownSecretNamed, valuesForCommand } from "@/modules/tools/credential-files.ts";
import { printedOutput, printedSource } from "@/modules/tools/credential-output.ts";
import { credentialSendAsk, credentialSent } from "@/modules/tools/credential-send.ts";
import { gitGuard } from "@/modules/tools/git-guard.ts";

export interface ExecToolOptions {
  /**
   * The agent's credentials: what one command is handed (`forCommand`), and every value, to mask output with.
   *
   * A function rather than a captured object: what an agent may spend changes when a pack is
   * reloaded or a secret is rotated, and a value read once at construction would answer for the
   * moment the toolset was built. Same reasoning as `liveGrants`.
   */
  childEnv?: ChildEnv;
  /**
   * The credentials people sent in chat (`tools/held-secrets.ts`): a command that names a handle is handed its value in
   * its environment, and what it prints is masked of every one its conversation holds.
   */
  heldSecrets?: TransientSecrets;
  /**
   * Every credential the daemon holds itself, by name (`ToolsetDeps.ownSecrets`): a value a printed credential file
   * shares with one keeps that one's mask rather than gaining a handle of its own (`tools/credential-output.ts`).
   */
  ownSecrets?: () => Record<string, string>;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Command patterns this agent refuses outright, merged with the global `blocked` list. */
  blocked: string[];
  /** The `[security.exec]` section: the operator's veto list and a command's ceilings. */
  policy: ExecPolicySection;
  /**
   * Live durable grants for an agent.
   *
   * A narrow function rather than the store, so the tool cannot reach anything else on it — and
   * so tests can supply a set without a database.
   */
  liveGrants?: (agentId: string) => Set<string>;
  /**
   * Starts a command that outlives the turn. Absent means `background: true` is not offered.
   *
   * A function rather than the store so the tool cannot reach anything else on it, and so a test can
   * supply one without a database.
   */
  startJob?: (params: {
    argv: string[];
    cwd: string;
    ctx: { agentId: string; gatewayId: string; chatId: string; turnId?: string };
    env: Record<string, string>;
    /** Whose own user it runs as: the agent's — absent for the daemon's CLI, run through the `nouride` tool. */
    agent?: string;
    onComplete?: string;
    /** A server, meant to run until stopped (`isService`). */
    service?: boolean;
    /** Values its log is masked of besides the agent's own: the credentials sent in its conversation. */
    mask?: Record<string, string>;
    /** What its log goes through first, per stream: the values a command printing credentials prints, as handles. */
    filter?: () => TextFilter;
    /** `limitMs`: when the daemon stops the job if it is still running (`[security] job_max_ms`); 0 or absent, never. */
  }) => { id: string; logPath: string; limitMs?: number };
  /**
   * Whether a human can be reached right now.
   *
   * Read at decision time, not captured at construction: a gateway that dropped between building
   * the toolset and the model deciding to run something must change the answer.
   */
  canAsk?: () => boolean;
}

/**
 * Characters that only mean anything to a shell — quotes included, since whitespace splitting would
 * cut `git commit -m "two words"` in the wrong place.
 *
 * A string carrying any of them is run through `bash -lc` rather than refused. Refusing it used to
 * cost a round trip per step: a model that wanted `git add . && git commit && git push` either
 * rewrote it as `["bash","-lc",...]` or, more often, sent three calls. Wrapping it is the same
 * command the model would have written by hand, and it goes through the same gate — hardline and
 * blocked patterns read inside a `-lc` payload, and the allowlist only auto-runs a script whose every
 * segment is allowlisted — so nothing here is looser than the explicit form.
 */
const SHELL_METACHARACTERS = /[|&;<>$`(){}[\]\\!*?~\n"'#=]/;

/**
 * Environment handed to a child process.
 *
 * An allowlist, not a filter: `process.env` holds every provider key the daemon was
 * started with, and a subprocess that can read them can exfiltrate them (§17.1 item 2).
 */
const ENV_ALLOWLIST = [
  "PATH",
  // This daemon's bin directory, which the runtime puts back first on a shell script's PATH after its
  // login profile has reset it (`withBinFirst` in `@nouride/runtime`). A path, set by boot.
  "NOURIDE_BIN",
  // The whole PATH boot composed — bin directory, shared Python env, the system's, the tool directories
  // in HOME — under its own name, so the same restore puts all of it back. See `modules/toolchain/env.ts`.
  "NOURIDE_PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TERM",
  // Not `SSH_AUTH_SOCK`, since 0.7.9. It was here, for every command of every agent: a socket whose other end
  // signs with every key the ssh-agent holds, for whoever asks, so `git push` or `ssh` to any host those keys open was
  // an ordinary command for an agent that never needed SSH. An agent that does says `[security] ssh_agent = true`, and
  // `childEnvFor` (`apps/engine/src/boot/child-env.ts`) hands it the socket.
  /**
   * Where installers put what they install: `.nouride/bin` and `.nouride/opt`, set by boot.
   *
   * Paths and switches, never credentials, and they have to reach the child to mean anything — an
   * installer reads its own settings from its own environment. See `modules/toolchain/env.ts`.
   */
  ...TOOLCHAIN_ENV_NAMES,
];


export function createExecTool(options: ExecToolOptions): Tool {
  const guard = new SecretGuard();
  return {
    requiresApproval: true,
    definition: {
      name: "exec",
      description:
        "Run a shell command in your workspace. Pipes, redirection, globs, quotes, variables and " +
        "multi-line scripts all work (it runs under bash). Every call is a full round trip, so for any " +
        "task (not just git) put every command you already know you need into ONE call: chain dependent " +
        "steps with && (e.g. `npm ci && npm run build && npm test`, `mkdir -p d && mv *.log d/`), and split " +
        "across calls only when you must see one output before choosing the next command. Independent " +
        "commands go as several exec calls in the same message. Use ; only when an earlier failure should " +
        "not stop the rest. Use `cwd` instead " +
        "of prefixing with `cd`. The same safety rules read every part of the command: a destructive step " +
        "inside a chain still stops for approval.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: 'The shell command, e.g. "git status && git diff --stat"',
          },
          cwd: {
            type: "string",
            description:
              "Directory to run in. Must be inside one of your workspace roots; defaults to your own directory. Prefer this over `cd`.",
          },
          timeout_ms: {
            type: "integer",
            description: `Milliseconds before a foreground command is killed. Default ${options.timeoutMs}, max 240000.`,
          },
          background: {
            type: "boolean",
            description:
              `Run without waiting, for anything that may outlast the foreground timeout (${options.timeoutMs}ms, max 240000) and then finish: a test suite, a build, a deploy. Not a server: use \`service\` for that. You get a job id and log path at once and are told when it finishes. Starting one ends your turn unless \`keep_working\`, so say what you started. Obvious long-running commands are backgrounded automatically when this is omitted; pass false to keep one in the foreground. If this process cannot run background jobs, the call says so.`,
          },
          keep_working: {
            type: "boolean",
            description:
              "With a background job: keep this turn going for other work that does not need its result, which reaches you after this turn. Leave it off when your next step needs the result: the turn ends and you are woken with it.",
          },
          service: {
            type: "boolean",
            description:
              "Start something that serves until it is stopped (a dev server, a static server, a tunnel) and carry on: unlike `background`, your turn does not end, so you can check it answers and use it straight away. It is a job like the others: listed, logged, and stopped with `nouride jobs kill <id>`. Tell the person it is running and that you can stop it. Obvious servers are run this way automatically.",
          },
          on_complete: {
            type: "string",
            description:
              "Opt-in instruction for when this job finishes. Write what you should do with the result: \"run bun install in the cloned directory\", \"check the exit code and report any errors\", \"summarise the test results\". Only set this when there is a clear next action; omit it for fire-and-forget jobs.",
          },
        },
        required: ["command"],
      },
    },

    /**
     * Decide before running: run, ask, or refuse.
     *
     * The whole decision is `@nouride/policy`'s, and everything this method does is assemble the
     * facts it needs — which is the point of the split. The previous version answered
     * `"auto" | "ask"` from a prefix match here, and the ceiling was checked separately inside
     * `execute`, so no single place could tell you what would happen.
     */
    // A command that posts, uploads, copies to another machine, pushes or mails (0.8.0, `@nouride/policy` network-send).
    sendsOut(args) {
      const command = normalizeCommand(args.command);
      if ("error" in command) return null;
      const what = sendsOverNetwork(command.argv);
      return what ? { what, to: sendDestinations(command.argv) ?? [] } : null;
    },

    gate(args, ctx): GateDecision {
      const command = normalizeCommand(args.command);
      // A malformed command cannot be classified, so it cannot be auto-run. `execute` produces
      // the actual explanation; refusing here keeps a broken argv from reaching the gate.
      if ("error" in command) return { action: "refuse", reason: command.error };
      // Refused at the gate so it never reaches a human for approval: the answer does not depend on
      // who is asked, and an approval prompt for it would teach the operator to wave through the
      // door this closes.
      if (!ctx.ownCliTool && reachesOwnCli(command.argv, ctx.workspaceRoots)) {
        return { action: "refuse", reason: OWN_CLI_REFUSAL };
      }
      // The same kind of refusal, for the files beside that CLI. See `exec-own-install.ts`.
      const installWrite = ctx.ownCliTool ? null : writesOwnInstall(command.argv);
      if (installWrite) return { action: "refuse", reason: OWN_INSTALL_REFUSAL.replace("%s", installWrite) };

      const cwd = resolveCwd(args.cwd, ctx);
      if ("error" in cwd) return { action: "refuse", reason: cwd.error };
      // The store and the control token, at every level: what they hold is used by name, never read (`credential-files.ts`).
      const ownSecret = ownSecretNamed(command.argv, cwd.path, process.env.HOME);
      if (ownSecret) return { action: "refuse", reason: ownSecretCommandRefusal(ownSecret) };

      // A credential sent in chat (`held-secrets.ts`): one this conversation does not hold is refused, and so is one in a
      // list of arguments, which no shell reads — no answer from anyone changes either.
      const handles = heldForCommand(options.heldSecrets, ctx, command.argv);
      // And in its stdin, which the `nouride` tool feeds it — replaced by their values when it runs (`withHeldValues`).
      const fed = heldForCommand(options.heldSecrets, ctx, typeof args.stdin === "string" ? [args.stdin] : []);
      if (handles.missing.length + fed.missing.length > 0) return { action: "refuse", reason: notHeld([...handles.missing, ...fed.missing]) };
      if (handles.named.length > 0 && !readByShell(command.argv)) return { action: "refuse", reason: HANDLE_IN_ARGV };
      // And after outside content, the first command to use one asks, whatever else would let it run — as does one that
      // sends a credential file off this machine (`credential-send.ts`). The secret guard: off only under `trusted`, which
      // answers every question by itself (0.8.0; it was a switch of its own, `[security] secret_guard`).
      const sent = credentialSent(command.argv, cwd.path);
      const guarded = bothAsks(guard.ask(ctx, [...handles.named, ...fed.named]), sent ? credentialSendAsk(sent) : null);

      // Handed a credential it is bound to, it asks whatever else lets it run, and its grant names the credentials.
      // Every grant is bound to the files the command runs.
      const secrets = ctx.checkOnly ? [] : (options.childEnv?.forCommand(ctx.agentId, command.argv).bound ?? []);
      const binding = grantBinding(command.argv, cwd.path, ctx.workspaceRoots, ctx.agentId, secrets);
      const outcome = secretGate(
        decideExec({
          policy: toExecPolicy(options),
          request: { argv: command.argv, cwd: cwd.path, agentId: ctx.agentId, ...binding.digest },
          grantKey: binding.key,
          grants: options.liveGrants?.(ctx.agentId) ?? new Set<string>(),
          canAsk: options.canAsk?.() ?? true,
          // The `nouride` tool runs as the daemon's user, whatever the agents run as: its own state is in its reach.
          ownStateByOs: !ctx.ownCliTool && agentCommandsHaveOwnUsers(),
        }),
        secrets,
        binding.pinned,
      );

      if (outcome.action === "run") return guarded ?? { action: "run", via: outcome.via, grantKey: binding.key };

      const asked = (ask: PolicyAsk): GateAsk => ({
        action: "ask",
        grantable: ask.grantable,
        reason: ask.reason,
        /**
         * Carried through, and this line is load-bearing.
         *
         * `decideExec` marks the fixed list's class and the executor reads it to decide whether
         * the approval level answers: at `balanced`, a `delete` it does, a `config` it does not.
         *
         * This builder used to rebuild the decision and drop the flag. The effect was that
         * every hardline command became auto-approvable the moment auto-approve was on — `/auto on`
         * for a person, or `[cron] unattended_approval = "auto"` for a scheduled turn. `sudo`,
         * `rm -rf`, and `cat` of a credential file all ran with no prompt, while three comments in
         * this codebase stated they always ask. Found by asking a live agent to read a planted
         * credential and watching it succeed in 2ms.
         *
         * The **class** has to come with it, and it caught this rebuild a second time: added to
         * `decideExec` and read by the executor, it was silently dropped right here, so every
         * elevation still looked like an unclassified hardline. A field that only two lines apart
         * know about is exactly what this rebuild keeps eating.
         */
        ...(ask.hardline ? { hardline: true } : {}),
        ...(ask.hardlineClass ? { hardlineClass: ask.hardlineClass } : {}),
        // Precomputed so the approval gate can persist it on `allow-always` without needing to
        // know how a command identity is built.
        grant: {
          grantKey: binding.key,
          agentId: ctx.agentId,
          argv: command.argv,
          cwd: cwd.path,
          ...binding.digest,
          policy: toExecPolicy(options),
        },
      });

      // The guard's question rides on the policy's: one prompt, both reasons, no grant answers it, and only `trusted`
      // answers it by itself — so it keeps a class `balanced` asks, the policy's own when that is one.
      const withGuard = (ask: GateAsk): GateAsk =>
        guarded
          ? { ...ask, grantable: false, hardline: true, hardlineClass: autoApprovable(ask.hardlineClass) ? "credential-out" : ask.hardlineClass!, reason: `${ask.reason}, and ${guarded.reason}` }
          : ask;

      // A refusal for want of anyone to ask carries the question, built the same way, so the approval
      // level can still answer it — see `ToolCaller.run`.
      if (outcome.action === "refuse") {
        return outcome.unasked ? { action: "refuse", reason: outcome.reason, unasked: withGuard(asked(outcome.unasked)) } : outcome;
      }
      return withGuard(asked(outcome));
    },

    async execute(args, ctx) {
      const command = normalizeCommand(args.command);
      if ("error" in command) return { content: command.error, isError: true };

      // Re-checked here even though `gate` already decided. `execute` is reachable directly in
      // tests and from any future caller that forgets the gate, and this is the one rule that
      // must not depend on being called through the right path. The same argument applies to the
      // line below it, for the same reason.
      if (!ctx.ownCliTool && reachesOwnCli(command.argv, ctx.workspaceRoots)) {
        return { content: OWN_CLI_REFUSAL, isError: true };
      }
      const installWrite = ctx.ownCliTool ? null : writesOwnInstall(command.argv);
      if (installWrite) return { content: OWN_INSTALL_REFUSAL.replace("%s", installWrite), isError: true };
      const blocked = findBlocked(command.argv, mergedBlocked(options));
      if (blocked) {
        return {
          content: `Command blocked by this agent's configuration: "${blocked}".`,
          isError: true,
        };
      }

      const cwd = resolveCwd(args.cwd, ctx);
      if ("error" in cwd) return { content: cwd.error, isError: true };
      const ownSecret = ownSecretNamed(command.argv, cwd.path, process.env.HOME);
      if (ownSecret) return { content: `Refused: ${ownSecretCommandRefusal(ownSecret)}.`, isError: true };

      // Rechecked for the reason the two above are; then what it names is handed to it, and what it prints is masked of
      // all its conversation holds.
      const handles = heldForCommand(options.heldSecrets, ctx, command.argv);
      const fed = heldForCommand(options.heldSecrets, ctx, typeof args.stdin === "string" ? [args.stdin] : []);
      if (handles.missing.length + fed.missing.length > 0) return { content: `Refused: ${notHeld([...handles.missing, ...fed.missing])}.`, isError: true };
      if (handles.named.length > 0 && !readByShell(command.argv)) return { content: `Refused: ${HANDLE_IN_ARGV}.`, isError: true };
      // Asked and answered, when the turn has read outside content — the next command in it with the same handle is not.
      if (ctx.untrustedRead?.length) guard.clear(ctx, [...handles.named, ...fed.named]);
      // A credential file a commit or a push would carry refuses it (`git-guard.ts`), at every level.
      const unpushable = await gitGuard(command.argv, cwd.path);
      if (unpushable) return { content: `Refused: ${unpushable}.`, isError: true };
      // Masked of what its conversation holds, and of what any credential file it names holds: `cat .env` shows what
      // `read` shows, and `set -a; . ./.env` still works.
      const held = { ...heldValues(options.heldSecrets, ctx), ...valuesForCommand(command.argv, cwd.path, process.env.HOME) };
      // A command that prints credentials — a credential file, here or over `ssh`, or an environment — has every value
      // of its output swapped for a handle before anything keeps it (`tools/credential-output.ts`).
      const source = printedSource(command.argv);
      const printed = source
        ? printedOutput(source, { held: options.heldSecrets, ctx, known: { ...options.ownSecrets?.(), ...options.childEnv?.(ctx.agentId) } })
        : null;

      // Only the secrets bound to this command; its output is masked with every one the agent has.
      const offered = options.childEnv?.forCommand(ctx.agentId, command.argv) ?? { env: {}, secrets: [], bound: [] };
      const handed = ctx.checkOnly ? withoutBound(offered) : offered;
      // Not for an agent another one asked: its job would report to that one, and it would hand back before the result.
      const autoBackground = !ctx.askedBy && shouldAutoBackground(command.argv, args.timeout_ms, options.startJob !== undefined);
      // A server is a service whether it was asked for as one or not: as an ordinary job it ends the
      // turn, and it never finishes to wake it (`isService`).
      const service = args.service === true || (args.service !== false && args.background !== false && isService(command.argv));
      const runInBackground = service || args.background === true || (args.background !== false && autoBackground);

      if (runInBackground) {
        // A follower never ends, so it is a service or nothing (`exec-follow.ts`).
        const follower = service ? null : followerIn(command.argv);
        if (follower) return { content: followerRefusal(follower), isError: true };
        if (!options.startJob) {
          return {
            content: "Background execution is not available in this process. Run it in the foreground.",
            isError: true,
          };
        }
        try {
          const onComplete = typeof args.on_complete === "string" && args.on_complete.trim()
            ? args.on_complete.trim()
            : undefined;
          const job = options.startJob({
            argv: command.argv,
            cwd: cwd.path,
            ctx: { agentId: ctx.agentId, gatewayId: ctx.gatewayId, chatId: ctx.chatId, ...(ctx.turnId ? { turnId: ctx.turnId } : {}) },
            ...(ctx.ownCliTool ? {} : { agent: ctx.agentId }),
            /**
         * `caller_env` — who is calling, for a command that has to schedule its own way back.
         *
         * Not in this tool's schema, for the same reason `stdin` is not: the caller that needs it is
         * the `nouride` tool, which knows the agent, gateway and chat from its own `ToolContext`.
         *
         * Without it `nouride update --start --then "…"` fails on "needs to know where to come back
         * to" *after* its approval has been granted — so the agent pays an interruption for a run
         * that did nothing, then retries with the flags spelled out and pays a second one. That is
         * the escalation behind three approvals for one update. The CLI has always read these three
         * variables as a fallback; nothing ever set them.
         */
        env: commandEnv(ctx, { ...handed.env, ...handles.env, ...callerEnv(args.caller_env, ctx) }),
            onComplete,
            service,
            ...(Object.keys(held).length > 0 ? { mask: held } : {}),
            ...(printed ? { filter: printed.filter } : {}),
          });
          return withSecrets(handed.secrets, jobStarted({
            job,
            argv: command.argv,
            cwd: cwd.path,
            service,
            keepWorking: args.keep_working === true,
            requested: args.background === true || !autoBackground,
            ...(ctx.askedBy ? { reportsTo: ctx.askedBy } : {}),
          }));
        } catch (err) {
          // The concurrency cap and a failed spawn both land here, and both are things the model can
          // act on — so a result, not a throw.
          return { content: String(err instanceof Error ? err.message : err), isError: true };
        }
      }

      const timeoutMs = foregroundWait(args.timeout_ms, foregroundTimeoutFor(command.argv, options.timeoutMs), ctx.commandMaxMs);
      // The output streams through this rather than being collected; see `exec-output.ts`.
      const capture = new OutputCapture({
        ...(ctx.spoolPath ? { spoolPath: ctx.spoolPath } : {}),
        env: { ...(options.childEnv?.(ctx.agentId) ?? handed.env), ...held },
        // A credential file it names — on this host or another (`ssh box "cat /srv/app/.env"`) — is masked by what it is.
        ...(printed ? { printed: printed.filter } : {}),
        diskCapChars: options.maxOutputBytes,
      });
      const sandbox: SandboxOptions = {
        cwd: cwd.path,
        // The agent's own user — but the daemon's CLI is the daemon's, run for the agent through the `nouride` tool.
        ...(ctx.ownCliTool ? {} : { agent: ctx.agentId }),
        timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        signal: ctx.signal,
        /**
         * A value for the command to read, kept out of `argv`.
         *
         * Not advertised in this tool's schema: the caller that needs it is the `nouride` tool, whose
         * own `stdin` parameter documents it against the commands that read one (`secret set
         * --stdin`, `mcp add --stdin`). Advertising it on a general shell would invite
         * `sh -lc` pipelines whose value ends up in `argv` anyway, which is the failure it exists to
         * prevent. The audit log drops this field — see `auditableArgs` in `tools/audited.ts`.
         */
        // Handles in it replaced by what they hold: no shell reads stdin (`withHeldValues`).
        ...(typeof args.stdin === "string" ? { stdin: withHeldValues(options.heldSecrets, ctx, args.stdin) } : {}),
        /**
         * `caller_env` — who is calling, for a command that has to schedule its own way back.
         *
         * Not in this tool's schema, for the same reason `stdin` is not: the caller that needs it is
         * the `nouride` tool, which knows the agent, gateway and chat from its own `ToolContext`.
         *
         * Without it `nouride update --start --then "…"` fails on "needs to know where to come back
         * to" *after* its approval has been granted — so the agent pays an interruption for a run
         * that did nothing, then retries with the flags spelled out and pays a second one. That is
         * the escalation behind three approvals for one update. The CLI has always read these three
         * variables as a fallback; nothing ever set them.
         */
        env: commandEnv(ctx, { ...handed.env, ...handles.env, ...callerEnv(args.caller_env, ctx) }),
        onOutput: capture.push,
        limits: {
          memoryMb: options.policy.maxMemoryMb ?? 0,
          cpuSeconds: options.policy.maxCpuSeconds ?? 0,
        },
      };

      const result = await runCommand(command.argv, sandbox);
      const captured = capture.finish();

      const parts: string[] = [];
      if (captured.spooled) {
        // Both ends of an output too big to hold; the spill cuts the excerpt the model sees from it,
        // and names the file, which already holds the whole thing.
        parts.push(captured.excerpt.trimEnd());
        if (captured.cappedOnDisk) parts.push(`[the file stops at ${options.maxOutputBytes} characters; the lines above are the real end]`);
      } else {
        if (captured.stdout) parts.push(captured.stdout.trimEnd());
        if (captured.stderr) parts.push(`[stderr]\n${captured.stderr.trimEnd()}`);
      }
      /**
       * The kill names the way out, because on its own it points at the wrong one.
       *
       * `[killed after 30000ms]` reads as "that took too long, take smaller steps" — and that is
       * what it got. Live, on a turn watching a CI run: `sleep 45; <check>` was killed here, and the
       * model's next four calls were the same poll with a shorter sleep. It never reached for
       * `background: true`, which was the only thing that would have worked, because nothing in the
       * failure mentioned it. Same shape as an UNAVAILABLE skill: a dead end that names no way
       * forward is read as a dead end.
       */
      // …but only when longer would help. A follow or a monitor never ends, and a hung connection
      // stays hung: pushed into the background, both run until somebody kills them.
      if (result.timedOut) parts.push(timeoutAdvice(timeoutMs, command.argv, result.activity, ctx.askedBy));
      if (result.aborted) parts.push("[killed when the turn ended]");
      if (parts.length === 0) parts.push(`[no output, exit code ${result.exitCode ?? "killed"}]`);
      if (result.oomKills) parts.push(oomKillNote(result.oomKills));
      // One line at a wall agents used to improvise around — see `exec-hints.ts` for why this is read
      // from the output whatever the exit code says.
      const hint = execHint(captured.spooled ? captured.excerpt : `${captured.stdout}\n${captured.stderr}`, result.exitCode);
      if (hint) parts.push(hint);
      const swapped = printed?.note();
      if (swapped) parts.push(swapped);

      return {
        content: parts.join("\n"),
        ...(captured.spooled ? { spooled: captured.output } : {}),
        isError: result.timedOut || result.aborted === true || (result.exitCode !== null && result.exitCode !== 0) || Boolean(result.oomKills),
        metadata: {
          argv: command.argv,
          cwd: cwd.path,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          ...(result.oomKills ? { oomKills: result.oomKills } : {}),
          ...(result.activity ? { activity: result.activity } : {}),
          ...(result.aborted ? { aborted: true } : {}),
          // The names it was handed, for its audit row. Never a value.
          ...(handed.secrets.length ? { secrets: handed.secrets } : {}),
        },
      };
    },
  };
}

/** A result that says which secrets its command was handed — `tool_exec` keeps the names. */
function withSecrets<R extends { metadata?: Record<string, unknown> }>(secrets: readonly string[], result: R): R {
  return secrets.length ? { ...result, metadata: { ...result.metadata, secrets } } : result;
}

/**
 * Re-exported, not re-implemented: the classifier moved to its own file and this is still the
 * address every caller knows. See `exec-background.ts`.
 */
export { shouldAutoBackground } from "./exec-background.ts";

/** Moved to its own file with the shape matcher it needs; this is still the address callers know. */
export { findBlocked };

/**
 * Does this command reach *this* daemon's own CLI, the long way round?
 *
 * There are two doors to the same control surface and they are not equivalent. The `nouride` tool
 * pins `argv[0]` to this install's own binary, runs it from the install directory, injects which
 * agent and chat is asking — which is what the commands that schedule their own way back read — and
 * carries a `stdin` field that is the only argument this daemon never records. Through a shell,
 * the name resolves via `PATH` to whichever install owns the symlink, and a credential has nowhere
 * to go but the argument list, which is kept in the exec grant, the audit table and the log table
 * permanently.
 *
 * Measured before this was written, on the live install: of 336 `exec` calls in the last 500
 * audited actions, exactly one ran a `nouride` binary, and that one was a freshly built artifact in
 * the agent's own checkout. So the shell door was open, worse in four ways, and unused. Closing it
 * costs nothing and makes "may touch this daemon" a line in the tool list rather than something
 * that leaks through the shell.
 *
 * **Steering, not containment.** An agent with a shell can always spell a program name in a way no
 * predicate catches; the hardline classes are what actually stand between it and a dangerous verb,
 * and they are unchanged. What this buys is one obvious door and a refusal that names the other.
 *
 * Scoped by *where the binary is*, not by its name. `nouride` bare is refused because a bare name
 * is exactly the PATH lookup that resolves to the wrong install on a machine running two. A path is
 * refused when it lands outside the agent's own directories — `resolveWithin` follows symlinks, so
 * `/usr/local/bin/nouride` is caught by where it points. A `nouride` the agent built itself, in its
 * own checkout, is its own business: that is the one real call in the audit, and refusing it would
 * be this rule misfiring on work that has nothing to do with the running daemon.
 */
export function reachesOwnCli(argv: string[], roots: readonly string[]): boolean {
  if (isShellScript(argv)) {
    // Every command position in the script, because `sh -lc "nouride status"` is the same door with
    // a shell in front of it. Only at a command position: `cd /opt/projects/nouride && bun test`
    // names the word and runs something else.
    for (const match of argv.slice(2).join(" ").matchAll(/(?:^|[;&|\n(])\s*([^\s;&|)]+)/g)) {
      if (isOwnCli(match[1] ?? "", roots)) return true;
    }
    return false;
  }
  return isOwnCli(argv[0] ?? "", roots);
}

function isOwnCli(word: string, roots: readonly string[]): boolean {
  if (!word.endsWith("nouride")) return false;
  // A bare name is a `PATH` lookup, and which install it finds is not knowable from here.
  if (!word.includes("/")) return true;
  return !roots.some((root) => {
    try {
      resolveWithin(root, word);
      return true;
    } catch {
      return false;
    }
  });
}

/** Said the same way from `gate` and `execute`, because they are the same refusal. */
const OWN_CLI_REFUSAL =
  "That is this daemon's own CLI, and `exec` is not the way to it: use the `nouride` tool, which" +
  ' takes the arguments after the name, as in `{"args": ["status"]}`. It runs the binary belonging to' +
  " this install, tells the daemon which agent and chat is asking, and has a `stdin` field for a" +
  " credential, which `exec` arguments can never be because they are recorded permanently. If you" +
  " do not have the `nouride` tool, you have no access to this daemon's CLI: say so rather than working around it.";

/** Two of the guard's questions as one prompt, both reasons in it — or whichever there is. */
function bothAsks(first: GateAsk | null, second: GateAsk | null): GateAsk | null {
  if (first && second) return { ...first, reason: `${first.reason}, and ${second.reason}` };
  return first ?? second;
}

/** A shell given a script — `bash -lc "…"`, `sh -c "…"` — which reads a handle in it from the environment. */
function readByShell(argv: readonly string[]): boolean {
  return argv.length >= 3 && /^(?:.*\/)?(?:ba|da|z|k)?sh$/.test(argv[0]!) && /^-[a-z]*c$/.test(argv[1]!);
}

export function normalizeCommand(raw: unknown): { argv: string[] } | { error: string } {
  if (Array.isArray(raw)) {
    const argv = raw.map(String).filter((part) => part.length > 0);
    if (argv.length === 0) return { error: "`command` array is empty." };
    return { argv };
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { error: "`command` is empty." };
    // The JSON text of an argv (`"[\"pwd\"]"`), which some models send even for a string schema.
    // Read as the array it is, not handed to bash as a `[` test.
    if (trimmed.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.every((part) => typeof part === "string")) {
          return normalizeCommand(parsed);
        }
      } catch {
        // Not JSON: a shell test like `[ -f x ] && ...`, which the shell handles below.
      }
    }
    if (SHELL_METACHARACTERS.test(trimmed)) return { argv: ["bash", "-lc", trimmed] };
    // No shell syntax at all: split on whitespace and run the program directly, so a plain
    // `git status` is matched against the allowlist as `git`, not as a shell.
    return { argv: trimmed.split(/\s+/) };
  }

  return { error: '`command` must be a shell command string, e.g. "git status && git diff --stat".' };
}



/**
 * The caller's own identity, as the CLI's fallback variables expect to find them.
 *
 * Filtered to exactly three names rather than spread: this value is handed over by a tool, and a
 * passthrough that took any key would be a way to set `PATH` or `LD_PRELOAD` on a child process
 * from inside a tool call. And taken only from the `nouride` tool, which sets it from its own
 * context: from a model's own `exec` call it would be the model saying which chat it calls from.
 */
function callerEnv(value: unknown, ctx: Pick<ToolContext, "ownCliTool">): Record<string, string> {
  if (!ctx.ownCliTool || typeof value !== "object" || value === null) return {};
  const source = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ["NOURIDE_AGENT_ID", "NOURIDE_GATEWAY_ID", "NOURIDE_CHAT_ID"]) {
    const found = source[key];
    if (typeof found === "string" && found !== "") out[key] = found;
  }
  return out;
}

/**
 * The environment a child process gets.
 *
 * `extra` is how a credential reaches a command **without passing through the model**. The value is
 * resolved at call time and handed straight to the child: it is never rendered into the prompt, a
 * tool result or the transcript. That matters more than the filesystem question it looks like — a
 * credential that reaches the context window is in the provider's request log, in the session on
 * disk, and in whatever the model says next.
 *
 * The allowlist is applied last, so an extra cannot replace it. It was the other way round, under a
 * comment that said this: an `exec_secrets` entry named
 * `path` arrives upper-cased as `PATH`, and would have replaced the PATH of every command that agent
 * ran — or `HOME`, or an installer's prefix. Boot warns about such a name (`childEnv` in `index.ts`).
 */
export function buildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value) env[key] = value;
  }
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/**
 * What a command an agent runs gets: the allowlist, the scratchpad as its temporary directory, and
 * `extra` — the agent's `exec_secrets`, the caller's identity. One builder for `exec`, its jobs and
 * `session`, which used to get the allowlist alone: no `TMPDIR`, and none of the agent's credentials.
 */
export function commandEnv(ctx: ToolContext, extra: Record<string, string> = {}): Record<string, string> {
  // Its own HOME and installs over the daemon's — after the allowlist, which would put the daemon's back.
  return { ...buildEnv({ ...NOBODY_AT_THE_KEYBOARD, ...tmpdirEnv(ctx), ...extra }), ...(ctx.ownCliTool ? {} : ownHomeEnv(ctx.privateDir)) };
}

/**
 * Where each agent's commands run as its own user: its folder as HOME, and its own place to install into
 * (`ownUserEnv`). Nothing otherwise — the agents share the daemon's HOME and installs, as before.
 */
export function ownHomeEnv(privateDir: string | undefined): Record<string, string> {
  if (!privateDir || !agentCommandsHaveOwnUsers()) return {};
  const rustup = process.env.HOME ? join(process.env.HOME, ".rustup") : null;
  return ownUserEnv(privateDir, process.env.NOURIDE_PATH ?? process.env.PATH ?? "", rustup && dirExists(rustup) ? rustup : undefined);
}

/**
 * Nobody is at the keyboard of a command an agent runs, so a tool that would stop to ask is told so up front.
 *
 * `apt-get install` of a package with a debconf question, and `git clone` of a repository that wants a password,
 * each wait on a prompt nobody can see: the command sits until the timeout, or a background job holds its slot for
 * an hour, and the agent learns only that it took too long. With these the first fails at once and says why, and
 * the second takes its default. Before `extra`, so a pack that sets either for a reason of its own wins.
 */
const NOBODY_AT_THE_KEYBOARD: Readonly<Record<string, string>> = { DEBIAN_FRONTEND: "noninteractive", GIT_TERMINAL_PROMPT: "0" };

/** Exposed for tests: the sandbox contract is worth asserting on directly. */
export function execEnvAllowlist(): string[] {
  return [...ENV_ALLOWLIST];
}

/**
 * Point a child's temporary files at the agent's scratchpad.
 *
 * The only part of "put throwaway work in the scratchpad" that does not depend on the model going
 * along with it. A prompt can ask; `TMPDIR` decides — `mktemp`, Python's `tempfile`, Node's
 * `os.tmpdir()`, `ffmpeg`, ImageMagick and most of the rest read the environment and write where it
 * points. Without this they write to `/tmp`, and a delete in `/tmp` is `destructive`: hardline, asked
 * every time, and never answerable by `/approvals balanced`. So the default landing spot for a temporary file
 * decided whether the agent could ever clean up after itself.
 *
 * All three spellings, because which one is read is the child's business and not something worth
 * being clever about. `TMPDIR` is POSIX, `TMP`/`TEMP` are what a Windows-aware toolchain looks at.
 *
 * Not set when the context has no scratchpad — a subagent context assembled by hand, a test — and
 * then a child gets exactly the environment it got before.
 */
function tmpdirEnv(ctx: ToolContext): Record<string, string> {
  if (!ctx.scratchpadDir) return {};
  return { TMPDIR: ctx.scratchpadDir, TMP: ctx.scratchpadDir, TEMP: ctx.scratchpadDir };
}

/**
 * Where a command may run.
 *
 * Defaults to the agent's own directory — unchanged behaviour for an agent with no roots declared.
 * A requested `cwd` has to resolve inside one of the roots, checked on the resolved path so `../`
 * and absolute spellings normalize first.
 */
export function resolveCwd(
  raw: unknown,
  ctx: { workspaceDir: string; workspaceRoots: string[] },
): { path: string } | { error: string } {
  if (raw === undefined || raw === null) return { path: ctx.workspaceDir };
  if (typeof raw !== "string") return { error: "`cwd` must be a string." };

  const roots = ctx.workspaceRoots.length > 0 ? ctx.workspaceRoots : [ctx.workspaceDir];
  for (const root of roots) {
    try {
      return { path: resolveWithin(root, raw) };
    } catch {
      // Not under this root — try the next.
    }
  }
  return {
    error: `\`${raw}\` is outside the directories you may use: ${roots.join(", ")}.`,
  };
}

/** The agent's own blocked patterns plus the global ones. Neither can loosen the other. */
function mergedBlocked(options: ExecToolOptions): string[] {
  return [...options.blocked, ...options.policy.blocked];
}

function toExecPolicy(options: ExecToolOptions): ExecPolicy {
  return { blocked: mergedBlocked(options) };
}



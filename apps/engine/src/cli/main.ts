#!/usr/bin/env bun
/**
 * `nouride` — the CLI.
 *
 * Two kinds of command, and the split matters:
 *
 * - **`start`** boots the daemon in this process.
 * - **everything else** talks to a *running* daemon over the control API.
 *
 * The second kind is why the control API exists. A CLI that booted its own daemon to answer
 * `nouride status` would report on a process nobody is using, and `nouride chat` would talk to a
 * second copy with its own gateways — two Telegram bots polling the same token.
 *
 * This file is the dispatch table and nothing else: one `commands/<name>.ts` per command, one
 * `case` per name. `connect()` is called at the call site rather than at the top, so the commands
 * that need no daemon — `nouride help` lists them under *Without a running daemon* — never open one.
 * What each command takes is `grammar.ts`, checked here before any command runs.
 *
 * Shipped as one binary: `bun build --compile` (see `bun run build:binary`).
 */

import type { AckResponse } from "@nouride/cli-kit";
import {
  fileExistsSync,
  isProcessAlive,
  join,
  processCommandLine,
  readTextFileSync,
  removePath,
  signalProcess,
} from "@nouride/runtime";
import { configureLogger, isLogLevel } from "@nouride/shared";
import { loadInstallEnv } from "@/modules/config/global/dotenv.ts";
import { executableRoot } from "@/modules/config/global/paths.ts";
import { keepStoreKeyAside } from "@/boot/secret-store.ts";
import { describeStop, stopDaemon } from "@/cli/stop.ts";
import { dispatchedArgv, hasFlag, crashed, DIM, emit, fail, finish, GREEN, jsonOutput, plain, RESET, say, setJsonOutput, usageError, usageLines, usage, usageFor, lookAtHealth, waitBack } from "@nouride/cli-kit";
import { connect } from "@/cli/connect.ts";
import { loadConfig } from "@/cli/load-config.ts";
import { meantCommand, refuseUnread } from "@/cli/grammar.ts";
import { VERSION } from "@/commons/version.ts";

import { access } from "@/cli/commands/access.ts";
import { agentAction, agentsCommand } from "@/cli/commands/agents.ts";
import { acp } from "@/cli/commands/acp.ts";
import { approvals } from "@/cli/commands/approvals.ts";
import { audit } from "@/cli/commands/audit.ts";
import { chat } from "@/cli/commands/chat.ts";
import { configCmd } from "@/cli/commands/config.ts";
import { toolBudget } from "@/cli/commands/tool-budget.ts";
import { turnBudget } from "@/cli/commands/turn-budget.ts";
import { cron } from "@/cli/commands/cron.ts";
import { doctor } from "@/cli/commands/doctor.ts";
import { gateway } from "@/cli/commands/gateway.ts";
import { provider } from "@/cli/commands/provider.ts";
import { secret } from "@/cli/commands/secret.ts";
import { unsealSecrets } from "@/cli/commands/secret-unseal.ts";
import { decryptSecrets } from "@/cli/commands/secret-decrypt.ts";
import { restoreSecrets } from "@/cli/commands/secret-restore.ts";
import { parseWakeUp, wakeUpUsage } from "@/cli/wake-up.ts";
import { update } from "@/cli/commands/update.ts";
import { rollback } from "@/cli/commands/rollback.ts";
import { gatewayRename } from "@/cli/commands/gateway-rename.ts";
import { db as dbCommand } from "@/cli/commands/db.ts";
import { grants } from "@/cli/commands/grants.ts";
import { jobs } from "@/cli/commands/jobs.ts";
import { mission } from "@/cli/commands/mission.ts";
import { logs } from "@/cli/commands/logs.ts";
import { mcp } from "@/cli/commands/mcp.ts";
import { mcpServerCommand } from "@/cli/commands/mcp-server.ts";
import { pkg } from "@/cli/commands/pkg.ts";
import { tools } from "@/cli/commands/tools.ts";
import { peopleCommand } from "@/cli/commands/people.ts";
import { memoryCommand } from "@/cli/commands/memory.ts";
import { knowledge } from "@/cli/commands/knowledge.ts";
import { policy } from "@/cli/commands/policy.ts";
import { service } from "@/cli/commands/service.ts";
import { sessions } from "@/cli/commands/sessions.ts";
import { turns } from "@/cli/commands/turns.ts";
import { events } from "@/cli/commands/events.ts";
import { skills } from "@/cli/commands/skills.ts";
import { status } from "@/cli/commands/status.ts";
import { users } from "@/cli/commands/users.ts";
import { webhook } from "@/cli/commands/webhook.ts";

/**
 * `nouride stop` — signal the running daemon and wait for it to go.
 *
 * Inline rather than in `commands/`, because it is the one command that reaches the daemon without
 * the control API: it reads the lock file and sends a signal, which is the path that still works
 * when the HTTP server is the thing that has wedged.
 */
async function stop(): Promise<void> {
  const { config } = await loadConfig();
  const lockPath = join(config.daemon.dataDir, "nouride.lock");
  const outcome = await stopDaemon(
    {
      readLock: () => (fileExistsSync(lockPath) ? readTextFileSync(lockPath) : null),
      // `removePath` is already best-effort — a lock that is gone is the outcome either way.
      removeLock: () => removePath(lockPath),
      lockExists: () => fileExistsSync(lockPath),
      isAlive: isProcessAlive,
      commandLine: processCommandLine,
      signal: signalProcess,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    config.daemon.shutdownTimeoutMs,
  );
  const { text, ok, hint } = describeStop(outcome);
  if (!ok) fail(text, hint);
  emit({ stopped: true, note: text });
  return say(`${GREEN}✓${RESET} ${text}`);
}

/** Commands that hold the terminal rather than answer once — there is no one object for `--json` to print. */
function streams(command: string | undefined, args: readonly string[]): boolean {
  return command === "chat" || command === "start" || command === "setup" || ((command === "logs" || command === "events") && hasFlag(args, "-f", "--follow"));
}

async function main(): Promise<void> {
  // `--flag=value` read as `--flag value`, and `--` respected, by every command alike; `--json` is everybody's,
  // so it is taken off before a command reads its arguments.
  const { argv, json } = dispatchedArgv(process.argv.slice(2));
  setJsonOutput(json);
  const [command, ...args] = argv;
  // The secret store's key, which the launcher hands root's commands, out of the environment before anything runs.
  if (command !== "start") keepStoreKeyAside();
  // Stdout is the answer — under `--json`, one object — so what the code a command runs logs goes to stderr, at
  // `warn` unless LOG_LEVEL says otherwise: "database backed up" over `db backup`'s own line is noise. Not `start`,
  // which is the daemon, logging to stdout for the journal.
  if (command !== "start") {
    const level = process.env.LOG_LEVEL;
    configureLogger({ stream: "stderr", level: isLogLevel(level) ? level : "warn" });
  }

  // `nouride <command> --help` answers from the help text instead of running the command with a flag
  // it does not read. See `usageFor`.
  if (command && hasFlag(args, "--help", "-h")) {
    const lines = usageFor(command);
    if (lines) {
      emit({ help: plain(lines) });
      return say(lines);
    }
  }
  if (jsonOutput() && streams(command, args)) {
    usageError(`--json is not available for \`nouride ${command}${command === "logs" || command === "events" ? " -f" : ""}\`: it keeps the terminal rather than answering once.`);
  }
  // Before any command runs — before the daemon is asked anything or a file is written: a flag or a word the command
  // does not read is refused, naming it, rather than dropped. `memory pass --dry-run` ran a real pass, and `agents
  // reload` listed the agents (`cli/grammar.ts`).
  if (command) refuseUnread(command, args, usageFor(command));

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return usage(VERSION);

    case "version":
    case "--version":
      emit({ version: VERSION });
      return say(VERSION);

    case "start": {
      // The install's own `.env`, for the daemon only — the binary no longer reads one from wherever it runs
      // (`config/global/dotenv.ts`). Before the config is read, which it may point somewhere.
      loadInstallEnv(executableRoot());
      // Imported lazily so `nouride chat` does not open the database or bind a port. `index.ts`
      // guards its own auto-boot with `import.meta.main`, so this import does not start anything.
      const { runDaemon } = await import("@/index.ts");
      try {
        await runDaemon();
      } catch (err) {
        crashed(err);
      }
      return;
    }

    case "setup": {
      // Not behind `connect()`. Every command below it talks to a running daemon; this one exists to
      // produce the install that daemon needs, so requiring one would be a loop with no entry.
      const { setup } = await import("@/cli/setup.ts");
      return await setup(args);
    }

    case "service":
      return await service(args);

    case "doctor":
      return await doctor(args);
    // No daemon: it talks to the root package service, which answers whether the daemon is up or not.
    case "pkg":
      return await pkg(args);
    // No daemon: it runs an installer as this user, in the shared folders, and shares what it installed.
    case "tools":
      return await tools(args);

    case "chat":
      return await chat(await connect(), args);
    case "status":
      return await status(await connect());
    case "agents":
      return await agentsCommand(await connect(), args);
    // Started by an editor, not typed: it connects itself, and says nothing on stdout but the protocol.
    case "acp":
      return await acp(args);
    case "agent":
      return await agentAction(await connect(), args);
    case "gateway":
      /**
       * `rename` before `connect()`, deliberately.
       *
       * Every other gateway action asks the daemon. This one rewrites the database the daemon has
       * open and the config it booted from, so it refuses to run while the daemon is up — and
       * connecting first would fail with "cannot reach the daemon" on the very box where the answer
       * is that it is running.
       */
      if (args[0] === "rename") return await gatewayRename(args.slice(1));
      return await gateway(await connect(), args);
    /**
     * Local, all four of them, and grouped rather than split by transport.
     *
     * `restore` replaces the file a running daemon holds open, so it cannot go through the API —
     * and splitting the group would mean the one command that matters at three in the morning
     * behaves unlike the three beside it. See the header of `commands/db.ts`.
     */
    case "db":
      return await dbCommand(args);
    // Local for the same reason, and for the person it is for: they cannot sign in (`commands/users.ts`).
    case "users":
      return await users(args);

    case "provider":
    case "providers":
      return await provider(await connect(), args);
    case "secret":
    case "secrets":
      // Local, before `connect()`: for the box being rebuilt, or the way back, where no daemon runs (0.8.18, 0.8.19).
      if (args[0] === "unseal") return await unsealSecrets(args.slice(1));
      if (args[0] === "decrypt") return await decryptSecrets(args.slice(1));
      if (args[0] === "restore") return await restoreSecrets(args.slice(1));
      return await secret(await connect(), args);

    case "approvals":
      return await approvals(await connect(), args);

    case "grants":
      return await grants(await connect(), args);

    case "people":
      return await peopleCommand(await connect(), args);
    case "memory":
      return await memoryCommand(await connect(), args);
    case "knowledge":
      return await knowledge(await connect(), args);
    case "access":
      return await access(await connect(), args);

    case "jobs":
      return await jobs(await connect(), args);
    case "mission":
      return await mission(await connect(), args);
    case "cron":
      return await cron(await connect(), args);
    case "webhook":
    case "webhooks":
      return await webhook(await connect(), args);
    case "skills":
      return await skills(await connect(), args);
    // No daemon needed: the classifier is a pure function, and asking "would this be gated" should
    // work when the daemon is down — which is exactly when somebody is debugging a refusal.
    case "policy":
      return await policy(undefined as never, args);
    case "audit":
      return await audit(await connect(), args);
    case "logs":
      return await logs(await connect(), args);
    case "mcp":
      return await mcp(await connect(), args);
    case "mcp-server":
      return await mcpServerCommand(await connect(), args);
    case "sessions":
      return await sessions(await connect(), args);
    case "turns":
      return await turns(await connect(), args);
    case "events":
      return await events(await connect(), args);
    case "config":
      return await configCmd(args);
    case "tool-budget":
      return await toolBudget(await connect(), args);
    case "turn-budget":
      return await turnBudget(await connect(), args);

    /**
     * Ordered next to `restart` because it is the other command that ends the process, and it
     * keeps the same `--then` contract for the same reason.
     */
    case "update":
      // Local, like `db restore`: it replaces what a running daemon holds open.
      if (hasFlag(args, "--rollback")) return await rollback(args);
      return await update(await connect(), args);

    case "stop":
      return await stop();

    case "restart": {
      /**
       * The contract `update` has (`commands/update.ts`): the daemon restarts once nothing is running —
       * `--now` skips the wait — and an agent says with `--then` what happens when it is back. The follow-up
       * is written before the restart and armed as the process ends, so `--in` counts from the restart and a
       * refused restart leaves no wake-up behind (`modules/update/restart.ts`).
       *
       * Only an agent has to say what happens after: its `nouride` tool carries `NOURIDE_AGENT_ID`, so a call
       * without one was typed by a person, who is watching. `--no-then` is still accepted from either.
       */
      const wake = parseWakeUp(args, "restarting the daemon");
      if (!wake && !hasFlag(args, "--no-then") && process.env.NOURIDE_AGENT_ID) {
        usageLines(
          wakeUpUsage(
            "nouride restart",
            'nouride restart --then "check every gateway reconnected and report anything that did not"',
          ),
        );
      }
      const client = await connect();
      // Looked at first, so the wait can tell the process that comes back from the one asked to go.
      const before = hasFlag(args, "--wait") ? await lookAtHealth(client.baseUrl) : null;
      const result = await client.post<AckResponse & { wake_in_seconds?: number }>("/restart", {
        ...(hasFlag(args, "--now") ? { now: true } : {}),
        ...(hasFlag(args, "--force") ? { force: true } : {}),
        ...(wake
          ? { then: wake.message, agent_id: wake.agentId, gateway_id: wake.gatewayId, chat_id: wake.chatId, in_seconds: wake.delaySeconds }
          : {}),
      });
      say(`${GREEN}✓${RESET} ${result.note}`);
      if (result.wake_in_seconds) say(`${DIM}a turn is scheduled ${result.wake_in_seconds}s after the restart to pick this up${RESET}`);
      if (before) await waitBack(before, client.baseUrl);
      return;
    }

    default: {
      const meant = meantCommand(command);
      usageError(`Unknown command "${command}".`, meant ? `Did you mean \`nouride ${meant}\`? \`nouride help\` lists every command.` : "Run `nouride help`.");
    }
  }
}

// Every way out prints the envelope under `--json`: a throw nothing above caught is a failure, said as one, rather
// than an empty stdout and a stack trace — what a script or an agent's tool cannot read.
await main().catch(crashed);
finish();

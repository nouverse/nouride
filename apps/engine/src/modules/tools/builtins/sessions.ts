/**
 * Processes that stay open, so the agent can answer a prompt.
 *
 * `exec` runs a program with stdin closed and hands back what it printed. That covers most work —
 * `ssh host kubectl get pods` is one command and one answer — and it cannot cover the shape where the
 * program asks something back: a `sudo` password, an ssh host-key confirmation, a REPL, an installer
 * that wants `y`. Those are the moments where `exec` looks like a hang, because the program is waiting
 * on input that will never arrive and the timeout is the only thing that ends it.
 *
 * ## What this is not
 *
 * **A terminal, where one can be had.** On Linux the child gets a real pty by way of `script(1)`, so
 * `isatty` passes and `kubectl exec -it`, colours and curses programs work. On macOS the BSD `script` gives
 * one too, fed through a pipe (`process-terminal.ts`). Where there is no `script`, the session falls back to
 * pipes — and says so, rather than letting the agent discover it through a program behaving oddly.
 *
 * Neither path needs a native module, which is what keeps the runtime adapter portable (TD-001).
 *
 * ## Why every send asks
 *
 * A session is a live process accepting arbitrary input. Approving `ssh prod` once and then letting
 * the agent type freely into it would be a worse gate than `exec` has, not a better one — the whole
 * point of the exec gate is that a human sees each command. So `start` and `send` are both gated and
 * both show what they are about to do; `read`, `list` and `close` are not, because none of them can
 * change anything.
 *
 * Gated at every approval level but `trusted`, which is the property that was missing: both carry the
 * `interactive` class, and auto-approval never covers it — see `interactiveAsk`.
 */

import {
  createLogger,
  newId,
  type GateAsk,
  type GateDecision,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@nouride/shared";
import { classifyHardline, classifyOwnState } from "@nouride/policy";
import { agentCommandsHaveOwnUsers, spawnInteractive, type InteractiveProcess } from "@nouride/runtime";
import type { TransientSecrets } from "@nouride/secrets";
import { ownSecretCommandRefusal, ownSecretNamed } from "@/modules/tools/credential-files.ts";
import { printedOutput, printedSource, type PrintedSource } from "@/modules/tools/credential-output.ts";

const log = createLogger("tools.sessions");

/** Per agent. A session is a held process; an agent that wants many has lost track of them. */
const MAX_SESSIONS_PER_AGENT = 3;

/**
 * How long to wait for a program to say something, and how long of nothing counts as "done for now".
 *
 * A fixed sleep was the first version and it is a race: under load the echo had not arrived within it,
 * so the answer was "(no output)" for a command that worked. Caught by the suite failing only when run
 * with everything else. Waiting *until output stops* instead is both faster in the common case — a
 * prompt appears in milliseconds — and correct in the slow one.
 *
 * The no-output timeout is deliberately short. Plenty of programs say nothing until spoken to (`cat`,
 * a REPL waiting on its first line), and blocking for seconds on every one of those would make an
 * exchange feel broken. Something slow to answer is what `read` is for — the agent asks again, which
 * costs one cheap ungated call rather than holding the turn.
 */
const FIRST_OUTPUT_TIMEOUT_MS = 500;
const QUIET_MS = 150;
const POLL_MS = 25;

/**
 * `wait` — the action the tool was missing, and the reason an agent was running `sleep`.
 *
 * `send` returns after 500ms of silence and `read` returns instantly, which is right for a REPL and
 * useless for a build. Nothing here waited, so on 2026-09-04 an agent driving a Remotion render over
 * an interactive PowerShell reached for the only wait it had: `exec ["sleep","30"]`. `exec` is capped
 * at exactly `tool_timeout_ms` — 30_000 — so `sleep 30` finished at 30001ms and was killed as a
 * failure. Three times, all `error: true`, each burning an iteration and a tenth of the turn's clock
 * on a wait that reported itself as broken.
 *
 * The cap does not apply here: `tool_timeout_ms` is handed to `createExecTool` and to nothing else,
 * so this action can honestly wait minutes. `ctx.signal` is what bounds it — the turn deadline, or
 * somebody pressing stop — rather than a number of its own choosing.
 *
 * Quiet is two seconds rather than 150ms because that is what separates the two jobs. A prompt
 * appearing is an exchange; a renderer printing frame counts for four minutes and then stopping is a
 * job finishing, and 150ms of silence happens constantly in the middle of one.
 */
const WAIT_QUIET_MS = 2_000;
const WAIT_DEFAULT_MS = 60_000;
const WAIT_MAX_MS = 600_000;
/**
 * Enough of a build log to diagnose one, and not enough to cost the turn its context.
 *
 * A four-minute wait can collect megabytes, and the whole point of fixing this was a turn that died
 * of context. Hitting the cap ends the wait rather than truncating silently: the process is still
 * running and the agent is told so, so the next `read` picks up where this left off.
 */
const WAIT_MAX_OUTPUT = 64 * 1024;

/** Nothing may be held open forever: a session nobody closed is a process nobody is watching. */
const IDLE_TIMEOUT_MS = 10 * 60_000;

interface Session {
  id: string;
  agentId: string;
  command: string;
  proc: InteractiveProcess;
  startedAt: number;
  lastUsedAt: number;
  /**
   * What it was given prints credentials (`printedSource`) — `ssh box`, then `cat /srv/app/.env` — so what it prints from
   * then on has every value swapped for a handle (`tools/credential-output.ts`). Sticky: the next screen may be that file.
   */
  printed: PrintedSource | null;
}

const sessions = new Map<string, Session>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Collect output until it stops arriving, or until nothing arrives at all.
 *
 * Returns as soon as the program has gone quiet, so an interactive exchange stays interactive. The
 * timeout is only for the case where it says nothing — a program that is thinking, or one that wants
 * input it has not asked for.
 */
async function collect(proc: InteractiveProcess): Promise<string> {
  const deadline = Date.now() + FIRST_OUTPUT_TIMEOUT_MS;
  let out = "";
  let lastArrival = 0;

  for (;;) {
    const chunk = proc.drain();
    if (chunk) {
      out += chunk;
      lastArrival = Date.now();
    }

    if (out) {
      if (Date.now() - lastArrival >= QUIET_MS) return out;
    } else if (Date.now() >= deadline || !proc.running()) {
      // A process that has already exited will produce nothing more, so there is nothing to wait for.
      return proc.drain();
    }

    await sleep(POLL_MS);
  }
}

/**
 * Close anything idle past its welcome.
 *
 * **Idle, not dead.** Removing a session the moment its process exits was the first version, and it
 * threw away the last thing the process said — which on a failure is the entire point: a command that
 * printed an error and quit would come back as "no such session", and the agent would learn nothing
 * about why. A finished session holds no process, only its final output, so it costs a buffer to keep
 * until the idle sweep takes it.
 *
 * Swept on use rather than on a timer: the only thing that cares is the next call, and a timer would
 * be one more thing to stop cleanly at shutdown.
 */
function sweep(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.lastUsedAt > IDLE_TIMEOUT_MS) {
      session.proc.kill();
      sessions.delete(id);
    }
  }
}

function forAgent(agentId: string): Session[] {
  return [...sessions.values()].filter((s) => s.agentId === agentId);
}

function describe(session: Session): string {
  const state = session.proc.running() ? "running" : "exited";
  return `${session.id} · ${state} · ${session.command}`;
}

/** Kill every session. Called from the shutdown sequence — a held process must not outlive the daemon. */
export function closeAllSessions(): number {
  const count = sessions.size;
  for (const session of sessions.values()) session.proc.kill();
  sessions.clear();
  return count;
}

export function activeSessionCount(): number {
  return sessions.size;
}

function ok(content: string, metadata?: Record<string, unknown>): ToolResult {
  return { content, isError: false, ...(metadata ? { metadata } : {}) };
}

function fail(content: string): ToolResult {
  return { content, isError: true };
}

export interface SessionToolOptions {
  /** The command sandbox, shared with `exec` so both agree on what may run and where. */
  resolveCwd: (raw: unknown, ctx: ToolContext) => { path: string } | { error: string };
  normalizeCommand: (raw: unknown) => { argv: string[] } | { error: string };
  /**
   * The environment a session's program gets: `exec`'s own (`commandEnv`), so a session has the same
   * PATH, temporary directory and credentials as a command. It used to get the bare allowlist, which
   * is how a program run in a session could not find what `exec` had just installed.
   */
  env: (ctx: ToolContext) => Record<string, string>;
  /** Blocked patterns, checked exactly as `exec` checks them. */
  findBlocked: (argv: string[]) => string | undefined;
  /** Where a printed credential's handle is held (`tools/credential-output.ts`), as `exec` holds one. */
  heldSecrets?: TransientSecrets;
  /** The values already masked by name — the store's, the agent's own — which keep that mask rather than a handle. */
  known?: (ctx: ToolContext) => Record<string, string>;
}

/**
 * Wait for a running program to stop producing output, exit, or run out of time.
 *
 * Returns why it stopped as well as what it collected, because those need different next moves from
 * the model and it cannot tell them apart from the text: `exited` means read the result, `quiet`
 * means the job is probably done but the shell is still there, `timeout` and `capped` both mean go
 * round again.
 */
async function waitFor(
  session: Session,
  opts: { timeoutMs: number; quietMs: number; signal: AbortSignal },
): Promise<{ output: string; reason: "exited" | "quiet" | "timeout" | "capped" | "cancelled" }> {
  const deadline = Date.now() + opts.timeoutMs;
  let out = "";
  let lastArrival = Date.now();

  for (;;) {
    const chunk = session.proc.drain();
    if (chunk) {
      out += chunk;
      lastArrival = Date.now();
      // Touched as output arrives, not once at the end. `sweep` runs at the top of every tool call
      // and closes anything idle for ten minutes, and a parallel call during a long wait would
      // otherwise kill the process this is waiting on.
      session.lastUsedAt = Date.now();
      if (out.length >= WAIT_MAX_OUTPUT) return { output: out, reason: "capped" };
    }

    if (!session.proc.running()) return { output: out + session.proc.drain(), reason: "exited" };
    // The abort is checked before the clock so a stopped turn says it was stopped. Reporting
    // "timeout" for a turn somebody cancelled sends the reader looking for a slow command.
    if (opts.signal.aborted) return { output: out, reason: "cancelled" };
    if (Date.now() - lastArrival >= opts.quietMs) return { output: out, reason: "quiet" };
    if (Date.now() >= deadline) return { output: out, reason: "timeout" };

    await sleep(POLL_MS);
  }
}

/**
 * `start` and `send` are on the fixed list (`interactive`): what is typed into a running shell is not a command any
 * check sees, so each reaches a person under `careful`, and a durable grant never covers one.
 *
 * When the classifier recognises something more specific in what is about to run or be typed — a delete outside the
 * workspace, this daemon stopped — that class and its reason travel instead, because it is what the person deciding
 * and the audit row both need to read, and because `balanced` asks some of them where it does not ask `interactive`.
 * The daemon's own state counts where the session runs as the daemon's user.
 *
 * `grantable: false`, as always. A durable grant is bound to a command identity, and neither of these
 * has one worth binding: "always allow starting sessions" is a policy change, and "always allow typing
 * into this process" is the gate turned off for whatever the process turns out to be. Offering a
 * button that would be downgraded teaches the operator the prompt lies.
 */
function interactiveAsk(reason: string, argv: string[] | null, cwd?: string): GateAsk {
  const specific = argv ? (classifyHardline(argv) ?? (agentCommandsHaveOwnUsers() ? null : classifyOwnState(argv, cwd))) : null;
  return {
    action: "ask",
    grantable: false,
    hardline: true,
    hardlineClass: specific?.class ?? "interactive",
    reason: specific ? `${reason}: ${specific.reason}` : reason,
  };
}

function clampMs(raw: unknown, fallback: number, max: number): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : fallback;
  return Math.max(POLL_MS, Math.min(max, value));
}

export function createSessionTool(options: SessionToolOptions): Tool {
  /** What a session's output may show: as printed, or — once it was given something that prints credentials — with every value a handle. */
  const shown = (session: Session, text: string, ctx: ToolContext): string => {
    if (!session.printed || !text) return text;
    const printed = printedOutput(session.printed, { held: options.heldSecrets, ctx, known: options.known?.(ctx) ?? {} });
    const filter = printed.filter();
    const out = filter.push(text) + filter.end();
    const note = printed.note();
    return note ? `${out}\n${note}` : out;
  };

  return {
    requiresApproval: true,
    definition: {
      name: "session",
      description:
        "Run a program with its input kept open, for things that prompt: a password, a host-key " +
        "confirmation, a REPL, or anything needing a terminal. The session reports whether it got a " +
        "real terminal; without one, curses programs and `-it` flags will not work. " +
        'Actions: start (command), send (id, input), read (id), wait (id), list, close (id). ' +
        "If a call shows no output, the program may not have printed yet: use read again before " +
        "assuming it said nothing. For something slow (a build, a render, an install), use wait " +
        "rather than sleeping: it returns as soon as the program goes quiet or exits, and it can " +
        "wait up to the turn's deadline, longer than a foreground `exec`. Prefer `exec` when one command and one answer will do.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["start", "send", "read", "wait", "list", "close"],
          },
          command: { type: "array", description: "For start: the argv array." },
          cwd: { type: "string", description: "For start: directory, inside your workspace." },
          id: { type: "string", description: "For send, read, wait and close." },
          input: { type: "string", description: "For send: written verbatim." },
          newline: {
            type: "boolean",
            description: "For send: append a newline. Default true.",
          },
          timeout_ms: {
            type: "number",
            description:
              "For wait: give up after this long. Default 60000, max 600000. Waiting past the turn's own deadline is pointless: it stops when the turn does.",
          },
          quiet_ms: {
            type: "number",
            description:
              "For wait: how long of no output counts as finished. Default 2000. Raise it for a program that pauses mid-job, lower it for a chatty prompt.",
          },
        },
        required: ["action"],
      },
    },

    /**
     * Gate `start` and `send`; let the rest through.
     *
     * `read`, `list` and `close` cannot change anything outside the session, and asking about them
     * would spend an approval on a question with one sensible answer — which is how a gate stops being
     * read (§ the approval prompt was unreadable).
     */
    gate(args, ctx): GateDecision {
      const action = typeof args.action === "string" ? args.action : "";
      if (action === "start") {
        const command = options.normalizeCommand(args.command);
        const argv = "argv" in command ? command.argv : null;
        const cwd = options.resolveCwd(args.cwd, ctx);
        // The store and the control token are refused to a session as to `exec`, at every level (`credential-files.ts`).
        const ownSecret = argv && ownSecretNamed(argv, "path" in cwd ? cwd.path : ctx.workspaceDir, process.env.HOME);
        if (ownSecret) return { action: "refuse", reason: ownSecretCommandRefusal(ownSecret) };
        return interactiveAsk("starts a program and keeps its input open", argv, "path" in cwd ? cwd.path : ctx.workspaceDir);
      }
      if (action === "send") {
        const input = typeof args.input === "string" ? args.input : "";
        // Read as the shell line it most often is. A REPL's input is not one, and the cost of
        // misreading it is a more specific reason on a prompt that was going to be asked anyway.
        const argv = input.trim() ? ["sh", "-c", input] : null;
        const ownSecret = argv && ownSecretNamed(argv, ctx.workspaceDir, process.env.HOME);
        if (ownSecret) return { action: "refuse", reason: ownSecretCommandRefusal(ownSecret) };
        return interactiveAsk("types into a running program", argv);
      }
      return { action: "run", via: "ceiling" };
    },

    async execute(args, ctx) {
      sweep(Date.now());
      const action = typeof args.action === "string" ? args.action : "";

      if (action === "list") {
        const mine = forAgent(ctx.agentId);
        return ok(mine.length === 0 ? "No open sessions." : mine.map(describe).join("\n"), {
          count: mine.length,
        });
      }

      if (action === "start") {
        const mine = forAgent(ctx.agentId);
        if (mine.length >= MAX_SESSIONS_PER_AGENT) {
          return fail(
            `${mine.length} sessions are already open (limit ${MAX_SESSIONS_PER_AGENT}). Close one first: ${mine
              .map((s) => s.id)
              .join(", ")}`,
          );
        }

        const command = options.normalizeCommand(args.command);
        if ("error" in command) return fail(command.error);

        const blocked = options.findBlocked(command.argv);
        if (blocked) return fail(`Command blocked by this agent's configuration: "${blocked}".`);

        const cwd = options.resolveCwd(args.cwd, ctx);
        if ("error" in cwd) return fail(cwd.error);

        let proc: InteractiveProcess;
        try {
          proc = spawnInteractive(command.argv, { cwd: cwd.path, env: options.env(ctx), agent: ctx.agentId });
        } catch (err) {
          return fail(`Could not start it: ${String(err instanceof Error ? err.message : err)}`);
        }

        const id = newId("ses");
        const now = Date.now();
        sessions.set(id, {
          id,
          agentId: ctx.agentId,
          command: command.argv.join(" "),
          proc,
          startedAt: now,
          lastUsedAt: now,
          printed: printedSource(command.argv),
        });

        // Wait for the prompt before answering. Without this the first read is almost always empty and
        // the model sends into a program that has not asked anything yet.
        const output = shown(sessions.get(id)!, await collect(proc), ctx);

        log.info("session started", {
          agent_id: ctx.agentId,
          session: id,
          pid: proc.pid,
          tty: proc.tty,
        });
        return ok(
          [
            `Session ${id} started (pid ${proc.pid})`,
            // Stated up front. An agent that assumes a terminal will reach for `-it` and read the
            // refusal as the remote host's fault.
            proc.tty ? " with a terminal." : " without a terminal, so curses programs will not work.",
            output ? `\n${output}` : "\n(no output yet)",
          ].join(""),
          { session: id, pid: proc.pid, tty: proc.tty },
        );
      }

      const id = typeof args.id === "string" ? args.id : "";
      const session = sessions.get(id);
      if (!session) return fail(`No session "${id}". Use action "list" to see the open ones.`);
      if (session.agentId !== ctx.agentId) return fail(`No session "${id}".`);
      session.lastUsedAt = Date.now();

      if (action === "close") {
        session.proc.kill();
        sessions.delete(id);
        return ok(`Session ${id} closed.`);
      }

      if (action === "read") {
        const output = shown(session, session.proc.drain(), ctx);
        const running = session.proc.running();
        // Said explicitly. "(nothing new)" from a process that has ended reads as "still working",
        // which is the state this tool exists to make distinguishable.
        const suffix = running ? "" : "\n[the process has exited]";
        return ok(`${output || "(nothing new)"}${suffix}`, { running });
      }

      if (action === "send") {
        if (typeof args.input !== "string") return fail("`input` must be a string.");
        if (!session.proc.running()) {
          // Reported rather than silently swallowed: writing to a dead process throws on some
          // platforms and does nothing on others, and either way the model would wait for a reply
          // that cannot come.
          const tail = shown(session, session.proc.drain(), ctx);
          sessions.delete(id);
          return fail(`Session ${id} has exited.${tail ? `\n${tail}` : ""}`);
        }

        // Read with the session's own command in front, so `ssh box` there names the host the file is on.
        if (printedSource([args.input])) session.printed = printedSource([session.command, args.input]);
        try {
          session.proc.write(args.newline === false ? args.input : `${args.input}\n`);
        } catch (err) {
          return fail(`Could not write to it: ${String(err instanceof Error ? err.message : err)}`);
        }

        const output = shown(session, await collect(session.proc), ctx);
        return ok(output || "(no output)", { running: session.proc.running() });
      }

      if (action === "wait") {
        if (!session.proc.running()) {
          const tail = shown(session, session.proc.drain(), ctx);
          sessions.delete(id);
          return ok(`Session ${id} has already exited.${tail ? `\n${tail}` : ""}`, {
            running: false,
          });
        }

        const timeoutMs = clampMs(args.timeout_ms, WAIT_DEFAULT_MS, WAIT_MAX_MS);
        const result = await waitFor(session, {
          timeoutMs,
          quietMs: clampMs(args.quiet_ms, WAIT_QUIET_MS, timeoutMs),
          signal: ctx.signal,
        });

        const running = session.proc.running();
        if (!running) sessions.delete(id);
        // Said in words, because the four endings need four different next moves and the collected
        // text looks the same in all of them.
        const note = {
          exited: "[the process has exited]",
          quiet: "[it has gone quiet but is still open: send again or close it]",
          timeout: `[still running after ${Math.round(timeoutMs / 1000)}s: wait again or read]`,
          capped: "[stopped collecting at 64KB, still running: read again for the rest]",
          cancelled: "[the turn was stopped, so this wait was cut short. The process is still running]",
        }[result.reason];
        return ok(`${shown(session, result.output, ctx) || "(nothing new)"}\n${note}`, {
          running,
          reason: result.reason,
        });
      }

      return fail('`action` must be one of: start, send, read, wait, list, close.');
    },
  };
}

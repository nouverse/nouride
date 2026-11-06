import type { ApprovalsResponse, MessageResponse, StatusResponse } from "@/cli/wire.ts";
import { openLinePrompt, resolve } from "@nouride/runtime";
import { createApprovalPoller } from "@/cli/approvals.ts";
import { MARKS, followChat } from "@/cli/chat-follow.ts";
import { formatActivityLine } from "@/cli/activity-view.ts";
import { LOCAL_GATEWAY_ID } from "@/modules/gateways/local.ts";
import { renderPreview } from "@/cli/preview-view.ts";
import { BOLD, CYAN, DIM, GREEN, RESET, YELLOW, fail, say, usageError } from "@/cli/ui.ts";
import { decisionFromAnswer } from "./approvals.ts";
import type { Client } from "@/cli/client.ts";

/**
 * Interactive chat against a running daemon.
 *
 * The whole point of this command: an end-to-end test that needs no Discord or Telegram token.
 * Messages go through the real `local` gateway, so routing, hooks, the queue, the tool loop and
 * session persistence all run exactly as they would for a chat platform.
 */
export async function chat(client: Client, args: string[]): Promise<void> {
  const agent = args[0];
  /**
   * A flag is never an agent id, so it is refused instead of becoming one.
   *
   * `nouride chat --help` used to open a chat "addressing: --help" and wait on stdin. Over ssh that
   * stdin never closes, so each attempt left a process on the live box, and three were found there
   * still waiting days later. `--help` itself is answered before this, in `main.ts`.
   */
  if (agent?.startsWith("-")) {
    usageError(`\`nouride chat\` takes an agent id, not ${agent}.`, "nouride chat [agent], or `nouride agents` for the ids.");
  }
  const chatId = `cli-${process.pid}`;

  const status = await client.get<StatusResponse>("/status");
  const active = status.agents.filter((a) => a.enabled && a.state === "running");

  if (active.length === 0) {
    fail(
      "No agent is running, so nothing would answer.",
      "Add one under agents/ and enable it, then `nouride agents` to check.",
    );
  }

  // Piped stdin cannot answer a prompt. Detected rather than assumed, because a script driving
  // this command is a first-class use — it is how an end-to-end test talks to the daemon — and
  // trying to prompt anyway crashed with ERR_USE_AFTER_CLOSE at EOF.
  const interactive = Boolean(process.stdin.isTTY);

  say(`${BOLD}nouride chat${RESET} ${DIM}→ ${client.baseUrl}${RESET}`);
  say(`${DIM}agents: ${active.map((a) => a.id).join(", ")}${RESET}`);


  if (agent) say(`${DIM}addressing: ${agent}${RESET}`);
  say(`${DIM}session: ${chatId} · slash commands work · /attach <path> [text] sends a file · /quit to leave${RESET}`);
  if (!interactive) {
    say(`${DIM}non-interactive: approvals are printed, not prompted${RESET}`);
  }
  say();

  const rl = openLinePrompt();
  let closed = false;
  rl.onClose(() => {
    closed = true;
  });

  /**
   * Answer approvals that appear while a turn is in flight.
   *
   * Safe to share the readline with the main prompt only because the main loop is *awaiting the
   * POST* at this point, not reading — and `closed` plus the try/catch cover the boundary where
   * the two could still overlap.
   */
  const approvals = createApprovalPoller({
    fetchPending: async () => {
      const data = await client.softGet<ApprovalsResponse>("/approvals").catch(() => null);
      return data?.pending ?? null;
    },
    ask: async (request) => {

      finishCurrentLine();
      say();
      say(`${YELLOW}⚠ approval needed${RESET} ${BOLD}${request.tool}${RESET} ${DIM}(${request.id})${RESET}`);
      if (request.reason) say(`${DIM}  ${request.reason}${RESET}`);
      // A summary, not the arguments. Printing a `write`'s content meant a whole file scrolled past and
      // the operator answered without reading it — a gate nobody reads is a gate that is off.
      for (const line of renderPreview(request.preview, request.params)) say(line);

      if (!interactive || closed) {
        // Left pending on purpose: it will time out as a denial, which is the safe default, and
        // the operator is told exactly how to answer it instead.
        say(`${DIM}  answer it with: nouride approvals allow-once ${request.id}${RESET}`);
        return;
      }

      let answer: string;
      try {
        // `a` is offered only when it would do something. A prompt that lists an option the
        // daemon will silently downgrade teaches the operator that the prompt lies.
        const options = request.grantable ? "[y]es / [a]lways / [N]o" : "[y]es / [N]o";
        answer = await rl.ask(`${YELLOW}approve? ${options} ${RESET}`);
      } catch {
        // stdin ended while we were asking. Leaving the request pending is correct — it expires
        // as a denial rather than being approved by an absent human.
        say(`${DIM}  input closed; left pending${RESET}`);
        return;
      }

      const decision = decisionFromAnswer(answer, request.grantable === true);
      await client.post(`/approvals/${request.id}/${decision}`);
      if (decision === "allow-always") {
        say(`${DIM}  remembered (nouride grants to review)${RESET}`);
      }
    },
  });
  const handleApprovals = () => approvals.poll();

  /**
   * Print what the agent is doing while it does it.
   *
   * A 21-second turn used to show a blank screen and then an answer. The daemon knew it was reading a
   * file and calling a provider; none of it reached the person waiting, and a long silence is
   * indistinguishable from a hang.
   *
   * From the conversation's event stream (`chat-follow.ts`): this chat on the local gateway, and nothing
   * of any other — a helper's and a peer's steps included, marked as theirs.
   */
  const activity = followChat({
    open: (path) => client.open(path),
    gatewayId: LOCAL_GATEWAY_ID,
    chatId,
    drawing: () => awaiting || settling,
    notice: (line) => {
      finishCurrentLine();
      say(`${DIM}  (${line})${RESET}`);
    },
    draw: (event) => {
      // `▸` something the agent is doing, `│` something it is thinking, `·` a result or a remark — `MARKS`.
      const how = MARKS[event.kind as keyof typeof MARKS] ?? "said";
      const settled = how === "said";
      const mark = `${DIM}${how === "said" ? "·" : how === "thinking" ? "│" : "▸"}${RESET}`;
      finishCurrentLine();
      // Both already carry everything they have to say, so neither is timed again here.
      current = settled ? null : { prefix: `  ${mark} `, text: event.text, since: Date.now() };
      process.stdout.write(`  ${mark} ${DIM}${event.text}${RESET}`);
      if (current === null) process.stdout.write("\n");
    },
  });

  /**
   * The line being timed, if any.
   *
   * Held rather than printed-and-forgotten so the elapsed time can be revised in place. A step that runs
   * 30 seconds should say so while it is running, which is the whole point — printing the duration only
   * once the step ends tells the operator how long the wait *was*, after they have finished waiting.
   */
  let current: { prefix: string; text: string; since: number } | null = null;

  /** Terminate the timed line, keeping its final elapsed time on screen. */
  const finishCurrentLine = (): void => {
    if (!current) return;
    if (interactive) redrawCurrentLine();
    process.stdout.write("\n");
    current = null;
  };

  const redrawCurrentLine = (): void => {
    if (!current) return;
    // `\r` then clear-to-end-of-line: the line is rewritten, not appended to. Without the clear, a
    // shorter timer string would leave the tail of the longer one behind — `· 10s` becoming `· 9ss`.
    process.stdout.write(
      `\r\x1b[2K${current.prefix}${DIM}${formatActivityLine(current.text, Date.now() - current.since)}${RESET}`,
    );
  };

  /**
   * A message is being answered — and, after it, its turns' last rows are being drawn above the answer. Progress is
   * **not** gated on `closed`: in piped mode stdin ends as soon as the last line is read, while the POST is still in
   * flight, and `closed` means "no more input", not "stop showing what is happening".
   */
  let awaiting = false;
  let settling = false;
  const pollOnce = (): void => {
    if (!awaiting) return;
    // Redrawn on every tick so the timer advances while nothing else is happening — which is exactly the
    // situation the operator could not distinguish from a hang. Only where we own a tty: rewriting a line
    // in a pipe would produce a file full of escape sequences.
    if (interactive) redrawCurrentLine();
    // Not gated on `closed` either, for the same reason and one more: a scripted run that is silently
    // blocked on an approval looks like a hang. `ask` checks `closed` itself and prints how to answer
    // from another shell instead of touching the readline, so it never fights the main prompt for stdin.
    //
    // This is what `nouride chat` in `docs/CLI.md` has claimed all along — piped mode prints approvals
    // instead of prompting — and the gate meant it printed nothing at all.
    // Same reasoning, and this one can genuinely reject: answering an approval POSTs to the daemon, and
    // a connection that drops mid-answer throws out of the poll. The request stays pending and expires
    // as a denial, which is the safe outcome; killing the CLI over it is not.
    void handleApprovals().catch((err: unknown) => {
      say(`${DIM}  approval poll failed: ${String(err)}${RESET}`);
    });
  };
  // The same reasoning once more, for what is not a promise: out of a timer a throw ends the command, and the reply
  // the operator is waiting for with it, over a progress line.
  const poll = setInterval(() => {
    try {
      pollOnce();
    } catch (err) {
      say(`${DIM}  progress poll failed: ${String(err)}${RESET}`);
    }
  }, 1000);

  try {
    for (;;) {
      let text: string;
      try {
        text = (await rl.ask(`${CYAN}you ›${RESET} `)).trim();
      } catch {
        break; // EOF — a piped script that ran out of lines.
      }
      // Not ended by `closed`: a script's input closes while its first message is answered, with its other
      // lines already read — each is still sent, and the ask after the last is the end.
      if (!text) continue;
      if (text === "/quit" || text === "/exit") break;

      // `/attach <path> [text]` — the attachment path, exercised the way a platform would. The control
      // API has taken files all along; a chat that could only send text could not reach that path.
      const attach = /^\/attach\s+(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      const body = attach
        ? { text: attach[2] ?? "", attachments: [{ path: resolve(attach[1]!), mimeType: mimeFor(attach[1]!) }] }
        : { text };

      awaiting = true;
      const started = Date.now();
      let result: MessageResponse;
      try {
        result = await client.post<MessageResponse>("/message", {
        ...body,
        chatId,
        ...(agent ? { agent } : {}),
      });
      } finally {
        awaiting = false;
        // What the turn did in its last moment, drawn above its answer rather than under the next prompt.
        settling = true;
        await activity.settle().catch(() => {});
        settling = false;
        // The timed line is still open and unterminated at this point; anything printed now would land on
        // the end of it.
        finishCurrentLine();
      }

      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      for (const reply of result.replies ?? []) {
        say(`${GREEN}${BOLD}‹${RESET} ${reply}`);
      }
      if (!result.answered) say(`${DIM}‹ (silence) ${result.note ?? ""}${RESET}`);
      say(`${DIM}  ${elapsed}s${RESET}`);
      say();
    }
  } finally {
    clearInterval(poll);
    activity.stop();
    rl.close();
  }
}

/** Enough to tell the daemon what kind of file it is; anything else goes as a document. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
};

function mimeFor(path: string): string {
  return MIME_BY_EXTENSION[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

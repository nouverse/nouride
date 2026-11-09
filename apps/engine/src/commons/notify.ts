/**
 * The daemon's own voice.
 *
 * Everything the *runtime* needs to tell a human — an approval is waiting, a gateway died, a
 * provider is failing — goes through here rather than reaching into the gateway map at each call
 * site. Two reasons, and the second is the one that matters:
 *
 * - Scattered `gateway.send()` calls become impossible to audit for "does the operator actually
 *   find out when this breaks", which is the whole question.
 * - Alerts and turn replies have different failure rules. A reply that fails should surface; an
 *   alert that fails must never take down the thing it was reporting on. Sinking that distinction
 *   in one place means no caller has to remember it.
 *
 * Not a general pub/sub. Two destinations, because there are two questions: "tell the person in
 * this conversation" and "tell whoever owns this daemon".
 */

import {
  type ApprovalPreview,
  type ApprovalRequest,
  clip,
  createLogger,
  type Gateway,
  type MessageButton,
  previewHeadline,
} from "@nouride/shared";
import { escapeMarkdown } from "@nouride/gateways";

const log = createLogger("notify");

export interface ChatTarget {
  gatewayId: string;
  chatId: string;
  /** A message to quote — in a room, what keeps a notice attached to what it answers. */
  replyTo?: string;
}

/** Where daemon-level alerts go when no particular conversation is involved. */
export interface OwnerTarget extends ChatTarget {}

export interface NotifierOptions {
  gateways: Map<string, Gateway>;
  /** Whether a text holds a dashboard link, sent with its preview off: no card of the login page (0.8.11). */
  previewOff?: (text: string) => boolean;
  /**
   * The operator's own chat, from `[alerts]`.
   *
   * Absent is a legitimate configuration — a local-only daemon has the terminal — and then alerts
   * are logged only. It is *not* silently fine on a server, so boot says so once.
   */
  owner?: OwnerTarget | undefined;
  /**
   * Suppression window per alert key.
   *
   * A reconnect loop emits the same failure every few seconds. Without this the alert channel
   * becomes the noisiest thing in the chat and gets muted, which removes the only path by which
   * the operator learns anything.
   */
  alertCooldownMs?: number;
  /**
   * Where each alert's last send is kept, so a restart does not send again what its cooldown was holding back.
   * The map lived in this process alone: an alert sent a minute before a nightly update went out again a minute after.
   */
  cooldowns?: { load(): Record<string, number>; save(at: Record<string, number>): void };
  now?: () => number;
}

export class Notifier {
  private lastAlertAt = new Map<string, number>();

  constructor(private readonly options: NotifierOptions) {
    for (const [key, at] of Object.entries(options.cooldowns?.load() ?? {})) {
      // Only what is still cooling down — and nothing from the future: a clock set back must not silence a kind for good.
      if (at <= this.now && this.now - at < this.cooldownMs) this.lastAlertAt.set(key, at);
    }
    if (this.lastAlertAt.size > 0) log.info("alerts still in their cooldown from before the restart", { keys: [...this.lastAlertAt.keys()] });
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get cooldownMs(): number {
    return this.options.alertCooldownMs ?? 5 * 60_000;
  }

  /**
   * Send into a specific conversation.
   *
   * Best-effort by design: this is used to say "I am waiting on you" and "still working". If that
   * message cannot be delivered, the turn it describes must carry on regardless.
   */
  async toChat(target: ChatTarget, text: string): Promise<boolean> {
    const gateway = this.options.gateways.get(target.gatewayId);
    if (!gateway) {
      log.warn("cannot notify: unknown gateway", { gateway_id: target.gatewayId });
      return false;
    }

    try {
      await gateway.send({ gatewayId: target.gatewayId, chatId: target.chatId, text, ...(target.replyTo ? { replyTo: target.replyTo } : {}), ...(this.options.previewOff?.(text) ? { suppressPreview: true } : {}) });
      return true;
    } catch (err) {
      log.warn("notification failed", { gateway_id: target.gatewayId, error: String(err) });
      return false;
    }
  }

  /**
   * Ask the person in this conversation something: as `toChat`, and the message carries `buttons` where the connection
   * can (`Gateway.buttons`). `text` is told whether they go, so it says how to answer without them. The ids of what
   * was posted and whether it has its buttons — or null when nothing was.
   */
  async ask(target: ChatTarget, text: (buttons: boolean) => string, buttons: MessageButton[]): Promise<{ ids: string[]; buttons: boolean } | null> {
    const gateway = this.options.gateways.get(target.gatewayId);
    if (!gateway) {
      log.warn("cannot ask: unknown gateway", { gateway_id: target.gatewayId });
      return null;
    }
    const carried = gateway.buttons === true && buttons.length > 0;
    try {
      const said = text(carried);
      const ids = await gateway.send({ gatewayId: target.gatewayId, chatId: target.chatId, text: said, ...(carried ? { buttons } : {}), ...(target.replyTo ? { replyTo: target.replyTo } : {}), ...(this.options.previewOff?.(said) ? { suppressPreview: true } : {}) });
      return { ids, buttons: carried };
    } catch (err) {
      log.warn("notification failed", { gateway_id: target.gatewayId, error: String(err) });
      return null;
    }
  }

  /**
   * Rewrite a message sent before, where the connection can (`Gateway.editMessage`) — a mission's one progress line
   * (0.8.7). False where it cannot, or the edit failed: the caller sends a new one, as before.
   */
  async edit(target: ChatTarget, messageId: string, text: string): Promise<boolean> {
    const gateway = this.options.gateways.get(target.gatewayId);
    if (!gateway?.editMessage) return false;
    try {
      return await gateway.editMessage(target.chatId, messageId, text);
    } catch (err) {
      log.warn("could not edit a message", { gateway_id: target.gatewayId, error: String(err) });
      return false;
    }
  }

  /**
   * A question asked with buttons, settled: the message says how, and its buttons go. Best-effort, like every notice.
   * With `keep`, a question still open said again, its buttons under it (`Gateway.settleButtons`).
   */
  async settle(target: ChatTarget, messageId: string, text: string, keep?: readonly MessageButton[]): Promise<boolean> {
    const gateway = this.options.gateways.get(target.gatewayId);
    if (!gateway?.settleButtons) return false;
    try {
      return await gateway.settleButtons(target.chatId, messageId, text, ...(keep ? [keep] : []));
    } catch (err) {
      log.warn("could not settle a question's buttons", { gateway_id: target.gatewayId, error: String(err) });
      return false;
    }
  }

  /**
   * Tell the operator something about the daemon itself.
   *
   * `key` identifies the *kind* of alert for cooldown purposes — `gateway_dead:telegram:nouva`,
   * not the message text, so a changing attempt count does not defeat the suppression.
   *
   * Always logged at warn level even when it cannot be delivered or is suppressed, because the log
   * is the record of what happened and the chat is only a convenience.
   */
  async alert(key: string, text: string): Promise<boolean> {
    const previous = this.lastAlertAt.get(key);
    const since = previous === undefined ? Number.POSITIVE_INFINITY : this.now - previous;
    const cooling = since < this.cooldownMs;
    log.warn("alert", { key, text, ...(cooling ? { held_back_for_ms: this.cooldownMs - since } : {}) });
    if (cooling) return false;

    const owner = this.options.owner;
    if (!owner) return false;

    // Recorded before the send, not after: a slow or failing send must not let a burst through
    // while the first attempt is still in flight.
    this.lastAlertAt.set(key, this.now);
    this.saveCooldowns();
    return await this.toChat(owner, `⚠️ ${text}`);
  }

  /** What is still cooling down, written down for the next process; what is not is forgotten here too. */
  private saveCooldowns(): void {
    if (!this.options.cooldowns) return;
    for (const [key, at] of this.lastAlertAt) if (this.now - at >= this.cooldownMs) this.lastAlertAt.delete(key);
    this.options.cooldowns.save(Object.fromEntries(this.lastAlertAt));
  }

  /** Whether alerts have anywhere to go. Surfaced at boot so a silent channel is not a surprise. */
  get canAlert(): boolean {
    return this.options.owner !== undefined;
  }

  /**
   * Whether this conversation is the one alerts go to.
   *
   * The nearest thing the daemon has to "is the sender the operator": the chat named in `[alerts]` is
   * theirs by definition. Used to put a fix in the reply itself rather than in an alert that would land
   * in the same chat a second later — and, the other way round, to keep configuration advice out of a
   * reply to somebody who cannot act on it.
   */
  isOwnerChat(target: ChatTarget): boolean {
    const owner = this.options.owner;
    return owner !== undefined && owner.gatewayId === target.gatewayId && owner.chatId === target.chatId;
  }
}

/** The shape `approvalPrompt` needs — narrower than the store's notice, so it stays testable. */
export interface ApprovalNoticeLike {
  request: {
    id: string;
    /**
     * Who is asking.
     *
     * Named in the prompt, and it has to be. The request is posted under the asking agent's own bot
     * where it has one — but in a one-to-one chat a peer usually has no bot in the room, so its
     * question arrives wearing the face of the agent the person was talking to. Two questions in a
     * row from two different agents then look like one agent asking twice.
     */
    agentId: string;
    tool: string;
    params: Record<string, unknown>;
    preview?: ApprovalPreview;
  };
  grantable: boolean;
  /** *Always* allows it for a job's runs, not the agent (0.8.0) — the prompt says what it allows. */
  forJob?: boolean;
  reason: string;
  /**
   * How many more questions are waiting behind this one in this conversation.
   *
   * Zero for the ordinary turn, which can only ever have one question open. Non-zero once two agents
   * work at the same time — and then it is the difference between "I answered it, why is nothing
   * happening" and knowing there is a second question coming.
   */
  queuedBehind?: number;
  /**
   * Asked before a restart and kept across it. Said in the first line: the person may already have seen this
   * question, and a second copy that does not say why reads as the agent asking twice.
   */
  kept?: boolean;
  /** The daemon's own line under the question — the hint under `careful`, once a day at most (`careful-hint.ts`). */
  hint?: string;
  /**
   * The mission whose turn asked (0.8.7): named, since its question lands in the chat the mission began in, where the
   * person may be talking to the agent about something else. Its short id and goal.
   */
  mission?: { id: string; goal: string };
  /** The kind of command *Approve similar* would allow for that mission — offered only with one (`missions/similar.ts`). */
  similar?: string;
  /**
   * Only an admin answers it (`approval-answerers.ts`) — said in the question (0.8.10): a person who could not answer it
   * was shown "Tap a button below", and told no only once they tapped.
   */
  adminOnly?: boolean;
  /**
   * The copy put in front of an admin in their own chat, the question waiting in another (0.8.10). Answered by a button
   * or on the dashboard: `/approve` here finds nothing, as it answers only what was asked in the chat it is typed in.
   */
  elsewhere?: boolean;
}

/** How long a command line can get before it stops being readable in a chat bubble. */
const MAX_COMMAND_CHARS = 300;
/** The previews a question in a chat shows instead of the arguments: a change to a file. */
const FILE_PREVIEWS: ReadonlySet<ApprovalPreview["kind"]> = new Set(["edit", "new_file", "overwrite"]);

/**
 * The message a human sees when a tool is waiting on them.
 *
 * Written to be answerable from a phone, in one glance, without opening anything else. That rules
 * out a JSON dump: an operator who cannot read what they are approving either approves blindly or
 * ignores it, and both end with the gate switched off.
 *
 * The full arguments are never truncated away silently — a shortened command is not something
 * anyone can meaningfully approve, so an over-long one is marked as clipped and the id is there to
 * inspect it properly with `nouride approvals`.
 */
export function approvalPrompt(notice: ApprovalNoticeLike, shown: { buttons?: boolean } = {}): string {
  const { request } = notice;
  const from = notice.mission ? `, from mission ${notice.mission.id} (${escapeMarkdown(clipGoal(notice.mission.goal))})` : "";
  const lines = [
    notice.elsewhere
      ? `⏸ **${request.agentId}** is waiting on an admin before running **${request.tool}**${from}. It was asked in another chat, where only an admin can answer it; you are one.`
      : notice.kept
        ? `⏸ **${request.agentId}** is still waiting on you before running **${request.tool}**${from}. It was asked before the daemon restarted, and is still open.`
        : `⏸ **${request.agentId}** is waiting on you before running **${request.tool}**${from}.`,
  ];

  // A file's change by its summary — a write's size, an edit's or a persona's diff — and anything else by its
  // parameters: a command as a terminal shows it, with the folder it runs in, which its summary leaves out. A `write`
  // used to put the whole file in the bubble, which on a phone is a wall of text nobody reads before answering.
  const preview = request.preview && FILE_PREVIEWS.has(request.preview.kind) ? request.preview : null;
  if (preview) {
    lines.push("", previewHeadline(preview));
    if (preview.kind === "edit" && preview.hunk.length > 0) {
      lines.push(
        "```diff",
        // A run of backticks in a line closed the block, and the rest of the change was drawn as the chat's own markdown — a
        // proposal could format its own prompt (0.8.8). A zero-width space between them keeps them text.
        ...preview.hunk.map((line) => `${line.sign} ${line.text.replace(/`(?=`)/g, "`\u200b")}`),
        ...(preview.clipped ? ["… clipped"] : []),
        "```",
      );
    }
  } else {
    const command = describeParams(request.params);
    if (command) lines.push("", "```", command, "```");
  }

  // Free text from outside the daemon — a CLI writes its own title, which the reason carries — is escaped: an underscore
  // or a backtick in it was read as markup and turned the rest of the prompt into italics or code.
  if (notice.reason) lines.push(`Why I am asking: ${escapeMarkdown(notice.reason)}.`);
  if (notice.adminOnly && !notice.elsewhere) lines.push("Only an admin can answer this one.");

  // The bare form first, because it is the one a person can actually type on a phone.
  //
  // The id was the only option offered, and it is 24 hex characters: an operator answering a dozen
  // `write` requests while scaffolding a project mistyped one, got "not waiting for an answer any
  // more", and had to find the right id in a wall of text. `/approve` on its own has always worked
  // when one request is waiting — nothing said so.
  // With buttons under it, the commands still: a client that shows no buttons is answered in words.
  // The copy in an admin's own chat: a button, or the dashboard — `/approve` here would look for a question asked here.
  if (notice.elsewhere) {
    lines.push("", shown.buttons ? "Tap a button below, or answer it on the dashboard's Approvals." : "Answer it on the dashboard's Approvals, or in the chat it was asked in.", `id: \`${request.id}\``);
    return lines.join("\n");
  }
  lines.push(
    "",
    shown.buttons
      ? notice.grantable
        ? notice.forJob
          ? "Tap a button below (**Always for this job** lets this job's runs send there without asking), or answer with `/approve` · `/approve always` · `/deny`"
          : "Tap a button below (**Always** stops asking for this exact command), or answer with `/approve` · `/approve always` · `/deny`"
        : "Tap a button below, or answer with `/approve` · `/deny`\nThis one always asks: it cannot be granted permanently."
      : notice.grantable
        ? notice.forJob
          ? `\`/approve\` · \`/approve always\` to let this job's runs send there without asking · \`/deny\``
          : `\`/approve\` · \`/approve always\` to stop asking for this exact command · \`/deny\``
        : `\`/approve\` · \`/deny\`\nThis one always asks: it cannot be granted permanently.`,
    `\`/approve all\` answers everything waiting`,
  );
  if (shown.buttons && notice.mission && notice.similar) {
    lines.push(`**Approve similar** allows \`${notice.similar}\` commands again for this mission only, until it ends.`);
  }
  if (notice.hint) lines.push(notice.hint);

  // Only when it is true, which for a single turn is never. A person who answers this one and then
  // sees the chat go quiet has no way to know a second agent is parked on a question of its own.
  if (notice.queuedBehind && notice.queuedBehind > 0) {
    lines.push(
      notice.queuedBehind === 1
        ? `_One more question is waiting behind this one._`
        : `_${notice.queuedBehind} more questions are waiting behind this one._`,
    );
  }

  // Inline code, not italics: an id has underscores (`apr_…`), which ended the italic early and showed the rest raw.
  lines.push(`id: \`${request.id}\``);

  return lines.join("\n");
}

/** A mission's goal as a prompt names it: its first line, short. */
function clipGoal(goal: string): string {
  return clip(goal.trim().split("\n")[0]!, 80);
}

/**
 * A prompt once its question is settled: what was decided, by whom where that is known, and what it was about —
 * the buttons gone, so the chat keeps the answer where it kept the question rather than an invitation to press again.
 * `who` is a name a person reads; nobody is named for a request that expired.
 */
export function approvalSettledLine(
  request: Pick<ApprovalRequest, "agentId" | "tool" | "params" | "preview" | "status" | "decision" | "grantable" | "resolvedBy">,
  who?: string,
  /** Its *always* allowed it for a job's runs (0.8.0), not for the agent. */
  forJob = false,
): string {
  const by = who ? ` by ${who}` : "";
  const agent = `**${request.agentId}**`;
  const tool = `**${request.tool}**`;
  const head =
    request.status === "approved"
      ? request.decision === "allow-always" && request.grantable
        ? forJob
          ? `✅ Approved for this job${by}: ${agent} may run ${tool}, and the job's runs send there without asking`
          : `✅ Approved for good${by}: ${agent} may run ${tool}, and is not asked again for it`
        : `✅ Approved${by}: ${agent} may run ${tool}`
      : request.status === "denied"
        ? `🚫 Denied${by}: ${agent} will not run ${tool}`
        : request.resolvedBy === "timeout"
          ? `⌛ Nobody answered in time: ${agent} did not run ${tool}`
          : `⌛ No longer waiting: ${agent} did not run ${tool}`;
  // What it was about, on one short line: the summary a person decided from, else the command.
  const about = (request.preview ? previewHeadline(request.preview) : describeParams(request.params).split("\n")[0]!).replace(/`/g, "'");
  return about ? `${head}\n\`${clip(about, 120)}\`` : head;
}

/**
 * Render tool arguments as one readable line.
 *
 * `exec` gets its argv joined, because that is the form the operator recognises from a terminal;
 * anything else falls back to compact JSON.
 */
function describeParams(params: Record<string, unknown>): string {
  const command = params.command;
  const rendered = Array.isArray(command)
    ? command.map(String).join(" ")
    : typeof command === "string"
      ? command
      : JSON.stringify(params);

  const cwd = typeof params.cwd === "string" ? `\n(in ${params.cwd})` : "";
  const shown = clip(rendered, MAX_COMMAND_CHARS, MAX_COMMAND_CHARS);
  return shown === rendered ? `${rendered}${cwd}` : `${shown} [clipped, see nouride approvals]${cwd}`;
}

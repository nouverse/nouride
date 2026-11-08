/**
 * The approval prompt in a chat, and its buttons.
 *
 * Posted under the asking agent's own name, as it always was, and — on a connection that carries buttons
 * (`Gateway.buttons`) — with Approve and Deny under it, and Always where `/approve always` would be honoured. The text
 * still says how to answer by command, for a client that shows no buttons; WhatsApp, which has none a bridge can rely
 * on, gets the text alone.
 *
 * A press is the command's answer: the same `resolve`, by the same rule for who may answer (`approval-answerers.ts`)
 * and from the conversation the question was asked in. Anybody else's press is refused to them alone and changes
 * nothing. Once a request settles — a press, `/approve`, the dashboard, the CLI, its window running out — its prompt
 * says how and by whom, and its buttons go; a press on one already settled, or one a restart left behind, says so.
 */

import { createLogger, type ApprovalDecision, type ApprovalRequest, type ButtonPress, type Gateway, type MessageButton, type PressAnswer } from "@nouride/shared";
import { approvalPrompt, approvalSettledLine, type ApprovalNoticeLike, type Notifier } from "@/commons/notify.ts";
import { TERMINAL_SENDER } from "@/modules/gateways/local.ts";
import { adminOnly, adminOnlyNotice, mayAnswer } from "./approval-answerers.ts";
import type { Answerer, Settlement } from "./approval.ts";
import type { ApprovalNotice } from "./approvals.store.ts";

const log = createLogger("tools.approval-prompts");

/** What a button answers, by the word its data carries: `approval:<once|always|deny>:<request id>`, well under 64 bytes. */
const DECISIONS: Record<string, ApprovalDecision> = { once: "allow-once", always: "allow-always", deny: "deny", similar: "allow-once" };

/**
 * The buttons under a prompt: Approve; Always only where a standing grant is on offer, as `/approve always` is — for one
 * of a job's guards, *Always for this job*, since that is all it allows (0.8.0); Deny.
 */
export function approvalButtons(notice: Pick<ApprovalNotice, "grantable" | "forJob"> & { request: Pick<ApprovalRequest, "id">; similar?: string }): MessageButton[] {
  const data = (word: string) => `approval:${word}:${notice.request.id}`;
  return [
    { label: "Approve", data: data("once"), style: "positive" },
    // A mission's question with a kind of command (0.8.7, `missions/similar.ts`): yes to this and the ones like it, there.
    ...(notice.similar ? [{ label: "Approve similar from this mission", data: data("similar") }] : []),
    ...(notice.grantable ? [{ label: notice.forJob ? "Always for this job" : "Always", data: data("always") }] : []),
    { label: "Deny", data: data("deny"), style: "negative" },
  ];
}

/** The request and the answer a button carries, or null for one that is not an approval's. */
export function approvalPressed(data: string): { id: string; decision: ApprovalDecision; similar: boolean } | null {
  const match = /^approval:(once|always|deny|similar):(apr_[A-Za-z0-9]+)$/.exec(data);
  return match ? { decision: DECISIONS[match[1]!]!, id: match[2]!, similar: match[1] === "similar" } : null;
}

export interface ApprovalPromptsDeps {
  gateways: Map<string, Gateway>;
  notifier: Pick<Notifier, "ask" | "settle">;
  /** The gate — built after this is, so read when a press or a settlement comes. */
  approvals: () => { get(id: string): ApprovalRequest | null; resolve(id: string, decision: ApprovalDecision, by: Answerer): boolean };
  /** The connection an agent speaks on in a chat: where its prompt goes, and so where a press on it comes from. */
  voice: (agentId: string, gatewayId: string) => string;
  /** An admin by People: in a room, who besides the person who asked may answer. */
  isAdmin: (who: { gatewayId: string; senderId: string }) => boolean;
  /**
   * Where a request asked in a conversation nobody reads is put in front of a person instead — a mission's, whose
   * questions go to the chat it began in (0.8.0). Null for every other request: its own conversation.
   */
  askedIn?: (request: ApprovalRequest) => { gatewayId: string; chatId: string } | null;
  /** The mission whose turn asked, named on its prompt (0.8.7). Null for any other request. */
  missionOf?: (request: ApprovalRequest) => { id: string; goal: string } | null;
  /**
   * *Approve similar from this mission* (0.8.7, `missions/similar.ts`): the kind of command a request is — null where
   * the button is not offered — and the yes that allows that kind for its mission.
   */
  similar?: { kindOf(request: ApprovalRequest): string | null; allow(request: ApprovalRequest): void };
  /**
   * Each admin's own chat (0.8.10): where a question only an admin answers is put in front of them too, when it was asked
   * somewhere else — a family member's chat, a room, a mission's. Absent: only where it was asked, and the dashboard.
   */
  adminChats?: () => { gatewayId: string; chatId: string }[];
}

/** A prompt posted with buttons: where it is. */
interface Posted {
  gatewayId: string;
  chatId: string;
  messageId: string;
  /** What it asked and its buttons, to say it again with another count behind it — a prompt sent as one message only. */
  asked?: { notice: ApprovalNoticeLike; buttons: MessageButton[] };
}

/** Prompts, and names, held at once. The oldest go first: a request settles inside its window, and a restart forgets them. */
const HELD_CAP = 500;

export class ApprovalPrompts {
  /** Each request's prompt with buttons, while it is open. */
  private readonly posted = new Map<string, Posted>();
  /** Who settled each recent request, as a person reads them — what a late press on its prompt is told. */
  private readonly names = new Map<string, string>();
  /** The requests whose *always* allows it for a job, not the agent (0.8.0) — what a press on it is answered with. */
  private readonly forJob = new Map<string, boolean>();
  /** How many wait behind each prompt on screen, as the gate last said (`behind`) — kept for one still being posted. */
  private readonly behindNow = new Map<string, number>();
  /** Each prompt's rewrites, in turn: a count said again must never land after the line that settles it. */
  private readonly rewriting = new Map<string, Promise<unknown>>();
  /** An admin-only request's copies in admins' own chats (0.8.10): answerable there, and settled with it. */
  private readonly copies = new Map<string, Posted[]>();

  constructor(private readonly deps: ApprovalPromptsDeps) {}

  /** A press is this one's when its data is an approval's (`approval:…`) — `gateways/presses.ts` routes it here. */
  owns(data: string): boolean {
    return data.startsWith("approval:");
  }

  /**
   * Into the conversation the turn belongs to — without it the agent stops talking for up to the approval timeout, which
   * reads as a crash — under the asking agent's own name: posted on whichever connection received the trigger, Nexa's
   * question was attributed to Nouva. Not where the gateway's client asks itself: the CLI prompts inline, and a second
   * copy arriving once the turn ends — after the answer — is noise that reads as a bug. An admin-only question's copies
   * go out all the same (0.8.10): the dashboard's chat is such a client, and an operator there cannot answer one.
   */
  async post(notice: ApprovalNotice): Promise<void> {
    log.info("approval waiting for a human", {
      approval: notice.request.id,
      tool: notice.request.tool,
      agent_id: notice.request.agentId,
      grantable: notice.grantable,
      ...(notice.kept ? { kept_across_restart: true } : {}),
    });
    const where = this.where(notice.request);
    const target = { gatewayId: this.deps.voice(notice.request.agentId, where.gatewayId), chatId: where.chatId };
    const mission = this.deps.missionOf?.(notice.request) ?? null;
    // Only where *Always* could be offered: a command that always asks — a hardline one — is not covered by a kind either.
    const similar = mission && notice.grantable ? (this.deps.similar?.kindOf(notice.request) ?? null) : null;
    const shown = { ...notice, ...(mission ? { mission } : {}), ...(similar ? { similar } : {}), ...(adminOnly(notice.request) ? { adminOnly: true } : {}) };
    const buttons = approvalButtons(shown);
    const asksItself = this.deps.gateways.get(notice.gatewayId)?.promptsApprovals === true;
    const sent = asksItself ? null : await this.deps.notifier.ask(target, (carried) => approvalPrompt(shown, { buttons: carried }), buttons);
    // Whether the question reached the chat, said on its own line. "Waiting for a human" above said only that one was
    // asked: a prompt that never arrived looked the same in the journal as one nobody answered (0.7.17, live).
    if (asksItself) {
      log.info("approval prompt left to the gateway, which asks itself", { approval: notice.request.id, gateway_id: notice.gatewayId });
    } else if (sent) {
      log.info("approval prompt sent", { approval: notice.request.id, gateway_id: target.gatewayId, chat_id: target.chatId, messages: sent.ids.length, buttons: sent.buttons });
    } else {
      log.warn("approval prompt not delivered: answer it from the dashboard or with /approve", { approval: notice.request.id, gateway_id: target.gatewayId, chat_id: target.chatId });
    }
    if (notice.forJob) hold(this.forJob, notice.request.id, true);
    // The buttons ride on the last part of what was sent. Held before the copies go out: a press on it while they do
    // must find it, or it was settled twice — by the press's answer, and again below.
    const messageId = sent?.buttons ? sent.ids.at(-1) : undefined;
    if (messageId) hold(this.posted, notice.request.id, { ...target, messageId, ...(sent!.ids.length === 1 ? { asked: { notice: shown, buttons } } : {}) });
    await this.toAdmins(notice.request, shown, buttons, target);
    // Answered while it was being posted — the dashboard lists it at once — so settled now, or its buttons would stay:
    // the copies' too, one posted after the answer settled the rest.
    const now = this.deps.approvals().get(notice.request.id);
    if (now && now.status !== "pending") return this.settled(now, { status: now.status, by: now.resolvedBy ?? "system" });
    // Asked behind while it was being posted: the count it went up with is already out of date.
    if (messageId) this.restate(notice.request.id);
  }

  /**
   * The count behind a prompt on screen changed (`ApprovalStoreOptions.onBehind`): said again in the prompt, its buttons
   * kept. A question asked behind one already shown left that one saying nothing of it (0.8.7, live): answered, the chat
   * went quiet, and the next prompt came 37 minutes later as if from nowhere.
   */
  behind(id: string, count: number): void {
    hold(this.behindNow, id, count);
    this.restate(id);
  }

  /** The prompt rewritten with the count the gate last said, where it was posted whole and says another. */
  private restate(id: string): void {
    const posted = this.posted.get(id);
    const count = this.behindNow.get(id);
    if (!posted?.asked || count === undefined || count === (posted.asked.notice.queuedBehind ?? 0)) return;
    const asked = { ...posted.asked, notice: { ...posted.asked.notice, queuedBehind: count } };
    posted.asked = asked;
    this.rewrite(id, () => this.deps.notifier.settle(posted, posted.messageId, approvalPrompt(asked.notice, { buttons: true }), asked.buttons));
  }

  /** One prompt's rewrites, one after another. */
  private rewrite(id: string, run: () => Promise<unknown>): Promise<unknown> {
    const next = (this.rewriting.get(id) ?? Promise.resolve()).then(run).catch(() => false);
    this.rewriting.set(id, next);
    void next.then(() => this.rewriting.get(id) === next && this.rewriting.delete(id));
    return next;
  }

  /** A request settled, however it was (`ApprovalStoreOptions.onSettled`): its prompt says how, and its buttons go. */
  settled(request: ApprovalRequest, settlement: Settlement): void {
    if (settlement.name) hold(this.names, request.id, settlement.name);
    this.behindNow.delete(request.id);
    const posted = this.posted.get(request.id);
    this.posted.delete(request.id);
    // Its copies in admins' chats too, or their buttons would stay on a question already answered.
    const copies = this.copies.get(request.id) ?? [];
    this.copies.delete(request.id);
    const line = approvalSettledLine(request, this.names.get(request.id), this.forJob.get(request.id) === true);
    for (const one of [...(posted ? [posted] : []), ...copies]) void this.rewrite(request.id, () => this.deps.notifier.settle(one, one.messageId, line));
  }

  /**
   * A question only an admin answers, put in front of each admin in their own chat too (0.8.10) — not the chat it was
   * asked in. Before, it waited where a family member or a room had asked it, and no admin was told. Each copy is said
   * as the asking agent, on that admin's platform; where its own connection cannot reach them, on the one that found
   * them (`adminChats`).
   */
  private async toAdmins(request: ApprovalRequest, shown: ApprovalNoticeLike, buttons: MessageButton[], asked: { gatewayId: string; chatId: string }): Promise<void> {
    if (!adminOnly(request) || !this.deps.adminChats) return;
    // A copy is for a question its asker cannot answer: an admin answers it where they asked, and so does the terminal —
    // `nouride chat` answers anything, through the control token.
    const by = this.deps.approvals().get(request.id)?.requestedBy;
    if (by === TERMINAL_SENDER || (by && this.deps.isAdmin({ gatewayId: request.gateway, senderId: by }))) return;
    const platform = (gatewayId: string) => this.deps.gateways.get(gatewayId)?.platform;
    const copy = { ...shown, elsewhere: true };
    for (const chat of this.deps.adminChats()) {
      if (chat.chatId === asked.chatId && platform(chat.gatewayId) === platform(asked.gatewayId)) continue;
      const voice = this.deps.voice(request.agentId, chat.gatewayId);
      const ask = (gatewayId: string) => this.deps.notifier.ask({ gatewayId, chatId: chat.chatId }, (carried) => approvalPrompt(copy, { buttons: carried }), buttons);
      let on = voice;
      let sent = await ask(voice);
      if (!sent && voice !== chat.gatewayId) {
        on = chat.gatewayId;
        sent = await ask(chat.gatewayId);
      }
      if (!sent) {
        log.warn("an admin-only question could not be put in front of an admin", { approval: request.id, gateway_id: chat.gatewayId, chat_id: chat.chatId });
        continue;
      }
      log.info("an admin-only question put in front of an admin too", { approval: request.id, gateway_id: on, chat_id: chat.chatId });
      const messageId = sent.buttons ? sent.ids.at(-1) : undefined;
      if (messageId) hold(this.copies, request.id, [...(this.copies.get(request.id) ?? []), { gatewayId: on, chatId: chat.chatId, messageId }]);
    }
  }

  /** A press, answered — `Gateway.onPress`. */
  async press(press: ButtonPress): Promise<PressAnswer> {
    const asked = approvalPressed(press.data);
    if (!asked) return { notice: "That button is not one I know any more." };
    const gate = this.deps.approvals();
    const request = gate.get(asked.id);
    if (!request) return { notice: "That request is no longer on record.", settled: "⌛ No longer waiting: this request is no longer on record." };
    // Where it was asked: its conversation, on the connection that raised it or the one its prompt went through — the
    // scope `/approve` keeps, so a request is never answered from a chat that did not see it.
    const where = this.where(request);
    const asker = this.deps.voice(request.agentId, where.gatewayId);
    // Or its copy in an admin's own chat (0.8.10): put there to be answered, by the same rule for who may.
    const copied = this.copies.get(request.id)?.some((one) => one.chatId === press.chatId && one.gatewayId === press.gatewayId) === true;
    if (!copied && (where.chatId !== press.chatId || (press.gatewayId !== where.gatewayId && press.gatewayId !== asker))) {
      return { notice: "That request was not asked here." };
    }
    if (request.status !== "pending") return this.alreadySettled(request, press);
    if (!mayAnswer({ chatType: press.chatType, senderId: press.senderId, isAdmin: () => this.deps.isAdmin(press) }, request)) {
      log.info("a press on an approval by someone who may not answer it", { approval: request.id, sender: press.senderId });
      return { notice: adminOnlyNotice(request) ?? "Only the person who asked, or an admin, can answer this one." };
    }
    // This prompt is settled by the answer to the press; another posted for the same request, by `settled`. A count said
    // again on it, still on its way, lands first — or it would put the buttons back over the answer.
    this.letGo(request.id, press.messageId);
    await this.rewriting.get(request.id);
    const name = press.senderName || press.senderId;
    if (!gate.resolve(request.id, asked.decision, { id: press.senderId, name })) return this.alreadySettled(gate.get(request.id) ?? request, press);
    if (asked.similar) {
      this.deps.similar?.allow(request);
      log.info("commands like this one allowed for its mission", { approval: request.id, actor: press.senderId });
    }
    const now = gate.get(request.id) ?? request;
    log.info("approval answered by a button", { approval: request.id, decision: asked.decision, actor: press.senderId });
    const forJob = this.forJob.get(request.id) === true;
    const notice = asked.similar ? "Approved, and commands like it for this mission, until it ends." : answered(now, asked.decision, forJob);
    return { notice, settled: approvalSettledLine(now, name, forJob) };
  }

  /** The chat a request is put in front of a person in: its own, unless it was asked where nobody reads. */
  private where(request: ApprovalRequest): { gatewayId: string; chatId: string } {
    return this.deps.askedIn?.(request) ?? { gatewayId: request.gateway, chatId: request.chatId };
  }

  /** Settled before this press — answered elsewhere, expired, or pressed twice: said to the presser, and the prompt says how. */
  private alreadySettled(request: ApprovalRequest, press: ButtonPress): PressAnswer {
    this.letGo(request.id, press.messageId);
    const who = this.names.get(request.id);
    const how = request.status === "approved" ? "approved" : request.status === "denied" ? "denied" : request.resolvedBy === "timeout" ? "it expired" : "it is no longer waiting";
    return { notice: `Already settled: ${how}${who && request.status !== "expired" ? ` by ${who}` : ""}.`, settled: approvalSettledLine(request, who) };
  }

  /** This prompt is the one pressed, and the answer to the press rewrites it: nothing else should. */
  private letGo(id: string, messageId: string): void {
    if (this.posted.get(id)?.messageId === messageId) this.posted.delete(id);
    const copies = this.copies.get(id)?.filter((one) => one.messageId !== messageId);
    if (copies) this.copies.set(id, copies);
  }
}

/** What the presser is told: their answer, and when they asked for always and that cannot be, that it was once. */
function answered(request: ApprovalRequest, decision: ApprovalDecision, forJob: boolean): string {
  if (decision === "deny") return "Denied.";
  if (decision === "allow-always" && forJob && request.grantable) return "Approved: this job's runs send there from now on without asking. Its page on the dashboard can take that back.";
  if (decision === "allow-always") return request.grantable ? "Approved: I won't ask again for this exact command." : "Approved, this once: that command always asks.";
  return "Approved.";
}

/** One more entry, the oldest dropped past the cap. */
function hold<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= HELD_CAP) break;
    map.delete(oldest);
  }
}

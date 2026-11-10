/**
 * Durable turns at boot.
 *
 * A journal still here when the daemon starts belongs to a turn whose process died without a signal: a
 * power cut, the OOM killer, `kill -9`. Before anything listens, each one is closed into its
 * conversation the same way a running turn closes when it is cut short (`modules/turns/close.ts`):
 * every call keeps its result, the call that was running is said to be cut off, and the assistant has
 * the last word. Its record is marked `interrupted` — or `done`, when the journal already held the
 * answer and only the settle was lost.
 *
 * What the person is told waits for the gateways, so this returns it rather than sending it.
 *
 * A turn cut off minutes ago is then taken up by itself (`pipeline/restart-resume.ts`). One cut off longer ago is
 * not, and its person is asked whether to carry on, once (`pipeline/resume-ask.ts`): for a turn lost in a crash its
 * report is the question, and for one the last process's shutdown stopped a line of its own asks.
 */

import { isMissionChat } from "@/modules/missions/gateway.ts";
import { cutAsksNotice, worstCut, type CutCall } from "@/modules/turns/cut-calls.ts";
import type { SqliteDb } from "@nouride/runtime";
import { capStoredTurns } from "@/modules/llm/context.ts";
import type { ChatEventsPort } from "@/modules/chat-events/chat-events.store.ts";
import { INBOX_FRESH_MS, InboxStore, type InboxPort } from "@/modules/pipeline/inbox.store.ts";
import { asksAfterCrash, askToCarryOn, postWithContinue, turnsToAsk } from "@/modules/pipeline/resume-ask.ts";
import { turnsToResume } from "@/modules/pipeline/restart-resume.ts";
import { providerResumesOwed } from "@/modules/pipeline/provider-resume.ts";
import type { Pipeline } from "@/modules/pipeline/index.ts";
import type { EventsPort } from "@/modules/events/events.store.ts";
import { DeliveryStore, type DeliveryPort } from "@/modules/turns/delivery.store.ts";
import { TurnJournalStore } from "@/modules/turns/journal.store.ts";
import { deliverUndelivered } from "./delivery.ts";
import { announceInterrupted } from "./interrupted.ts";
import { estimateMessagesTokens } from "@nouride/llm";
import { createLogger, messageText, type ApprovalRequest, type ChatMessage } from "@nouride/shared";
import type { Notifier } from "@/commons/notify.ts";
import type { SessionsPort } from "@/modules/sessions/sessions.store.ts";
import { closeTurn, interruptionReport, type Onward } from "@/modules/turns/close.ts";
import type { TurnJournalPort } from "@/modules/turns/journal.store.ts";
import { SCHEDULED, type TurnRecord, type TurnsPort } from "@/modules/turns/turns.store.ts";

const log = createLogger("daemon");

/** One turn a dead process left behind, closed. */
export interface RecoveredTurn {
  turnId: string;
  gatewayId: string;
  chatId: string;
  kind: "chat" | "job";
  /** When it was cut off: the last thing its journal holds — `pipeline/restart-resume.ts` takes up only a recent one. */
  cutAt: number;
  /** The calls that were running when it was cut off, as they were made — what taking it up reads (`turns/cut-calls.ts`). */
  cut: CutCall[];
  /**
   * What the person is told once the gateways are up. Null for a job turn — nobody is waiting on it in
   * a chat, and its run record says how it ended — and for a turn whose answer was already written,
   * which is delivered instead (`boot/delivery.ts`).
   */
  report: string | null;
  /** The report asks whether to carry on: cut off too long ago to take up unasked. It goes with Continue under it. */
  asked: boolean;
}

/** `gateway chat`, the key a chat is told apart by here. */
const chatKey = (at: { gatewayId: string; chatId: string }): string => `${at.gatewayId} ${at.chatId}`;

/** The chats with a message waiting from before the restart: its person wrote again, and is answered for that. */
function chatsWaiting(inbox: Pick<InboxPort, "open"> | undefined, receivedBefore?: number): Set<string> {
  return new Set((inbox?.open(receivedBefore) ?? []).filter((row) => row.status === "queued").map(chatKey));
}

/** Close every journal a dead process left behind. Called once, before the pipeline starts. */
export function recoverTurns(input: {
  journal: TurnJournalPort;
  sessions: SessionsPort;
  turns: TurnsPort;
  /** Marks what each closed turn owes its person — the report, or the answer it had written. */
  delivery?: Pick<DeliveryPort, "awaiting">;
  /** What was received and never answered: a chat with a message waiting is not asked about the turn before it. */
  inbox?: Pick<InboxPort, "open">;
  atomically: <T>(work: () => T) => T;
  maxTurns: number;
  now?: number;
}): RecoveredTurn[] {
  const recovered: RecoveredTurn[] = [];
  const now = input.now ?? Date.now();
  const waiting = chatsWaiting(input.inbox);
  for (const turn of input.journal.unsettled()) {
    const { head } = turn;
    const key = { agentId: head.agentId, chatId: head.chatId, gatewayId: head.gatewayId };
    const closed = closeTurn(turn.entries, { kind: "restart" }, { complete: turn.complete });
    const record = head.kind === "chat" ? input.turns.get(turn.turnId) : null;
    const question = turn.entries.find((entry): entry is { message: ChatMessage } => "message" in entry)?.message;
    const prompt = record?.prompt ?? (question ? messageText(question.content) : "");
    const cutAt = Math.max(record?.startedAt ?? 0, ...turn.entries.flatMap((entry) => ("message" in entry ? [entry.message.timestamp ?? 0] : [])));
    // What the report ends on is what this boot then does with the turn: the two are decided from the same facts.
    const agoMs = now - cutAt;
    const scheduled = record?.cause?.via === SCHEDULED;
    const left = scheduled || isMissionChat(head) || waiting.has(chatKey(head));
    const asked = closed.answer === undefined && record?.status === "running" && !left && asksAfterCrash({ agoMs, chatId: head.chatId, scheduled });
    const onward: Onward = asked
      ? { kind: "asked", agoMs }
      : agoMs > INBOX_FRESH_MS
        ? { kind: "kept", agoMs }
        : left || worstCut(closed.cutCalls)?.kind === "asks"
          ? { kind: "kept" }
          : { kind: "now" };
    const report = closed.answer === undefined ? interruptionReport(closed, prompt, onward) : null;

    input.atomically(() => {
      const history = input.sessions.load(key).messages;
      const kept = capStoredTurns([...history, ...closed.messages], input.maxTurns);
      if (kept.length > 0) input.sessions.save(key, kept, estimateMessagesTokens(kept));
      input.journal.clear(turn.turnId);
      if (record?.status === "running") {
        input.turns.finish(
          turn.turnId,
          closed.answer === undefined
            ? { status: "interrupted", reply: report ?? "", error: "the daemon restarted while this turn was running" }
            : { status: "done", reply: closed.answer },
        );
        input.delivery?.awaiting(turn.turnId);
        // The question is in the report: marked with it, so no later boot asks again or takes the turn up unasked.
        if (asked) input.turns.markResumeAsked(turn.turnId, now);
      }
    });

    log.info("closed a turn the last process left unfinished", {
      turn_id: turn.turnId,
      kind: head.kind,
      chat_id: head.chatId,
      answered: closed.answer !== undefined,
      done: closed.done.length,
      cut_off: closed.cut.length,
      not_started: closed.notStarted.length,
      ...(turn.complete ? {} : { journal: "incomplete" }),
    });
    recovered.push({ turnId: turn.turnId, gatewayId: head.gatewayId, chatId: head.chatId, kind: head.kind, cutAt, cut: closed.cutCalls, report: head.kind === "chat" ? report : null, asked });
  }
  return recovered;
}

/**
 * Tell each person whose turn was closed what it had done, once the gateways are up.
 *
 * One message per turn, not per chat: two agents cut off in one room each say what they had done. Sent
 * however long the daemon was down — a power cut can last the night — where a late answer is dropped after
 * half an hour (`delivery.ts`). Each report that lands is marked delivered, so that pass skips it.
 */
async function announceRecovered(input: { recovered: RecoveredTurn[]; notifier: Pick<Notifier, "toChat" | "ask">; delivery: DeliveryPort }): Promise<number> {
  const reports = input.recovered.filter((turn): turn is RecoveredTurn & { report: string } => turn.report !== null && !turn.chatId.startsWith("cron:"));
  await Promise.all(
    reports.map(async (turn) => {
      // A report that asks goes with Continue under it, where the connection carries buttons.
      const said = turn.asked
        ? await postWithContinue(input.notifier, { id: turn.turnId, gatewayId: turn.gatewayId, chatId: turn.chatId }, turn.report)
        : await input.notifier.toChat({ gatewayId: turn.gatewayId, chatId: turn.chatId }, turn.report);
      if (said) input.delivery.markDelivered(turn.turnId);
    }),
  );
  if (reports.length > 0) log.info("reported turns a restart cut off", { turns: reports.length });
  return reports.length;
}

/**
 * The stores durable turns run on, and the transaction that ties their writes together — the event stream's, so
 * a turn's end written in it reaches a follower only once it is committed, and never when it is rolled back.
 */
export function durableStores(db: SqliteDb, events: Pick<EventsPort, "batch">) {
  return {
    journal: new TurnJournalStore(db),
    inbox: new InboxStore(db),
    delivery: new DeliveryStore(db),
    atomically: <T>(work: () => T): T => events.batch(work),
  };
}

/**
 * What a restart owes, once the gateways are up — in this order, and none of it awaited by the boot:
 *
 * 1. each turn closed from a journal tells its chat what it had done, and a turn left `running` without
 *    one — a build from before the journal — gets the plain notice (`interrupted.ts`);
 * 2. what the last process told its people and never got out goes now (`delivery.ts`), ahead of anything
 *    asked after it — after step 1, so a report sent there is not sent twice;
 * 3. messages it received and never got to are answered when fresh, or told they came in while the
 *    daemon was offline (`InboxDesk.reopen`) — queued ahead of the background jobs the restart killed,
 *    which wake their agents after this (`boot/jobs.ts`);
 * 4. each touched chat's timeline on the dashboard marks where the restart happened. Not in any prompt:
 *    the conversation itself already says what was cut off.
 * 5. a turn the last process's shutdown stopped longer ago than one is taken up unasked has its chat asked whether
 *    to carry on, once (`pipeline/resume-ask.ts`) — after the reports, so a chat never reads the question first.
 *
 * Returns steps 1–2 and 5, which the boot does not wait on and a test does.
 */
export function resumeAfterBoot(input: {
  recovered: RecoveredTurn[];
  orphaned: { turnId?: string; gatewayId: string; chatId: string }[];
  stores: ReturnType<typeof durableStores>;
  /**
   * When this process started. Only what the inbox received before it is the last process's: a message
   * that arrives once the gateways are up is this one's, already on its way, and reading it as left over
   * marked a question being answered as interrupted.
   */
  startedAt: number;
  pipeline: Pick<Pipeline, "inbox" | "resumeTurn" | "resumeLater">;
  /** For the turns a restart cut off, and those a provider ended, which are taken up again — `pipeline/restart-resume.ts`. */
  turns: Pick<TurnsPort, "get" | "interruptedSince" | "startedFor" | "failedSince" | "retryPromisedSince" | "interruptedBetween" | "startedInChatSince" | "markResumeAsked">;
  notifier: Pick<Notifier, "toChat" | "ask">;
  chatEvents: Pick<ChatEventsPort, "record">;
  /** The approvals a turn taken up was cut off waiting on, which the restart kept — said in the words that take it up. */
  keptFor?: (turn: TurnRecord) => ApprovalRequest[];
}): Promise<void> {
  const warn = (what: string) => (err: unknown) => log.warn(`could not ${what}`, { error: String(err) });
  // Chosen first, so a turn taken up again is not also told it is gone and to send it again. Taken up below,
  // after the inbox.
  // A mission's conversation is the mission's to take up — from its page, with what was cut off (`modules/missions/`).
  const now = Date.now();
  const resuming = turnsToResume({ recovered: input.recovered, turns: input.turns, now }).filter((turn) => !isMissionChat(turn));
  // Chosen now too, before anything below starts a turn in these chats: who is asked is decided by what the last
  // process left. Not a mission's, which goes on from its page; not a chat with a message waiting, which is answered.
  const open = input.stores.inbox.open(input.startedAt);
  const waiting = chatsWaiting({ open: () => open });
  const toAsk = turnsToAsk({ turns: input.turns, now }).filter((turn) => !isMissionChat(turn) && !waiting.has(chatKey(turn)));
  const gone = input.orphaned.filter((turn) => !isMissionChat(turn) && !resuming.some((resumed) => resumed.id === turn.turnId));
  if (gone.length > 0) void announceInterrupted({ conversations: gone, notifier: input.notifier }).catch(warn("report interrupted turns"));
  const { delivery } = input.stores;
  const sent = announceRecovered({ recovered: input.recovered, notifier: input.notifier, delivery })
    .then(() => deliverUndelivered({ delivery, notifier: input.notifier }))
    .then(() => {}, warn("send what the last process owed"))
    // On the chat's timeline too: the dashboard reads a chat from its record, and this question is no turn's reply.
    .then(() => askToCarryOn({ toAsk, turns: input.turns, notifier: input.notifier, now, onAsked: (turn, text) => void input.chatEvents.record({ gatewayId: turn.gatewayId, chatId: turn.chatId, audience: "ui", kind: "restart", text }) }))
    .then(() => {}, warn("ask whether to carry on with turns cut off a while ago"));
  const reopened = input.pipeline.inbox.reopen(open);
  if (reopened.redelivered + reopened.stale + reopened.interrupted > 0) log.info("reopened the inbox", { ...reopened });
  // After the inbox, so what was waiting in a chat is answered first, in order, and then the work carries on.
  for (const turn of resuming) {
    const waiting = input.keptFor?.(turn) ?? [];
    // A call the gate asks about, cut off mid-run, is not taken up by itself: a person says whether to go on (0.8.0).
    const cut = worstCut(input.recovered.find((recovered) => recovered.turnId === turn.id)?.cut ?? []);
    if (cut?.kind === "asks") {
      log.info("not taking up a turn cut off in a call the gate asks about", { turn_id: turn.id, agent_id: turn.agentId, tool: cut.call.name });
      void input.notifier.toChat({ gatewayId: turn.gatewayId, chatId: turn.chatId }, cutAsksNotice(turn.agentId, cut.call)).catch(warn("say a cut-off call is left for a person"));
      // That notice asks its person to say whether it goes on: asked, so no later boot asks again or takes it up.
      input.turns.markResumeAsked(turn.id, now);
      continue;
    }
    if (input.pipeline.resumeTurn(turn, "restart", waiting, cut ?? undefined)) {
      log.info("taking up a turn a restart cut off", { turn_id: turn.id, agent_id: turn.agentId, ...(waiting.length ? { approvals_still_open: waiting.map((request) => request.id) } : {}) });
    }
  }
  // A turn its provider ended and its person was told would be tried again in a few minutes: the timer for that died
  // with the last process, so it is set again from when the turn failed (`pipeline/provider-resume.ts`).
  for (const turn of providerResumesOwed(input.turns, Date.now())) {
    if (input.pipeline.resumeLater(turn, turn.endedAt)) log.info("will take up a turn its provider ended before the restart", { turn_id: turn.id, agent_id: turn.agentId });
  }
  const chats = new Map([...input.recovered, ...input.orphaned].map((turn) => [`${turn.gatewayId} ${turn.chatId}`, turn]));
  for (const chat of chats.values()) {
    if (chat.chatId.startsWith("cron:") || isMissionChat(chat)) continue;
    input.chatEvents.record({ gatewayId: chat.gatewayId, chatId: chat.chatId, audience: "ui", kind: "restart", text: "The daemon restarted while this conversation was open" });
  }
  return sent;
}

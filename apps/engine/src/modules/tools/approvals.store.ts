/**
 * The real approval gate — §7.3 SPEC.
 *
 * A pending request lives in SQLite, not in memory, for one reason: a human takes minutes to
 * answer, and a daemon restart in that window must not silently drop the request or — worse —
 * leave the tool call believing it was approved. A restart keeps it, a crash too: its row stays
 * pending with what only the asking process knew on it (076), and the next boot asks it again for
 * the time it has left, or expires it and says so when too little is (`approvals-kept.ts`).
 *
 * Answers can arrive from anywhere: chat (`/approve`), the CLI, or the dashboard. They all
 * resolve the same row, and whoever asked first wins.
 */

import {
  contained,
  createLogger,
  newId,
  type ApprovalDecision,
  type ApprovalPreview,
  type ApprovalRequest,
  type GatewayName,
} from "@nouride/shared";
import { resolveDecision } from "@nouride/policy";
import type { SqliteDb } from "@nouride/runtime";
import type { Answerer, ApprovalAsk, ApprovalGate, ApprovalOutcome, JobGrantPayload, Settlement } from "@/modules/tools/approval.ts";
import { ApprovalFloor, chatKey, type HeldPrompt } from "@/modules/tools/approval-floor.ts";
import { rowExtras, toRequest, type ApprovalRow } from "@/modules/tools/approval-rows.ts";
import { askedExtras, callKey, KEEP_AT_LEAST_MS, UnclaimedAnswers, type KeptExtras, type KeptFile } from "@/modules/tools/approvals-kept.ts";
import type { GrantStore } from "@/modules/tools/grants.store.ts";
import type { ToolGrantStore } from "@/modules/tools/tool-grants.store.ts";
import type { AuditLog } from "@/commons/audit.store.ts";

const log = createLogger("tools.approval");

export interface ApprovalNotice {
  request: ApprovalRequest;
  /** Instance the request came from, so a prompt can be delivered back to it. */
  gatewayId: string;
  /** Whether the prompt should offer `allow-always`. */
  grantable: boolean;
  /** Why approval is needed, for the prompt text. */
  reason: string;
  /**
   * How many more questions are waiting behind this one in this conversation.
   *
   * Only ever non-zero once tool calls that can stop for a human run concurrently — see
   * `approval-floor.ts`. Said out loud because the alternative is a person answering one prompt,
   * seeing nothing more, and concluding the turn is finished while it is parked on the next question.
   */
  queuedBehind: number;
  /** Asked before a restart and kept across it — the prompt says so, or it reads as a new question. */
  kept?: boolean;
  /** The daemon's own line under the question (`ApprovalAsk.hint`). */
  hint?: string;
  /** *Always* here allows it for a job's runs, not the agent (0.8.0, `ApprovalAsk.jobGrant`) — the button says so. */
  forJob?: boolean;
}

export interface ApprovalStoreOptions {
  db: SqliteDb;
  timeoutMs: number;
  audit?: AuditLog;
  /**
   * Where `allow-always` is written.
   *
   * Persisting here rather than in the executor keeps the grant next to the decision that created
   * it: the row that records "they said always" and the grant that acts on it cannot diverge.
   */
  grants?: GrantStore;
  /** Where `allow-always` is written for tools that are not `exec`. */
  toolGrants?: ToolGrantStore;
  /** Where `allow-always` is written for one of a job's guards (0.8.0): on the job, as a standing yes for its runs. */
  jobGrants?: { allow(grant: JobGrantPayload, by: string): void };
  /**
   * Whether a prompt would reach anybody.
   *
   * Supplied by the daemon, which is the only thing that knows which gateways are connected.
   * Defaults to true so a gate with no wiring behaves as it did before.
   */
  canAsk?: () => boolean;
  /** Called when a request is created, so chat/CLI can prompt a human. */
  onRequest?: (notice: ApprovalNotice) => void;
  /**
   * The request a chat shows has a different number of questions waiting behind it now — one more asked, or one
   * answered elsewhere — so its prompt can say so again (`ApprovalFloor`'s `recount`).
   */
  onBehind?: (id: string, queuedBehind: number) => void;
  /**
   * Where a request asked in a conversation nobody reads is put in front of a person instead — a mission's, in the chat
   * it began in (`ApprovalPromptsDeps.askedIn`). Null for every other request: its own conversation. One question at a
   * time is per that chat, and a bare `/approve` there answers it.
   */
  askedIn?: (request: { gateway: string; chatId: string }) => { gatewayId: string; chatId: string } | null;
  /**
   * Called when an answer arrives with nobody left waiting for it.
   *
   * The turn that asked has ended — it stopped waiting so the model could report and carry on — but
   * the question stayed open and has now been answered. Nothing in this process is holding a promise
   * to release, so the answer is worth nothing unless somebody is told: this is what turns a late
   * `/approve` into a fresh turn instead of a row quietly flipping to `approved`.
   */
  onLateAnswer?: (request: ApprovalRequest, decision: ApprovalDecision, by: string) => void;
  /**
   * Called once a request is settled, however it was — answered from a chat, a button, the dashboard or the CLI, expired,
   * or dropped by `/reset` — so the prompt that asked it can say how and lose its buttons. Every settlement passes
   * `finish`, which is why it is said there and only there. Never fails the settlement.
   */
  onSettled?: (request: ApprovalRequest, settlement: Settlement) => void;
  /**
   * What 0.8.17 and before handed the next process at a clean shutdown (`approvals-kept.json`): the extras of a request
   * asked before the upgrade, which its row does not hold. Read once at the first start, moved onto the rows, then
   * removed (`carryOver`). For 0.9.0 to delete, with the file's reader.
   */
  oldHandOver?: KeptFile;
  /**
   * A yes given before for calls like this one (0.8.7: *Approve similar from this mission*): who gave it, or null. Asked
   * first — such a call is approved without a row or a prompt, and audited as such.
   */
  allowedBefore?: (ask: ApprovalAsk) => string | null;
  now?: () => number;
}

export class SqliteApprovalGate implements ApprovalGate {
  readonly available = true;

  /** Grant payloads for requests in flight, so a late answer can still persist one. */
  private pendingGrants = new Map<string, NonNullable<ApprovalAsk["grant"]>>();
  private pendingToolGrants = new Map<string, NonNullable<ApprovalAsk["toolGrant"]>>();
  private pendingJobGrants = new Map<string, JobGrantPayload>();
  /** Who asked, for each request in flight — `ApprovalRequest.requestedBy`. */
  private requesters = new Map<string, string>();
  /** The turn each request in flight was asked from — handed over across a restart, and on the request's audit row. */
  private turnIds = new Map<string, string>();
  /** Each open request's call (`callKey`), so the same call asked again waits on it instead of asking twice. */
  private calls = new Map<string, string>();
  /** Answers that arrived with nobody waiting, each the answer to the next identical call — once. */
  private readonly unclaimed: UnclaimedAnswers;
  /** Requests kept from before the restart and not yet put in front of anybody again — `showKept`. */
  private keptToShow: ApprovalRequest[] = [];
  /** Every request kept from before the restart and still open — `keptFor`. */
  private carried = new Set<string>();
  /** Kept requests that could offer `always` and lost the grant it writes: such an answer runs the call once. */
  private grantsLost = new Set<string>();

  /** Resolvers for requests this process is currently waiting on. */
  private waiters = new Map<string, (outcome: ApprovalOutcome) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * "Stop waiting" timers, separate from the expiry timers above.
   *
   * One ends the caller's wait; the other ends the request. Sharing a map would mean cancelling one
   * cancels the other, which is exactly the conflation this whole change is undoing.
   */
  private waitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Which request each conversation is showing, and what is queued behind it.
   *
   * See `approval-floor.ts`. Two concurrent peer turns can both need a human, and two prompts racing
   * into one chat is a question nobody can answer — a bare `/approve` cannot tell them apart.
   */
  private floor = new ApprovalFloor();
  /**
   * When each request reached a person, for the requests that had to wait their turn.
   *
   * The expiry window is measured from here, not from `requested_at`: a five-minute window that spent
   * four of those minutes behind somebody else's question would expire almost as soon as it was read.
   */
  private deliveredAt = new Map<string, number>();
  /**
   * Set once the database this writes to is gone.
   *
   * An approval waits on a timer measured in minutes, and a process — or a test — can end well inside
   * that. When it did, the timer fired against a closed database and threw `Cannot use a closed
   * database` from a callback with nobody to catch it: an unhandled rejection, which bun attributes to
   * whichever test happens to be running and which therefore reads as flakiness somewhere unrelated.
   *
   * `JobStore` learned this and grew the same flag; the approval gate had the same timer and did not.
   * Found the same way, by an unrelated test failing with someone else's error in it.
   */
  private closed = false;

  constructor(private readonly options: ApprovalStoreOptions) {
    this.unclaimed = new UnclaimedAnswers(options.timeoutMs, () => this.now());
  }

  /**
   * What a previous run left pending — kept when young enough to be answered, expired when not. Called once at
   * boot, before the gateways connect: the kept ones are asked again by `showKept` once something can carry them.
   *
   * A request younger than its window, with at least `KEEP_AT_LEAST_MS` of it left, gets back what its row keeps — who
   * asked, its turn, the grant `always` writes — however the last process ended. One asked before 0.8.18 gets them from
   * that release's file, once, and they move onto its row. One with less is expired, the safe answer, and the caller
   * tells its chat (`boot/approvals-kept.ts`).
   */
  carryOver(): { kept: ApprovalRequest[]; lapsed: ApprovalRequest[] } {
    const handed = this.options.oldHandOver?.read() ?? {};
    const kept: ApprovalRequest[] = [];
    const lapsed: ApprovalRequest[] = [];
    for (const row of this.pendingRows()) {
      const request = this.pendingRequest(row);
      const left = request.requestedAt + request.timeoutMs - this.now();
      if (left < KEEP_AT_LEAST_MS) {
        this.finish(request.id, "expired", "system");
        lapsed.push(request);
        log.info("an approval asked before the restart could not be kept, so it expired", { approval: request.id, tool: request.tool, agent_id: request.agentId, left_ms: Math.max(0, left) });
        continue;
      }
      const own = rowExtras(row);
      this.restore(request.id, own ?? handed[request.id]);
      if (!own && handed[request.id]) this.keep(request.id);
      if (request.grantable && !this.pendingGrants.has(request.id) && !this.pendingToolGrants.has(request.id) && !this.pendingJobGrants.has(request.id)) this.grantsLost.add(request.id);
      this.calls.set(request.id, callKey({ ...request, gatewayId: request.gateway }));
      this.carried.add(request.id);
      kept.push(request);
      log.info("an approval asked before the restart is kept: it will be asked again", { approval: request.id, tool: request.tool, agent_id: request.agentId, turn_id: this.turnIds.get(request.id), left_ms: left });
    }
    // After what it held is on the rows, so a start cut off before then reads it again.
    this.options.oldHandOver?.remove();
    this.keptToShow = [...kept];
    return { kept, lapsed };
  }

  /** What a request's row keeps beyond its columns (or the old file held), back where this process keeps it. */
  private restore(id: string, extras: KeptExtras | undefined): void {
    if (extras?.requestedBy !== undefined) this.requesters.set(id, extras.requestedBy);
    if (extras?.turnId) this.turnIds.set(id, extras.turnId);
    if (extras?.grant) this.pendingGrants.set(id, extras.grant);
    if (extras?.toolGrant) this.pendingToolGrants.set(id, extras.toolGrant);
    if (extras?.jobGrant) this.pendingJobGrants.set(id, extras.jobGrant);
  }

  /**
   * Put each kept request in front of its chat again, for the time it has left — once the gateways can carry it. One
   * question at a time per chat, as for any request (`approval-floor.ts`). Returns how many were asked again.
   */
  showKept(): number {
    const kept = this.keptToShow.splice(0).filter((request) => this.row(request.id)?.status === "pending");
    for (const request of kept) {
      const left = Math.max(1, request.requestedAt + request.timeoutMs - this.now());
      const grantable = request.grantable === true && !this.grantsLost.has(request.id);
      const notice = {
        gatewayId: request.gateway,
        grantable,
        reason: request.reason ?? "",
        kept: true,
        ...(grantable && this.pendingJobGrants.has(request.id) ? { forJob: true } : {}),
        request: this.pendingRequest(this.row(request.id)!),
      };
      this.floor.enter(this.chatShowing(request.gateway, request.chatId), this.held(request.id, this.display(request.id, left, notice)));
    }
    return kept.length;
  }

  /** The floor a request asked in this conversation waits on: the chat it is put in front of (`askedIn`). */
  private chatShowing(gatewayId: string, chatId: string): string {
    const shown = this.options.askedIn?.({ gateway: gatewayId, chatId }) ?? { gatewayId, chatId };
    return chatKey(shown.gatewayId, shown.chatId);
  }

  /** A prompt for the floor: shown by `show`, and said again in place when the count behind it changes. */
  private held(id: string, show: (queuedBehind: number) => void): HeldPrompt {
    return { id, show, recount: (behind) => this.options.onBehind?.(id, behind) };
  }

  /**
   * The kept requests a turn taken up after the restart was cut off waiting on — by its turn when the last process said
   * which, else by its agent and conversation. For the words that take it up (`restart-resume.ts`).
   */
  keptFor(turn: { id: string; agentId: string; gatewayId: string; chatId: string }): ApprovalRequest[] {
    return this.pending(turn.agentId).filter((request) => {
      const asked = this.turnIds.get(request.id);
      return this.carried.has(request.id) && !this.waiters.has(request.id) && (asked ? asked === turn.id : request.gateway === turn.gatewayId && request.chatId === turn.chatId);
    });
  }

  canAsk(): boolean {
    return this.options.canAsk?.() ?? true;
  }

  async request(ask: ApprovalAsk): Promise<ApprovalOutcome> {
    // Only a call that could be granted is covered by an earlier yes for calls like it — the button is offered on no
    // other. Covering any call of the kind, `git push origin fix` approved as similar let `git push --force origin main`
    // through, and an `rm` inside the workspace every `rm` outside it: the fixed list's questions are asked each time.
    const before = ask.grantable ? (this.options.allowedBefore?.(ask) ?? null) : null;
    if (before) {
      this.options.audit?.record({
        action: "approval_covered",
        agentId: ask.agentId,
        actor: before,
        gatewayId: ask.gatewayId,
        chatId: ask.chatId,
        ...(ask.turnId ? { turnId: ask.turnId } : {}),
        details: { tool: ask.tool, params: ask.params, by: before },
      });
      log.info("a call covered by an earlier yes for calls like it", { tool: ask.tool, agent_id: ask.agentId, chat_id: ask.chatId });
      return { status: "approved", by: before, decision: "allow-once" };
    }
    const call = callKey(ask);
    /**
     * Asked already, answered with nobody waiting — the person said yes or no to exactly this, and the agent was woken
     * to act on it. Asking again would be asking what they have just answered.
     */
    const answered = this.unclaimed.take(call);
    if (answered) {
      log.info("a call took the answer that arrived while nobody was waiting for it", { approval: answered.id, tool: ask.tool, outcome: answered.outcome.status });
      return answered.outcome;
    }
    // Still open in this conversation, with nobody waiting on it — kept across a restart, or left by a turn that
    // stopped waiting: this call waits on that question rather than putting a second one in front of the person.
    const open = [...this.calls].find(([id, key]) => key === call && !this.waiters.has(id))?.[0];
    if (open) {
      this.adopt(open, ask);
      log.info("a call is waiting on the same question, still open, so not asking twice", { approval: open, tool: ask.tool, agent_id: ask.agentId, turn_id: ask.turnId });
      return await this.wait(open, ask);
    }

    const id = newId("apr");
    const requestedAt = this.now();
    const timeoutMs = ask.answerableMs ?? this.options.timeoutMs;
    // On the row from the start (076), not handed over at a clean shutdown alone: a crash kept none of it.
    const extras = askedExtras(ask);

    this.options.db
      .prepare(
        `INSERT INTO approvals (id, agent_id, chat_id, gateway, tool, params, status,
                                requested_at, timeout_ms, grantable, auto_coverable, reason, preview_json, hardline_class, extras_json)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        ask.agentId,
        ask.chatId,
        ask.gatewayId,
        ask.tool,
        JSON.stringify(ask.params),
        requestedAt,
        timeoutMs,
        ask.grantable ? 1 : 0,
        ask.autoCoverable ? 1 : 0,
        ask.reason,
        ask.preview ? JSON.stringify(ask.preview) : null,
        ask.hardlineClass ?? null,
        JSON.stringify(extras),
      );

    this.restore(id, extras);
    this.calls.set(id, call);

    this.options.audit?.record({
      action: "approval_requested",
      agentId: ask.agentId,
      actor: ask.senderId,
      gatewayId: ask.gatewayId,
      chatId: ask.chatId,
      ...(ask.turnId ? { turnId: ask.turnId } : {}),
      details: { approval: id, tool: ask.tool, reason: ask.reason, grantable: ask.grantable },
    });

    log.info("approval requested", { approval: id, tool: ask.tool, agent_id: ask.agentId });

    const notice: Omit<ApprovalNotice, "queuedBehind"> = {
      gatewayId: ask.gatewayId,
      grantable: ask.grantable,
      reason: ask.reason,
      ...(ask.hint ? { hint: ask.hint } : {}),
      ...(ask.jobGrant && ask.grantable ? { forJob: true } : {}),
      request: {
        id,
        agentId: ask.agentId,
        chatId: ask.chatId,
        gateway: ask.gatewayId as GatewayName,
        tool: ask.tool,
        params: ask.params,
        status: "pending",
        requestedAt,
        grantable: ask.grantable,
        autoCoverable: ask.autoCoverable,
        ...(ask.hardlineClass ? { hardlineClass: ask.hardlineClass } : {}),
        reason: ask.reason,
        timeoutMs,
        // What the chat's question shows of it — a persona change's diff, a write's size. Stored with the row and left out
        // of this, the question in a chat showed the arguments as JSON, a persona's diff only after a restart (0.8.13).
        ...(ask.preview ? { preview: ask.preview } : {}),
      },
    };
    return await this.wait(id, ask, this.display(id, timeoutMs, notice));
  }

  /**
   * A call taking up an open question: what it knows that the question lacks — the grant `always` writes, for one asked
   * before 0.8.18 that came across without it. Onto the row too, so the next restart keeps what this call brought.
   */
  private adopt(id: string, ask: ApprovalAsk): void {
    if (ask.grant && ask.grantable && !this.pendingGrants.has(id)) this.pendingGrants.set(id, ask.grant);
    if (ask.toolGrant && ask.grantable && !this.pendingToolGrants.has(id)) this.pendingToolGrants.set(id, ask.toolGrant);
    if (ask.jobGrant && ask.grantable && !this.pendingJobGrants.has(id)) this.pendingJobGrants.set(id, ask.jobGrant);
    if (this.pendingGrants.has(id) || this.pendingToolGrants.has(id) || this.pendingJobGrants.has(id)) this.grantsLost.delete(id);
    if (!this.requesters.has(id)) this.requesters.set(id, ask.senderId);
    this.keep(id);
  }

  /** What this process knows of request `id` beyond its columns, written onto its row for whichever process comes next. */
  private keep(id: string): void {
    const grant = this.pendingGrants.get(id);
    const toolGrant = this.pendingToolGrants.get(id);
    const jobGrant = this.pendingJobGrants.get(id);
    const extras: KeptExtras = {
      ...(this.requesters.has(id) ? { requestedBy: this.requesters.get(id)! } : {}),
      ...(this.turnIds.has(id) ? { turnId: this.turnIds.get(id)! } : {}),
      ...(grant ? { grant } : {}),
      ...(toolGrant ? { toolGrant } : {}),
      ...(jobGrant ? { jobGrant } : {}),
    };
    this.options.db.prepare("UPDATE approvals SET extras_json = ? WHERE id = ?").run(JSON.stringify(extras), id);
  }

  /**
   * Wait on request `id` for `ask` — and, given `show`, put it in front of a person first (a new request; a request
   * already asked is waited on as it stands).
   */
  private async wait(id: string, ask: ApprovalAsk, show?: (queuedBehind: number) => void): Promise<ApprovalOutcome> {
    // The request's own window, which a parked one sets longer (`ask.answerableMs`): read as the default, the log said a
    // mission's approval was answerable for five minutes when it was answerable for a day.
    const timeoutMs = this.row(id)?.timeout_ms ?? this.options.timeoutMs;
    return await new Promise<ApprovalOutcome>((resolve) => {
      // Every exit goes through here, so the abort listener is detached exactly once however the
      // request ends — answered, expired, aborted, or released by `close()` during shutdown.
      let settled = false;
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const settle = (outcome: ApprovalOutcome): void => {
        if (settled) return;
        settled = true;
        ask.signal?.removeEventListener("abort", abortHandler);
        // Its own give-up timer, and only its own: a later call waiting on the same question has one of its own.
        if (giveUp) clearTimeout(giveUp);
        if (this.waitTimers.get(id) === giveUp) this.waitTimers.delete(id);
        if (this.waiters.get(id) === settle) this.waiters.delete(id);
        resolve(outcome);
      };

      /**
       * Two clocks, and separating them is the whole point.
       *
       * **How long the turn waits** is `ask.waitMs`: short, sized so the model still has time to say
       * something before its own deadline. **How long the question stays answerable** is `timeoutMs`:
       * the operator's window, unchanged. They used to be one number, so a request the turn gave up on
       * was also a request nobody could answer any more — and since both defaults are 300s and the
       * turn starts first, the turn always died before the model could react to the refusal.
       *
       * When the turn stops waiting, the row stays `pending`. The operator can still answer it, and
       * `onLateAnswer` is what turns that answer into a fresh turn — see `resolve`.
       */
      const stopWaiting = (why: string): void => {
        log.info("no longer waiting on this approval, though it is still answerable", {
          approval: id,
          why,
          // From when it was shown, which for a queued request is not when it was asked. A request
          // still waiting its turn has its whole window ahead of it.
          answerable_for_ms: Math.max(0, (this.deliveredAt.get(id) ?? this.now()) + timeoutMs - this.now()),
        });
        settle({ status: "expired", stillAnswerable: true });
      };

      // The turn gave up on us. The row is left alone: the question is still worth answering, and
      // answering it now wakes the agent rather than releasing a promise nobody holds.
      const abortHandler = contained(log, "could not stop waiting on an approval", () => stopWaiting("the turn that asked ended"), { approval: id });

      this.waiters.set(id, settle);

      if (ask.waitMs !== undefined && ask.waitMs < timeoutMs) {
        giveUp = setTimeout(
          contained(log, "could not stop waiting on an approval", () => stopWaiting("the turn reserved this long and no longer"), { approval: id }),
          ask.waitMs,
        );
        giveUp.unref?.();
        this.waitTimers.set(id, giveUp);
      }

      // Delivered from inside the promise executor — still synchronously, but after `settle` is
      // registered. A gate whose `onRequest` answers immediately (a test, or an auto-approving
      // surface) used to find no waiter and take the late-answer path for a promise nobody had
      // created yet.
      const enter = (): void => {
        if (show && !this.floor.enter(this.chatShowing(ask.gatewayId, ask.chatId), this.held(id, show))) {
          log.info("approval queued behind another question in this chat", {
            approval: id,
            tool: ask.tool,
            agent_id: ask.agentId,
          });
        }
      };
      /**
       * The turn says it waits — its `waiting` step names this request — before the prompt goes out, with the waiter
       * already registered: an answer that lands meanwhile (the dashboard lists the row at once) releases this call
       * rather than waking the agent as a late one. Shown only if the request is still open by then.
       */
      if (ask.asking) {
        void (async () => {
          try {
            await ask.asking!(id);
          } catch (err) {
            log.warn("could not say a turn waits on an approval", { approval: id, error: String(err) });
          }
          if (!this.closed && this.calls.has(id)) enter();
        })();
      } else {
        enter();
      }

      if (ask.signal?.aborted) {
        abortHandler();
        return;
      }
      ask.signal?.addEventListener("abort", abortHandler, { once: true });
    });
  }

  /**
   * Put the question in front of a person, and start its clock — `windowMs` from now.
   *
   * Both halves belong together and that is the point. The expiry timer is armed here rather than
   * at insert because a request that waited its turn has not been asked yet — arming it earlier
   * would spend the operator's window on somebody else's question. See `approval-floor.ts`.
   */
  private display(id: string, windowMs: number, notice: Omit<ApprovalNotice, "queuedBehind">): (queuedBehind: number) => void {
    return (queuedBehind) => {
      this.deliveredAt.set(id, this.now());
      const timer = setTimeout(
        contained(log, "could not record an approval as expired", () => {
          // Timeout is a *denial*, not an approval. An unattended request must never become a
          // yes just because nobody was looking (§7.3 SPEC step 6).
          //
          // Whoever is waiting is released either way — captured before `finish`, which forgets it: a caller
          // parked on this must not be left there because the store shut down underneath it, nor because writing
          // the expiry threw, which leaves the row pending: still answerable, and settled at the next boot.
          const waiter = this.waiters.get(id);
          try {
            if (!this.closed) this.finish(id, "expired", "timeout");
          } finally {
            waiter?.({ status: "expired" });
          }
        }, { approval: id }),
        windowMs,
      );
      this.timers.set(id, timer);
      this.options.onRequest?.({ ...notice, queuedBehind });
    };
  }

  /**
   * Answer a request.
   *
   * Returns false when it is already resolved or unknown — first answer wins, which matters
   * because the same prompt is visible in chat, in the CLI and on the dashboard at once.
   */
  resolve(id: string, decision: ApprovalDecision, answerer: string | Answerer, reason?: string): boolean {
    const row = this.row(id);
    if (!row || row.status !== "pending") return false;
    // An id, recorded as who answered; a name, where the answer came with one, for the prompt that says so.
    const { id: by, name } = typeof answerer === "string" ? { id: answerer, name: undefined } : answerer;

    // Grantable as asked — unless it was kept across a restart without the grant `always` writes, when such an answer
    // runs the call once and says so (`downgraded`) rather than writing nothing in silence.
    const grant = this.pendingGrants.get(id);
    const toolGrant = this.pendingToolGrants.get(id);
    const jobGrant = this.pendingJobGrants.get(id);
    const { run, persist, downgraded } = resolveDecision(decision, row.grantable === 1 && !this.grantsLost.has(id));

    // Captured BEFORE `finish`, which clears the waiter map. Reading it afterwards always found
    // nothing, so the row was marked approved while the promise it was meant to release hung
    // forever — the tool never ran, the turn never ended, and the whole conversation's queue
    // stayed blocked. The symptom was the "nobody waiting" warning below firing on every answer.
    const waiter = this.waiters.get(id);
    const call = this.calls.get(id);

    // Written before the waiter is released, so the grant is durable before the tool it authorizes
    // can run. The other order would let the command execute and the daemon die with nothing
    // recorded — the operator would have answered "always" and be asked again next time.
    if (persist && grant && this.options.grants) {
      this.options.grants.grant({
        grantKey: grant.grantKey,
        agentId: grant.agentId,
        argv: grant.argv,
        cwd: grant.cwd,
        ...(grant.fileSha256 ? { fileSha256: grant.fileSha256 } : {}),
        createdBy: by,
        approvalId: id,
        policy: grant.policy as Parameters<GrantStore["grant"]>[0]["policy"],
      });
    }
    // Same ordering rule as above: durable before the tool that it authorizes can run.
    if (persist && toolGrant && this.options.toolGrants) {
      this.options.toolGrants.grant({
        grantKey: toolGrant.grantKey,
        agentId: toolGrant.agentId,
        tool: toolGrant.tool,
        scopeDir: toolGrant.scopeDir,
        createdBy: by,
        approvalId: id,
      });
    }
    // A job's: on the job, so its next runs send there without asking, and nothing else is allowed (0.8.0).
    if (persist && jobGrant && this.options.jobGrants) this.options.jobGrants.allow(jobGrant, by);
    this.pendingGrants.delete(id);
    this.pendingToolGrants.delete(id);
    this.pendingJobGrants.delete(id);

    this.finish(id, run ? "approved" : "denied", by, decision, name);

    const outcome: ApprovalOutcome = run
      ? { status: "approved", id, by, decision, ...(downgraded ? { downgraded: true } : {}) }
      : { status: "denied", by, ...(reason ? { reason } : {}) };
    if (waiter) {
      waiter(outcome);
    } else {
      /**
       * Nobody is holding a promise for this. Three ways that happens, and only one is a dead end.
       *
       * The turn stopped waiting but left the question open (`waitMs`), the daemon restarted, or it
       * was answered from another process. In the first case — now the common one — the operator has
       * just said yes to something the agent asked for and gave up on, and silently marking the row
       * `approved` would waste that answer entirely.
       *
       * Kept as the answer to that call, too, for the agent woken to act on it (`UnclaimedAnswers`): asked again
       * for the same thing, it is not asking the person what they have just answered.
       */
      log.info("approval answered with nobody waiting, so waking the agent", { approval: id, decision });
      const answered = this.row(id);
      if (answered && call) this.unclaimed.keep(call, toRequest(answered), outcome);
      if (answered && this.options.onLateAnswer) {
        try {
          this.options.onLateAnswer(toRequest(answered), decision, by);
        } catch (err) {
          // Never fails the answer: the row is already correct, and a wake-up that throws must not
          // make `/approve` report a failure for something that worked.
          log.error("could not wake the agent after a late answer", { approval: id, error: String(err) });
        }
      }
    }
    return true;
  }

  /**
   * Pending requests visible from one conversation.
   *
   * Scoped because `pending(agentId)` was not, and that was a cross-conversation authorization hole:
   * an `exec` requested in a Discord channel could be approved by a bare `/approve` typed in a
   * Telegram DM — the operator answering something they had never seen, or one allowlisted person
   * answering for another. The prompt goes to one chat, so the answer has to come from it.
   *
   * The CLI and dashboard deliberately keep the unscoped view: the operator reaching the daemon
   * through a token-guarded API *is* entitled to answer anything, and that is a different question.
   *
   * The conversation a request is put in front of (`askedIn`) — a mission's question is answered in the chat it was
   * shown in, where a typed `/approve` found nothing while the floor there was showing it.
   */
  pendingForChat(agentId: string, gatewayId: string, chatId: string): ApprovalRequest[] {
    const here = chatKey(gatewayId, chatId);
    return this.pending(agentId).filter((request) => this.chatShowing(request.gateway, request.chatId) === here);
  }

  /**
   * Requests in one conversation that are no longer pending, newest first.
   *
   * Read by `/approve` when it finds nothing to answer, so the reply can say *why* — an answer that
   * lost a race with the turn deadline is a very different thing from one typed into an idle chat, and
   * only one of them means something is wrong. Not scoped by agent: the caller already knows the
   * conversation, and which agent asked is not something the operator typed.
   */
  recentlySettledForChat(gatewayId: string, chatId: string, sinceMs: number): ApprovalRequest[] {
    return this.options.db
      .prepare<ApprovalRow>(
        `SELECT * FROM approvals
         WHERE status != 'pending' AND gateway = ? AND chat_id = ? AND resolved_at >= ?
         ORDER BY resolved_at DESC
         LIMIT 5`,
      )
      .all(gatewayId, chatId, sinceMs)
      .map(toRequest);
  }

  /**
   * Requests that are no longer pending, newest answered first — what was asked and how it ended, from the rows the gate
   * already keeps until `sweep`. `agentId` narrows to one agent's: an agent's `work` tool reads only its own.
   */
  settled(options: { agentId?: string; limit: number }): ApprovalRequest[] {
    const rows = options.agentId
      ? this.options.db
          .prepare<ApprovalRow>("SELECT * FROM approvals WHERE status != 'pending' AND agent_id = ? ORDER BY resolved_at DESC, requested_at DESC LIMIT ?")
          .all(options.agentId, options.limit)
      : this.options.db
          .prepare<ApprovalRow>("SELECT * FROM approvals WHERE status != 'pending' ORDER BY resolved_at DESC, requested_at DESC LIMIT ?")
          .all(options.limit);
    return rows.map(toRequest);
  }

  pending(agentId?: string): ApprovalRequest[] {
    return this.pendingRows(agentId).map((row) => this.pendingRequest(row));
  }

  /** The rows themselves, oldest first: `carryOver` reads what a request's row keeps beyond what a request shows. */
  private pendingRows(agentId?: string): ApprovalRow[] {
    return agentId
      ? this.options.db
          .prepare<ApprovalRow>(
            "SELECT * FROM approvals WHERE status = 'pending' AND agent_id = ? ORDER BY requested_at",
          )
          .all(agentId)
      : this.options.db
          .prepare<ApprovalRow>(
            "SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at",
          )
          .all();
  }

  /** A pending row, with who asked when this process is the one that did, and whether its chat shows it yet. */
  private pendingRequest(row: ApprovalRow): ApprovalRequest {
    const by = this.requesters.get(row.id);
    return { ...toRequest(row), ...(by === undefined ? {} : { requestedBy: by }), ...(this.floor.shown(row.id) ? {} : { queued: true }) };
  }

  /**
   * Do not put these in front of anybody — they are about to be answered in bulk.
   *
   * `/approve all` and the `/approvals balanced` drain resolve a list one at a time, and each answer hands the
   * floor to the next request in that conversation — which is usually the next one on the same list.
   * The prompt is posted asynchronously and the answer lands synchronously, so it arrives *after* the
   * thing it asks about is already approved: a question in the chat for something the operator just
   * said yes to.
   *
   * Only the queue is dropped. Whatever is already on screen stays there, because it has already been
   * asked and is about to be answered like the rest.
   */
  stopShowing(ids: readonly string[]): void {
    this.floor.drop(ids);
  }

  /**
   * Which request this conversation is currently showing a person, if any.
   *
   * What a bare `/approve` means when more than one is pending. Only the one on screen could have
   * been meant — the rest have not been asked yet. See `approval-floor.ts`.
   */
  displayedForChat(gatewayId: string, chatId: string): string | null {
    return this.floor.displayed(chatKey(gatewayId, chatId));
  }

  /**
   * Expire everything for an agent — `/reset` (§9.4 SPEC) — or, with `chat`, what it asked in one conversation, which a
   * delete takes with it. An answer nobody had taken up yet goes with them: nothing may stay parked across those.
   */
  expireAll(agentId?: string, chat?: { gatewayId: string; chatId: string }): number {
    const requests = this.pending(agentId).filter((request) => !chat || (request.gateway === chat.gatewayId && request.chatId === chat.chatId));
    this.unclaimed.drop(agentId, chat);
    // Before the loop, not inside it: finishing the request that holds the floor promotes the next
    // one, and the next one may be on this very list. Without this the operator watches a prompt
    // appear and expire in the same instant.
    this.floor.drop(requests.map((request) => request.id));
    for (const request of requests) {
      // Same ordering trap as `resolve`: capture, then finish.
      const waiter = this.waiters.get(request.id);
      this.finish(request.id, "expired", "system");
      waiter?.({ status: "expired" });
    }
    return requests.length;
  }

  /**
   * At shutdown, where every pending request used to be expired: the rows are left pending, with what only this
   * process knew about each already on them (076), as a crash leaves them too. Whoever still waits is released as a turn
   * that stopped waiting is — the question is still open — so the drain does not wait on a person who cannot answer:
   * the gateways are already stopped. Returns how many are kept.
   */
  handOver(): number {
    const pending = this.pending();
    for (const waiter of [...this.waiters.values()]) waiter({ status: "expired", stillAnswerable: true });
    if (pending.length > 0) log.info("pending approvals kept for after the restart", { count: pending.length, approvals: pending.map((request) => request.id) });
    return pending.length;
  }

  /**
   * Drop settled requests past the retention window. `0` days keeps everything.
   *
   * This table was never pruned. Three weeks of a live install left every approval since day one —
   * 208 rows, none of them pending — while five other tables were being swept daily beside it. Not
   * urgent at that rate, and not bounded either, which is the only property that matters for a table
   * nobody looks at.
   *
   * **`pending` is never touched**, whatever the cutoff. A request waiting for a human is the one
   * row here that is still doing something, and an old one is not stale — it is a turn parked on an
   * answer that has not come. Deleting it would strand that turn on a question nobody can now find.
   *
   * On the audit knob rather than a knob of its own: what a settled row records is who allowed what,
   * and that is the same question `[retention] audit_days` already answers for.
   */
  sweep(retentionDays: number, now: number = Date.now()): number {
    if (retentionDays <= 0) return 0;
    const cutoff = now - retentionDays * 24 * 60 * 60_000;
    const result = this.options.db
      .prepare("DELETE FROM approvals WHERE status != 'pending' AND requested_at < ?")
      .run(cutoff);
    return Number(result.changes ?? 0);
  }

  /**
   * Stop writing, and release anyone waiting.
   *
   * Called before the database closes. Every pending timer is cleared and every parked caller is
   * resolved as expired — the safe answer, and the same one an unanswered approval gets everywhere
   * else. Without this the timers survive the store, which is where the unhandled rejection came from.
   */
  shutDown(): void {
    this.closed = true;
    this.floor.clear();
    this.deliveredAt.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.waitTimers.values()) clearTimeout(timer);
    this.waitTimers.clear();
    for (const waiter of [...this.waiters.values()]) waiter({ status: "expired" });
    this.waiters.clear();
  }

  private finish(id: string, status: Settlement["status"], by: string, decision?: ApprovalDecision, name?: string): void {
    if (this.closed) return;
    this.options.db
      .prepare(
        `UPDATE approvals SET status = ?, resolved_at = ?, resolved_by = ?, decision = ?
         WHERE id = ?`,
      )
      .run(status, this.now(), by, decision ?? null, id);

    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    clearTimeout(this.waitTimers.get(id));
    this.waitTimers.delete(id);
    this.waiters.delete(id);
    this.pendingGrants.delete(id);
    this.pendingToolGrants.delete(id);
    this.pendingJobGrants.delete(id);
    this.requesters.delete(id);
    this.turnIds.delete(id);
    this.calls.delete(id);
    this.carried.delete(id);
    this.grantsLost.delete(id);
    this.deliveredAt.delete(id);
    // Last, and after the row is already `resolved`: this is what puts the next question in front of
    // the person, and that prompt must never be posted while the one it replaces still reads pending.
    this.floor.leave(id);

    const row = this.row(id);
    this.options.audit?.record({
      action: "approval_resolved",
      ...(row ? { agentId: row.agent_id } : {}),
      actor: by,
      details: {
        approval: id,
        status,
        ...(decision ? { decision } : {}),
        ...(row ? { tool: row.tool } : {}),
      },
    });
    log.info("approval resolved", { approval: id, status, by });
    try {
      if (row) this.options.onSettled?.(toRequest(row), { status, by, ...(decision ? { decision } : {}), ...(name ? { name } : {}) });
    } catch (err) {
      log.warn("could not say how an approval settled", { approval: id, error: String(err) });
    }
  }

  /** One request as it stands now, whatever became of it — what a press on its prompt is answered from. */
  get(id: string): ApprovalRequest | null {
    const row = this.row(id);
    return row ? (row.status === "pending" ? this.pendingRequest(row) : toRequest(row)) : null;
  }

  previewOf(id: string): ApprovalPreview | null {
    return this.get(id)?.preview ?? null;
  }

  private row(id: string): ApprovalRow | null {
    return this.options.db
      .prepare<ApprovalRow>("SELECT * FROM approvals WHERE id = ?")
      .get(id);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

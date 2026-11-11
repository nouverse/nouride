/**
 * The missions: what starts one, what runs its turns, and what each turn's end leads to. Nothing
 * starts by itself: a person or an agent starts a mission, and
 * this only runs what was started — one turn at a time, through the pipeline every chat uses, each from the mission's
 * page (`page.ts`), until the agent says it is done and its checks agree, it needs a person, or a limit is reached.
 *
 * Nothing runs beside the pipeline: no loop of its own, no resident process. A turn is a message into the mission's
 * conversation (`web:mission`, the chat id its id), and the pipeline hands it back here to be shaped (`turn-shape.ts`).
 */

import { createLogger, newId, type MessageEnvelope } from "@nouride/shared";
import type { MissionWaitKind } from "@nouride/wire";
import { describeToolCall } from "@/commons/activity.ts";
import { cutLine, worstCut, type CutCall } from "@/modules/turns/cut-calls.ts";
import type { TurnOutcome, TurnShape, TurnShaper } from "@/modules/pipeline/turn-shape.ts";
import { SYSTEM_SENDER } from "@/modules/pipeline/deps.ts";
import { buttonsFor } from "./actions.ts";
import { Checking, type Reviewing } from "./checking.ts";
import type { MissionsDeps } from "./deps.ts";
import { afterTurn, answersWait, blockedBy, continueGives, limitReached, limitsNear, nearLimit, openInSameRepository, planSignature, stepsDone, type LimitsInForce, type MissionLimit, type Unsettled } from "./decide.ts";
import { isMissionChat, MISSION_GATEWAY_ID } from "./gateway.ts";
import { ANSWERS_KEPT, APPROVAL_ANSWERABLE_MS, MAX_RESUMES, SAME_QUESTION, STALL_AFTER_MS } from "./limits.ts";
import { newMission, startRefusal, type StartRequest } from "./start.ts";
import { acceptMission, acceptOutside, answerMission, continueMission, deleteMission, stopMission, type Acted, type Deleted, type Sayer } from "./person.ts";
import { markRead, tellMission, unreadTold, type TellAnswer } from "./tell.ts";
import { MissionStore } from "./missions.store.ts";
import { doneNotice, endedNotice, goesOnNotice, needsYouNotice, paged, queuedNotice, startedNotice, warnNotice } from "./notices.ts";
import { withOptions } from "./options.ts";
import { announceDraft, editDraft, type DraftEdited } from "./draft-edit.ts";
import { briefPath, type DraftChange, type DraftEditor } from "./drafts.ts";
import { sendFiles, sendReport } from "./results.ts";
import { limitsLine, missionPage, shortId, type LimitsShown } from "./page.ts";
import { MissionCounts } from "./counts.ts";
import { carryBack, carryInto, carryWait, closePlan } from "./carry.ts";
import { MissionTimers } from "./timers.ts";
import { isFinal, seenAs, type Mission } from "./types.ts";
import { worktreeBranch } from "./worktree.ts";

const log = createLogger("missions");

/** How a mission's later turns name the outside content an earlier one read — the record a memory write carries. */
const OUTSIDE_EARLIER = "outside content this mission read earlier";

/** What the agent said in a turn about the mission itself — acted on when the turn ends. */
type Claim = { kind: "done"; summary: string; report: string; files: string[] } | { kind: "ask"; question: string; options?: string[] } | { kind: "fail"; reason: string; report: string };

/** What a mission's turns leave in memory between them: none of it needs to survive a restart. */
interface TurnState {
  /** A turn queued or running — a second is not queued behind it. */
  inFlight: boolean;
  /** When the turn in flight was queued; null once one runs. */
  queuedAt: number | null;
  plan: string;
  done: number;
  claim?: Claim;
  /** When its claim was made: a CLI turn that said done and kept working is stopped at a limit once this is old. */
  claimedAt?: number;
  idle: number;
  failures: number;
  /** The same question, asked again in a row. */
  sameQuestion: number;
  /** Tries made after a pause for a model that could not answer (`retry`); told once it answers again. */
  retried: number;
}

export class Missions implements TurnShaper {
  private readonly state = new Map<string, TurnState>();
  /** Missions the queue notice was said for — once each — and why the dispatcher held each back, in its words. */
  private readonly toldQueued = new Map<string, string>();
  readonly timers: MissionTimers;
  private readonly checking: Checking;
  /** What it counts beside its turns: a CLI's tokens, its helpers' (0.8.7) — kept on the mission's record. */
  private readonly counts: MissionCounts;
  /**
   * The limits each waiting mission was stopped at, as they read then (0.8.8): a running CLI turn is stopped on an
   * estimate of its tokens, and the count its end brings may come in under them — then going on raises what the stop
   * read. In memory: after a restart, going on reads them again.
   */
  private readonly stoppedAt = new Map<string, MissionLimit[]>();
  /** The person's words a mission started at once on (`now` with `said`, 0.8.11), quoted in its *started*. In memory. */
  private readonly saidFor = new Map<string, string>();

  constructor(private readonly deps: MissionsDeps) {
    this.timers = new MissionTimers(this, deps);
    this.checking = new Checking(this, deps);
    this.counts = new MissionCounts(deps);
  }

  /** The missions' clock — the routes read hours worked and a week's age by it, as the timers do. */
  now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private turnState(id: string): TurnState {
    let state = this.state.get(id);
    if (!state) {
      state = { inFlight: false, queuedAt: null, plan: "", done: 0, idle: 0, failures: 0, sameQuestion: 0, retried: 0 };
      this.state.set(id, state);
    }
    return state;
  }

  get(id: string): Mission | null {
    return this.deps.store.get(id);
  }

  /** The newest first — `agentId` narrows to one agent's. */
  recent(limit: number, agentId?: string): Mission[] {
    return this.deps.store.recent(limit, agentId);
  }

  /** An agent's own: those it works and those it started — what its `work` tool reaches, and nothing else. */
  ownedBy(agentId: string, limit: number): Mission[] {
    return this.deps.store.ownedBy(agentId, limit);
  }

  /**
   * Another open mission of the same agent — one it works or started — in the same repository as this one (0.8.7): the
   * `mission` tool reminds it to make the new work a sub-mission rather than two that each merge (`sameRepository`).
   */
  sameRepository(mission: Mission): Mission[] {
    return this.deps.sourceRepository ? openInSameRepository(mission, this.deps.store.open(), this.deps.sourceRepository) : [];
  }

  /** Its helpers' tokens are in its count up to now (`counts.ts`) — on the record the caller saves. */
  helpersCounted(mission: Mission): void {
    this.counts.helpersCounted(mission, this.now());
  }

  inForce(mission: Pick<Mission, "agentId">): LimitsInForce {
    return this.counts.inForce(mission);
  }

  /** What it has spent that is not in its count yet: its helpers' since the last count, its running CLI turn's (`counts.ts`). */
  unsettled(mission: Mission): Unsettled {
    return this.counts.unsettled(mission, this.now());
  }

  /** The limits it was stopped at, as they read then — for a person's continue (`person.ts`); empty where none is known. */
  limitsStoppedAt(id: string): MissionLimit[] {
    return this.stoppedAt.get(id) ?? [];
  }

  /** Where it stands against its limits, in one line (`page.ts` `limitsLine`). */
  limitsLine(mission: Mission): string {
    return limitsLine(mission, this.now(), this.counts.shown(mission));
  }

  /** Which limits hold for it and whether its tokens are known — what the dashboard's meters draw (0.8.8). */
  limitsShown(mission: Mission): LimitsShown {
    return this.counts.shown(mission);
  }

  /**
   * An agent's missions, for its status: at work (queued, running, checking, or waiting to try its model again by
   * itself) and waiting for a person (a question, stuck, a limit, its result to accept). One waiting on an approval is
   * left out of both: the approval counts it.
   */
  forStatus(agentId: string): { atWork: number; waiting: number } {
    let atWork = 0;
    let waiting = 0;
    for (const mission of this.deps.store.open()) {
      if (mission.agentId !== agentId || mission.waitKind === "approval") continue;
      if (seenAs(mission.status) === "working" || mission.waitKind === "retry") atWork += 1;
      else waiting += 1;
    }
    return { atWork, waiting };
  }

  /** The missions holding a slot on the box now, of how many may: what a chat's turn is told while any does. */
  load(): { running: number; atOnce: number } {
    return { running: this.running().length, atOnce: this.deps.settings().maxRunning };
  }

  /** The missions holding a slot now, each with its goal and its folder: what a turn is told is at work beside it (`pipeline/work-now.ts`). */
  running(): Mission[] {
    return this.deps.store.open().filter((mission) => mission.status === "running" || mission.status === "checking");
  }

  forChat(gatewayId: string, chatId: string): Mission[] {
    return this.deps.store.forChat(gatewayId, chatId);
  }

  /** A mission by its id or a prefix of it that only it has — what a person types (`msn_3f2a91`). */
  find(idOrPrefix: string): Mission | null {
    const wanted = idOrPrefix.trim();
    const exact = wanted ? this.deps.store.get(wanted) : null;
    if (exact) return exact;
    // At least the four characters after `msn_` a person could tell apart — `msn_` alone names none.
    const prefix = wanted.startsWith("msn_") ? wanted : `msn_${wanted}`;
    if (prefix.length < "msn_".length + 4) return null;
    const matches = this.deps.store.recent(500).filter((mission) => mission.id.startsWith(prefix));
    return matches.length === 1 ? matches[0]! : null;
  }

  // ── Starting ─────────────────────────────────────────────────────────────

  /** Why a start's `branch` cannot be the worktree's — asked before `start`, since git's answer is a command away. */
  async branchRefusal(request: Pick<StartRequest, "agentId" | "workdir" | "branch">): Promise<string | null> {
    if (request.branch === undefined || request.workdir === undefined) return null;
    return await this.deps.branchRefusal({ agentId: request.agentId, workdir: request.workdir, branch: request.branch });
  }

  /**
   * `queued`: why the dispatcher held it back, when it did — what the queue notice says (`blockedBy`). `drafted`, for a
   * draft: its folder and brief written and its notice sent — why the brief could not be, or null.
   */
  start(request: StartRequest): { mission: Mission; queued?: string; drafted?: Promise<string | null> } | { refused: string } {
    const refused = startRefusal(request, { exists: this.deps.agents.exists, store: this.deps.store, now: this.now(), ...(this.deps.checkRefusal ? { checkRefusal: this.deps.checkRefusal } : {}), ...(this.deps.readBrief ? { readBrief: this.deps.readBrief } : {}) });
    if (refused) return { refused };
    const id = MissionStore.newId();
    const mission = newMission(request, { id, settings: this.deps.settings(), privateDir: this.deps.agents.privateDir(request.agentId), now: this.now() });
    this.deps.store.save(mission);
    log.info("mission created", { mission: id, agent_id: mission.agentId, by: request.byAgent ?? request.startedBy, proposed: request.proposed === true });
    // The chat's task goes with the work, when the same agent's chat started it.
    if (request.from && request.from.agentId === mission.agentId && this.deps.notes) {
      const { turnId, ...from } = request.from;
      void carryInto(this.deps.notes, mission, from, turnId ? (this.deps.turnStartedAt?.(turnId) ?? null) : null).catch((err: unknown) => log.warn("a chat's task could not move into its mission", { mission: id, error: String(err) }));
    }
    this.deps.changed?.(mission);
    if (request.proposed) {
      const drafted = announceDraft(this.deps, mission, request.brief);
      return { mission, drafted };
    }
    if (request.said?.trim()) this.saidFor.set(id, request.said.trim());
    this.schedule();
    const queued = this.toldQueued.get(id);
    return { mission: this.deps.store.get(id) ?? mission, ...(queued ? { queued } : {}) };
  }

  /** Start what can start: the queued missions, oldest first, as slots and repositories allow. */
  schedule(): void {
    const open = this.deps.store.open();
    const settings = this.deps.settings();
    // One started here is marked so in `open` itself: the next one is decided against it.
    for (const mission of open.filter((one) => one.status === "queued")) {
      // An asleep agent's missions wait, marked so, and start when it wakes.
      const blocked = this.deps.agents.asleep(mission.agentId) ? `${mission.agentId} is asleep` : blockedBy(mission, open, settings);
      if (blocked) {
        if (!this.toldQueued.has(mission.id)) {
          this.toldQueued.set(mission.id, blocked);
          if (!mission.jobId) void this.deps.tell(mission, queuedNotice(mission, blocked));
        }
        continue;
      }
      this.toldQueued.delete(mission.id);
      const now = this.now();
      mission.status = "running";
      mission.startedAt = now;
      mission.updatedAt = now;
      this.deps.store.save(mission);
      this.deps.changed?.(mission);
      void this.begin(mission);
    }
  }

  private async begin(started: Mission): Promise<void> {
    let moved: string | void = undefined;
    try {
      moved = await this.deps.prepare(started);
    } catch (err) {
      log.warn("a mission's folder could not be made: its first command will make it", { mission: started.id, error: String(err) });
    }
    // Read again: stopped or deleted while its worktree was made, the copy it began with was saved over that, and ran on.
    const mission = this.deps.store.get(started.id);
    if (!mission || mission.status !== "running") {
      log.info("a mission ended while its folder was made, so it was not begun", { mission: started.id, status: mission?.status ?? "deleted" });
      // Its row names the folder it was given, so nothing else would ever remove the worktree made for it.
      if (moved) void this.deps.remove?.({ ...(mission ?? started), workdir: moved }).catch((err: unknown) => log.warn("an ended mission's worktree could not be removed", { mission: started.id, error: String(err) }));
      return;
    }
    if (moved && moved !== mission.workdir) {
      mission.workdir = moved;
      mission.updatedAt = this.now();
      this.deps.store.save(mission);
      this.deps.changed?.(mission);
    }
    log.info("mission started", { mission: mission.id, agent_id: mission.agentId, job: mission.jobId });
    // A job's run starts on its schedule, which its chat already knows: it is told when it is done or needs someone.
    if (!mission.jobId) void this.deps.tell(mission, paged(startedNotice(mission, this.saidFor.get(mission.id)), this.deps.pageOf?.(mission)));
    this.saidFor.delete(mission.id);
    this.queueTurn(mission, "the mission starts. Write the checklist with `plan` first, then begin.");
  }

  // ── Turns ────────────────────────────────────────────────────────────────

  /**
   * A turn of this mission, into its conversation — unless one is already queued or running. `always`: news that must
   * reach it even then, which the queue keeps behind the turn in hand.
   */
  queueTurn(mission: Mission, why: string, always = false): void {
    if (this.inFlight(mission) && !always) return;
    const state = this.turnState(mission.id);
    if (!state.inFlight) state.queuedAt = this.now();
    state.inFlight = true;
    const queued = this.deps.queueTurn({
      id: newId("msg"),
      timestamp: this.now(),
      gateway: "web",
      gatewayId: MISSION_GATEWAY_ID,
      chatId: mission.id,
      chatType: "dm",
      senderId: SYSTEM_SENDER,
      senderName: "Nouride",
      mentions: [mission.agentId],
      text: why,
      raw: { via: "mission", mission: mission.id },
    });
    if (!queued) {
      state.inFlight = false;
      log.warn("a mission's turn could not be queued", { mission: mission.id });
    }
  }

  shapes(envelope: Pick<MessageEnvelope, "gatewayId">): boolean {
    return isMissionChat(envelope);
  }

  shapeFor(agentId: string, envelope: MessageEnvelope): TurnShape | null {
    const mission = this.deps.store.get(envelope.chatId);
    if (!mission || mission.agentId !== agentId) {
      log.warn("a message for a mission that is not there was not run", { chat_id: envelope.chatId, agent_id: agentId });
      return this.letGo(envelope.chatId, mission);
    }
    const via = (envelope.raw as { via?: unknown } | null | undefined)?.via;
    if (mission.status === "waiting" && answersWait(mission.waitKind, via)) {
      this.resume(mission);
      this.deps.store.save(mission);
      this.deps.changed?.(mission);
    }
    if (mission.status !== "running" || this.deps.agents.asleep(agentId)) {
      log.info("a mission's turn not run: the mission is not running", { mission: mission.id, status: mission.status, wait: mission.waitKind, via: String(via) });
      return this.letGo(mission.id, mission);
    }
    const key = { agentId, gatewayId: MISSION_GATEWAY_ID, chatId: mission.id };
    const plan = this.deps.notes?.plan(key);
    const state = this.turnState(mission.id);
    state.inFlight = true;
    state.queuedAt = null;
    state.plan = planSignature(plan);
    state.done = stepsDone(plan);
    state.claim = undefined;
    state.claimedAt = undefined;
    const parked = this.deps.parked(mission);
    // Its children report to its chat, so they are among that chat's missions.
    const handedOut = this.deps.store.forChat(mission.gatewayId, mission.chatId).filter((one) => one.parentId === mission.id);
    const text = missionPage({ mission, why: envelope.text.trim() || "continue.", plan, parked, handedOut, now: this.now(), limits: this.counts.shown(mission), freeToDelete: this.deps.freeToDelete?.(mission.agentId) === true, onCli: this.deps.runsOnCli?.(mission.agentId) === true, personSaid: this.deps.personSaid?.(mission) ?? null, brief: this.deps.briefOf?.(mission) ?? null });
    // What a person told it that no turn read is on this page, in full: read now, in this turn.
    if (markRead(mission, unreadTold(mission).map((one) => one.id))) {
      this.deps.store.save(mission);
      this.deps.changed?.(mission);
    }
    return {
      text,
      fresh: true,
      parkApprovalsMs: APPROVAL_ANSWERABLE_MS,
      workdir: mission.workdir,
      ...(worktreeBranch(mission) ? { helperWorktrees: true as const } : {}),
      parked: parked.length,
      person: { gatewayId: mission.gatewayId, senderId: mission.startedBy },
      ...(mission.untrusted ? { outsideContent: [OUTSIDE_EARLIER] } : {}),
      // A job's run sends only to its job's chat, and a person may answer *always for this job* (0.8.0).
      unattended: {
        goal: mission.goal,
        ...(mission.jobId
          ? { sendsTo: { gatewayId: mission.gatewayId, chatId: mission.chatId }, jobId: mission.jobId, allowed: this.deps.jobAllowed?.(mission.jobId) ?? [] }
          : {}),
      },
      ended: (outcome) => this.turnEnded(mission.id, outcome),
    };
  }

  /**
   * No turn of it in flight — and, for a mission gone or ended, nothing kept at all: `end` let its state go, and a turn
   * ending or a message coming after that made it again, for good.
   */
  private letGo(id: string, mission: Mission | null): null {
    const state = this.state.get(id);
    if (!mission || isFinal(mission.status)) this.state.delete(id);
    else if (state) state.inFlight = false;
    return null;
  }

  /** A turn ended: count it, act on what it claimed, and decide the next. */
  turnEnded(id: string, outcome: TurnOutcome): void {
    const mission = this.deps.store.get(id);
    if (!mission || isFinal(mission.status)) {
      this.letGo(id, mission);
      return;
    }
    const state = this.turnState(id);
    state.inFlight = false;
    const now = this.now();
    mission.turnsUsed += 1;
    this.counts.turnEnded(mission, outcome, now);
    mission.nudgedAt = null;
    mission.updatedAt = now;
    const plan = this.deps.notes?.plan({ agentId: mission.agentId, gatewayId: MISSION_GATEWAY_ID, chatId: id });
    const moved = planSignature(plan) !== state.plan;
    // A step finished: the mission is getting somewhere, and a restart before the next is not a loop.
    const finished = stepsDone(plan) > state.done;
    if (finished) mission.resumes = 0;
    const claim = state.claim;
    state.claim = undefined;
    state.claimedAt = undefined;
    // Kept on the mission: its next turn starts fresh, and would otherwise forget the page it read, and with it the
    // guard that makes a later memory write wait for a person.
    if (outcome.readOutside && !mission.untrusted) {
      mission.untrusted = true;
      log.info("a mission read outside content: its later turns are marked as having read it", { mission: id });
    }
    // Cut short — or ended after the minute's check stopped it at a limit, the stop landing as it finished: it decides
    // nothing, and the limit's notice was said once (a review of affb384f: said twice, and the mission left "checking"
    // while waiting on its limit).
    if (outcome.interrupted || mission.status === "waiting") {
      this.deps.store.save(mission);
      return;
    }
    if (claim?.kind === "fail") return this.end(mission, "failed", `gave up: ${claim.reason}`, claim.report);
    if (claim?.kind === "ask") return this.asked(mission, withOptions(claim.question, claim.options ?? []), claim.options ?? []);
    if (claim?.kind === "done") {
      mission.summary = claim.summary;
      mission.report = claim.report;
      mission.files = claim.files;
      mission.status = "checking";
      this.deps.store.save(mission);
      this.deps.changed?.(mission);
      void this.checking.run(mission.id);
      // Its agent's slot is free while it is checked (`blockedBy`): one queued behind it starts now.
      this.schedule();
      return;
    }
    state.failures = outcome.failed ? state.failures + 1 : 0;
    if (!outcome.failed && state.retried > 0) {
      void this.deps.tell(mission, goesOnNotice(mission, state.retried));
      state.retried = 0;
    }
    // Nothing done: no call that ran and worked, no step moved — refused or failing calls are not progress.
    const stood = outcome.worked === 0 && !moved;
    state.idle = stood && !outcome.failed ? state.idle + 1 : 0;
    const reached = limitReached(mission, now, this.inForce(mission));
    if (reached) return this.limitHit(mission, reached);
    // Not beside the limit itself: msn_3d28e0's chat was told "80% of its 100M tokens" and "reached its token limit" in
    // the same second.
    this.warnNear(mission);
    const next = afterTurn({
      idle: state.idle,
      failures: state.failures,
      ...(outcome.error ? { error: outcome.error } : {}),
      parked: this.deps.parked(mission).length,
      stood,
      finished,
      jobRunning: this.awaits(mission),
    });
    if (next.kind === "wait") {
      const parked = this.deps.parked(mission);
      return this.wait(mission, next.on, next.on === "approval" ? parked.map((one) => `#${one.id} ${one.what}`).join("; ") : next.reason);
    }
    // Paused, said once: the tries after the first are quiet until it answers or a person is needed.
    if (next.kind === "retry") return this.wait(mission, "retry", next.reason, next.attempt === 1);
    this.deps.store.save(mission);
    if (next.kind === "continue") this.queueTurn(mission, next.why);
  }

  // ── What the agent says, through `mission` ───────────────────────────────

  /** When its turn running now said done, ask or fail — what its end acts on (`timers.ts`); null where it has not. */
  claimedAt(id: string): number | null {
    const state = this.state.get(id);
    return state?.claim !== undefined ? (state.claimedAt ?? null) : null;
  }

  /** `done`, `ask` or `fail` from inside a mission's turn — acted on when the turn ends. */
  claim(missionId: string, claim: Claim): void {
    const state = this.turnState(missionId);
    state.claim = claim;
    // The turn's first claim: one said again every few minutes does not keep putting off a limit.
    state.claimedAt ??= this.now();
  }

  /** `question` as the person reads it, its `options` listed under it (`options.ts`). */
  private asked(mission: Mission, question: string, options: string[]): void {
    const state = this.turnState(mission.id);
    const last = mission.answers.at(-1);
    state.sameQuestion = last && last.question.trim().toLowerCase() === question.trim().toLowerCase() ? state.sameQuestion + 1 : 1;
    mission.answers = [...mission.answers, { question, at: this.now(), ...(options.length > 0 ? { options } : {}) }].slice(-ANSWERS_KEPT);
    if (state.sameQuestion >= SAME_QUESTION) {
      return this.wait(mission, "stuck", `it asked the same question ${SAME_QUESTION} times in a row, going round in circles: "${question}"`);
    }
    this.wait(mission, "input", question);
  }

  // ── What a person says — `person.ts` ──────────────────────────────────────

  stop(id: string, by: string): Acted {
    return stopMission(this, this.deps, id, by);
  }

  /**
   * Its conversation deleted (0.8.0): the mission goes with it — stopped first while it still runs, or it worked on with
   * its checklist gone; then the folder the daemon made for it, and its record. One history, one lifetime, as retention
   * has it.
   */
  forget(id: string, by: string): void {
    const mission = this.deps.store.get(id);
    if (!mission) return;
    if (!isFinal(mission.status)) this.stop(id, by);
    this.deps.store.remove(id);
    void this.deps.remove?.(mission).catch((err: unknown) => log.warn("a deleted mission's folder could not be removed", { mission: id, error: String(err) }));
  }

  /** A person deletes an ended mission (`person.ts`): refused while it is open, or over work nobody committed unless forced. */
  delete(id: string, by: string, how: { force?: boolean } = {}): Promise<Deleted> {
    return deleteMission(this, this.deps, id, by, how);
  }

  /** Go on: past a limit (the one it reached raised again), out of being stuck, or with what an accept found missing. */
  continueMission(id: string, by: string, note?: string, as?: Sayer): Acted {
    return continueMission(this, this.deps, id, by, note, as);
  }

  answer(id: string, text: string, by: string): Acted {
    return answerMission(this, this.deps, id, text, by);
  }

  /** Words for it while it works (`tell.ts`): into its turn, or kept for the next; `via` the agent that passed them on. */
  tell(id: string, text: string, by: string, via?: string): TellAnswer {
    return tellMission(this, this.deps, id, text, by, via);
  }

  /** Told words its turn was handed — a steer it read (`ActiveTurns.takeSteers`): read in this turn. */
  toldRead(id: string, tellIds: readonly string[]): void {
    const mission = this.deps.store.get(id);
    if (!mission || !markRead(mission, tellIds)) return;
    this.deps.store.save(mission);
    this.deps.changed?.(mission);
  }

  /** Where its `BRIEF.md` goes: its own folder, under its agent's (`drafts.ts`). */
  briefPath(mission: Pick<Mission, "id" | "agentId">): string {
    return briefPath(this.deps.agents.privateDir(mission.agentId), mission.id);
  }

  /** Its brief as written, and where — what the dashboard shows: its own `BRIEF.md`, else one its goal names (0.8.11). */
  brief(mission: Mission): { path: string; text: string } | null {
    for (const path of [this.deps.briefOf?.(mission), this.deps.goalBriefOf?.(mission)]) {
      const text = path ? (this.deps.readBrief?.(path) ?? null) : null;
      if (path && text !== null) return { path, text };
    }
    return null;
  }

  /** A draft changed before it starts (`draft-edit.ts`): by its agent from its chat, or a person on the dashboard. */
  edit(id: string, change: DraftChange, editor: DraftEditor): Promise<DraftEdited> {
    return editDraft(this, this.deps, id, change, editor);
  }

  /** Accept its result — or, for a proposal, start it; said in its chat (`as`), a proposal runs as whoever said it. */
  accept(id: string, by: string, as?: Sayer): Acted {
    return acceptMission(this, this.deps, id, by, as);
  }

  /** Closed as done outside its checks, with a note saying where (`person.ts` `acceptOutside`). */
  acceptOutside(id: string, note: string, by: string): Acted {
    return acceptOutside(this, this.deps, id, note, by);
  }

  /** Its counts of turns in a row — idle, failed, the same question — start again: a person said to go on. */
  freshStart(id: string): void {
    const state = this.turnState(id);
    state.idle = 0;
    state.failures = 0;
    state.sameQuestion = 0;
    this.checking.forget(id);
  }

  // ── Waiting and ending ───────────────────────────────────────────────────

  /** Out of a wait: the time it waited on a person is left out of its hours. */
  resume(mission: Mission): void {
    if (mission.waitKind === "input") this.carryWait(mission, null);
    if (mission.waitingSince !== null) mission.waitedMs += Math.max(0, this.now() - mission.waitingSince);
    mission.waitingSince = null;
    mission.status = "running";
    mission.waitKind = null;
    mission.reason = null;
    mission.followedUpAt = null;
    mission.updatedAt = this.now();
  }

  /** The try a paused mission is on (`retry`): its failed turns in a row — one, after a restart forgot them. */
  retryAttempt(id: string): number {
    return Math.max(this.state.get(id)?.failures ?? 0, 1);
  }

  /** A paused mission's time came round (`timers.ts`): out of its wait, a turn to try its model again. */
  retryNow(mission: Mission): void {
    const why = mission.reason ?? "no answer";
    const attempt = this.retryAttempt(mission.id);
    this.turnState(mission.id).retried = attempt;
    this.resume(mission);
    this.deps.store.save(mission);
    this.deps.changed?.(mission);
    log.info("a paused mission tries its model again", { mission: mission.id, attempt: attempt + 1 });
    this.queueTurn(mission, `its model could not answer at the last try (${why}). Trying again: carry on from the page.`);
  }

  wait(mission: Mission, kind: MissionWaitKind, detail: string, tellPerson = true, gives?: string): void {
    const now = this.now();
    mission.status = "waiting";
    mission.waitKind = kind;
    mission.reason = detail;
    mission.waitingSince = now;
    mission.followedUpAt = null;
    mission.updatedAt = now;
    this.deps.store.save(mission);
    this.deps.changed?.(mission);
    log.info("a mission waits for a person", { mission: mission.id, wait: kind });
    if (kind === "input") this.carryWait(mission, detail);
    // A question that names its options gets a button for each (0.8.7, `options.ts`), a free answer still working; the
    // other waits, what a person can do about them (`actions.ts`).
    // A result waiting for the person's accept has its whole report after it (0.8.11): read before they decide.
    if (tellPerson) void this.deps.tell(mission, paged(needsYouNotice(mission, kind, kind === "approval" ? `approval ${detail}` : detail, gives), this.deps.pageOf?.(mission)), buttonsFor(mission)).then(() => (kind === "accept" ? sendReport(this.deps, mission) : undefined));

    // Waiting for a person holds no slot.
    this.schedule();
  }

  /** The chat's notes say its mission waits on the person's answer, or no longer does (`carry.ts` `carryWait`). */
  private carryWait(mission: Mission, question: string | null): void {
    if (!this.deps.notes) return;
    void carryWait(this.deps.notes, mission, question).catch((err: unknown) => log.warn("a chat's line for its waiting mission could not be written", { mission: mission.id, error: String(err) }));
  }

  /**
   * A limit reached: its jobs stopped, and it waits for a person to continue or stop it — told what going on gives
   * it. `raise`, where the caller read them with what is not counted yet (`timers.ts`); else read here.
   */
  limitHit(mission: Mission, which: string, raise: MissionLimit[] = limitsNear(mission, this.now(), this.inForce(mission))): void {
    for (const job of this.jobsOf(mission)) this.deps.jobs?.kill(job.id, `mission ${mission.id} reached ${which}`);
    this.stoppedAt.set(mission.id, raise);
    this.wait(mission, "limit", which, true, continueGives(raise, this.deps.settings()));
  }

  private warnNear(mission: Mission): void {
    const near = nearLimit(mission, this.now(), this.inForce(mission));
    if (!near) return;
    mission.warnedAt = this.now();
    void this.deps.tell(mission, warnNotice(mission, near));
  }

  end(mission: Mission, status: "done" | "failed" | "stopped", why?: string, report?: string, accepted = false): void {
    const now = this.now();
    // Its report went with the wait for an accept this end closes: one report reaches the chat once.
    const reportShown = mission.status === "waiting" && mission.waitKind === "accept";
    if (mission.waitingSince !== null) mission.waitedMs += Math.max(0, now - mission.waitingSince);
    mission.waitingSince = null;
    mission.status = status;
    mission.waitKind = null;
    mission.reason = why ?? null;
    if (report !== undefined) mission.report = report;
    mission.endedAt = now;
    mission.updatedAt = now;
    for (const job of this.jobsOf(mission)) this.deps.jobs?.kill(job.id, `mission ${mission.id} ${status}`);
    this.deps.withdraw?.(mission);
    this.deps.letGoCli?.(mission);
    this.deps.store.save(mission);
    this.deps.changed?.(mission);
    // What it kept in memory goes with it: each table had a row for every mission that ever ended a certain way.
    this.state.delete(mission.id);
    this.stoppedAt.delete(mission.id);
    this.timers.forget(mission.id);
    this.toldQueued.delete(mission.id);
    this.saidFor.delete(mission.id);
    this.checking.forget(mission.id);
    // A draft dropped — never started — takes its folder with it: its brief, and nothing else was ever written there.
    if (mission.startedAt === null) void this.deps.remove?.(mission).catch((err: unknown) => log.warn("a dropped draft's folder could not be removed", { mission: mission.id, error: String(err) }));
    log.info("mission ended", { mission: mission.id, status, turns: mission.turnsUsed, tokens: mission.tokensUsed, reason: why });
    void this.deps
      .tell(mission, status === "done" ? paged(doneNotice(mission, accepted), this.deps.pageOf?.(mission)) : endedNotice(mission, why ?? status))
      .then(() => (reportShown ? undefined : sendReport(this.deps, mission)))
      .then(() => sendFiles(this.deps, mission));
    if (this.deps.notes) void carryBack(this.deps.notes, mission).catch((err: unknown) => log.warn("a chat's line for its mission could not be updated", { mission: mission.id, error: String(err) }));
    if (this.deps.notes) void closePlan(this.deps.notes, mission).catch((err: unknown) => log.warn("a done mission's checklist could not be closed", { mission: mission.id, error: String(err) }));
    void this.deps.remember?.(mission).catch((err: unknown) => log.warn("a mission's episode could not be filed", { mission: mission.id, error: String(err) }));
    this.tellParent(mission);
    this.tidy(mission);
    this.schedule();
  }

  /** The worktrees it made itself, removed now it has ended (`worktree.ts` `removeExtraWorktrees`). */
  private tidy(mission: Mission): void {
    if (!this.deps.tidy) return;
    void this.deps
      .tidy(mission)
      .then(({ removed, kept }) => {
        if (removed.length > 0 || kept.length > 0) log.info("a mission's own extra worktrees tidied", { mission: mission.id, removed, kept_uncommitted: kept });
      })
      .catch((err: unknown) => log.warn("a mission's extra worktrees could not be tidied", { mission: mission.id, error: String(err) }));
  }

  /** A mission handed out from inside another tells that one how it ended — its next turn starts from that. */
  private tellParent(child: Mission): void {
    const parent = child.parentId ? this.deps.store.get(child.parentId) : null;
    if (!parent || parent.status !== "running") return;
    const what = child.status === "done" ? `is done: ${child.report ?? "no report"}` : `ended (${child.status}): ${child.reason ?? ""}`;
    this.queueTurn(parent, `the mission you handed to ${child.agentId}, ${shortId(child.id)}, ${what}`, true);
  }

  jobsOf(mission: Mission): { id: string }[] {
    return (this.deps.jobs?.running(mission.agentId) ?? []).filter((job) => job.gatewayId === MISSION_GATEWAY_ID && job.chatId === mission.id);
  }

  /**
   * Work of its own still under way, whose end tells it: a job, or a mission it handed out. A parent left with nothing
   * but its child's result went round idle turns into `stuck`, and the child's end then found it waiting.
   */
  awaits(mission: Mission): boolean {
    return this.jobsOf(mission).length > 0 || this.deps.store.open().some((other) => other.parentId === mission.id);
  }

  /** An agent woke: its running missions go on from their pages, and what waited for a slot may start. */
  woke(agentId: string): void {
    for (const mission of this.deps.store.open()) {
      if (mission.agentId !== agentId || mission.status !== "running") continue;
      const state = this.state.get(mission.id);
      // A turn held while it slept goes back into the queue now: queued from now — not lost for the hours it slept, with
      // a second turn queued beside it.
      if (state?.inFlight && state.queuedAt !== null) state.queuedAt = this.now();
      else if (!state?.inFlight) this.queueTurn(mission, "the agent was asleep and has woken. Carry on from the page.");
    }
    this.schedule();
  }

  /**
   * A turn of it queued or running. One queued a stall's time ago and never run is lost: the pipeline drops a message on
   * paths that never reach the mission — a queue that timed it out or was full, an agent turned off — and, kept in
   * flight, it held the mission `running` for good, past the checks that nudge a quiet one and find it stuck. One held
   * for an asleep agent is not lost: it runs when the agent wakes.
   */
  inFlight(mission: Mission): boolean {
    const state = this.state.get(mission.id);
    if (!state?.inFlight) return false;
    if (state.queuedAt === null || this.now() - state.queuedAt < STALL_AFTER_MS || this.deps.agents.asleep(mission.agentId)) return true;
    log.warn("a mission's turn was queued and never ran, so it is taken as lost", { mission: mission.id, queued_at: state.queuedAt });
    state.inFlight = false;
    state.queuedAt = null;
    return false;
  }

  /**
   * After a restart: every running mission gets *continue*, and a check that was running runs again. A mission whose
   * turns keep being cut off by restarts with no step finished in between fails — one that kills the daemon must not
   * loop. Only a restart that cut one of its turns (`cuts`, the turns the last process left unfinished) counts: every
   * restart was, and a healthy mission on one long step — a job running — failed at the third deploy.
   */
  afterRestart(cuts: ReadonlyMap<string, readonly CutCall[]> = new Map()): void {
    // Nothing of the last process's turns is in flight now.
    this.state.clear();
    for (const mission of this.deps.store.open()) {
      if (mission.status === "checking") {
        void this.checking.run(mission.id);
        continue;
      }
      if (mission.status !== "running") continue;
      if (cuts.has(mission.id)) mission.resumes += 1;
      if (mission.resumes >= MAX_RESUMES) {
        this.end(mission, "failed", `it was cut off by ${MAX_RESUMES} restarts in a row with no step finished in between`);
        continue;
      }
      // The call it was cut off in decides: one the gate asks about waits for a person; any other is named.
      const cut = worstCut(cuts.get(mission.id) ?? []);
      if (cut?.kind === "asks") {
        this.wait(mission, "unknown_outcome", describeToolCall(cut.call.name, cut.call.arguments));
        continue;
      }
      this.deps.store.save(mission);
      this.queueTurn(mission, `the daemon restarted while this mission was running.${cut ? ` ${cutLine(cut)}` : ""} Carry on from the page.`);
    }
    this.schedule();
  }

  /** The reviewer at work on it now, which pass and since when — or null: what its page and `mission show` say then. */
  reviewing(id: string): Reviewing | null {
    return this.checking.reviewingNow(id);
  }

  /** What it keeps in memory, table by table — exposed so a test can catch one growing without bound. */
  tables(): { turns: number; toldQueued: number; sameCheck: number; swept: number } {
    return { turns: this.state.size, toldQueued: this.toldQueued.size, sameCheck: this.checking.entries(), swept: this.timers.entries() };
  }

  /** The minute's checks — `timers.ts`. */
  tick(): void {
    this.timers.tick(this.now());
  }

  /** Its coding CLI said what its context holds, inside its turn: its limits read now (`timers.ts` `spent`). */
  spent(id: string): void {
    this.timers.spent(id, this.now());
  }
}

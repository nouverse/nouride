/**
 * Supervised recursive self-improvement — the loop, composed.
 *
 * An agent spends four turns working out why a deploy fails, gets it working, and the next
 * conversation starts from nothing. That is the problem; this is the smallest thing that fixes it
 * without becoming a second daemon:
 *
 *   trigger.ts    was this turn worth writing down                     (pure)
 *   synthesis.ts  triage, then author or revise: transcript in, proposed skill out
 *   redact.ts     nothing credential-shaped leaves the box or lands in a file
 *   drafts.ts     where the proposal waits, indefinitely, for a person
 *   this file     the order those run in, and the two decisions a human makes
 *
 * **Nothing here writes a skill.** `approve` does, and `approve` is only ever reached from a person:
 * a slash command, a dashboard button, or the CLI. That is the whole architecture — the agent gets to
 * notice and to propose, and a human keeps the write. An approved draft is on for *every* agent from
 * the next message, because a pooled skill is part of every agent's prompt — which is why the bar is
 * a person and not a confidence score.
 *
 *   observe()  →  detect  →  synthesize  →  DraftStore.create  →  tell somebody
 *   approve()  →  writeNewSkill  →  registry.reloadAll  →  audit
 *   deny()     →  the row is deleted, transcript and all
 */

import { createLogger, helperModel, type InstallTiers, type LLMProvider, type SkillLearningSection } from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import { meter, metered } from "@/modules/llm/metered.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import type { BudgetVerdict } from "@/modules/llm/budget.ts";
import { VALID_SKILL_NAME, archivePoolSkill, updateExistingSkill, writeNewSkill } from "@nouride/persona";
import type { AuditPort, SkillRead } from "@/commons/audit.store.ts";
import type { Notifier } from "@/commons/notify.ts";
import { REASON_SEPARATOR, ToolMemory, lessonOf, type DraftsPort } from "./drafts.store.ts";
import { redact } from "@nouride/secrets";
import { detectTrigger } from "./trigger.ts";
import { buildTranscript, synthesizeSkill } from "./synthesis.ts";
import { breadthOf, listSkillFiles, readPool, readSkill, readSkillFile, writeRefusal } from "./pool.ts";
import { announceAccepted, announceDraft } from "./notify.ts";
import { proposeImprovement } from "./propose.ts";
import { installedFields, type InstallDeps } from "./install.ts";
import { Cooldowns } from "./cooldown.ts";
import { TUNING, type Tuning } from "./tuning.ts";
import { LibraryReview } from "./review.ts";
import type { ReviewStore } from "./reviews.store.ts";
import type { CandidateStore } from "./candidates.store.ts";
import { refusalOf, writeNow } from "./gates.ts";
import type { DraftEdits, ObservedTurn, SkillDraft } from "./types.ts";

// What the daemon builds the loop from, and nothing else: a test that needs the trigger, the triage or the prompts
// imports them from their own files rather than widening this surface for it.
export { DraftStore, ToolMemory } from "./drafts.store.ts";
export { CandidateStore } from "./candidates.store.ts";
export { ReviewStore } from "./reviews.store.ts";
export type { ReviewReport } from "./curator.ts";
export type { DraftsPort } from "./drafts.store.ts";
export type { DraftEdits, ObservedTurn, SkillDraft, ToolStep, Trigger } from "./types.ts";

const log = createLogger("reflection");

export interface ReflectionDeps {
  /** `[skills.learning]`, read on every turn: a mode changed on the dashboard applies to the next one. */
  config: SkillLearningSection;
  /** `[llm.defaults]`, for a `model` that names a tier (0.8.0). Absent, a tier is the agent's own — a test's. */
  llmDefaults?: InstallTiers;
  /** The pass's dials over `TUNING` — for a test; the daemon leaves them alone. */
  tuning?: Partial<Tuning>;
  drafts: DraftsPort;
  toolMemory: ToolMemory;
  /** Classes of work seen once, held until they recur. Absent writes every create — what a test without a database gets. */
  candidates?: CandidateStore;
  /** When the weekly review ran (`curator.ts`). Absent, there is no review. */
  reviews?: ReviewStore;
  /** When each skill was last read, and since when that has been watched (`AuditLog.skillReads`) — what the review archives by. */
  lastRead?: (paths: string[]) => Map<string, SkillRead>;
  registry: AgentRegistry;
  providers: ProviderRegistry;
  /** Persona pack root — the pool is `skillsDirFor(agentsDir)`. */
  agentsDir: string;
  /**
   * Where the skills that ship with the daemon live, when this install has them.
   *
   * Listed to the pass, never written to. Without it triage cannot tell "nothing covers this" from
   * "Nouride already ships a skill for exactly this", and those are opposite answers — see
   * `readPool`.
   */
  builtinSkillsDir?: string;
  audit?: AuditPort;
  /**
   * Where a pass's calls are metered — `purpose: "reflection"`, under the turn it looked at. A pass is one to ten
   * calls of up to about 18k tokens each, and it reached neither cap nor any spend figure before this.
   */
  usage?: Pick<UsagePort, "record">;
  /** Today's spend against the caps (`llm/budget.ts`): a pass past them is not made — nobody is waiting on it. */
  spend?: () => BudgetVerdict;
  /** How a new draft reaches the person who just watched the work happen. */
  notifier?: Notifier;
  now?: () => number;
}

export type ApprovalOutcome =
  | { ok: true; draft: SkillDraft; path: string }
  | { ok: false; error: string };

export class ReflectionEngine {
  /**
   * Agents with a reflection in flight.
   *
   * The cooldown is read from the database and a synthesis call takes seconds, so two turns that
   * finish together both see "no recent draft" and both write one. Cheap to prevent, and the symptom
   * — two near-identical drafts, minutes apart, for the same afternoon — is exactly what the cooldown
   * exists to avoid.
   */
  private readonly inFlight = new Set<string>();

  /** Both clocks — see `cooldown.ts`. */
  private readonly cooldowns: Cooldowns;
  private readonly tuning: Tuning;

  constructor(private readonly deps: ReflectionDeps) {
    this.tuning = { ...TUNING, ...deps.tuning };
    this.cooldowns = new Cooldowns(this.tuning, () => this.now());
  }

  /**
   * Whether a draft this pass writes should be approved without asking.
   *
   * Exactly `auto` and nothing else. The loader tolerates an unrecognised mode rather than
   * refusing to boot — a file it accepted yesterday must not stop it starting — so "anything that is
   * not off" would make a typo grant autonomy. The two failure directions are not symmetric: reading
   * a bad value as gated costs one approval, reading it as autonomous puts an unreviewed skill in
   * front of every agent here.
   */
  private get autonomous(): boolean {
    return this.deps.config.mode === "auto";
  }

  /** The two fields `notify.ts` reads, so it needs nothing else from this class. */
  private notifyDeps(): { notifyChat: boolean; notifier?: Notifier } {
    return { notifyChat: this.deps.config.notifyChat, ...(this.deps.notifier ? { notifier: this.deps.notifier } : {}) };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Look at a turn that has already replied, and maybe propose a skill.
   *
   * Never throws and never rejects. The caller is the tail of a turn whose answer has already gone
   * out; there is nothing left to fail, and an exception here would surface as an unhandled rejection
   * in a process that was otherwise fine.
   */
  async observe(turn: ObservedTurn): Promise<void> {
    try {
      await this.reflect(turn);
    } catch (err) {
      log.warn("reflection failed", { agent_id: turn.agentId, error: String(err) });
    }
  }

  /**
   * One reflection per agent at a time, the marker set and cleared by the same call.
   *
   * `observe` used to clear it in its own `finally`, for every turn — the one that returned here because
   * another reflection for its agent was already running included. A turn that only said "thanks" cleared
   * the marker of a synthesis still waiting on its model, and the next turn asking for a skill started a
   * second one beside it: two provider calls, and two drafts for one skill name in the queue.
   */
  private async reflect(turn: ObservedTurn): Promise<void> {
    if (this.deps.config.mode === "off") return;
    if (this.inFlight.has(turn.agentId)) return;
    this.inFlight.add(turn.agentId);
    try {
      await this.look(turn);
    } finally {
      this.inFlight.delete(turn.agentId);
    }
  }

  private async look(turn: ObservedTurn): Promise<void> {
    // Recorded on every turn, whether or not anything is proposed: the table's job is to know what an
    // agent's ordinary working set looks like, and it can only learn that from ordinary turns.
    const unfamiliar = this.deps.toolMemory.observe(
      turn.agentId,
      turn.steps.filter((step) => step.ok).map((step) => step.name),
    );

    const effort = this.cooldowns.accumulate(turn);

    const trigger = detectTrigger({
      userText: turn.userText,
      steps: turn.steps,
      minToolFailures: this.tuning.minToolFailures,
      effort,
      reflectAfter: this.tuning.reflectAfter,
      unfamiliarTools: unfamiliar,
    });
    if (!trigger) return;

    /**
     * The agent already wrote it down itself.
     *
     * Found live on 2026-09-01, on the very first explicit request. An agent that holds
     * `skill_create` hears "catet jadi skill ya" and calls the tool — which raises a *tool approval*
     * with the whole skill in it. The reflection pass then proposed the same skill through the drafts
     * gate, so one sentence produced two things for the operator to answer, about one skill, in two
     * different queues with two different lifecycles.
     *
     * Neither is wrong on its own and both are human-gated. But two proposals for one skill is a
     * review surface nobody trusts, and the agent's own is the better of the two here: it is what the
     * person was answering when they asked, and it did not cost a second provider call. So the loop
     * yields.
     *
     * Only on *success*: a `skill_create` that was denied or that failed leaves nothing written, and
     * that is precisely a turn worth reflecting on.
     */
    if (turn.steps.some((step) => step.name === "skill_create" && step.ok)) {
      // Counted as looked-at: the lesson was captured, through the other gate. Leaving the counter
      // high would have the loop re-propose the same thing on the very next turn.
      this.cooldowns.spend(turn.sessionId);
      log.info("reflection skipped: the agent wrote the skill itself this turn", {
        agent_id: turn.agentId,
      });
      return;
    }

    /**
     * The cooldown, and the one thing that ignores it.
     *
     * A person asking for a skill is not noise, so `user_request` skips both the cooldown and the
     * pending ceiling. Everything else waits its turn: an afternoon on one broken system produces a
     * dozen turns that all look like error recovery, and a dozen near-identical drafts is how a
     * review queue stops being read.
     */
    const explicit = trigger.kind === "user_request";
    if (!explicit) {
      // A draft written, or a pass that looked and declined — both mean this agent has just been
      // asked, and only the first survives a restart.
      if (this.cooldowns.tooSoonToLook(turn.agentId, this.deps.drafts.lastDraftAt(turn.agentId) ?? 0)) {
        log.debug("reflection skipped: still inside the cooldown", { agent_id: turn.agentId });
        return;
      }

      if (this.deps.drafts.pendingCount() >= this.tuning.maxPending) {
        log.info("reflection skipped: the drafts queue is full", {
          agent_id: turn.agentId,
          pending: this.deps.drafts.pendingCount(),
        });
        return;
      }
    }

    const agent = this.deps.registry.get(turn.agentId);
    if (!agent) return;

    // After every check that costs nothing, before the calls that cost: the turn that crossed the cap has answered.
    const verdict = this.deps.spend?.();
    if (verdict?.action === "refuse") {
      log.info("reflection skipped: over today's cap", { agent_id: turn.agentId });
      return;
    }

    let provider: LLMProvider;
    try {
      provider = metered(
        this.deps.providers.get(agent.config.llm.provider),
        meter(this.deps.usage, { agentId: agent.config.id, provider: agent.config.llm.provider, purpose: "reflection", ...(turn.turnId ? { turnId: turn.turnId } : {}) }),
      );
    } catch (err) {
      // A profile that cannot be resolved is the operator's problem, not this turn's, and it has
      // already been reported by everything that actually needed it.
      log.warn("reflection has no provider", { agent_id: turn.agentId, error: String(err) });
      return;
    }

    /**
     * The counter is spent here, and **not one line earlier**.
     *
     * It used to be reset the moment a trigger matched, which threw the accumulated work away even
     * when the cooldown or the pending ceiling then refused to look — so a conversation that did real
     * work during a quiet hour started again from zero, and that work was never examined at all.
     * Replaying this box's 550 recorded turns put the loss at 14 reflections, an eighth of the total.
     * The counter means "how long since we last **looked**", and declining to look is not looking.
     */
    this.cooldowns.spend(turn.sessionId);
    // Marked here, not after the call: what starts the cooldown is *having looked*, and a call that
    // throws has still spent the money.
    this.cooldowns.looking(turn.agentId);

    /**
     * A chain trigger reads the chain; everything else reads the turn.
     *
     * Not always the chain, though it would be simpler: on a single-turn trigger the extra history
     * would be whatever unrelated thing was discussed before it — noise the pass has to read past,
     * in a call that is already the only cost this feature has. Where the chain *is* the point, it
     * is the whole point: the reasoning that found the answer is in the turns that failed, not in
     * the one that worked, and `buildTranscript` now compresses the head instead of dropping it so
     * those turns are actually in what the pass reads.
     */
    const source = trigger.kind === "sustained_effort" ? turn.chain : turn.messages;
    const { text: transcript, redactions } = buildTranscript(source);
    const model = helperModel(this.deps.config.model, agent.config.llm, this.deps.llmDefaults ?? { provider: "" }) || agent.config.llm.model;
    const existing = await readPool(this.deps.agentsDir, this.deps.builtinSkillsDir);

    const synthesized = await synthesizeSkill({
      provider,
      model,
      transcript,
      trigger,
      existing: await Promise.all(
        existing.map(async (skill) => ({
          name: skill.name,
          description: skill.description,
          /**
           * Listed whatever it is, marked by who keeps it — see `renderSkillList`.
           *
           * A skill the pass may not write to still has to appear, or it cannot be recognised as
           * covering the ground and declined as a duplicate. `author` is set by this loop when it
           * writes one, so its absence in the shared pool means a person wrote the file by hand;
           * `builtin` is ours and is absent from `author` for a different reason. See `Skill.author`.
           */
          owner: skill.scope === "builtin" ? "nouride" : skill.author ? "agent" : "person",
          ...(await breadthOf(skill)),
        })),
      ),
      readSkill: (name) => readSkill(existing, name, this.deps.drafts),
      listSkillFiles: (name) => listSkillFiles(existing, name),
      readSkillFile: (name, path) => readSkillFile(existing, name, path),
      candidates: (this.deps.candidates?.list() ?? []).map((held) => ({ name: held.name, description: held.description, day: new Date(held.lastSeenAt).toISOString().slice(0, 10) })),
      gate: (create) => writeNow(this.deps.candidates, create, { trigger, agentId: turn.agentId, sessionId: turn.sessionId, audit: this.deps.audit }),
    });
    if (!synthesized) return;

    const refused = await refusalOf(synthesized, existing, this.deps.drafts);
    if (refused) {
      log.info("reflection draft refused", { agent_id: turn.agentId, skill: synthesized.name, reason: refused });
      this.deps.audit?.record({ action: "skill_draft_refused", agentId: turn.agentId, details: { skill: synthesized.name, reason: refused } });
      return;
    }

    /**
     * This skill was written minutes ago without anybody being asked. Leave it alone.
     *
     * Checked here rather than before the provider calls, because the name is what the check is
     * about and triage is what produces it. That costs one pass on a repeat, and the alternative —
     * an early gate keyed on the agent — costs every *other* lesson that agent might have had in
     * the window, which is the wrong thing to spend to save a call.
     *
     * `user_request` never reaches this: an explicit ask skips the cooldown block above and lands
     * here only when somebody typed the words, and a person asking twice means they meant it.
     */
    if (trigger.kind !== "user_request" && this.cooldowns.tooSoonToRewrite(synthesized.name)) {
      log.debug("reflection skipped: this skill was written without asking a moment ago", {
        agent_id: turn.agentId,
        skill: synthesized.name,
      });
      return;
    }

    /**
     * A create for a name that is taken is dropped; an update for it is the whole point.
     *
     * This check used to be unconditional, and it was the single biggest reason the loop produced
     * nothing: on the live box 8 of 39 refusals were "already covered by an existing skill". Now
     * that the pass can improve one, the same collision means the opposite thing.
     */
    if (!synthesized.target && existing.some((skill) => skill.name === synthesized.name)) {
      log.info("reflection proposed a skill that already exists", { skill: synthesized.name });
      return;
    }
    /**
     * A draft for this skill is already waiting, so this one was written on top of it — see
     * `readSkill`. It replaces it, whichever session it came from.
     *
     * This used to stack instead: same session replaced, a different session queued alongside, on
     * the reasoning that two conversations learned two different things and the daemon should not
     * decide one is redundant. Watched on the live box on 2026-09-08 that produced four pending
     * drafts for `infrastructure-ops`, from two agents, and each body was a full rewrite that
     * contained none of the others' lessons — one had the `lxc-attach` fix, one had Headlamp, one had
     * the macOS cleanup. `updateExistingSkill` overwrites the body whole, so approving all four
     * would have kept only the last and silently dropped three.
     *
     * The reasoning was not wrong, the mechanism was. Nothing here decides a lesson is redundant:
     * the newer draft is built from the older one's body, so it carries both and the queue holds one
     * decision instead of four that quietly cancel each other.
     */
    const waiting = this.deps.drafts.pendingByName(synthesized.name);
    if (waiting) {
      // Hard-deleted rather than left as history: it was never decided, and a reviewer scrolling two
      // versions of the same unapproved proposal cannot tell which one the daemon means.
      this.deps.drafts.deny(waiting.id);
      log.info("reflection superseded a waiting draft", {
        skill: synthesized.name,
        replaced: waiting.id,
        same_session: waiting.sessionId === turn.sessionId,
      });
    }

    /**
     * The model's own output is scrubbed too, not only what it read.
     *
     * The instruction tells it to leave credentials out. This is what happens when it does not, and
     * it is not hypothetical: a transcript's masked token can be reconstructed by a model that saw
     * the surrounding text. What was masked is said out loud on the draft, because a reviewer reading
     * `[redacted:api-key]` in a procedure needs to know that is the daemon's doing and not the
     * agent's idea of documentation.
     */
    const scrubbedBody = redactAll(synthesized.body, synthesized.description);
    const masked = [...new Set([...redactions, ...scrubbedBody.hits])];

    const draft = this.deps.drafts.create({
      agentId: turn.agentId,
      gatewayId: turn.gatewayId,
      chatId: turn.chatId,
      sessionId: turn.sessionId,
      triggerKind: trigger.kind,
      // The model's own account wins over the counter. "12 steps of work in this conversation" says
      // why the daemon looked; "you corrected the sort order twice" says why it is proposing, and
      // that is the sentence the person deciding actually needs.
      triggerReason: [synthesized.why || trigger.reason, ...(masked.length > 0 ? [`masked: ${masked.join(", ")}`] : [])].join(REASON_SEPARATOR),
      /**
       * The waiting draft's history, plus the waiting draft's own lesson.
       *
       * Built from the earlier draft's `carries` rather than by taking its reason apart repeatedly:
       * everything before it is already in that list, so this appends exactly one entry per round.
       */
      ...(waiting ? { carries: [...waiting.carries, lessonOf(waiting.triggerReason)] } : {}),
      name: synthesized.name,
      description: scrubbedBody.description,
      requires: synthesized.requires,
      ...(synthesized.needsTools ? { needsTools: synthesized.needsTools } : {}),
      body: scrubbedBody.body,
      ...(synthesized.target ? { target: synthesized.target } : {}),
      /**
       * The superseded draft's files come along, unless this one replaces them by name.
       *
       * The body is inherited through `readSkill`, but support files are not in the body — they were
       * only ever attached to a draft that is about to be deleted. Without this, an improvement that
       * retires a draft shipping `references/grafana.md` writes a body pointing at a file nobody
       * ever creates. Both live drafts on the box carried one, so this was one approval away.
       *
       * Scrubbed like the body: a reference file is written into the pool and read by every agent
       * that follows the pointer, so it is exactly as bad a place for a credential.
       */
      ...(() => {
        const carried = new Map<string, string>();
        for (const file of waiting?.files ?? []) carried.set(file.path, file.content);
        for (const file of synthesized.files) carried.set(file.path, redact(file.content).text);
        return carried.size > 0
          ? { files: [...carried].map(([path, content]) => ({ path, content })) }
          : {};
      })(),
      transcript,
      model,
    });

    this.deps.audit?.record({
      action: "skill_draft_created",
      agentId: turn.agentId,
      actor: "system",
      gatewayId: turn.gatewayId,
      chatId: turn.chatId,
      details: { draft: draft.id, skill: draft.name, trigger: trigger.kind },
    });
    log.info("skill draft raised", {
      agent_id: turn.agentId,
      draft: draft.id,
      skill: draft.name,
      trigger: trigger.kind,
    });

    const superseded = Boolean(waiting && waiting.sessionId === turn.sessionId);

    /**
     * `auto` — the loop closed, which is what Hermes does.
     *
     * Approved through the same `approve` path a person uses rather than by writing the file here.
     * That path is where the hand-written-skill guard lives, where provenance is merged, where the
     * registry is reloaded and where the audit row is written; a second writer that skipped it would
     * be a second set of rules for the same act, and the one that gets forgotten is always the one
     * nobody sees run.
     *
     * `actor` says the daemon did it, not a person. "Who let this in" has to have a truthful answer,
     * and `skill-learning:auto` is one that also says *why* nobody was asked.
     *
     * A failure here is logged and nothing else: the draft stays pending, which is the same state
     * `ask` would have left it in, so the worst case is that somebody has to press the
     * button. The turn it came from is long finished and there is nobody to tell.
     */
    if (this.autonomous) {
      const outcome = await this.approve(draft.id, "skill-learning:auto");
      if (outcome.ok) {
        log.info("skill draft approved without asking", {
          agent_id: turn.agentId,
          draft: draft.id,
          skill: draft.name,
          path: outcome.path,
        });
        this.cooldowns.wrote(draft.name);
        await announceAccepted(this.notifyDeps(), draft, superseded);
        return;
      }
      log.warn("could not approve a draft automatically, so it stays pending", {
        draft: draft.id,
        skill: draft.name,
        error: outcome.error,
      });
    }

    await announceDraft(this.notifyDeps(), draft, superseded);
  }

  // --- the two decisions a human makes ------------------------------------------------------

  /** `skill_improve`, in `propose.ts` — the deps it needs, and nothing more of this class. */
  async propose(input: Parameters<typeof proposeImprovement>[1]) {
    return await proposeImprovement(
      {
        agentsDir: this.deps.agentsDir,
        ...(this.deps.builtinSkillsDir ? { builtinSkillsDir: this.deps.builtinSkillsDir } : {}),
        drafts: this.deps.drafts,
        maxPending: this.tuning.maxPending,
        notify: this.notifyDeps(),
        ...(this.deps.audit ? { audit: this.deps.audit } : {}),
      },
      input,
    );
  }

  /** For `skills-hub`: the queue an installed skill waits in, and who hears about it. See `install.ts`. */
  installDeps(): InstallDeps { return { drafts: this.deps.drafts, maxPending: () => this.tuning.maxPending, notify: this.notifyDeps(), ...(this.deps.audit ? { audit: this.deps.audit } : {}) }; }

  /** Every pending draft under one name — see `DraftStore.pendingAllByName`. */
  pendingAllByName(name: string): SkillDraft[] {
    return this.deps.drafts.pendingAllByName(name);
  }

  pending(): SkillDraft[] {
    return this.deps.drafts.pending();
  }

  recent(limit?: number): SkillDraft[] {
    return this.deps.drafts.recent(limit);
  }

  get(id: string): SkillDraft | null {
    return this.deps.drafts.get(id);
  }

  resolve(reference: string): SkillDraft | null {
    return this.deps.drafts.resolve(reference);
  }

  /** The weekly review of the library (`review.ts`) — its own entry, on the same agents, providers and drafts. */
  get library(): LibraryReview {
    this.review ??= new LibraryReview({ ...this.deps, now: () => this.now() });
    return this.review;
  }
  private review: LibraryReview | undefined;

  /**
   * Approve: write the skill into the pool and reload every pack.
   *
   * Exactly what `skill_create` does, through the same writer. A new skill is on for the agent that learned it
   * (`agents:`), an update reaches whoever has it, and a merge or an archive moves the retired skills to `.archive/`.
   *
   * The row is marked approved only after the write succeeded and the reload did. A draft marked
   * approved beside a pool that does not have the skill is the one state nobody could diagnose from
   * either surface.
   */
  async approve(id: string, by: string, edits?: DraftEdits): Promise<ApprovalOutcome> {
    const draft = this.deps.drafts.get(id);
    if (!draft) return { ok: false, error: `no draft "${id}"` };
    if (draft.status !== "pending") {
      return { ok: false, error: `draft "${draft.name}" was already ${draft.status}` };
    }

    const fields = applyEdits(draft, edits ?? {});
    if (!VALID_SKILL_NAME.test(fields.name)) {
      return { ok: false, error: `"${fields.name}" is not a valid skill name` };
    }

    /**
     * A skill a person wrote is not the loop's to rewrite, checked again here.
     *
     * The triage step already refuses to name one, so reaching this is either a draft raised before
     * somebody replaced an agent's skill with their own, or a client calling the route directly.
     * Both are exactly why the check is repeated at the write: the first gate is advice to a model
     * and this one is the rule.
     */
    // A create is checked too: a new skill under a built-in's name would shadow it. See `writeRefusal`.
    const refusal = await writeRefusal(this.deps.agentsDir, this.deps.builtinSkillsDir, draft.target ?? fields.name, !draft.target);
    if (refusal) return { ok: false, error: refusal };

    const today = new Date(this.now()).toISOString().slice(0, 10);
    const document = {
      name: fields.name,
      description: fields.description,
      ...(fields.requires ? { requires: fields.requires } : {}),
      ...(fields.needsTools ? { needsTools: fields.needsTools } : {}),
      body: fields.body,
      author: draft.agentId,
      verifiedBy: by,
      ...installedFields(draft),
      ...(draft.files.length > 0 ? { files: draft.files } : {}),
      ...(draft.removeFiles.length > 0 ? { removeFiles: draft.removeFiles } : {}),
    };

    /**
     * Two verbs, one gate.
     *
     * `updateExistingSkill` overwrites and keeps the original `author` and `created`; `writeNewSkill`
     * refuses to overwrite. Which one runs is decided by the draft, not by whether a file happens to
     * be there — an update whose target was deleted while the draft waited must fail loudly rather
     * than quietly becoming a create.
     */
    // A proposal to archive a skill retires the skill it names, and writes nothing.
    const archiveOnly = draft.retire.includes(draft.name);
    const written = archiveOnly
      ? { ok: true as const, path: "" }
      : draft.target
      ? await updateExistingSkill(this.deps.agentsDir, { ...document, updated: today })
      : await writeNewSkill(this.deps.agentsDir, {
          ...document,
          created: today,
          // On for the agent whose work it came from; another turns it on in its `skills.toml`. An installed skill was
          // asked for by name, for whoever wants it.
          ...(draft.triggerKind !== "external_install" ? { agents: draft.agentId } : {}),
        });
    if (!written.ok) return { ok: false, error: written.error };
    // After the write: a merge's others are archived only once the skill that holds them is on disk.
    const archived: string[] = [];
    const archivedTo: string[] = [];
    for (const name of draft.retire) {
      const moved = await archivePoolSkill(this.deps.agentsDir, name);
      if (moved.ok) {
        archived.push(name);
        archivedTo.push(moved.path);
      } else log.warn("an approved draft could not archive a skill", { draft: id, skill: name, error: moved.error });
    }

    try {
      await this.deps.registry.reloadAll();
    } catch (err) {
      // Said plainly rather than reported as success. The file is on disk and the prompts are stale,
      // which is a state somebody has to know about to fix.
      return { ok: false, error: `wrote ${written.path} but reloading the agents failed: ${String(err)}` };
    }

    this.deps.drafts.markApproved(id, by, written.path || archivedTo[0] || "");
    this.deps.audit?.record({
      action: draft.target ? "skill_draft_updated" : "skill_draft_approved",
      agentId: draft.agentId,
      actor: by,
      details: {
        draft: id,
        skill: fields.name,
        path: written.path,
        ...(draft.target ? { updated: draft.target } : {}),
        ...(draft.files.length > 0 ? { files: draft.files.map((file) => file.path) } : {}),
        // What left the pool — the audit row of an archive otherwise names a skill and an empty path.
        ...(archived.length > 0 ? { archived } : {}),
      },
    });
    log.info(archiveOnly ? "skill archived" : draft.target ? "skill improved" : "skill draft approved", {
      draft: id,
      skill: fields.name,
      actor: by,
      ...(archived.length > 0 ? { archived } : {}),
    });

    return { ok: true, draft: this.deps.drafts.get(id)!, path: written.path };
  }

  /** Discard: the row goes, transcript and all. */
  deny(id: string, by: string): boolean {
    const draft = this.deps.drafts.get(id);
    if (!draft || draft.status !== "pending") return false;

    this.deps.drafts.deny(id);
    this.deps.audit?.record({
      action: "skill_draft_denied",
      agentId: draft.agentId,
      actor: by,
      details: { draft: id, skill: draft.name },
    });
    log.info("skill draft discarded", { draft: id, skill: draft.name, actor: by });
    return true;
  }
}

/** The draft's fields with a human's corrections applied. Anything absent keeps what the model wrote. */
function applyEdits(
  draft: SkillDraft,
  edits: DraftEdits,
): { name: string; description: string; requires: string; needsTools: string; body: string } {
  return {
    name: (edits.name ?? draft.name).trim().toLowerCase(),
    description: (edits.description ?? draft.description).trim(),
    requires: (edits.requires ?? draft.requires).trim(),
    needsTools: (edits.needsTools ?? draft.needsTools).trim(),
    body: (edits.body ?? draft.body).trim(),
  };
}

/** Scrub the two fields that end up in a file every agent reads on every turn. */
function redactAll(
  body: string,
  description: string,
): { body: string; description: string; hits: string[] } {
  const scrubbedBody = redact(body);
  const scrubbedDescription = redact(description);
  return {
    body: scrubbedBody.text,
    description: scrubbedDescription.text,
    hits: [...new Set([...scrubbedBody.hits, ...scrubbedDescription.hits])],
  };
}

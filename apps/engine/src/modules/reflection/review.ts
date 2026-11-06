/**
 * The weekly review's entry: run now, run when due, and what the last one said (`curator.ts` does the reading).
 *
 * Beside the reflection engine rather than inside it: it shares the agents, providers, drafts and clock, and none of a
 * turn's state — no trigger, no cooldown, no conversation.
 */

import { createLogger, helperModel, type InstallTiers, type LLMProvider, type SkillLearningSection } from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import type { AuditPort, SkillRead } from "@/commons/audit.store.ts";
import type { BudgetVerdict } from "@/modules/llm/budget.ts";
import { meter, metered } from "@/modules/llm/metered.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import { REVIEW_EVERY_DAYS, reviewLibrary, type ReviewReport } from "./curator.ts";
import type { DraftsPort } from "./drafts.store.ts";
import type { ReviewStore } from "./reviews.store.ts";

const log = createLogger("reflection.review");

export interface LibraryReviewDeps {
  config: SkillLearningSection;
  /** `[llm.defaults]`, for a `model` that names a tier (0.8.0) — the engine's own, passed through. */
  llmDefaults?: InstallTiers;
  drafts: DraftsPort;
  registry: AgentRegistry;
  providers: ProviderRegistry;
  agentsDir: string;
  builtinSkillsDir?: string;
  audit?: AuditPort;
  usage?: Pick<UsagePort, "record">;
  spend?: () => BudgetVerdict;
  /** When the review ran. Absent, there is no review. */
  reviews?: ReviewStore;
  /** When each skill was last read, from the audit log — what the review archives by. */
  lastRead?: (paths: string[]) => Map<string, SkillRead>;
  now: () => number;
}

export class LibraryReview {
  private running = false;

  constructor(private readonly deps: LibraryReviewDeps) {}

  /**
   * The review now — `nouride skills review` and the dashboard. Its proposals are drafts that wait in every mode. `why` it
   * was refused is for the dashboard's words at its route (0.8.20); `refused` is the CLI's.
   */
  async run(): Promise<ReviewReport | { refused: string; why: "off" | "running" | "spend" }> {
    if (!this.deps.reviews) return { refused: "the review is not wired in this process", why: "off" };
    if (this.running) return { refused: "a review is already running", why: "running" };
    if (this.deps.spend?.().action === "refuse") return { refused: "over today's cap", why: "spend" };
    this.running = true;
    try {
      const report = await reviewLibrary({
        agentsDir: this.deps.agentsDir,
        ...(this.deps.builtinSkillsDir ? { builtinSkillsDir: this.deps.builtinSkillsDir } : {}),
        drafts: this.deps.drafts,
        lastRead: this.deps.lastRead ?? (() => new Map()),
        asker: (agentId) => this.asker(agentId),
        now: this.deps.now,
      });
      this.deps.reviews.record(report);
      this.deps.audit?.record({ action: "skill_review_ran", details: { ...report } });
      return report;
    } finally {
      this.running = false;
    }
  }

  /** The review, when a week has passed since the last one and learning is on — the daily sweep's call. */
  async reviewIfDue(): Promise<ReviewReport | null> {
    if (this.deps.config.mode === "off" || !this.deps.reviews) return null;
    const last = this.deps.reviews.last();
    if (last && this.deps.now() - last.ranAt < REVIEW_EVERY_DAYS * 86_400_000) return null;
    const outcome = await this.run();
    return "refused" in outcome ? null : outcome;
  }

  /** When the last review ran and what it proposed, for the dashboard. */
  last(): { ranAt: number; report: ReviewReport } | null {
    return this.deps.reviews?.last() ?? null;
  }

  /** A metered provider for the review: the named agent's, or the first enabled one's. */
  private asker(agentId: string | undefined): { provider: LLMProvider; model: string; agentId: string } | null {
    const agent = (agentId ? this.deps.registry.get(agentId) : undefined) ?? this.deps.registry.enabled()[0];
    if (!agent) return null;
    try {
      const provider = metered(
        this.deps.providers.get(agent.config.llm.provider),
        meter(this.deps.usage, { agentId: agent.config.id, provider: agent.config.llm.provider, purpose: "reflection" }),
      );
      return { provider, model: helperModel(this.deps.config.model, agent.config.llm, this.deps.llmDefaults ?? { provider: "" }) || agent.config.llm.model, agentId: agent.config.id };
    } catch (err) {
      log.warn("the weekly review has no provider", { agent_id: agent.config.id, error: String(err) });
      return null;
    }
  }
}

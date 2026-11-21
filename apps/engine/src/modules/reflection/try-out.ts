/**
 * What learning would do with a conversation, with nothing kept: the replay a change to the pass is measured with.
 * Out of `index.ts`: it is asked for by a person measuring, never by a turn.
 */

import { helperModel, type InstallTiers, type LLMProvider, type SkillLearningSection } from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import { redact } from "@nouride/secrets";
import { meter, metered } from "@/modules/llm/metered.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import type { UsagePort } from "@/modules/llm/usage.store.ts";
import type { DraftsPort } from "./drafts.store.ts";
import { refusalOf } from "./gates.ts";
import { passInput } from "./pass-input.ts";
import { readPool, readSkill } from "./pool.ts";
import { synthesizeSkill } from "./synthesis.ts";

export interface TryDeps {
  config: SkillLearningSection;
  llmDefaults?: InstallTiers;
  drafts: DraftsPort;
  registry: Pick<AgentRegistry, "get">;
  providers: ProviderRegistry;
  agentsDir: string;
  builtinSkillsDir?: string;
  usage?: Pick<UsagePort, "record">;
}

/** What learning would do with a conversation, were it looked at now (`ReflectionEngine.tryOut`). */
export interface TryOut {
  decision: "nothing" | "create" | "update" | "attach";
  /** Triage's own line: why it would act, or why not. */
  why: string;
  /** The class named, or the skill to change. */
  name: string;
  description: string;
  /** The body's size as written, and the skill's before it (0 for a new one). */
  bodyChars: number;
  before: number;
  files: string[];
  /** Why the daemon would refuse what was written, the writer's second try included; null where it would be kept. */
  refused: string | null;
  /** Calls made to the model. */
  calls: number;
  model: string;
  triageModel: string;
}

/**
 * What learning would do with a conversation, and nothing kept: no candidate held, no draft, no file. For measuring
 * a change to the pass against recorded conversations before it ships: which model decides, what the prompts say.
 * The calls are real and are metered as a reflection's.
 */
export async function tryOut(deps: TryDeps, asked: { agentId: string; transcript: string; reason?: string; model?: string; triageModel?: string; decideOnly?: boolean }): Promise<TryOut | { error: string }> {
  const agent = deps.registry.get(asked.agentId);
  if (!agent) return { error: `no agent "${asked.agentId}"` };
  let calls = 0;
  let provider: LLMProvider;
  try {
    const real = metered(deps.providers.get(agent.config.llm.provider), meter(deps.usage, { agentId: agent.config.id, provider: agent.config.llm.provider, purpose: "reflection" }));
    provider = { ...real, chat: async (request) => ((calls += 1), await real.chat(request)) } as LLMProvider;
  } catch (err) {
    return { error: String(err) };
  }
  const tiers = deps.llmDefaults ?? { provider: "" };
  const model = asked.model?.trim() || helperModel(deps.config.model, agent.config.llm, tiers) || agent.config.llm.model;
  const triageModel = asked.triageModel?.trim() || model;
  const existing = await readPool(deps.agentsDir, deps.builtinSkillsDir);
  const out: TryOut = { decision: "nothing", why: "", name: "", description: "", bodyChars: 0, before: 0, files: [], refused: null, calls: 0, model, triageModel };
  const input = await passInput(deps.drafts, { provider, model, triageModel, transcript: redact(asked.transcript).text, existing, inPlay: [] }, { kind: "sustained_effort", reason: asked.reason?.trim() || "a recorded conversation, replayed" });
  const synthesized = await synthesizeSkill({
    ...input,
    ...(asked.decideOnly ? { decideOnly: true } : {}),
    // Handed back once as in a real pass, so what is reported is what would have been kept.
    refusal: (draft) => refusalOf(draft, existing, deps.drafts),
    nothing: (why) => (out.why = why),
    triaged: (triage) => {
      out.decision = triage.decision;
      out.why = triage.why;
      out.name = triage.decision === "create" ? triage.name : triage.target;
    },
  });
  out.calls = calls;
  if (!synthesized) return out;
  const before = synthesized.target ? await readSkill(existing, synthesized.target, deps.drafts) : null;
  return {
    ...out,
    name: synthesized.name,
    description: synthesized.description,
    bodyChars: synthesized.body.length,
    before: before === null ? 0 : before.replace(/^---[\s\S]*?\n---\n/, "").trim().length,
    files: synthesized.files.map((file) => file.path),
    refused: await refusalOf(synthesized, existing, deps.drafts),
  };
}

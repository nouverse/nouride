/**
 * A reflection engine over a real database and a model whose answers a test scripts: what the pass asked, of which
 * model, is kept for the test to read. For the tests of what learning looks at and what it writes
 * (`learning-sources.test.ts`, `revision-edits.test.ts`); `gates.test.ts` keeps its own, older and smaller.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SqliteDb } from "@nouride/runtime";
import type { ChatMessage, LLMProvider, SkillLearningSection } from "@nouride/shared";
import type { AgentRegistry } from "@nouride/persona";
import type { AuditEntry, AuditPort } from "@/commons/audit.store.ts";
import { migrate } from "@/db/index.ts";
import type { ProviderRegistry } from "@/modules/llm/providers.ts";
import { CandidateStore, DraftStore, ReflectionEngine, ToolMemory } from "@/modules/reflection/index.ts";
import type { Tuning } from "@/modules/reflection/tuning.ts";
import { fakeAgent } from "../helpers.ts";

const dirs: string[] = [];
export const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "nouride-learning-"));
  dirs.push(dir);
  return dir;
};
/** Every folder a test of this file made, removed: for `afterEach`. */
export const removeTempDirs = (): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

export const createAnswer = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ decision: "create", name: "restart-stuck-ingress", description: "Use when the ingress answers 502 after a node reboot.", closest: "none", why_not_update: "n/a", why: "a fix that worked", ...extra });
export const skipAnswer = (reason = "a question answered, nothing done"): string => JSON.stringify({ decision: "skip", reason });
export const updateAnswer = (target: string, why = "a step was missing"): string => JSON.stringify({ decision: "update", target, why });
export const SKILL_ANSWER = JSON.stringify({ name: "restart-stuck-ingress", description: "Use when the ingress answers 502 after a node reboot.", requires: "kubectl", body: "## When to Use\n- 502 after a reboot\n\n## Procedure\n1. `kubectl rollout restart deploy/<ingress>`" });

/** One request the pass made: which call it was, on which model, and everything it was sent as one text. */
export interface Asked {
  triage: boolean;
  model: string;
  prompt: string;
}

export interface HarnessOptions {
  /** Triage's answers, one a call, the last from then on. */
  triage?: string | string[];
  /** The writing call's answers, likewise. */
  written?: string | string[];
  agentsDir?: string;
  mode?: SkillLearningSection["mode"];
  /** `[skills.learning] model`. */
  model?: string;
  tuning?: Partial<Tuning>;
  /** The agent's own small model, where it has one. */
  smallModel?: string;
  /** Conversations as the session store would return them, by id. */
  conversations?: Record<string, ChatMessage[]>;
  /** Made to wait before each triage answer: a pass still in flight when the next thing happens. */
  triageWaits?: () => Promise<void>;
}

export function learning(options: HarnessOptions = {}) {
  const db: SqliteDb = openDatabase(join(tempDir(), "nouride.db"));
  migrate(db);
  const agentsDir = options.agentsDir ?? tempDir();
  let clock = Date.UTC(2026, 9, 22);
  const drafts = new DraftStore(db, () => clock);
  const candidates = new CandidateStore(db, () => clock);
  const asked: Asked[] = [];
  const audited: AuditEntry[] = [];
  const changed: string[] = [];
  const pick = (answers: string | string[] | undefined, fallback: string, nth: number): string => {
    const list = Array.isArray(answers) ? answers : [answers ?? fallback];
    return list[Math.min(nth, list.length) - 1]!;
  };
  const provider = {
    async chat(request: { model: string; messages: { content: string }[] }) {
      const triage = (request.messages[0]?.content ?? "").includes("what should happen to the skill");
      asked.push({ triage, model: request.model, prompt: request.messages.map((message) => message.content).join("\n") });
      if (triage) await options.triageWaits?.();
      const nth = asked.filter((one) => one.triage === triage).length;
      return { text: triage ? pick(options.triage, createAnswer(), nth) : pick(options.written, SKILL_ANSWER, nth), toolCalls: [], stopReason: "stop" as const, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;
  const base = fakeAgent();
  const agent = fakeAgent({ config: { ...base.config, llm: { ...base.config.llm, ...(options.smallModel ? { smallModel: options.smallModel } : {}) } } });
  const config: SkillLearningSection = { mode: options.mode ?? "ask", model: options.model ?? "", notifyChat: false };
  const engine = new ReflectionEngine({
    config,
    // No wait between two looks, and no failures needed: these tests look when they say so.
    tuning: { minToolFailures: 2, cooldownMs: 0, maxPending: 5, ...options.tuning },
    drafts,
    toolMemory: new ToolMemory(db, () => clock),
    candidates,
    conversation: (sessionId) => (options.conversations?.[sessionId] ? { gatewayId: "telegram:nouva", chatId: "123", messages: options.conversations[sessionId] } : null),
    conversationKept: (sessionId) => (options.conversations?.[sessionId]?.length ?? 0) > 0,
    skillChanged: (path) => void changed.push(path),
    registry: { get: (id: string) => (id === agent.config.id ? agent : undefined), reloadAll: async () => {} } as unknown as AgentRegistry,
    providers: { get: () => provider } as unknown as ProviderRegistry,
    agentsDir,
    audit: { record: (entry: AuditEntry) => void audited.push(entry) } as unknown as AuditPort,
    now: () => clock,
  });
  return {
    engine,
    drafts,
    candidates,
    asked,
    audited,
    changed,
    agentsDir,
    agent,
    /** How many of each call were made. */
    calls: () => ({ triage: asked.filter((one) => one.triage).length, written: asked.filter((one) => !one.triage).length }),
    hours: (hours: number) => void (clock += hours * 3_600_000),
    now: () => clock,
  };
}

/** A turn of `rounds` model round-trips in conversation `session`: enough of them is what makes the pass look. */
export const worked = (session: string, rounds: number, extra: { userText?: string; at?: number; messages?: ChatMessage[] } = {}) => {
  const userText = extra.userText ?? "benerin ingress-nya";
  const at = extra.at ?? 0;
  const messages: ChatMessage[] = extra.messages ?? [
    { role: "user", content: userText, timestamp: at },
    { role: "assistant", content: "fixed", timestamp: at },
  ];
  return { agentId: "nouva", gatewayId: "telegram:nouva", chatId: "123", sessionId: session, userText, messages, chain: messages, iterations: rounds, steps: [] };
};

/** Two failed steps and one that worked: a recovery, which the pass looks at whatever the work done. */
export const recovered = (session: string, userText = "kenapa ingress-nya 502") => ({
  ...worked(session, 2, { userText }),
  steps: [{ name: "exec", ok: false }, { name: "exec", ok: false }, { name: "exec", ok: true }],
});

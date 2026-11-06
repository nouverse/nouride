/**
 * What changed in memory, as a person reads it — `memory_changes` in `069_baseline.sql`.
 *
 * Facts change without asking by default (`[memory] facts = "auto"`), so every writer that changes
 * one records it here: the nightly pass, a profile's tidy-up, an agent in a chat, an approved
 * proposal. Built from the operations each writer already applied and the facts as they were before,
 * so what is recorded is what happened to the file, not what a model said it would do.
 */

import type { Fact, FactOperation } from "./profile.ts";

export type ChangeKind = "added" | "updated" | "removed" | "merged";
export type ChangeCause = "pass" | "consolidation" | "agent" | "approval";

export interface MemoryChange {
  at: number;
  subject: string;
  change: ChangeKind;
  /** The fact as it now reads, or as it read when removed. */
  text: string;
  /** An update's old text; a merge's facts, one per line. */
  previous?: string;
  source?: string;
  cause: ChangeCause;
  /** Kept from a conversation its subject was not in: what someone else said about them. */
  secondhand?: true;
}

/** The changes a batch of applied operations made, given the facts they were numbered against. */
export function changesOf(
  before: readonly Fact[],
  applied: readonly FactOperation[],
  meta: { subject: string; cause: ChangeCause; source?: string; at: number; secondhand?: boolean },
): MemoryChange[] {
  const base = { at: meta.at, subject: meta.subject, cause: meta.cause, ...(meta.source ? { source: meta.source } : {}), ...(meta.secondhand ? { secondhand: true as const } : {}) };
  return applied.flatMap((operation): MemoryChange[] => {
    if (operation.op === "add") return [{ ...base, change: "added", text: operation.text }];
    const was = before.find((fact) => fact.n === operation.n)?.text;
    if (operation.op === "remove") return was ? [{ ...base, change: "removed", text: was }] : [];
    return [{ ...base, change: "updated", text: operation.text, ...(was ? { previous: was } : {}) }];
  });
}

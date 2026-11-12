/**
 * The list's decisions, apart from drawing it (`tests/automation-list.test.ts`): which automations are rows, the state
 * each is in, what its preview holds, and what the filter and the search keep.
 */

import type { AutomationStart, AutomationSummary } from "@nouride/wire";
import { stepsOf } from "./draft";
import { runWords, took, whenWords, type Tone } from "./runs";
import { mainText, type StepKind } from "./steps";

export type StartFilter = "all" | AutomationStart;

/**
 * The automations a list shows. A change an agent suggested to one is not a row of its own: the automation it would
 * change says a change waits, and opens to it. Shown on its own only when what it would change is gone.
 */
export function rows(automations: readonly AutomationSummary[]): AutomationSummary[] {
  const ids = new Set(automations.map((one) => one.id));
  return automations.filter((one) => !one.proposal?.replaces || !ids.has(one.proposal.replaces));
}

/** The state a row says, most pressing first: something waits for the person, it fails, it is off, or it is on. */
export function stateOf(automation: AutomationSummary, agentName: (id: string) => string): { word: string; tone: Tone } {
  if (automation.proposal) return { word: `Suggested by ${agentName(automation.proposal.by)}`, tone: "needs" };
  if (automation.lastRun?.status === "waiting" && automation.lastRun.waiting?.kind === "approval") return { word: "Waiting for you", tone: "needs" };
  if (automation.suggested) return { word: "A change is suggested", tone: "needs" };
  if (automation.failStreak > 0) return { word: "Failing", tone: "failed" };
  if (!automation.enabled) return { word: "Paused", tone: "quiet" };
  return { word: "On", tone: "done" };
}

/** At most this many steps are drawn in a row's preview; the rest are counted. */
const PREVIEW_MAX = 6;

export function previewOf(automation: AutomationSummary): { kinds: StepKind[]; more: number } {
  const kinds = stepsOf(automation.payload).map((step) => step.kind);
  return { kinds: kinds.slice(0, PREVIEW_MAX), more: Math.max(0, kinds.length - PREVIEW_MAX) };
}

/** A row's last run in words: when, and how it went. Null for one that never ran. */
export function lastRunLine(automation: AutomationSummary, now = Date.now()): { words: string; tone: Tone } | null {
  const run = automation.lastRun;
  if (!run) return null;
  const { label, tone } = runWords(run);
  const how = run.status === "success" && run.finishedAt !== undefined ? `done in ${took(run.finishedAt - run.startedAt)}` : label.toLowerCase();
  return { words: `${whenWords(run.startedAt, now)}, ${how}`, tone };
}

/** What the search box looks in: its name, its agent, and what each step says. */
export function searchedIn(automation: AutomationSummary, agentName: (id: string) => string): string[] {
  return [automation.name, automation.agentId, agentName(automation.agentId), ...stepsOf(automation.payload).flatMap((step) => [step.name ?? "", mainText(step)])];
}

export function matches(automation: AutomationSummary, filter: StartFilter): boolean {
  return filter === "all" || automation.start === filter;
}

/** How many rows each choice of the filter holds, for its dropdown. */
export function counts(automations: readonly AutomationSummary[]): Record<StartFilter, number> {
  const count: Record<StartFilter, number> = { all: automations.length, scheduled: 0, webhook: 0, manual: 0 };
  for (const one of automations) count[one.start] += 1;
  return count;
}

/** The filter the address names (`?start=`), or all of them for anything else. */
export function parseStart(value: unknown): StartFilter {
  return value === "scheduled" || value === "webhook" || value === "manual" ? value : "all";
}

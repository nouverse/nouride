/**
 * What a step and its paths are called, and how each kind looks: one table, so the list's preview, a card, its editor
 * and the picker that adds a step say the same thing about the same kind. The words are for a person who does not run
 * the server: what happens, never how it is stored.
 */

import { Bot, Clock, Hand, MessageSquare, Play, Target, Terminal, Zap, type LucideIcon } from "lucide-react";
import type { AutomationStart } from "@nouride/wire";
import { APPROVAL_WAIT_MS, canWatch, exitOf, exitsOf, landsAt, mainText, type ExitName, type Step, type StepKind } from "./steps";

export interface KindLook {
  icon: LucideIcon;
  /** What the picker and the editor call it. */
  label: string;
  /** One line under it in the picker: what it does and what it costs. */
  hint: string;
  /** Its soft colour, as the tile behind its icon. */
  tile: string;
}

/** A soft colour a kind: peach for an agent's work, mint for what is sent, lavender for a mission, pink for what waits on you. */
export const KIND: Record<StepKind, KindLook> = {
  agentTurn: { icon: Bot, label: "Ask an agent", hint: "An agent works on it with its tools, and hands on what it found.", tile: "bg-primary/15 text-primary" },
  command: { icon: Terminal, label: "Run a command", hint: "A command on this server, with no AI. What it prints goes to the next step.", tile: "bg-base-content/[0.07] text-base-content/80" },
  systemEvent: { icon: MessageSquare, label: "Send a message", hint: "Your words, sent as written to where it reports. No AI.", tile: "bg-info/15 text-info" },
  mission: { icon: Target, label: "Start a mission", hint: "Long work, checked. The run waits until the mission ends.", tile: "bg-secondary/10 text-secondary" },
  approval: { icon: Hand, label: "Wait for your OK", hint: "The run stops and asks you. It goes on when you say yes.", tile: "bg-accent/15 text-accent" },
};

export const START: Record<AutomationStart, { icon: LucideIcon; label: string; tile: string }> = {
  scheduled: { icon: Clock, label: "Scheduled", tile: "bg-secondary/10 text-secondary" },
  webhook: { icon: Zap, label: "Webhook", tile: "bg-primary/15 text-primary" },
  manual: { icon: Play, label: "Manual", tile: "bg-base-content/[0.07] text-base-content/80" },
};

/** A step's title: the name a person gave it, or what its kind does. `agent` is who an agent's step is for. */
export function stepTitle(step: Step, agent: string): string {
  if (step.name?.trim()) return step.name.trim();
  switch (step.kind) {
    case "agentTurn":
      return `${agent} works on it`;
    case "command":
      return "Run a command";
    case "systemEvent":
      return "Send a message";
    case "mission":
      return "Start a mission";
    case "approval":
      return "Wait for your OK";
  }
}

/** The one line under a step's title: the start of what it says, asks or runs. */
export function stepLine(step: Step): string {
  return mainText(step).trim().replace(/\s+/g, " ");
}

/** A path's question in a step's editor: what happened for the run to take it. */
export function exitAsks(step: Step, exit: ExitName): string {
  if (exit === "then") return step.kind === "approval" ? "When you say yes" : "When it is done";
  if (exit === "whenFailed") return step.kind === "approval" ? "When you say no, or nobody answers" : "When it fails";
  return "When it has nothing to say";
}

/** The same as a chip under the card begins it. */
export function exitChip(step: Step, exit: ExitName): string {
  if (exit === "then") return step.kind === "approval" ? "After your yes" : "Once done";
  if (exit === "whenFailed") return step.kind === "approval" ? "If you say no" : "If it fails";
  return "With nothing to say";
}

/** Where a path leads, in a few words: "go on", "end here", or a later step by its number and title. */
export function exitGoes(steps: readonly Step[], index: number, exit: ExitName, titleOf: (step: Step) => string): string {
  const go = exitOf(steps[index]!, exit);
  if (go === "end") return "end here";
  const to = landsAt(steps, index, exit);
  if (to === "end") return go === "next" ? "go on" : "end here";
  return go === "next" ? "go on" : `step ${to + 1}, ${titleOf(steps[to]!)}`;
}

/** What "end the run" means for a path, as its dropdown says it: a failure ends it failed, silence ends it quietly. */
export function endWords(exit: ExitName): string {
  if (exit === "whenFailed") return "End the run, as failed";
  return exit === "whenEmpty" ? "End the run quietly" : "End the run here";
}

/**
 * What happens after the last step, in place of its paths: the run ends, and how that end is counted. Said and not
 * chosen, since every choice there ends the run the same way.
 */
export function lastStepWords(step: Step): string {
  const ways = exitsOf(step);
  return [
    "This is the last step, so the run ends after it.",
    ...(ways.includes("whenFailed") ? [step.kind === "approval" ? "If you say no, or nobody answers, it ends there." : "If it fails, the run ends as failed."] : []),
    ...(ways.includes("whenEmpty") ? ["With nothing to say, it ends quietly."] : []),
  ].join(" ");
}

/** How long a wait is, in the unit a person says it in: "5 minutes", "1 hour", "3 days". */
function waitWords(ms: number): string {
  const [count, unit] = ms % 86_400_000 === 0 ? [ms / 86_400_000, "day"] : ms % 3_600_000 === 0 ? [ms / 3_600_000, "hour"] : [Math.round(ms / 60_000), "minute"];
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * The line under "Go on only when this changes": what the run does when the step says what it said the last time. It
 * takes the step's path for nothing to say, which ends the run quietly unless the step sends it elsewhere. A mission's
 * run ends there too, and not quietly: the mission has told its chat how it went by then, as every mission does.
 */
export function sameAgainWords(steps: readonly Step[], index: number): string {
  const step = steps[index]!;
  if (landsAt(steps, index, "whenEmpty") !== "end") return `If it says the same as last time, the run goes where "${exitAsks(step, "whenEmpty")}" sends it.`;
  return step.kind === "mission" ? "If it says the same as last time, the run ends here." : "If it says the same as last time, the run ends here quietly.";
}

/**
 * A few quiet words under a step's line: what it costs, what it is handed, or what it waits for, and that it goes on
 * only when what it says changes, where it is marked so. `reads` is the agent a lone command hands its output to,
 * where it does.
 */
export function stepNote(step: Step, index: number, reads?: string): string {
  const note = kindNote(step, index, reads);
  return step.onlyChanged && canWatch(step) ? `${note} It goes on only when what it says changes.` : note;
}

function kindNote(step: Step, index: number, reads?: string): string {
  switch (step.kind) {
    case "command":
      return reads ? `No AI runs it. Then ${reads} reads what it printed and reports.` : "No AI is used for this step.";
    case "systemEvent":
      return "Sent as written to where it reports. No AI.";
    case "agentTurn":
      return index === 0 ? "It works with its tools, and what it says goes on." : "It is handed what the step before said.";
    case "mission":
      return "The run waits here until the mission ends.";
    case "approval":
      return `The run waits up to ${waitWords(step.timeoutMs ?? APPROVAL_WAIT_MS)} for your answer.`;
  }
}

/**
 * What a step and its paths are called, and how each kind looks: one table, so the list's preview, a card, its editor
 * and the picker that adds a step say the same thing about the same kind. The words are for a person who does not run
 * the server: what happens, never how it is stored.
 */

import { Bot, Clock, Hand, MessageSquare, NotebookPen, Play, Split, Target, Terminal, Zap, type LucideIcon } from "lucide-react";
import type { AutomationStart } from "@nouride/wire";
import { pathsOf, type Choice, type PathExit, type Paths } from "./paths";
import { canWatch, exitOf, landsAt, mainText, shellLine, type ExitName, type Part, type Step, type StepKind, type StepPick } from "./steps";

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
  command: { icon: Terminal, label: "Run a script", hint: "A small program on this server, with no AI. What it prints goes to the next step.", tile: "bg-base-content/[0.07] text-base-content/80" },
  systemEvent: { icon: MessageSquare, label: "Send a message", hint: "Your words, sent as written to where it reports. No AI.", tile: "bg-info/15 text-info" },
  mission: { icon: Target, label: "Start a mission", hint: "Long work, checked. The run waits until the mission ends.", tile: "bg-secondary/10 text-secondary" },
  approval: { icon: Hand, label: "Wait for your OK", hint: "The run stops and asks you. It goes on when you say yes.", tile: "bg-accent/15 text-accent" },
  parallel: { icon: Split, label: "Several at the same time", hint: "Agents and commands that start together. What each says is joined and handed on.", tile: "bg-primary/15 text-primary" },
};

/**
 * How each thing "Add a step" offers looks: the kinds, and a mission that is drafted, in the mission's colour with a
 * mark of its own. A box and its fields' head are drawn with it, so a step that only drafts never reads "Start".
 */
export const PICK: Record<StepPick, KindLook> = {
  ...KIND,
  missionDraft: { icon: NotebookPen, label: "Draft a mission", hint: "Long work, left in the Backlog for you to start. The run goes on.", tile: KIND.mission.tile },
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
      // A script is called by what it is said to do: its own line is only the program that runs it.
      return step.script?.about.trim() || "Run a script";
    case "systemEvent":
      return "Send a message";
    case "mission":
      // One the run only drafts starts nothing: its box must not say it does.
      return step.draft ? "Draft a mission" : "Start a mission";
    case "approval":
      return "Wait for your OK";
    case "parallel":
      return `${step.steps.length} at the same time`;
  }
}

/**
 * What one of the steps started at the same time is called over its words: the name a person gave it, or whose turn it
 * is, or the command. `agent` is what that agent is called here; the run's own report names it as the daemon does.
 */
export function partTitle(part: Part, agent: string): string {
  if (part.name?.trim()) return part.name.trim();
  return part.kind === "command" ? (part.script?.about.trim() || shellLine(part.argv)) : agent;
}

/**
 * Who wrote a script, as a box says it: the agent's name for one an agent wrote, and nothing for one a person typed,
 * which a page read by several people cannot call "yours".
 */
export function scriptWriter(by: string | undefined, agentName: (id: string) => string): string | null {
  return by?.startsWith("agent:") ? agentName(by.slice("agent:".length)) : null;
}

/**
 * The one line under a step's title: the start of what it says, asks or runs. A script says what it is and who wrote
 * it, since its title already says what it does and its text is behind a button.
 */
export function stepLine(step: Step, agentName?: (id: string) => string): string {
  if (step.kind === "command" && step.script) {
    const writer = agentName ? scriptWriter(step.script.by, agentName) : null;
    return writer ? `A script ${writer} wrote · no AI` : "A script · no AI";
  }
  return mainText(step).trim().replace(/\s+/g, " ");
}

/** One of the four answers a path can be given, as the panel offers it: what it is called and what it does. */
export function choiceWords(step: Pick<Step, "kind">, exit: PathExit, choice: Choice, jumpsTo = ""): { label: string; hint: string } {
  const waits = step.kind === "approval";
  switch (choice) {
    case "stop":
      if (exit === "whenEmpty") return { label: "Stop quietly", hint: "The run ends, and nobody is told." };
      return waits ? { label: "Stop there", hint: "The run ends. Nothing is counted as failed." } : { label: "Stop and tell me", hint: "The run ends, and its chat is told why." };
    case "goOn":
      if (exit === "whenEmpty") return { label: "Go on anyway", hint: "The next step runs with nothing handed to it." };
      return { label: "Go on anyway", hint: waits ? "The next step is told the answer was no." : "The next step gets what this step was given. An agent is also told why it failed." };
    case "ask":
      return { label: "Ask me first", hint: "Yes goes on, no stops here." };
    case "lane":
      return { label: "Do something else", hint: "Other steps run in its place." };
    case "jump":
      return { label: `Go to ${jumpsTo}`, hint: "Set from elsewhere. Pick another answer to change it." };
  }
}

/** A step's own rule as its box says it, after the path's name: "the run goes on anyway." */
export const GOES_ON = "the run goes on anyway.";

/**
 * What a box says of a path left at a stop, after the path's name: the same words its answer has in the step's fields,
 * so the box and the choice never say two things. "If it fails, the run ends, and its chat is told why."
 */
export function stopsWords(step: Pick<Step, "kind">, exit: PathExit): string {
  const hint = choiceWords(step, exit, "stop").hint;
  return `${hint.charAt(0).toLowerCase()}${hint.slice(1)}`;
}

/**
 * A step as the page names it to a person: by its place on the main line as it is drawn, and a step that runs in
 * another's place by that step and its path. The list's own count called the third box "step 5" once a lane hung over
 * it, in the bar that says what a save still lacks.
 */
export function drawnName(steps: readonly Step[], at: number, paths: Paths = pathsOf(steps)): string {
  const place = paths.line.indexOf(at);
  if (place >= 0) return `Step ${place + 1}`;
  // Not on the line, it is a step of a rule (`pathsOf`): the line is every step that is not.
  const within = paths.inside.get(at)!;
  const owner = paths.line.indexOf(within.owner);
  // A question asked in a step's own box is that step's; a lane's step is the step's, on that path.
  return within.folded ? `Step ${owner + 1}` : `Step ${owner + 1}, ${exitChip(steps[within.owner]!, within.exit).toLowerCase()}`;
}

/** A step of the main line as another box names it: by its place and its title, since five steps can share a title. */
export const placeTitle = (place: number, title: string): string => (place >= 0 ? `step ${place + 1}, “${title}”` : `“${title}”`);

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

/**
 * Where a path leads, in a few words: "go on", "end here", or a later step by its number and title. Its number is its
 * place on the main line as drawn; a step of a lane has none, and is said by its title.
 */
export function exitGoes(steps: readonly Step[], index: number, exit: ExitName, titleOf: (step: Step) => string, paths: Paths = pathsOf(steps)): string {
  const go = exitOf(steps[index]!, exit);
  if (go === "end") return "end here";
  const to = landsAt(steps, index, exit);
  if (to === "end") return go === "next" ? "go on" : "end here";
  return go === "next" ? "go on" : landingName(steps, to, titleOf, paths);
}

/** A step a path lands on, as a list of where to go names it: "step 3, Tell me". A lane's step has no number. */
export function landingName(steps: readonly Step[], to: number, titleOf: (step: Step) => string, paths: Paths = pathsOf(steps)): string {
  const place = paths.line.indexOf(to);
  return place >= 0 ? `step ${place + 1}, ${titleOf(steps[to]!)}` : titleOf(steps[to]!);
}

/** What "end the run" means for a path, as its dropdown says it: a failure ends it failed, silence ends it quietly. */
export function endWords(exit: ExitName): string {
  if (exit === "whenFailed") return "End the run, as failed";
  return exit === "whenEmpty" ? "End the run quietly" : "End the run here";
}

/**
 * The line under "Go on only when this changes": what the run does when the step says what it said the last time. It
 * takes the step's path for nothing to say, which ends the run quietly unless the step sends it elsewhere. A mission's
 * run ends there too, and not quietly: the mission has told its chat how it went by then, as every mission does.
 */
export function sameAgainWords(steps: readonly Step[], index: number): string {
  const step = steps[index]!;
  if (landsAt(steps, index, "whenEmpty") !== "end") return `If it says the same as last time, the run goes where "${exitChip(step, "whenEmpty")}" sends it.`;
  return step.kind === "mission" ? "If it says the same as last time, the run ends here." : "If it says the same as last time, the run ends here quietly.";
}

/**
 * What a step's box says under its words besides its paths, each a sentence: who a lone command hands what it printed
 * to, and that the step goes on only when what it says changes, where it is marked so. Both change what a run does, so
 * neither is left to the step's fields. `reads`: that agent's name, where the command hands its output on.
 */
export function stepFacts(step: Step, reads?: string): string[] {
  return [...(step.kind === "command" && reads ? [`Then ${reads} reads what it printed and reports.`] : []), ...(step.onlyChanged && canWatch(step) ? ["It goes on only when what it says changes."] : [])];
}

/**
 * What a pressed box of the canvas opens: a step's fields, how the automation starts, or where its results go
 * (`use-editor.ts` holds which). The same fields wherever they are drawn: beside the canvas where there is room, in
 * the box itself where there is none.
 */

import { useMemo } from "react";
import type { AutomationSummary, GatewayInstance, JobRunSummary } from "@nouride/wire";
import { OPEN_RESULTS, OPEN_START, type Editor } from "../hooks/use-editor";
import { savesAsList, type Draft, type Then } from "../lib/draft";
import { pathsOf } from "../lib/paths";
import type { Step } from "../lib/steps";
import type { AgentChoice } from "./KindFields";
import { StartFields } from "./StartCard";
import { StepFields } from "./StepFields";
import { ResultsFields } from "./WhoCard";

/** What a step is handed in the last run: what the step before it said, for "Try it" to start from. */
function handedTo(runs: readonly JobRunSummary[], stepId: string): string | undefined {
  const outcomes = runs[0]?.steps ?? [];
  const at = outcomes.findIndex((outcome) => outcome.id === stepId);
  return at > 0 ? outcomes[at - 1]!.said : undefined;
}

/**
 * What a script's own button writes in the chat with the orchestrator, for the person to finish: the step and the
 * automation named, so the agent knows which one is meant. One with nothing written yet asks for it to be written.
 */
function scriptAsk(step: Step, title: string, automation: string | undefined): string {
  const where = automation ? `my automation "${automation}"` : "an automation I am making";
  return step.kind === "command" && step.script?.text.trim() ? `Change the script of the step "${title}" in ${where}: …` : `Write the script for the step "${title}" of ${where}. It should: …`;
}

/** Whether something of the canvas is open that has fields: one of its own boxes, or a step that is there. */
export const opensFields = (editor: Pick<Editor, "open" | "draft">): boolean =>
  editor.open === OPEN_START || editor.open === OPEN_RESULTS || editor.draft.steps.some((step) => step.id === editor.open);

export function OpenFields({
  editor,
  automation,
  runs,
  home,
  writable,
  admin,
  agents,
  agentName,
  gateways,
  titleOf,
  onChanged,
  onRemove,
  onWent,
}: {
  editor: Editor;
  /** The automation as it is saved; none for one being made. */
  automation: AutomationSummary | null;
  runs: readonly JobRunSummary[];
  /** The server's own time zone. */
  home: string;
  writable: boolean;
  admin: boolean;
  agents: readonly AgentChoice[];
  agentName: (id: string) => string;
  gateways: GatewayInstance[];
  titleOf: (step: Step) => string;
  /** Something of the automation itself was changed on the server: a webhook's new address. */
  onChanged: () => void;
  onRemove: (index: number) => void;
  /** Steps went with a path's old answer: the draft as it was, for an undo. */
  onWent: (kept: Draft) => void;
}) {
  const { draft, open } = editor;
  const paths = useMemo(() => pathsOf(draft.steps), [draft.steps]);
  const close = () => editor.setOpen(null);
  if (open === OPEN_START) return <StartFields draft={draft} automation={automation} home={home} writable={writable} admin={admin} set={editor.set} onChanged={onChanged} onDone={close} />;
  if (open === OPEN_RESULTS) return <ResultsFields draft={draft} fresh={automation === null} agents={agents} gateways={gateways} set={editor.set} onDone={close} />;
  const at = draft.steps.findIndex((step) => step.id === open);
  const step = draft.steps[at];
  if (!step) return null;
  const place = paths.line.indexOf(at);
  const alone = !savesAsList(draft) && step.kind === "command" ? { then: draft.then, agent: agentName(draft.agentId), onThen: (then: Then) => editor.set({ then }) } : null;
  return (
    <StepFields
      // Another step's fields are another form: nothing typed in one is carried into the next unseen.
      key={step.id}
      steps={draft.steps}
      index={at}
      place={place >= 0 ? place : null}
      paths={paths}
      own={draft.agentId}
      agents={agents}
      alone={alone}
      script={{
        agentId: draft.agentId,
        agentName,
        asks: scriptAsk(step, titleOf(step), automation?.name),
        sample: handedTo(runs, step.id),
      }}
      titleOf={titleOf}
      onStep={editor.setStep}
      onKind={(kind) => editor.setKind(at, kind)}
      onExit={(exit, go) => editor.setExit(at, exit, go)}
      onChoose={(exit, choice) => {
        const kept = editor.choose(at, exit, choice);
        if (kept) onWent(kept);
      }}
      onLaneEnd={(exit, ends) => editor.laneEnd(at, exit, ends)}
      onOwnLaneEnd={(ends) => {
        const within = paths.inside.get(at);
        if (within) editor.laneEnd(within.owner, within.exit, ends);
      }}
      onMove={place >= 0 ? (by) => editor.move(place, place + by) : null}
      onDuplicate={place >= 0 ? () => editor.duplicate(at) : null}
      onRemove={() => onRemove(at)}
      onDone={close}
    />
  );
}

/**
 * An automation's canvas with its panel: how it starts, its steps in order and where its results go, and beside them
 * what is open. On a screen with no room beside the canvas a pressed box opens in place, under itself: no sheet over
 * the page.
 */

import { useRef, type ReactNode } from "react";
import type { JobRunSummary } from "@nouride/wire";
import { OPEN_RESULTS, OPEN_START, type Editor } from "../hooks/use-editor";
import { usePanelRoom } from "../hooks/use-panel-room";
import { savesAsList, type Draft, type DraftProblem } from "../lib/draft";
import { whenWords } from "../lib/runs";
import type { Mark } from "../lib/suggested";
import { Flow } from "./Flow";
import { WhenBox } from "./StartCard";
import type { FlowMode } from "./StepItem";
import { ResultsBox } from "./WhoCard";

export function AutomationCanvas({
  shown,
  home,
  agentName,
  mode,
  marks,
  drawn,
  editor,
  editable,
  laptop,
  fields,
  run,
  lacks,
  beside,
}: {
  /** What is drawn: the draft, the automation as saved under a run, or a suggested change. */
  shown: Draft;
  /** The server's own time zone. */
  home: string;
  agentName: (id: string) => string;
  mode: FlowMode;
  marks?: ReadonlyMap<string, Mark> | undefined;
  /** Which way of showing it this is: the canvas is drawn anew for each, so one view's lit jump is not carried into the next. */
  drawn: string;
  editor: Editor;
  /** The boxes open to be changed. */
  editable: boolean;
  /** There is room beside the canvas for a pressed box's fields. */
  laptop: boolean;
  /** The fields of what is open, where something with fields is. */
  fields: ReactNode;
  /** The run drawn over the steps. */
  run: JobRunSummary | undefined;
  /** What a save lacks first: the box that holds it says so, in the bar's own words, one thing at a time. */
  lacks: DraftProblem | undefined;
  /** The panel's own content: what is open where there is room for it, or what it holds at rest. */
  beside: ReactNode;
}) {
  const { open } = editor;
  const panel = useRef<HTMLElement>(null);
  usePanelRoom(panel);
  const press = (key: string) => (editable ? () => editor.setOpen(open === key ? null : key) : undefined);
  const inPlace = (key: string): ReactNode => (!laptop && open === key ? fields : null);
  const lacking = (part: DraftProblem["part"]) => (editable && lacks?.part === part ? lacks.message : undefined);
  const step = editable && !laptop && fields ? shown.steps.find((one) => one.id === open) : undefined;
  return (
    <div className="flex flex-col items-start gap-5 xl:flex-row xl:gap-7">
      <div className="w-full min-w-0 xl:flex-1">
        <Flow
          key={drawn}
          steps={shown.steps}
          own={shown.agentId}
          agentName={agentName}
          reads={!savesAsList(shown) && shown.then === "agentTurn" ? agentName(shown.agentId) : undefined}
          mode={mode}
          marks={marks}
          inline={step ? { key: step.id, node: fields } : null}
          head={
            <WhenBox
              draft={shown}
              home={home}
              open={editable && open === OPEN_START}
              onPress={press(OPEN_START)}
              note={run ? `This run started ${whenWords(run.startedAt).replace(/^Today/, "today").replace(/^Yesterday/, "yesterday")}.` : undefined}
              missing={lacking("start")}
            >
              {inPlace(OPEN_START)}
            </WhenBox>
          }
          foot={
            <ResultsBox draft={shown} open={editable && open === OPEN_RESULTS} onPress={press(OPEN_RESULTS)} missing={lacking("who")}>
              {inPlace(OPEN_RESULTS)}
            </ResultsBox>
          }
        />
      </div>
      {/* Beside the canvas from the width `useDesktop` reads, which is where the page opens a box's fields there. It
          stays where it is while the page scrolls, as tall as the window has room for (`usePanelRoom`), and what it
          holds scrolls inside its own card (`FieldsFrame`): the card's edges, its title and its Done never leave. It
          was a box that scrolled whole cards under an edge nobody could see, a card's top and its Done with them.
          The margin under it takes its height back out of the row: it may stand lower than a short canvas ends, and
          the page is no taller for it. Its width is the room its card had inside the box that scrolled: a wider one
          left the canvas short of the room a lane needs beside its step. */}
      <aside ref={panel} data-panel className="w-full space-y-4 xl:sticky xl:top-4 xl:-mb-[var(--panel-room,calc(100dvh-13rem))] xl:flex xl:max-h-[var(--panel-room,calc(100dvh-13rem))] xl:w-[23.5rem] xl:shrink-0 xl:flex-col xl:gap-4 xl:space-y-0">
        {beside}
      </aside>
    </div>
  );
}

/**
 * The Missions board (from the mockup the owner signed off): four columns side by side on a wide window, four tabs
 * with their counts on a phone, one column shown. Finished has a head of its own: how far back it goes, and chips by
 * how they ended (none chosen is all of them; pressing the chosen one clears it), and only the first few with "N more"
 * at its foot. The other columns show everything that is open, however old.
 */

import { useState, type ReactNode } from "react";
import type { MissionView } from "@nouride/wire";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { useWide } from "@/commons/hooks/use-wide";
import { useMotionList, LEAVE, type Moving } from "@/commons/hooks/use-motion-list";
import { cn } from "@/commons/lib/utils";
import { COLUMNS, FINISHED_SPANS, columnOf, outcomeOf, type Column, type FinishedSpan, type Outcome } from "../lib/board";
import { BoardCard } from "./BoardCard";

const key = (mission: MissionView) => mission.id;

/** How many finished ones show before "N more": a column of them pushed the others' cards out of sight. */
const FINISHED_SHOWN = 5;

const OUTCOMES: readonly { id: Outcome; label: string; dot: string }[] = [
  { id: "done", label: "Done", dot: "bg-success" },
  { id: "failed", label: "Failed", dot: "bg-failed" },
  { id: "stopped", label: "Stopped", dot: "bg-base-content/40" },
];

const NONE: Record<Column, (days: number) => string> = {
  backlog: () => "No drafts. An agent's draft waits here until it is started.",
  working: () => "Nothing at work.",
  needs: () => "Nothing needs you.",
  finished: (days) => `Nothing finished in the last ${days} days.`,
};

export interface BoardState {
  /** The column a phone shows. */
  column: Column;
  setColumn: (next: Column) => void;
  days: FinishedSpan;
  setDays: (next: FinishedSpan) => void;
  outcome: Outcome | null;
  setOutcome: (next: Outcome | null) => void;
}

export function MissionBoard({
  missions,
  shown,
  counts,
  state,
  writable,
  showWhose,
  empty,
}: {
  /** Every mission listed, every column's. */
  missions: readonly MissionView[];
  /** What the search leaves: one it hides is not drawn, and neither leaves nor enters when it shows again. */
  shown: (mission: MissionView) => boolean;
  /** Each column's count, of every mission listed. */
  counts: Readonly<Record<Column, number>>;
  state: BoardState;
  writable: boolean;
  /** Whose each one is, on a list that is not the reader's own. */
  showWhose: boolean;
  /** Drawn in place of the columns while nothing is listed; the board stays mounted, so the first mission enters. */
  empty?: ReactNode;
}) {
  const wide = useWide();
  const [allFinished, setAllFinished] = useState(false);
  const inColumn = (column: Column) => missions.filter((mission) => columnOf(mission) === column);
  // Each column through the motion list: a mission that moves leaves one column and enters the next, lit.
  const moving: Record<Column, Moving<MissionView>[]> = {
    backlog: useMotionList(inColumn("backlog"), key, { shown }),
    working: useMotionList(inColumn("working"), key, { shown }),
    needs: useMotionList(inColumn("needs"), key, { shown }),
    finished: useMotionList(inColumn("finished"), key, { shown: (mission) => shown(mission) && (!state.outcome || outcomeOf(mission) === state.outcome) }),
  };
  const finished = inColumn("finished").filter(shown);
  const byOutcome = (outcome: Outcome) => finished.filter((mission) => outcomeOf(mission) === outcome).length;
  const staying = moving.finished.filter((one) => one.motion !== LEAVE);
  const shownFinished = allFinished ? moving.finished : moving.finished.filter((one) => one.motion === LEAVE || staying.indexOf(one) < FINISHED_SHOWN);

  const cards = (list: readonly Moving<MissionView>[], column: Column): ReactNode =>
    list.length === 0 ? (
      <p className="px-1 py-3 text-xs text-base-content/65" data-none={column}>
        {NONE[column](state.days)}
      </p>
    ) : (
      list.map(({ key: id, item, motion }) => <BoardCard key={id} mission={item} motion={motion} writable={writable} showWhose={showWhose} />)
    );

  const finishedHead = (
    <div className="space-y-2.5" data-finished-head>
      <SearchSelect
        small
        named
        label="Ended in"
        options={FINISHED_SPANS.map((span) => ({ value: String(span), label: `Last ${span} days` }))}
        value={String(state.days)}
        onChange={(next) => state.setDays(Number(next) as FinishedSpan)}
        width={176}
        align="start"
        className="w-full"
      />
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="How they ended">
        {OUTCOMES.map((outcome) => (
          <button
            key={outcome.id}
            type="button"
            aria-pressed={state.outcome === outcome.id}
            data-outcome={outcome.id}
            className={cn("btn btn-sm min-h-11 gap-1.5 rounded-full border-base-content/10 px-3 sm:min-h-8", state.outcome === outcome.id ? "btn-active" : "btn-ghost border")}
            onClick={() => state.setOutcome(state.outcome === outcome.id ? null : outcome.id)}
          >
            <span className={cn("size-2 rounded-full", outcome.dot)} aria-hidden="true" />
            {outcome.label} {byOutcome(outcome.id)}
          </button>
        ))}
      </div>
    </div>
  );

  const finishedFoot =
    !allFinished && staying.length > FINISHED_SHOWN ? (
      <button type="button" className="btn btn-ghost btn-sm min-h-11 w-full rounded-xl border border-dashed border-base-content/15 sm:min-h-8" onClick={() => setAllFinished(true)}>
        {staying.length - FINISHED_SHOWN} more
      </button>
    ) : null;

  const body = (column: Column): ReactNode =>
    column === "finished" ? (
      <>
        {finishedHead}
        {cards(shownFinished, column)}
        {finishedFoot}
      </>
    ) : (
      cards(moving[column], column)
    );

  // Once what left has gone: until then its cards are drawn leaving, and one that comes back is not new.
  if (empty && Object.values(moving).every((list) => list.length === 0)) return <>{empty}</>;
  if (!wide) {
    return (
      <div className="space-y-4">
        <div role="tablist" aria-label="Columns" className="grid grid-cols-4 gap-2">
          {COLUMNS.map((column) => (
            <button
              key={column.id}
              type="button"
              role="tab"
              aria-selected={state.column === column.id}
              data-tab={column.id}
              className={cn("flex min-h-11 flex-col items-center justify-center rounded-2xl border px-1 py-2 text-xs font-semibold", state.column === column.id ? "border-transparent bg-base-content text-base-100" : "border-base-content/10 bg-base-100 text-base-content/70")}
              onClick={() => state.setColumn(column.id)}
            >
              <span className={cn("font-mono text-base tabular-nums", column.id === "needs" && counts.needs > 0 && state.column !== "needs" ? "text-warning" : "")}>{counts[column.id]}</span>
              {column.label}
            </button>
          ))}
        </div>
        {/* Keyed by the column, so the one a tab picks is drawn anew and fades in under tabs that stay. */}
        <div key={state.column} role="tabpanel" className="animate-fade space-y-3" data-column-shown={state.column}>
          {body(state.column)}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 items-start gap-4 lg:grid-cols-4">
      {COLUMNS.map((column) => (
        <section key={column.id} aria-label={column.label} data-board-column={column.id} className="space-y-3 rounded-[22px] border border-base-content/[0.06] bg-base-200/40 p-3">
          <header className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-base-content">{column.label}</h2>
            <span className={cn("font-mono text-xs tabular-nums", column.id === "needs" && counts.needs > 0 ? "text-warning" : "text-base-content/65")}>{counts[column.id]}</span>
          </header>
          {body(column.id)}
        </section>
      ))}
    </div>
  );
}

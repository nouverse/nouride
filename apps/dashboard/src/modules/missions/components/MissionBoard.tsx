/**
 * The Missions board. On a wide window: three columns side by side for what is still open (Backlog, Working, Needs
 * you), and under them Finished, across the page as a list of rows, since what has been is history and not a stage.
 * When nothing is open the three are one thin strip and Finished has the page: three empty columns took three quarters
 * of the window while the only one with anything in it was squeezed. On a phone: four
 * tabs with their counts, one shown, Finished the fourth so it stays a press away.
 *
 * Every column shows its newest few and "Show N more" under them (`SHOWN`), the same everywhere. Finished has a head of
 * its own: how far back it goes, and chips by how they ended (none chosen is all of them; pressing the chosen one
 * clears it). What is open is listed however old.
 */

import { useState, type ReactNode } from "react";
import type { MissionView } from "@nouride/wire";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { useWide } from "@/commons/hooks/use-wide";
import { useMotionList, LEAVE, type Moving } from "@/commons/hooks/use-motion-list";
import { cn } from "@/commons/lib/utils";
import { COLUMNS, FINISHED_SPANS, SHOWN, STAGES, columnOf, outcomeOf, type Column, type FinishedSpan, type Outcome } from "../lib/board";
import { BoardCard } from "./BoardCard";
import { FinishedRow } from "./FinishedRow";

const key = (mission: MissionView) => mission.id;

const OUTCOMES: readonly { id: Outcome; label: string; dot: string }[] = [
  { id: "done", label: "Done", dot: "bg-success" },
  { id: "failed", label: "Failed", dot: "bg-failed" },
  { id: "stopped", label: "Stopped", dot: "bg-base-content/40" },
];

const NONE: Record<Column, (days: number) => string> = {
  backlog: () => "No drafts. A new mission waits here until it is started.",
  working: () => "Nothing at work.",
  needs: () => "Nothing needs you.",
  finished: (days) => `Nothing finished in the last ${days} days.`,
};

const LABEL = Object.fromEntries(COLUMNS.map((column) => [column.id, column.label])) as Record<Column, string>;

export interface BoardState {
  /** The column a phone shows. */
  column: Column;
  setColumn: (next: Column) => void;
  days: FinishedSpan;
  setDays: (next: FinishedSpan) => void;
  outcome: Outcome | null;
  setOutcome: (next: Outcome | null) => void;
}

/** How far back Finished goes: over its list on a wide page, at the top of its tab on a phone. */
function FinishedSpanPicker({ state, wide }: { state: BoardState; wide: boolean }) {
  return (
    <SearchSelect
      small
      named
      label="Ended in"
      options={FINISHED_SPANS.map((each) => ({ value: String(each), label: `Last ${each} days` }))}
      value={String(state.days)}
      onChange={(next) => state.setDays(Number(next) as FinishedSpan)}
      width={176}
      align={wide ? "end" : "start"}
      className={wide ? "" : "w-full"}
    />
  );
}

/** Finished by how they ended: none chosen is all of them, and pressing the chosen one clears it. */
function OutcomeChips({ state, count }: { state: BoardState; count: (outcome: Outcome) => number }) {
  return (
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
          {outcome.label} {count(outcome.id)}
        </button>
      ))}
    </div>
  );
}

/** A phone's four tabs, each with its count: Needs you is marked while it holds anything and is not the one shown. */
function ColumnTabs({ state, counts }: { state: BoardState; counts: Readonly<Record<Column, number>> }) {
  return (
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
  );
}

/** The three columns as one thin strip, while nothing is open. */
function NothingOpen() {
  return (
    <section aria-label="Open missions" data-board-strip className="flex flex-wrap items-center gap-x-7 gap-y-2 rounded-[22px] border border-base-content/[0.06] bg-base-200/40 px-5 py-4">
      {STAGES.map((column) => (
        <span key={column} className="flex items-baseline gap-2" data-strip={column}>
          <span className="font-mono text-sm tabular-nums text-base-content/65">0</span>
          <span className="text-sm font-semibold text-base-content">{LABEL[column]}</span>
        </span>
      ))}
      <p className="text-sm text-base-content/65">Nothing is open. A new mission waits in the backlog until you start it.</p>
    </section>
  );
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
  /** Drawn in place of the board while nothing is listed; the board stays mounted, so the first mission enters. */
  empty?: ReactNode;
}) {
  const wide = useWide();
  // The columns a person opened past their first few: kept while the page is, a list read again does not fold them.
  const [whole, setWhole] = useState<Readonly<Partial<Record<Column, boolean>>>>({});
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
  const staying = (column: Column) => moving[column].filter((one) => one.motion !== LEAVE);
  /** The first few of a column, and whatever is on its way out: one that leaves is drawn until it has gone. */
  const first = (column: Column): Moving<MissionView>[] => {
    const stay = staying(column);
    return whole[column] ? moving[column] : moving[column].filter((one) => one.motion === LEAVE || stay.indexOf(one) < SHOWN);
  };
  /** "Show N more" under a column that holds more than its first few, and "Show less" once it is open. */
  const foot = (column: Column): ReactNode => {
    const more = staying(column).length - SHOWN;
    if (more <= 0) return null;
    return (
      <button
        type="button"
        data-more={column}
        aria-expanded={whole[column] === true}
        className="btn btn-ghost btn-sm min-h-11 w-full rounded-xl border border-dashed border-base-content/15 sm:min-h-8"
        onClick={() => setWhole((was) => ({ ...was, [column]: !was[column] }))}
      >
        {whole[column] ? "Show less" : `Show ${more} more`}
      </button>
    );
  };
  const none = (column: Column): ReactNode => (
    <p className="px-1 py-3 text-xs text-base-content/65" data-none={column}>
      {NONE[column](state.days)}
    </p>
  );
  const cards = (column: Column): ReactNode =>
    moving[column].length === 0 ? none(column) : first(column).map(({ key: id, item, motion }) => <BoardCard key={id} mission={item} motion={motion} writable={writable} showWhose={showWhose} />);

  const span = <FinishedSpanPicker state={state} wide={wide} />;
  const chips = <OutcomeChips state={state} count={byOutcome} />;

  // Once what left has gone: until then its cards are drawn leaving, and one that comes back is not new.
  if (empty && Object.values(moving).every((list) => list.length === 0)) return <>{empty}</>;
  if (!wide) {
    return (
      <div className="space-y-4">
        <ColumnTabs state={state} counts={counts} />
        {/* Keyed by the column, so the one a tab picks is drawn anew and fades in under tabs that stay. */}
        <div key={state.column} role="tabpanel" className="animate-fade space-y-3" data-column-shown={state.column}>
          {state.column === "finished" ? (
            <div className="space-y-2.5" data-finished-head>
              {span}
              {chips}
            </div>
          ) : null}
          {cards(state.column)}
          {foot(state.column)}
        </div>
      </div>
    );
  }

  // Nothing open, and nothing of the three still on its way out: the strip, and Finished has the page.
  const quiet = STAGES.every((column) => counts[column] === 0 && moving[column].length === 0);
  return (
    <div className="space-y-6">
      {quiet ? (
        <NothingOpen />
      ) : (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
          {STAGES.map((column) => {
            const asks = column === "needs" && counts.needs > 0;
            return (
              <section key={column} aria-label={LABEL[column]} data-board-column={column} className={cn("space-y-3 rounded-[22px] border p-3", asks ? "border-warning/25 bg-warning/[0.07]" : "border-base-content/[0.06] bg-base-200/40")}>
                <header className="flex items-center justify-between px-1">
                  <h2 className="text-sm font-semibold text-base-content">{LABEL[column]}</h2>
                  <span className={cn("font-mono text-xs tabular-nums", asks ? "text-warning" : "text-base-content/65")}>{counts[column]}</span>
                </header>
                {cards(column)}
                {foot(column)}
              </section>
            );
          })}
        </div>
      )}

      <section aria-label="Finished" data-board-column="finished" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
          <header className="flex items-baseline gap-2.5 px-1">
            <h2 className="font-display text-lg font-semibold tracking-tight text-base-content">Finished</h2>
            <span className="font-mono text-xs tabular-nums text-base-content/65">
              {counts.finished} in the last {state.days} days
            </span>
          </header>
          <div className="flex flex-wrap items-center gap-2" data-finished-head>
            {chips}
            {span}
          </div>
        </div>
        {moving.finished.length === 0 ? (
          none("finished")
        ) : (
          <ul className="divide-y divide-base-content/[0.06] rounded-[22px] border border-base-content/[0.08] bg-base-100 px-4 shadow-soft">
            {first("finished").map(({ key: id, item, motion }) => (
              <FinishedRow key={id} mission={item} motion={motion} showWhose={showWhose} />
            ))}
          </ul>
        )}
        {foot("finished")}
      </section>
    </div>
  );
}

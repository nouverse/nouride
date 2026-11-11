/**
 * The line that joins one card of the flow to the next, and the "+" on it that puts a step in between: the flow is
 * read down this line, start to end. Over a run, the stretch the run went along is drawn in the colour of what is
 * done, and the stretches it never took stay faint.
 *
 * The picker a "+" opens is one for the whole flow (`StepPicker`), under whichever "+" was pressed.
 */

import { Plus } from "lucide-react";
import { cn } from "@/commons/lib/utils";
import { KIND } from "../lib/words";
import { KINDS, type StepKind } from "../lib/steps";

export function Connector({
  onAdd,
  addLabel,
  taken = false,
  short = false,
}: {
  /** A "+" on the line, and what a press on it does with the button it was pressed on. None: a line and nothing more. */
  onAdd?: ((button: HTMLButtonElement) => void) | undefined;
  addLabel?: string;
  /** The run went along it. */
  taken?: boolean;
  short?: boolean;
}) {
  const line = cn("w-0.5 rounded-full transition-colors duration-200", taken ? "bg-success" : "bg-base-content/15");
  if (!onAdd) return <div aria-hidden="true" data-taken={taken ? "" : undefined} className={cn(line, "mx-auto", short ? "h-4" : "h-7")} />;
  return (
    <div className="flex flex-col items-center">
      <div aria-hidden="true" className={cn(line, "h-2.5")} />
      <button
        type="button"
        aria-label={addLabel}
        title={addLabel}
        className="grid size-7 place-items-center rounded-full border border-base-content/15 bg-base-100 text-base-content/65 shadow-xs transition-all duration-150 hover:border-secondary/40 hover:bg-secondary/10 hover:text-secondary active:scale-90 max-sm:size-9"
        onClick={(event) => onAdd(event.currentTarget)}
      >
        <Plus size={14} strokeWidth={2.5} aria-hidden="true" />
      </button>
      <div aria-hidden="true" className={cn(line, "h-2.5")} />
    </div>
  );
}

/** The kinds a step can be, each with what it does: what the "+" offers. */
export function StepPicker({ onPick }: { onPick: (kind: StepKind) => void }) {
  return (
    <div className="p-2">
      <p className="px-3 pt-2 pb-1.5 font-display text-base font-medium text-base-content">Add a step</p>
      <ul className="list-none space-y-0.5">
        {KINDS.map((kind) => {
          const { icon: Icon, label, hint, tile } = KIND[kind];
          return (
            <li key={kind}>
              <button type="button" className="flex w-full items-start gap-3 rounded-[14px] p-2.5 text-left transition-colors hover:bg-base-content/[0.05] focus-visible:bg-base-content/[0.05] focus-visible:outline-none" onClick={() => onPick(kind)}>
                <span aria-hidden="true" className={cn("grid size-9 shrink-0 place-items-center rounded-xl", tile)}>
                  <Icon size={17} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-base-content">{label}</span>
                  <span className="block text-xs leading-snug text-base-content/65">{hint}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

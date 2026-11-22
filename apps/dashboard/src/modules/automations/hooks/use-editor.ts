/**
 * The automation's page while it is edited: the draft a person is changing, apart from the automation as the server
 * last sent it. Nothing is saved as it is typed; the page shows the draft, and a bar offers to save it or put it back.
 *
 * There is a draft only once something was changed. Until then the page shows what the server sends, so an
 * automation a run is moving through, or one an agent's change was just accepted into, is followed as it is polled;
 * once there is a draft, the page holds it still against the polls until it is saved or discarded.
 *
 * Every change goes through the list's own operations (`lib/steps.ts`), which keep each path pointing forward; the
 * paths a move or a delete put back to their default are kept here, for the card to say.
 */

import { useCallback, useMemo, useState } from "react";
import type { StepExit } from "@nouride/wire";
import { useUnsaved } from "@/commons/lib/unsaved";
import { changed, settled, type Draft } from "../lib/draft";
import { addOnLine, addToLane, choosePath, copyOnLine, moveOnLine, pathsOf, removeDrawn, setLaneEnd, type Choice, type PathExit } from "../lib/paths";
import { asKind, replaceStep, resetsBetween, setExit, type Changed, type ExitName, type ExitReset, type Step, type StepKind } from "../lib/steps";

/** The step a change made, by its id: what is opened to be written. */
const madeIn = (now: readonly Step[], was: readonly Step[]): string | undefined => now.find((step) => !was.some((old) => old.id === step.id))?.id;

/** A changed list with the paths the change put back to their default, for the card to say. */
const told = (was: readonly Step[], now: Step[]): Changed => ({ steps: now, reset: resetsBetween(was, now) });

/** What is open beside the canvas when it is not a step: how it starts, where its results go, whose it is. No step's id begins so. */
export const OPEN_START = "@start";
export const OPEN_RESULTS = "@results";
export const OPEN_OWNER = "@owner";

interface State {
  draft: Draft | null;
  /** What is open: a step by its id, or one of the canvas's own boxes. */
  open: string | null;
  resets: ExitReset[];
}

export interface Editor {
  draft: Draft;
  /** Whether a save would send anything. A new automation is always unsaved. */
  dirty: boolean;
  open: string | null;
  resets: ExitReset[];
  setOpen: (id: string | null) => void;
  set: (patch: Partial<Draft>) => void;
  setStep: (index: number, step: Step) => void;
  setKind: (index: number, kind: StepKind) => void;
  setExit: (index: number, exit: ExitName, go: StepExit) => void;
  /** A new step on the main line, before the step at that place in the list or at the line's end, opened to be written. */
  add: (before: number | null, kind: StepKind) => void;
  duplicate: (index: number) => void;
  /** A step of the main line to another place on it, both counted as the line is drawn. What hangs on it goes along. */
  move: (from: number, to: number) => void;
  /** Takes a step out with what hangs on it, and hands back the draft as it was, for an undo. */
  remove: (index: number) => Draft;
  /** One of a step's paths given an answer (`lib/paths.ts`). Hands back the draft as it was where steps went with the old answer. */
  choose: (index: number, exit: PathExit, choice: Exclude<Choice, "jump">) => Draft | null;
  /** Where a lane ends: back into the main line, or a stop. */
  laneEnd: (index: number, exit: PathExit, ends: "stop" | "back") => void;
  /** A step added at a lane's end, opened to be written. */
  addToLane: (index: number, exit: PathExit, kind: StepKind) => void;
  /** Puts a draft back whole: what an undo does. */
  restore: (draft: Draft) => void;
  /** Forgets a path's "put back to its default" note. */
  forget: (reset: ExitReset) => void;
  /** Back to what the server holds. */
  discard: () => void;
}

/** `loaded`: the automation as the server holds it, or a blank one for a page that makes a new one (`fresh`). */
export function useEditor(loaded: Draft, fresh: boolean): Editor {
  const [state, setState] = useState<State>({ draft: null, open: null, resets: [] });
  const draft = state.draft ?? loaded;
  // What the floating chat asks before it opens an agent's work in this page's place (`lib/unsaved.ts`): a new one is
  // unsaved from its first key, not from being new.
  useUnsaved(state.draft !== null && changed(loaded, state.draft));

  const change = useCallback(
    (next: (draft: Draft) => { draft: Draft; reset?: ExitReset[]; open?: string | null }) => {
      setState((was) => {
        const made = next(was.draft ?? loaded);
        // A path reset again replaces its older note; one set by hand since has none.
        const kept = was.resets.filter((old) => !made.reset?.some((now) => now.id === old.id && now.exit === old.exit) && made.draft.steps.some((step) => step.id === old.id));
        return { draft: settled(made.draft), open: made.open === undefined ? was.open : made.open, resets: [...kept, ...(made.reset ?? [])] };
      });
    },
    [loaded],
  );

  const steps = useCallback(
    (op: (steps: readonly Step[]) => Changed | Step[], open?: (now: Step[], was: readonly Step[]) => string | null | undefined) => {
      change((draft) => {
        const out = op(draft.steps);
        const made = Array.isArray(out) ? { steps: out, reset: [] } : out;
        return { draft: { ...draft, steps: made.steps }, reset: made.reset, open: open?.(made.steps, draft.steps) };
      });
    },
    [change],
  );

  return useMemo<Editor>(
    () => ({
      draft,
      dirty: fresh || (state.draft !== null && changed(loaded, state.draft)),
      open: state.open,
      resets: state.resets,
      setOpen: (id) => setState((was) => ({ ...was, open: id })),
      set: (patch) => change((draft) => ({ draft: { ...draft, ...patch } })),
      setStep: (index, step) => steps((list) => replaceStep(list, index, step)),
      setKind: (index, kind) => steps((list) => (list[index] ? replaceStep(list, index, asKind(list[index], kind)) : [...list])),
      setExit: (index, exit, go) => {
        steps((list) => setExit(list, index, exit, go));
        const id = draft.steps[index]?.id;
        setState((was) => ({ ...was, resets: was.resets.filter((reset) => !(reset.id === id && reset.exit === exit)) }));
      },
      add: (before, kind) => steps((list) => addOnLine(list, before, kind), madeIn),
      duplicate: (index) => steps((list) => copyOnLine(list, index)),
      move: (from, to) => steps((list) => told(list, moveOnLine(list, pathsOf(list, false).line[from] ?? from, to))),
      remove: (index) => {
        steps(
          (list) => told(list, removeDrawn(list, index)),
          (now) => (state.open && (state.open.startsWith("@") || now.some((step) => step.id === state.open)) ? state.open : null),
        );
        return draft;
      },
      choose: (index, exit, choice) => {
        const removed = choosePath(draft.steps, index, exit, choice).removed;
        change((held) => {
          const chosen = choosePath(held.steps, index, exit, choice);
          // A lane's first step is opened to be written, by the id the choice gave it: it may be the id of the wait
          // that just went with the old answer, which a look for "the step that was not there before" does not find.
          // A question is written where it was chosen, in its step's own fields.
          return { draft: { ...held, steps: chosen.steps }, ...(choice === "lane" && chosen.opened ? { open: chosen.opened } : {}) };
        });
        return removed > 0 ? draft : null;
      },
      laneEnd: (index, exit, ends) => steps((list) => setLaneEnd(list, index, exit, ends)),
      addToLane: (index, exit, kind) =>
        change((held) => {
          const added = addToLane(held.steps, index, exit, kind);
          return { draft: { ...held, steps: added.steps }, ...(added.opened ? { open: added.opened } : {}) };
        }),
      restore: (kept) => setState((was) => ({ ...was, draft: kept })),
      forget: (reset) => setState((was) => ({ ...was, resets: was.resets.filter((one) => one !== reset) })),
      discard: () => setState({ draft: null, open: null, resets: [] }),
    }),
    [draft, fresh, loaded, state, change, steps],
  );
}

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
import { changed, settled, type Draft } from "../lib/draft";
import { asKind, blankStep, duplicateStep, insertStep, moveStep, removeStep, replaceStep, setExit, type Changed, type ExitName, type ExitReset, type Step, type StepKind } from "../lib/steps";

interface State {
  draft: Draft | null;
  /** The step whose fields are open, by its id. */
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
  /** A new step at a place, opened to be written. */
  add: (at: number, kind: StepKind) => void;
  duplicate: (index: number) => void;
  move: (from: number, to: number) => void;
  /** Takes a step out, and hands back the draft as it was, for an undo. */
  remove: (index: number) => Draft;
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
      add: (at, kind) =>
        steps(
          (list) => insertStep(list, at, blankStep(kind, list)),
          (now, was) => now.find((step) => !was.some((old) => old.id === step.id))?.id,
        ),
      duplicate: (index) => steps((list) => duplicateStep(list, index)),
      move: (from, to) => steps((list) => moveStep(list, from, to)),
      remove: (index) => {
        steps(
          (list) => removeStep(list, index),
          (now) => (state.open && now.some((step) => step.id === state.open) ? state.open : null),
        );
        return draft;
      },
      restore: (kept) => setState((was) => ({ ...was, draft: kept })),
      forget: (reset) => setState((was) => ({ ...was, resets: was.resets.filter((one) => one !== reset) })),
      discard: () => setState({ draft: null, open: null, resets: [] }),
    }),
    [draft, fresh, loaded, state, change, steps],
  );
}

/**
 * "Are you sure?" — once, for everything that asks it.
 *
 * The dashboard asked eleven times with `window.confirm()`: unstyled, unable to name the consequence in
 * more than one line, impossible to distinguish a destructive answer from a routine one, and blocked
 * outright by some browsers when it fires outside a user gesture. Every one of them is this now, and
 * `tests/native-dialogs.test.ts` keeps it that way. It is a component rather than a wrapper around the
 * native call so the dangerous answer can *look* dangerous.
 *
 * ## Why a hook and not a `<Confirm>` you render
 *
 * The call site is inside an event handler, in the middle of a decision:
 *
 * ```tsx
 * const { ask, dialog } = useConfirm();
 * …
 * onClick={async () => { if (await ask({ … })) remove.mutate(name); }}
 * …
 * {dialog}
 * ```
 *
 * A purely declarative dialog would have every caller invent the same three pieces of state — open,
 * which item, what to do on yes — and the third is the one that goes wrong: a `pendingItem` left set
 * after the dialog closes deletes the wrong row the next time somebody clicks. Handing back a promise
 * keeps the decision where the decision is written.
 *
 * No context provider: each component that asks owns its own dialog. There is never more than one
 * question in flight in a single component, and a provider would put a modal's state above the tree
 * that actually knows what is being confirmed.
 *
 * Built on the native `<dialog>` (daisyUI's recommended form), which gives focus trapping, Escape,
 * and inertness of the page behind it without any of it being written here.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

export interface ConfirmRequest {
  /** The question, as a short noun phrase: "Delete draw-diagram?" */
  title: string;
  /**
   * What will actually happen. Say the consequence, not the action — the button already says the
   * action, and "this cannot be undone" is the half people read.
   */
  body?: ReactNode;
  /** The affirmative button. Name the verb: "Delete", "Revoke". Never "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Paints the affirmative button as destructive. On by default — nothing asks unless it matters. */
  danger?: boolean;
  /**
   * Which answer is the primary button. `cancel` for a question whose safe answer is to stay where you
   * are — signing out: the blue, focused button keeps you signed in, and leaving is the plain one.
   */
  emphasis?: "confirm" | "cancel";
}

export interface Confirmation {
  ask: (request: ConfirmRequest) => Promise<boolean>;
  /** Render this somewhere in the component. Position is irrelevant; a dialog is not in the flow. */
  dialog: ReactNode;
}

export function useConfirm(): Confirmation {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  /**
   * The pending answer.
   *
   * A ref rather than state: resolving is not a render, and putting the resolver in state would make
   * every keystroke elsewhere in the component a chance to drop it.
   */
  const resolve = useRef<((answer: boolean) => void) | null>(null);

  const ask = useCallback(
    (next: ConfirmRequest) =>
      new Promise<boolean>((done) => {
        // A second question while one is open answers the first with "no" rather than stranding its
        // promise — an awaited call that never settles is a click that silently does nothing.
        resolve.current?.(false);
        resolve.current = done;
        setRequest(next);
      }),
    [],
  );

  // Opened as an effect rather than in `ask`, because the element does not exist until the state
  // that renders it has landed.
  useEffect(() => {
    if (request) ref.current?.showModal();
  }, [request]);

  // The question stays drawn once answered, so its box is seen to close (`main.css`, "Dialogs") rather than emptied
  // under the closing dialog; the next `ask` replaces it.
  const settle = useCallback((answer: boolean) => {
    resolve.current?.(answer);
    resolve.current = null;
    ref.current?.close();
  }, []);

  const danger = request?.danger !== false;
  const stay = request?.emphasis === "cancel";

  const dialog = (
    <dialog
      ref={ref}
      className="modal"
      // Escape and the backdrop both mean no. Without this the promise would hang on the one
      // dismissal route that does not go through a button.
      onClose={() => settle(false)}
    >
      {request ? (
        // `text-start`: a dialog inherits from where it sits in the tree, not from the top layer it is shown
        // in, and one asked from a right-aligned table cell otherwise reads right-aligned.
        <div className="modal-box rounded-2xl text-start">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            {danger ? <TriangleAlert size={16} className="text-error shrink-0" /> : null}
            {request.title}
          </h3>
          {request.body ? <div className="py-3 text-sm opacity-70">{request.body}</div> : null}
          <div className="modal-action">
            <button
              type="button"
              className={`btn btn-sm ${stay ? "btn-primary" : "btn-ghost"}`}
              onClick={() => settle(false)}
              autoFocus={stay}
            >
              {request.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${stay ? "btn-ghost" : danger ? "btn-error" : "btn-primary"}`}
              onClick={() => settle(true)}
              // The affirmative answer is focused rather than the cancel, because the person chose
              // it once by clicking the thing that opened this. Escape and the backdrop are the
              // cheap way out and both are one keystroke away. Unless `emphasis` says staying is the
              // answer to offer first.
              autoFocus={!stay}
            >
              {request.confirmLabel ?? "Confirm"}
            </button>
          </div>
        </div>
      ) : null}
      {/* Clicking outside closes it — `method="dialog"` fires `onClose`, which answers no. */}
      <form method="dialog" className="modal-backdrop">
        <button type="submit" aria-label="Cancel">
          close
        </button>
      </form>
    </dialog>
  );

  return { ask, dialog };
}

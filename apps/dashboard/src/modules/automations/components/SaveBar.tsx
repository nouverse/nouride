/**
 * The bar that saves. Nothing on the automation's page is saved as it is typed: once something changed, this bar
 * appears at the page's foot with Save and Discard changes, and says what a save still lacks, or what it will change
 * besides what was typed. A refusal is said here in the server's everyday words, and its own under Details.
 *
 * What it lacks is pressed to be taken there: the bar stays at the window's foot, and with six steps drawn "Give it a
 * name." was said of a field a screen and a half up the page.
 *
 * It stands above a phone's tab bar, where a toast stands too: while it is drawn, the toasts are lifted over it
 * (`--toast-lift`), so an Undo never lies on Save. And it keeps clear of the chat that floats over every page
 * (`FloatingChat`): below a laptop's width it ends short of the chat's button, which stands over the tab bar's right
 * end, and from a laptop up it ends short of where the open chat's card is, 25rem wide and 1rem in from the window's
 * right edge, so Save is never under either.
 */

import { useEffect, useRef } from "react";
import { failureWords } from "@/commons/lib/api.client";
import { Details } from "@/commons/components/ui/Details";

export function SaveBar({
  fresh,
  saving,
  lacks,
  notes,
  error,
  onSave,
  onDiscard,
  onLacks,
}: {
  /** Being made: it saves as a new automation, and there is nothing to go back to but the list. */
  fresh: boolean;
  saving: boolean;
  /** What a save still lacks, in a sentence; a save is not offered while there is one. */
  lacks: string | null;
  /** What saving changes besides what was typed. */
  notes: readonly string[];
  /** The last save's refusal. */
  error: unknown;
  onSave: () => void;
  onDiscard: () => void;
  /** Take the person to what it lacks: its field, or the box that holds it, opened. */
  onLacks: () => void;
}) {
  // By its own height, which is two rows on a phone and one on a laptop, and grows with a refusal's words.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const lift = () => document.documentElement.style.setProperty("--toast-lift", `${(bar.current?.offsetHeight ?? 64) + 12}px`);
    lift();
    const watch = typeof ResizeObserver === "undefined" || !bar.current ? null : new ResizeObserver(lift);
    if (bar.current) watch?.observe(bar.current);
    return () => {
      watch?.disconnect();
      document.documentElement.style.removeProperty("--toast-lift");
    };
  }, []);
  const refused = error ? failureWords(error) : null;

  return (
    <div ref={bar} role="region" aria-label="Unsaved changes" className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-20 flex w-auto max-w-2xl flex-wrap items-center gap-x-4 gap-y-2 rounded-[22px] border border-base-content/[0.08] bg-base-100 px-4 py-3 shadow-xl animate-enter max-lg:mr-[4.5rem] lg:bottom-6 lg:mr-[25rem]">
      <div className="min-w-0 flex-[1_1_14rem] space-y-1 text-sm">
        {refused ? (
          <div role="alert" className="space-y-1 text-error">
            <p className="font-semibold">{refused.said}</p>
            {refused.detail ? (
              <Details>
                <p className="whitespace-pre-line [overflow-wrap:anywhere]">{refused.detail}</p>
              </Details>
            ) : null}
          </div>
        ) : lacks ? (
          <p className="font-medium text-base-content/80">
            <button type="button" data-lacks className="rounded-md text-left underline decoration-base-content/30 underline-offset-4 outline-none hover:decoration-base-content/70 focus-visible:ring-2 focus-visible:ring-secondary/50" onClick={onLacks}>
              {lacks}
            </button>
          </p>
        ) : (
          <p className="font-medium text-base-content/80">{fresh ? "Ready to save." : "You changed this automation."}</p>
        )}
        {notes.map((note) => (
          <p key={note} className="text-xs text-base-content/65">
            {note}
          </p>
        ))}
      </div>
      {/* On a phone the two share the row from their own widths, their words on one line: as equal halves, the longer
          one's words broke in two inside it. */}
      <div className="flex shrink-0 items-center gap-2 max-sm:w-full">
        <button type="button" className="btn btn-ghost btn-sm whitespace-nowrap max-sm:flex-auto" disabled={saving} onClick={onDiscard}>
          {fresh ? "Cancel" : "Discard changes"}
        </button>
        <button type="button" className="btn btn-primary btn-sm gap-1.5 whitespace-nowrap max-sm:flex-auto" disabled={saving || lacks !== null} onClick={onSave}>
          {saving ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
          {fresh ? "Save automation" : "Save"}
        </button>
      </div>
    </div>
  );
}

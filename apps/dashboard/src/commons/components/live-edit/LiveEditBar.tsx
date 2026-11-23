/**
 * A change an agent wrote to what the page holds open, over the thing itself (`lib/live-edit.ts`): who wrote it, what
 * it would do in a sentence, a switch between the thing as it is and as it would be, and Apply and Discard. Once
 * applied, the same bar says so and offers Undo, for as long as its page shows it.
 *
 * Nothing changes until Apply, and Apply saves nothing: it puts the change into what the page holds, where the page's
 * own Save is still the person's to press. So the bar says "not saved" at both moments, which is the one thing a
 * person could take wrongly here.
 *
 * Any page that holds something open draws this one bar: what the thing is called and what the change does are its
 * page's to say.
 *
 * Its words and its buttons keep to the bar's left (`CLEAR`). The change arrives while the chat it was asked in is
 * open, and that chat is a card over the page's right side: laid across the bar, Apply and Discard were under the
 * card, and the sentence that says nothing is saved yet ended behind it.
 */

import type { ReactNode } from "react";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { useAgentFace } from "@/commons/hooks/use-agent-face";

/** Which of the two the page is drawing: the thing as the person has it, or with the change made. */
export type LiveSide = "current" | "changed";

const BAR = "rounded-[22px] border border-accent/25 bg-accent/[0.08] p-4 animate-fade sm:px-5";
/**
 * What a bar over a page's steps says and offers, kept clear of the chat's card: 400 wide, over the page's right side
 * from a tablet's width up. Up to a laptop's width that leaves a narrow strip beside the menu (about 320 at 1024);
 * from there on, half the page. On a phone the chat is a sheet over everything, and the bar has the screen's width.
 */
export const CLEAR = "space-y-3 md:max-w-[18rem] xl:max-w-lg";
const QUIET = "btn btn-ghost btn-sm border border-accent/30 text-accent";

function Who({ by, children }: { by: string; children: (name: string) => ReactNode }) {
  const face = useAgentFace(by);
  const name = face?.name ?? by;
  return (
    <div className="flex items-start gap-3">
      {face?.look ? <AgentAvatar look={face.look} name={name} size="sm" className="shrink-0 bg-base-100" /> : null}
      <div className="min-w-0 flex-1">{children(name)}</div>
    </div>
  );
}

export function LiveEditBar({
  by,
  noun,
  words,
  notes = [],
  side,
  onSide,
  onApply,
  onDiscard,
}: {
  /** The agent that wrote the change. */
  by: string;
  /** What the thing is called in a sentence: "automation". */
  noun: string;
  /** What the change would do, in a sentence or two. */
  words: string;
  /** What a person should look at before they apply it: a script it brings. */
  notes?: readonly string[];
  side: LiveSide;
  onSide: (side: LiveSide) => void;
  onApply: () => void;
  onDiscard: () => void;
}) {
  return (
    <section aria-label="Change from the chat" className={BAR}>
      <div className={CLEAR}>
        <Who by={by}>
          {(name) => (
            <>
              <p className="font-bold text-accent">
                {name} changed this {noun}
              </p>
              <p className="text-sm text-base-content/85 [overflow-wrap:anywhere]">{words} Nothing changes until you apply it, and nothing is saved until you save.</p>
            </>
          )}
        </Who>
        {notes.map((note) => (
          <p key={note} className="text-sm font-medium text-base-content/85">
            {note}
          </p>
        ))}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={onApply}>
              Apply
            </button>
            <button type="button" className={QUIET} onClick={onDiscard}>
              Discard
            </button>
          </div>
          <SegmentedTabs
            label="What to show"
            tabs={[
              { value: "current", label: "As you have it" },
              { value: "changed", label: "With the change" },
            ]}
            value={side}
            onChange={onSide}
          />
        </div>
      </div>
    </section>
  );
}

/** The change applied: said, with the way back, until the page shows something else. */
export function LiveEditApplied({ by, noun, onUndo, onDone }: { by: string; noun: string; onUndo: () => void; onDone: () => void }) {
  return (
    <section aria-label="Change from the chat" className={BAR}>
      <div className={CLEAR}>
        <Who by={by}>
          {(name) => (
            <>
              <p className="font-bold text-accent">You applied {name}'s change</p>
              <p className="text-sm text-base-content/85">
                It is in this {noun} now, and not saved yet: save it when you are ready, or take it back.
              </p>
            </>
          )}
        </Who>
        <div className="flex gap-2">
          <button type="button" className={QUIET} onClick={onUndo}>
            Undo
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    </section>
  );
}

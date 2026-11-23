/**
 * A change an agent wants made to the automation on this page, over its steps: one bar at a time, since each is a
 * question to the person.
 *
 * First the change it wrote to what is open here, from the chat over the page (`hooks/use-open-change.ts`): who
 * changed it and what the change does, Apply and Discard while it waits, and the way back once applied. What the bar
 * says of the change is this page's to work out: its steps by their numbers, a script it brings. Then, with none of
 * that waiting, a change it proposed to the automation as it is saved (`SuggestedBanner`), which waits on the server.
 */

import type { AutomationSummary } from "@nouride/wire";
import { LiveEditApplied, LiveEditBar } from "@/commons/components/live-edit/LiveEditBar";
import type { OpenChange } from "../hooks/use-open-change";
import type { Draft } from "../lib/draft";
import { draftChangeWords, scriptsBrought } from "../lib/suggested";
import { SuggestedBanner, type Side } from "./SuggestedBanner";

/** A change proposed to the saved automation, and what its answer takes: who may answer, and whether the page holds changes of the person's own. */
interface Proposed {
  current: AutomationSummary;
  suggested: AutomationSummary;
  admin: boolean;
  writable: boolean;
  dirty: boolean;
  onAnswered: () => void;
}

export function ChangeFromChat({
  change,
  draft,
  home,
  side,
  onSide,
  proposed,
}: {
  change: OpenChange;
  draft: Draft;
  home: string;
  side: Side;
  onSide: (side: Side) => void;
  proposed: Proposed | null;
}) {
  const { offered } = change;
  if (offered) {
    return (
      <LiveEditBar
        by={offered.by}
        noun="automation"
        words={draftChangeWords(draft, offered.draft, home)}
        notes={scriptsBrought(draft, offered.draft).map((place) => `It brings a script in step ${place}. Read it before you apply.`)}
        side={side === "suggested" ? "changed" : "current"}
        onSide={(next) => onSide(next === "changed" ? "suggested" : "current")}
        onApply={change.apply}
        onDiscard={change.discard}
      />
    );
  }
  if (change.applied) return <LiveEditApplied by={change.applied} noun="automation" onUndo={change.undo} onDone={change.settle} />;
  if (!proposed) return null;
  return (
    <SuggestedBanner
      current={proposed.current}
      suggested={proposed.suggested}
      home={home}
      side={side}
      onSide={onSide}
      // A change proposed in a chat the reader cannot open is not theirs to answer: the server says so of it.
      canAnswer={(proposed.suggested.start === "webhook" ? proposed.admin : proposed.writable) && proposed.suggested.changeable !== false}
      held={proposed.dirty ? "Save or discard your own changes first." : null}
      onAnswered={() => {
        onSide("current");
        proposed.onAnswered();
      }}
    />
  );
}

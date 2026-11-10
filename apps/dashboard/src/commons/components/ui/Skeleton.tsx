/**
 * What is on its way, drawn as its shape, where it is not a list (`ListLoading` is a list's): a page, a card, a file
 * being read. A spinner in the middle of a blank page says only "wait"; the shape says what is coming and holds its
 * place, so nothing jumps when it arrives. A spinner is left for one thing being done in a button.
 *
 * Every shape is a frame that says it is busy with the pulse inside it, as `ListLoading` is and for its reason: a
 * page's section fades in, one element takes one animation, and the fade would stop the pulse. The pulse rests under
 * the reduced-motion rule.
 */

import type { ReactNode } from "react";
import { cn } from "@/commons/lib/utils";

/** The frame: busy to a screen reader, pulsing as one for the eye. */
export function Loading({ children, className, inside }: { children: ReactNode; className?: string; inside?: string }) {
  return (
    <div aria-busy="true" aria-label="loading" className={className}>
      <div className={cn("animate-pulse", inside)}>{children}</div>
    </div>
  );
}

/** One piece of a shape: a line of text by default, anything with a `className` that gives it a size. */
export function Bone({ className }: { className?: string }) {
  return <div className={cn("h-3 rounded-full bg-base-content/[0.08]", className)} />;
}

/** How long each line of a text is, in turn: uneven, as lines of writing are. */
const LINES = ["w-11/12", "w-4/5", "w-full", "w-2/3", "w-5/6", "w-1/2"] as const;

/** A file or a document being read: lines of text, where the text will be. */
export function TextLoading({ lines = 6, className }: { lines?: number; className?: string }) {
  return (
    <Loading {...(className ? { className } : {})} inside="space-y-2.5">
      {Array.from({ length: lines }, (_, at) => (
        <Bone key={at} className={LINES[at % LINES.length]} />
      ))}
    </Loading>
  );
}

/** A card's own lines: a heading, and what is under it. */
function CardBones({ lines }: { lines: number }) {
  return (
    <div className="space-y-3 rounded-[22px] border border-base-content/[0.06] p-5">
      <Bone className="h-4 w-1/4 bg-base-content/10" />
      {Array.from({ length: lines }, (_, at) => (
        <Bone key={at} className={LINES[(at + 1) % LINES.length]} />
      ))}
    </div>
  );
}

/** One card on its way, where a card will be. */
export function CardLoading({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <Loading {...(className ? { className } : {})}>
      <CardBones lines={lines} />
    </Loading>
  );
}

/**
 * A page about one thing (an agent, a mission, a job) on its way: where it came from, its name and what is said under
 * it, then its cards.
 */
export function DetailLoading({ cards = 2 }: { cards?: number }) {
  return (
    <Loading inside="space-y-5">
      <Bone className="w-20" />
      <div className="space-y-3">
        <Bone className="h-6 w-1/2 bg-base-content/10" />
        <Bone className="w-2/3" />
      </div>
      {Array.from({ length: cards }, (_, at) => (
        <CardBones key={at} lines={at === 0 ? 3 : 2} />
      ))}
    </Loading>
  );
}

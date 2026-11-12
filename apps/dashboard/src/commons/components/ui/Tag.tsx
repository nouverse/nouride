/**
 * A small rounded word over a card (0.8.24): what the card is about, in the colour of its job. Pink is what needs you,
 * lavender what is yours or who it is from, mint what is moving or done; plain is everything else. A tint with the
 * colour's own text, which `nouverse-look.test.ts` holds to AA in both themes.
 */

import type { ReactNode } from "react";
import { cn } from "@/commons/lib/utils";

export type TagTone = "needs" | "mine" | "moving" | "plain";

/**
 * A daisyUI badge holding words that can run long (a skill's tools, a secret's note): it grows a line instead of
 * spilling out of its fixed height, or being cut to an ellipsis whose rest only a mouse's tooltip shows, which a phone
 * has none of.
 */
export const BADGE_WRAPS = "h-auto min-h-5 py-0.5 text-left whitespace-normal [overflow-wrap:anywhere]";

const TONES: Record<TagTone, string> = {
  needs: "bg-accent/15 text-accent",
  mine: "bg-secondary/10 text-secondary",
  moving: "bg-success/15 text-success",
  plain: "border border-base-content/10 text-base-content/70",
};

export function Tag({ tone = "plain", children, className, title }: { tone?: TagTone; children: ReactNode; className?: string; /** What the word means, for a pointer that rests on it. */ title?: string }) {
  return (
    <span data-tag={tone} title={title} className={cn("inline-flex max-w-full items-center gap-1 truncate rounded-full px-2.5 py-0.5 text-xs font-medium", TONES[tone], className)}>
      {children}
    </span>
  );
}

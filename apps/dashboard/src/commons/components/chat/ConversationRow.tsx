/**
 * One conversation in a list: a face, a name with what kind of thing it is, when it last moved, and one line of what
 * was said there or what is happening now. The chat page's list, its Groups, a group folded away, and an agent's
 * History all draw their rows with it, so a row looks and behaves the same wherever it is.
 *
 * A link, never a click handler on a box: it opens with a middle click, and the keyboard reaches it. Every part that can
 * run long is cut to its line — a long name, a long message, a long group name — so nothing leaves the row or covers
 * the time.
 */

import { Link, type LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/commons/lib/utils";

export type RowTone = "said" | "working" | "quiet";

const LINE: Record<RowTone, string> = {
  said: "text-base-content/65",
  working: "font-semibold text-success",
  quiet: "italic text-base-content/65",
};

export function ConversationRow({
  link,
  onToggle,
  avatar,
  name,
  tag,
  time,
  line,
  tone = "said",
  trailing,
  unread = false,
  current = false,
  label,
  menu,
}: {
  /** Where the row goes; or, with `onToggle` instead, a row that opens what it folds (a list's quiet groups). */
  link?: LinkProps;
  onToggle?: { expanded: boolean; toggle: () => void };
  avatar?: ReactNode;
  name: string;
  /** A word on what this is, after the name: "Orchestrator", "WhatsApp", "Telegram · read-only". */
  tag?: ReactNode;
  time?: string;
  line?: ReactNode;
  tone?: RowTone;
  /** After the line: a group's agents. */
  trailing?: ReactNode;
  /** Something came since this browser last opened it. */
  unread?: boolean;
  current?: boolean;
  /** What a screen reader says for the whole row, where the parts alone would not. */
  label?: string;
  /**
   * What can be done to what the row stands for, at its end (History's Delete): beside the row's link, not inside it,
   * since a button in a link is pressed as the link. The row's ground and its hover take both in.
   */
  menu?: ReactNode;
}) {
  const ground = current ? "bg-secondary/10" : "hover:bg-base-content/[0.04]";
  const className = cn(
    "group flex min-h-16 w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors duration-150",
    "outline-none focus-visible:ring-2 focus-visible:ring-secondary/60",
    menu ? "min-w-0 flex-1 pr-1" : ground,
  );
  const body = (
    <>
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 truncate font-display text-[15px] font-medium", current ? "text-secondary" : "text-base-content")}>{name}</span>
          {tag}
          <span className="flex-1" />
          {time ? <span className={cn("shrink-0 text-[11px] tabular-nums", unread ? "font-semibold text-accent" : "text-base-content/65")}>{time}</span> : null}
        </span>
        {line || trailing || unread ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-[13px] leading-5", unread && tone === "said" ? "font-semibold text-base-content" : LINE[tone])}>{line}</span>
            {trailing}
            {unread ? <span role="img" aria-label="New reply" className="size-2.5 shrink-0 rounded-full bg-accent" /> : null}
          </span>
        ) : null}
      </span>
    </>
  );
  if (onToggle) {
    return (
      <button type="button" aria-expanded={onToggle.expanded} aria-label={label} onClick={onToggle.toggle} className={className}>
        {body}
      </button>
    );
  }
  const row = (
    <Link {...link} aria-current={current ? "page" : undefined} aria-label={label} className={className}>
      {body}
    </Link>
  );
  if (!menu) return row;
  return (
    <div className={cn("flex items-center rounded-2xl transition-colors duration-150", ground)}>
      {row}
      <div className="shrink-0 pr-1.5">{menu}</div>
    </div>
  );
}

/** A small word after a row's name, the same pill everywhere: what the row is, never a count. */
export function RowTag({ children }: { children: ReactNode }) {
  return <span className="shrink-0 rounded-full bg-secondary/10 px-2 py-0.5 text-[10px] font-bold leading-none whitespace-nowrap text-secondary">{children}</span>;
}

/** The small heading over a part of a list: "Not talked to yet", "Quiet for two weeks or more", a History's "Today". */
export function ListHeading({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("px-3 pt-4 pb-1 font-mono text-[11px] font-bold tracking-wider text-base-content/65 uppercase", className)}>{children}</p>;
}

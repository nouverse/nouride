/**
 * A card for something that waits for the person and is decided on its own page (0.8.24): a mission's question, a
 * request to talk to the agents, a skill to review. It says what it is and opens where the answer is given; Home and
 * Work's first tab draw the same card.
 *
 * Its title wraps anywhere and stops at three lines: a mission's goal is long, and a path in it ran past the
 * card's edge and under the Quick chat card beside it on Home. The whole of it stays in the `title` and on its page.
 */

import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { LIFTS } from "@/commons/components/ui/CardGrid";
import { Tag } from "@/commons/components/ui/Tag";
import { cn } from "@/commons/lib/utils";

export function WaitingLink({
  to,
  params,
  search,
  tag,
  title,
  full,
  line,
}: {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
  tag: string;
  title: string;
  /** The whole text the title was cut from, shown on a pointer's rest: a mission's goal. */
  full?: string;
  line: string;
}) {
  return (
    <Link
      to={to}
      {...(params ? { params } : {})}
      {...(search ? { search } : {})}
      className={cn("group flex min-w-0 flex-col gap-2 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft sm:p-5", LIFTS)}
    >
      <Tag tone="needs" className="self-start">{tag}</Tag>
      <p className="line-clamp-3 font-display text-lg leading-snug font-medium text-base-content [overflow-wrap:anywhere]" title={full ?? title}>
        {title}
      </p>
      <p className="flex items-center gap-1.5 text-sm text-base-content/70">
        {line}
        <ArrowRight size={14} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
      </p>
    </Link>
  );
}

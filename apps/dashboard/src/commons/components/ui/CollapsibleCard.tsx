/**
 * A card that opens on demand: the header is the toggle, and a one-line summary stays visible while
 * it is closed — so something worth a glance (today's spend) sits at the top of a page without the
 * detail under it pushing everything else down.
 */

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/commons/lib/utils";

export function CollapsibleCard({
  title,
  description,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  description?: string;
  /** Shown beside the title whether open or not — the glanceable part. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-2xl border border-base-content/[0.08] bg-base-100/80 shadow-sm backdrop-blur-xl backdrop-saturate-150">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn("flex w-full flex-wrap items-center justify-between gap-3 px-5 py-4 text-left sm:px-6", open && "border-b border-base-content/[0.08]")}
      >
        <span className="min-w-0 space-y-0.5">
          <span className="block text-base font-semibold tracking-tight text-base-content">{title}</span>
          {description ? <span className="block text-xs text-base-content/65 sm:text-sm">{description}</span> : null}
        </span>
        <span className="flex items-center gap-3">
          {summary}
          <ChevronDown size={16} className={cn("shrink-0 text-base-content/50 transition-transform", open && "rotate-180")} />
        </span>
      </button>
      {open ? <div className="p-5 sm:p-6">{children}</div> : null}
    </section>
  );
}

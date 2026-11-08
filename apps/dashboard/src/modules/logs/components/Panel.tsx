/**
 * The panel every Logs tab is drawn in, and the retention control in its head: one window per
 * record, so each panel carries its own.
 */

import type { ReactNode } from "react";
import { RetentionControl, type RetentionShown } from "@/commons/components/ui/RetentionControl";

/**
 * A card whose body scrolls and whose head does not.
 *
 * Local to this page rather than a change to `Card`: every other page in the dashboard is a document
 * that scrolls as one, and that is right for them. Here the head carries the filters, and filters
 * that scroll out of reach are filters you have to scroll back for.
 */
export function Panel({
  title,
  description,
  retention,
  toolbar,
  children,
}: {
  title: string;
  description: string;
  /**
   * Which window prunes what this panel shows.
   *
   * In the head of the panel, not above the tabs. It was above them for one release and that was
   * wrong in a way worth writing down: each tab has its *own* window, so a control that changed as
   * you switched tabs sat in the one place that reads as page-level and meant something different in
   * each. Inside the panel there is nothing to misread — it governs what is underneath it.
   */
  retention?: RetentionShown;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    // Its own scroll from a laptop's width up; on a phone it is as tall as its rows and the page scrolls (`LogsPage`).
    <section className="flex shrink-0 flex-col rounded-2xl border border-base-content/[0.08] bg-base-100/80 backdrop-blur-xl shadow-sm lg:min-h-0 lg:flex-1 lg:shrink lg:overflow-hidden">
      <div className="shrink-0 space-y-3 border-b border-base-content/[0.08] px-4 py-3.5 sm:px-5">
        <div className="space-y-1 min-w-0">
          <h2 className="font-semibold tracking-tight text-base-content text-base">{title}</h2>
          <p className="text-base-content/65 text-sm">{description}</p>
          {/* Directly under the subtitle, in the same block, on every panel.
              It used to share a `justify-between` row with the title, so where it landed depended on
              how long that panel's description happened to be — beside it on one tab, wrapped below
              on the next. A control that moves between tabs is a control you have to look for. */}
          {retention && <RetentionControl scope={retention} />}
        </div>
        {toolbar}
      </div>
      {/* `min-h-0` is what makes the scroll happen here instead of pushing the page taller — without
          it a flex child grows to its content and the whole document scrolls again. */}
      <div className="px-2 py-2 sm:px-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">{children}</div>
    </section>
  );
}

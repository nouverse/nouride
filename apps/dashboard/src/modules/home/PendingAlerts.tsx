/**
 * What is waiting on somebody, on the page they already have open.
 *
 * Two queues sit on pages you have to think of opening — pairing requests on Access, proposed skills
 * in the Workshop — and both are time-sensitive in their own way: a pairing code
 * expires in fifteen minutes, and a draft is a lesson an agent learned that goes nowhere until a
 * person reads it. Neither surfaced anywhere you would see them without going to look.
 *
 * **Alerts, not controls.** An earlier version put Approve buttons here and that was wrong: Overview
 * is a glance, and a page you skim is the worst place to put an irreversible yes next to somebody's
 * name. These say how many and where, and the decision is made on the page that shows the whole
 * request — who is asking, on which connection, and what the alternative is.
 *
 * Renders nothing when both queues are empty. A permanent zero is a thing you learn to stop seeing.
 */

import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, UserPlus, Wrench } from "lucide-react";
import { api } from "@/commons/lib/api";

/** One row's worth of "N things are waiting, here is where". */
function Alert({
  icon: Icon,
  message,
  cta,
  to,
}: {
  icon: typeof UserPlus;
  message: string;
  cta: string;
  to: "/access" | "/skills";
}) {
  return (
    <div className="alert alert-warning bg-warning/10 border border-warning/30 text-warning rounded-2xl p-4 shadow-xs flex flex-wrap items-center gap-3">
      <Icon size={18} className="shrink-0" />
      <p className="text-sm font-semibold flex-1 min-w-0">{message}</p>
      <Link
        to={to}
        className="btn btn-warning btn-xs sm:btn-sm rounded-lg gap-1.5 font-semibold shadow-xs active:scale-95 transition-all"
      >
        {cta}
        <ArrowRight size={14} />
      </Link>
    </div>
  );
}

export function PendingAlerts() {
  /**
   * The same keys and interval the pages themselves use, so deciding something in one place clears
   * the alert here without either knowing the other exists.
   *
   * `retry: false` on both: a daemon with access control off answers 501, and a daemon with the
   * reflection loop off answers an empty queue. Retrying a settled "this is not on" four times only
   * delays the rest of the page.
   */
  const access = useQuery({ queryKey: ["access"], queryFn: api.access, refetchInterval: 15_000, retry: false });
  const drafts = useQuery({ queryKey: ["skill-drafts"], queryFn: api.skillDrafts, refetchInterval: 30_000, retry: false });

  const pairings = (access.data?.senders ?? []).filter((sender) => sender.status === "pending").length;
  const skills = drafts.data?.pending?.length ?? 0;
  if (pairings === 0 && skills === 0) return null;

  return (
    <div className="space-y-3">
      {pairings > 0 && (
        <Alert
          icon={UserPlus}
          message={`You have ${pairings} pending pairing request${pairings === 1 ? "" : "s"}.`}
          cta="See details"
          to="/access"
        />
      )}
      {skills > 0 && (
        <Alert
          icon={Wrench}
          message={`You have ${skills} skill${skills === 1 ? "" : "s"} waiting for review.`}
          cta="See details"
          to="/skills"
        />
      )}
    </div>
  );
}

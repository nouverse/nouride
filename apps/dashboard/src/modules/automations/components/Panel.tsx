/**
 * The one panel beside an automation's canvas, and what it holds when no box is pressed. A pressed box opens its
 * fields there (`OpenFields`), the canvas staying in view; whose the automation is opens there too, from the head's
 * menu: it was two cards of explanation beside the steps on every visit. With nothing open it holds the last runs.
 */

import type { ReactNode } from "react";
import type { AutomationSummary, JobRunSummary } from "@nouride/wire";
import { Allowed } from "@/commons/components/jobs/Allowances";
import { answeredBy } from "@/commons/lib/by-person";
import { RecentRuns } from "./RecentRuns";
import { WhoseItIs } from "./WhoseItIs";

/** A card of the panel: a pressed box's fields, or whose the automation is. */
export function PanelCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft sm:p-5">
      {children}
    </section>
  );
}

/** Whose it is, and who may change it: opened from the head's menu, which only one who may change it has. */
export function Whose({ automation, onHanded, onDone }: { automation: AutomationSummary; /** Its own person gave it away: there may be no page of it to stay on. */ onHanded: () => void; onDone: () => void }) {
  return (
    <div className="space-y-4" data-whose-fields>
      <WhoseItIs automation={automation} onHanded={onHanded} />
      <section aria-label="Who may change it" className="space-y-1.5">
        <h2 className="text-lg text-base-content">Who may change it</h2>
        <p className="text-sm text-base-content/85">You change the steps here. An agent can suggest a change, and it waits for your yes.</p>
        <p className="text-xs text-base-content/65">Nouride runs the steps in this order every time. An agent only does the step it is given, with what the step before it said.</p>
      </section>
      <div className="flex justify-end">
        <button type="button" className="btn btn-primary btn-sm rounded-xl px-5" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

/** With nothing open: the last runs, and what its runs may send without asking again. None of either for one an agent proposed, which has never run. */
export function AtRest({
  automation,
  runs,
  picked,
  onPick,
  canAllow,
}: {
  automation: AutomationSummary | null;
  runs: readonly JobRunSummary[];
  /** The run drawn over the steps, by its id. */
  picked: string | null;
  onPick: (run: JobRunSummary) => void;
  /** Whether a standing yes is the reader's to take back: a webhook's is an admin's, as making the webhook was. */
  canAllow: boolean;
}) {
  if (!automation) return null;
  return (
    <>
      {automation.proposal ? null : <RecentRuns jobId={automation.id} runs={runs} picked={picked} onPick={onPick} canAllow={canAllow} whom={answeredBy(automation)} />}
      {automation.allowed?.length ? (
        <section className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft">
          <Allowed job={automation} canEdit={canAllow} />
        </section>
      ) : null}
    </>
  );
}

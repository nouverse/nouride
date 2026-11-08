/**
 * A newer release this install cannot take yet: it upgrades only from a version this one is below (its upgrade floor).
 *
 * The page's buttons already act on the stepping stone — the check offers it as `latest` — so this card says why the
 * version they name is not the newest one, in the daemon's own sentence, the one `nouride update` prints.
 */

import { Footprints } from "lucide-react";
import type { UpdateStatus } from "@nouride/wire";
import { Card } from "@/commons/components/ui/ui";

export function FloorCard({ check }: { check: NonNullable<UpdateStatus["check"]> }) {
  if (!check.floor) return null;
  const target = check.floor.release.replace(/^v/, "");
  return (
    <Card
      title={`${target} needs ${check.floor.needs} first`}
      description={check.floor.message}
      className="border-warning/40 bg-warning/5"
    >
      <p className="text-xs opacity-80">
        <Footprints size={13} className="inline mr-1 -mt-0.5" />
        {check.newer
          ? `${target} can only update a Nouride that has run ${check.floor.needs} at least once, so ${check.latest} comes first. Once it has run, ${target} is offered here.`
          : `${target} can only update a Nouride that has run ${check.floor.needs} at least once, and this one cannot get there from here. Whoever runs this server needs to install ${check.floor.needs} by hand and start it once, then update.`}
      </p>
    </Card>
  );
}

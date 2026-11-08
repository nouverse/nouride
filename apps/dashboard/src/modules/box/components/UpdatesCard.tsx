import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2, RefreshCw } from "lucide-react";
import { applianceApi as api } from "@/commons/lib/api.appliance";
import type { BoxState } from "@nouride/wire";
import { Card, ErrorNote } from "@/commons/components/ui/ui";

/**
 * How this box stays current. Releases reach a box from Nouverse, signed, and are installed
 * overnight unless the owner turns that off; the Update page installs one now.
 */
export function UpdatesCard({ state }: { state: BoxState }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: api.boxSetAutomaticUpdates,
    onSuccess: (next) => queryClient.setQueryData(["box"], next),
  });
  if (!state.updates) return null;
  const automatic = state.updates.automatic;

  return (
    <Card title="Updates" description="New versions reach this box from Nouverse, signed, and are checked before they are installed.">
      <div className="space-y-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            className="toggle toggle-primary toggle-sm mt-0.5"
            checked={automatic}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
          <span className="space-y-1">
            <span className="flex items-center gap-2 text-sm font-medium text-base-content">
              Install updates automatically {toggle.isPending ? <Loader2 size={13} className="animate-spin" /> : null}
            </span>
            <span className="block text-xs text-base-content/65 leading-relaxed">
              Overnight, between 2 and 5 in the morning, and only while nobody is using the box. If a new version does not start
              properly, the box goes back to the one it had.
            </span>
          </span>
        </label>
        {toggle.error ? <ErrorNote error={toggle.error} /> : null}
        <Link to="/update" className="btn btn-sm btn-outline rounded-xl gap-2">
          <RefreshCw size={14} /> Check for an update now
        </Link>
      </div>
    </Card>
  );
}

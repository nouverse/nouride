/**
 * One automation's page: read with its last runs and any change an agent suggested to it, and asked again as it goes.
 * Every two seconds while a run of it is at work or waiting, so its steps are seen to move; as a slow net otherwise. A
 * hidden tab asks for nothing, which is the query client's own rule for an interval.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { DetailLoading } from "@/commons/components/ui/Skeleton";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { api } from "@/commons/lib/api";
import { ApiError } from "@/commons/lib/api.client";
import { AutomationView } from "./components/AutomationView";
import { blankDraft } from "./lib/draft";
import { live } from "./lib/runs";

const LIVE_MS = 2_000;
const SETTLED_MS = 10_000;
/** Never drawn from: a page that shows an automation has one. */
const NONE = blankDraft("", "", "UTC");

export default function AutomationPage({ id }: { id: string }) {
  const found = useQuery({
    queryKey: ["automations", "detail", id],
    queryFn: () => api.automation(id),
    refetchInterval: (query) => (query.state.data?.runs.some(live) ? LIVE_MS : SETTLED_MS),
    retry: (count, error) => !(error instanceof ApiError && (error.status === 404 || error.status === 501)) && count < 2,
  });

  if (found.isLoading) return <DetailLoading cards={3} />;
  if (!found.data) {
    if (found.error instanceof ApiError && found.error.status === 404) {
      return (
        <Card>
          <EmptyState
            pose="lost"
            title="No such automation"
            description="It may have been deleted, or the link is an old one."
            action={
              <Link to="/automations" className="btn btn-sm btn-ghost">
                All automations
              </Link>
            }
          />
        </Card>
      );
    }
    // "Not turned on" only when the server says so (501): a start's 503 or a timeout is an error, said as one.
    if (found.error instanceof ApiError && found.error.status === 501) {
      return (
        <div className="alert alert-warning rounded-2xl border border-warning/30 bg-warning/10 p-4 text-warning">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>Automations are not turned on for this server.</span>
        </div>
      );
    }
    return <ErrorNote error={found.error} />;
  }
  // Keyed by the automation: another one's page starts with nothing of this one's draft.
  return <AutomationView key={id} detail={found.data} blank={NONE} home={found.data.timezone} />;
}

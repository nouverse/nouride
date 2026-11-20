/**
 * Export and import: a Nouride taken to another machine as one file, or one brought in here. For someone moving house
 * with their data, not for an engineer: what the file holds is said before it is made, and what an import replaces
 * before it does. After an import the page leads with how it went, and with "Go live".
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { isAdmin, useMe } from "@/commons/lib/session";
import { EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { ShieldCheck } from "lucide-react";
import { ExportCard } from "./components/ExportCard";
import { ImportCard } from "@/commons/components/transfer/ImportCard";
import { ImportedCard } from "./components/ImportedCard";

/** Asked again while a file is being made, so its progress moves; otherwise only now and then. */
const WORKING_MS = 1_000;
const IDLE_MS = 15_000;

export default function TransferPage() {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const state = useQuery({
    queryKey: ["transfer"],
    queryFn: api.transfer,
    enabled: admin,
    refetchInterval: (query) => (query.state.data?.export.state === "working" ? WORKING_MS : IDLE_MS),
  });

  return (
    <div className="space-y-6 *:animate-fade">
      <PageHeader title="Export and import" description="Take everything this Nouride holds to another machine as one file, or bring such a file in here." />
      {!admin ? (
        <EmptyState icon={ShieldCheck} title="Only an admin can do this" description="A file like this holds every chat and memory, and bringing one in replaces them." />
      ) : (
        <>
          <ErrorNote error={state.error} />
          {state.data?.imported ? <ImportedCard report={state.data.imported} restarts={state.data.restarts} /> : null}
          {state.data ? <ExportCard state={state.data} /> : null}
          <ImportCard state={state.data} />
        </>
      )}
    </div>
  );
}

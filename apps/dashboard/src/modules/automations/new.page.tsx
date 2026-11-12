/**
 * A new automation: the same flow as one that exists, empty. It opens on the orchestrator and the first connection
 * that is on, as the agent and where it reports, since those are what most are made for; nothing exists until Save.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { DetailLoading } from "@/commons/components/ui/Skeleton";
import { ErrorNote } from "@/commons/components/ui/ui";
import { api } from "@/commons/lib/api";
import { orchestratorFirst } from "@/commons/lib/agents";
import { AutomationView } from "./components/AutomationView";
import { blankDraft } from "./lib/draft";

export default function NewAutomationPage() {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const gateways = useQuery({ queryKey: ["gateways"], queryFn: api.gateways, retry: false });
  // The server's time zone, which a time is read in unless it names its own.
  const list = useQuery({ queryKey: ["automations", "list", "mine"], queryFn: () => api.automations(), retry: false });
  const home = list.data?.timezone ?? "UTC";
  const agent = orchestratorFirst(status.data?.agents ?? [], status.data?.orchestrator)[0]?.id ?? "";
  const connections = gateways.data?.gateways ?? [];
  const gateway = (connections.find((one) => one.enabled) ?? connections[0])?.id ?? "";
  const blank = useMemo(() => blankDraft(agent, gateway, home), [agent, gateway, home]);

  if (status.isLoading || gateways.isLoading || list.isLoading) return <DetailLoading cards={3} />;
  if (status.error && !status.data) return <ErrorNote error={status.error} />;
  return <AutomationView detail={null} blank={blank} home={home} />;
}

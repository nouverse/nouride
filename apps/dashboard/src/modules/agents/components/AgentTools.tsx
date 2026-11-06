/**
 * Which tools one agent has, switched here and saved to its `[tools] enabled` — the line its preset
 * wrote when it was created. Admin only, as the route is: a tool switched on is a capability granted.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/commons/lib/api";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { ToolPicker } from "./ToolPicker";

export function AgentTools({ agentId, tools, admin }: { agentId: string; tools: readonly string[]; admin: boolean }) {
  const queryClient = useQueryClient();
  const presets = useQuery({ queryKey: ["agent-presets"], queryFn: api.agentPresets, staleTime: 5 * 60 * 1000 });
  const listed = new Set((presets.data?.groups ?? []).flatMap((group) => group.tools));
  // Only what a switch can show: `ask_agent` and `attachment_read` follow the daemon, not this list.
  const current = tools.filter((tool) => listed.has(tool));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => setPicked(new Set(current)), [presets.data, tools.join(",")]);
  const dirty = picked.size !== current.length || current.some((tool) => !picked.has(tool));

  const save = useMutation({
    mutationFn: () => api.setAgentTools(agentId, [...picked]),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });

  return (
    <Card title="Tools" description="What this agent can use. It still checks with you before anything risky.">
      {presets.error ? <ErrorNote error={presets.error} /> : null}
      {presets.data ? <ToolPicker groups={presets.data.groups} selected={picked} disabled={!admin || save.isPending} onChange={setPicked} /> : null}
      <ErrorNote error={save.error} />
      <div className="mt-4 flex items-center gap-3">
        <button type="button" className="btn btn-primary btn-sm rounded-xl" disabled={!admin || !dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null} Save tools
        </button>
        {!admin ? <span className="text-base-content/65 text-xs">Only an admin can change an agent's tools.</span> : null}
      </div>
    </Card>
  );
}

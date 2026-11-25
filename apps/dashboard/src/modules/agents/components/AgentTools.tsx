/**
 * Which tools one agent has, switched here and saved to its `[tools] enabled` — the line its preset
 * wrote when it was created. Admin only, as the route is: a tool switched on is a capability granted.
 *
 * An agent open to everyone holds none of them: it answers strangers, so Nouride gives it a few tools of its own
 * whatever this list says. The switches are shown locked while it is open, with why and the way to its Access tab,
 * and what they hold is kept for when it is closed.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { ToolPicker } from "./ToolPicker";

export function AgentTools({ agentId, tools, admin, open = false }: { agentId: string; tools: readonly string[]; admin: boolean; open?: boolean }) {
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
      {open ? (
        <p className="mb-4 flex items-start gap-2 rounded-xl border border-base-content/10 bg-base-200/60 p-3 text-xs leading-relaxed" data-tools-locked>
          <Lock size={14} className="mt-0.5 shrink-0 text-base-content/60" aria-hidden="true" />
          <span>
            <span className="font-semibold">Switched off while this agent is open to everyone.</span> It answers people you do not know, so it can only search and read what you opened to everyone under Knowledge, read a file someone sends
            it, and send a file from that knowledge. What is picked below is kept, and used again once you close it on its{" "}
            <Link to="/agents/$agentId/access" params={{ agentId }} className="link">
              Access tab
            </Link>
            .
          </span>
        </p>
      ) : null}
      {presets.data ? <ToolPicker groups={presets.data.groups} selected={picked} disabled={!admin || open || save.isPending} onChange={setPicked} /> : null}
      <ErrorNote error={save.error} />
      <div className="mt-4 flex items-center gap-3">
        <button type="button" className="btn btn-primary btn-sm rounded-xl" disabled={!admin || open || !dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null} Save tools
        </button>
        {!admin ? <span className="text-base-content/65 text-xs">Only an admin can change an agent's tools.</span> : null}
      </div>
    </Card>
  );
}

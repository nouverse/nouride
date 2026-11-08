/**
 * Whether the orchestrator installs and updates the programs every agent runs (`[security] shared_tools`, 0.8.0).
 *
 * Where each agent's commands run as its own user, what one agent installs is its own: a shared program another agent
 * could change is one it could make another agent — or the daemon — run. The orchestrator is the one that may, through
 * `nouride tools run`, as the daemon's user, under its approvals. Shown on the orchestrator's page alone: in any other
 * agent's pack the setting changes nothing. Turning it off asks first; turning it back on does not.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";
import { ToggleRow } from "@/commons/components/ui/ToggleRow";
import { useSaved } from "@/commons/hooks/use-saved";

/** Offered on the orchestrator's page only, and by a daemon that says (0.8.0 or later). */
export function offersSharedTools(orchestrator: string | null | undefined, agent: AgentSummary): boolean {
  return orchestrator === agent.id && agent.sharedTools !== undefined;
}

export function SharedTools({ agent, editable }: { agent: AgentSummary; editable: boolean }) {
  const queryClient = useQueryClient();
  const { ask, dialog } = useConfirm();
  const saved = useSaved();
  const name = agent.displayName || agent.id;
  const save = useMutation({
    mutationFn: (on: boolean) => api.setAgentSharedTools(agent.id, on),
    onSuccess: (answer, on) => {
      saved(answer, on ? `${name} installs programs for every agent` : `${name} no longer installs programs for every agent`);
      void queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });
  // A daemon before 0.8.0 does not say: not offered.
  const on = agent.sharedTools === true;

  async function change(next: boolean) {
    if (!next) {
      const confirmed = await ask({
        title: `Stop ${name} installing for every agent?`,
        body:
          "Programs every agent runs (claude, Rust, a global npm tool) will then change only when you change them " +
          "yourself. What each agent installs for itself is not affected.",
        confirmLabel: "Stop",
      });
      if (!confirmed) return;
    }
    save.mutate(next);
  }

  return (
    <Card
      title="Programs every agent runs"
      description="As the orchestrator, this agent installs and updates the programs every agent runs. Each agent installs what it needs for itself in its own folder."
    >
      <ToggleRow
        label="Install and update programs for every agent"
        hint="It asks before it installs anything, as its approvals say. No other agent can."
        checked={on}
        disabled={!editable || save.isPending || agent.sharedTools === undefined}
        onChange={(next) => void change(next)}
      />
      {save.error ? <ErrorNote error={save.error} /> : null}
      {dialog}
    </Card>
  );
}

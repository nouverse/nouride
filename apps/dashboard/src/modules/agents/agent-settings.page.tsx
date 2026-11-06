/**
 * One agent's own settings: what a turn may spend, how much it hands to helpers in the background, how many missions it
 * runs at once, and which tools it has.
 *
 * Moved off the Model tab, which is now only the endpoint and the model: these are about how the agent
 * works, whatever it runs on, and a Model tab that also held them was where nobody looked for them.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { AgentHeadline } from "./components/AgentHeadline";
import { AgentToolBudget } from "./components/AgentToolBudget";
import { AgentTools } from "./components/AgentTools";
import { AgentTurnBudget } from "./components/AgentTurnBudget";
import { AgentJobQuiet } from "./components/AgentJobQuiet";
import { AgentBackgroundHelpers } from "./components/AgentBackgroundHelpers";
import { AgentMissionSlots } from "./components/AgentMissionSlots";
import { offersSharedTools, SharedTools } from "./components/SharedTools";
import { ExternalNote } from "./components/ExternalNote";

export default function AgentSettingsPage({ agentId }: { agentId: string }) {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const me = useMe();
  const agent = status.data?.agents.find((entry) => entry.id === agentId);
  if (!agent) return null;
  const editable = canWrite(me.data ?? null);

  return (
    <div className="space-y-6">
      <ExternalNote agentId={agentId} says={({ cli }) => `${cli} runs its own tool loop, so the tool budget does not apply to it. The tools picked here are the Nouride tools lent to it: memory, asking another agent, missions, schedules.`} />
      <AgentHeadline agent={agent} editable={editable} />
      <AgentToolBudget agent={agent} editable={editable} />
      <AgentTurnBudget agent={agent} editable={editable} />
      <AgentJobQuiet agent={agent} editable={editable} />
      <AgentBackgroundHelpers agent={agent} editable={editable} />
      <AgentMissionSlots agent={agent} editable={editable} />
      <AgentTools agentId={agent.id} tools={agent.tools} admin={isAdmin(me.data ?? null)} />
      {/* The orchestrator's alone: in any other agent's pack the setting changes nothing. */}
      {offersSharedTools(status.data?.orchestrator, agent) ? <SharedTools agent={agent} editable={isAdmin(me.data ?? null)} /> : null}
    </div>
  );
}

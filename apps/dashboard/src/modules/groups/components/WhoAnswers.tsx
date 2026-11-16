/**
 * Who answers a message that tags nobody in one room: a tag is needed, or one of the agents answers, or the room says
 * nothing of its own. The room's own setting, the one `/mention` writes from the chat, so what is picked here is what
 * `/mention` says there, and the other way round.
 *
 * Picked by an admin, and said in words to anyone else. In a room made in the dashboard the agents to pick from are
 * the ones in it: the router answers such a room by its members, and its header picks the same way
 * (`chat/components/RoomAnswer.tsx`).
 */

import { useMutation } from "@tanstack/react-query";
import type { GroupRecord } from "@nouride/wire";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";
import { api } from "@/commons/lib/api";
import { agentChoice, choiceSaid, choiceSent, DEFAULT, pickedOf, REQUIRED } from "@/commons/lib/who-answers";

export function WhoAnswers({
  group,
  agents,
  orchestrator,
  editable,
  onChanged,
}: {
  group: GroupRecord;
  agents: readonly { id: string; name: string }[];
  orchestrator: string | null;
  editable: boolean;
  onChanged: () => void;
}) {
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id;
  const saved = useSaved();
  /** Who answers now, by the router's own answer. */
  const now = group.untagged ? `${nameOf(group.untagged)} answers` : "Nobody answers";
  const set = useMutation({
    mutationFn: (next: string) => api.setGroupMention({ gatewayId: group.gatewayId, chatId: group.chatId, ...choiceSent(next) }),
    onSuccess: (answer, next) => {
      saved(answer, choiceSaid(next, group.name ?? "this room", nameOf));
      onChanged();
    },
  });

  if (!editable) return <span className="text-base-content/80">{group.mention?.requireTag ? "A tag is needed" : now}</span>;

  const picked = pickedOf(group);
  // A room made in the dashboard is answered by its members: nobody else can be named there.
  const offered = group.dashboard ? agents.filter((agent) => group.agents.includes(agent.id)) : agents;
  return (
    <div className="space-y-1">
      <SearchSelect
        label="Who answers a message that tags nobody"
        options={[
          { value: DEFAULT, label: "Default" },
          { value: REQUIRED, label: "A tag is needed" },
          ...offered.map((agent) => ({ value: agentChoice(agent.id), label: agent.name, ...(agent.id === orchestrator ? { detail: "Orchestrator" } : {}) })),
        ]}
        value={picked}
        onChange={(next) => {
          if (next !== picked) set.mutate(next);
        }}
        placeholder="Nobody answers"
        align="start"
        small
        disabled={set.isPending}
      />
      {/* The default is whatever the connection and the server say: said, so "Default" is not a guess. */}
      {picked === DEFAULT ? <p className="text-[11px] text-base-content/65">Now: {group.untagged ? `${nameOf(group.untagged)} answers` : "nobody answers"} without a tag</p> : null}
      <ErrorNote error={set.error} />
    </div>
  );
}

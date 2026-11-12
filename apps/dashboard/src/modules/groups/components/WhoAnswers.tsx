/**
 * Who answers a message that tags nobody in one room: a tag is needed, or one of the agents answers, or the room says
 * nothing of its own. The room's own setting, the one `/mention` writes from the chat, so what is picked here is what
 * `/mention` says there, and the other way round.
 *
 * Picked by an admin, in a room on a chat app. Said in words where it cannot be picked: to anyone else, and in a room
 * made in the dashboard, which its members answer (the orchestrator when it is one of them).
 */

import { useMutation } from "@tanstack/react-query";
import type { GroupRecord } from "@nouride/wire";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";
import { api } from "@/commons/lib/api";

const DEFAULT = "default";
const REQUIRED = "required";
const AGENT = "agent:";

/** What is picked now, as the list's values have it: an agent picked that is gone reads as nobody, by its absence. */
export function pickedOf(group: Pick<GroupRecord, "mention" | "untagged">): string {
  if (!group.mention) return DEFAULT;
  if (group.mention.requireTag) return REQUIRED;
  return `${AGENT}${group.mention.answerer ?? group.untagged ?? ""}`;
}

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
    mutationFn: (next: string) =>
      api.setGroupMention({
        gatewayId: group.gatewayId,
        chatId: group.chatId,
        ...(next.startsWith(AGENT) ? { mention: "agent" as const, agent: next.slice(AGENT.length) } : { mention: next as "default" | "required" }),
      }),
    onSuccess: (answer, next) => {
      const room = group.name ?? "this room";
      const what =
        next === REQUIRED
          ? `A tag is needed in ${room}`
          : next === DEFAULT
            ? `${room} follows the default again`
            : `${nameOf(next.slice(AGENT.length))} answers in ${room} when nobody is tagged`;
      saved(answer, what);
      onChanged();
    },
  });

  if (group.dashboard || !editable) return <span className="text-base-content/80">{group.mention?.requireTag ? "A tag is needed" : now}</span>;

  const picked = pickedOf(group);
  return (
    <div className="space-y-1">
      <SearchSelect
        label="Who answers a message that tags nobody"
        options={[
          { value: DEFAULT, label: "Default" },
          { value: REQUIRED, label: "A tag is needed" },
          ...agents.map((agent) => ({ value: `${AGENT}${agent.id}`, label: agent.name, ...(agent.id === orchestrator ? { detail: "Orchestrator" } : {}) })),
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

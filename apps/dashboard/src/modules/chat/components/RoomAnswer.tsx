/**
 * Who answers a message that tags nobody in a room made in the dashboard, picked from its header: the choice
 * `/mention` writes when it is typed in the room, by the Groups page's values and in its words
 * (`commons/lib/who-answers.ts`). One of the room's members, a tag is needed, or the default, where the room's
 * members decide. An admin's, as `/mention` is; anyone else reads who answers, as before.
 *
 * From a laptop up it is a button beside the members' tags (`RoomAnswerMenu`). On a phone the tags are not drawn, and
 * the same choices open from the room's menu (`RoomAnswerChoices`).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import type { ChatListRoom, Room } from "@nouride/wire";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";
import { useToast } from "@/commons/components/ui/toast";
import { useSaved } from "@/commons/hooks/use-saved";
import { api } from "@/commons/lib/api";
import { cn } from "@/commons/lib/utils";
import { agentChoice, choiceSaid, choiceSent, DEFAULT, pickedOf, REQUIRED } from "@/commons/lib/who-answers";

interface Choice {
  value: string;
  label: string;
  detail?: string;
}

export interface RoomAnswer {
  picked: string;
  choices: Choice[];
  pick: (value: string) => void;
  pending: boolean;
}

/** The room's choices, what is picked now, and the change, sent as the Groups page sends it. */
export function useRoomAnswer(
  room: Pick<Room, "gatewayId" | "chatId" | "members">,
  said: Pick<ChatListRoom, "mention" | "untagged"> | undefined,
  o: { name: string; nameOf: (agentId: string) => string; refresh: () => void },
): RoomAnswer {
  const toast = useToast();
  const saved = useSaved();
  const queryClient = useQueryClient();
  const picked = pickedOf(said ?? {});
  const set = useMutation({
    mutationFn: (next: string) => api.setGroupMention({ gatewayId: room.gatewayId, chatId: room.chatId, ...choiceSent(next) }),
    onSuccess: (answer, next) => {
      saved(answer, choiceSaid(next, o.name, o.nameOf));
      o.refresh();
      // The Groups page lists the room too, with the same choice.
      void queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
    onError: (error: unknown) => toast.error("Could not change who answers", error),
  });
  return {
    picked,
    choices: [
      // The default is the room's members' rule: said as who that is now, so "Default" is not a guess.
      { value: DEFAULT, label: "Default", ...(picked === DEFAULT ? { detail: said?.untagged ? `Now: ${o.nameOf(said.untagged)}` : "Now: nobody" } : {}) },
      { value: REQUIRED, label: "A tag is needed" },
      ...room.members.map((member) => ({ value: agentChoice(member.agentId), label: o.nameOf(member.agentId), detail: `@${member.agentId}` })),
    ],
    pick: (value) => {
      if (value !== picked) set.mutate(value);
    },
    pending: set.isPending,
  };
}

/** The choices as a menu's rows, the picked one checked. `close` closes the menu they are in. */
export function RoomAnswerChoices({ answer, close }: { answer: RoomAnswer; close: () => void }) {
  return (
    <>
      <li className="menu-title px-3 pt-2 pb-1 text-[11px] font-normal text-base-content/65">A message that tags nobody is answered by</li>
      {answer.choices.map((choice) => (
        <li key={choice.value}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={choice.value === answer.picked}
            className="min-h-11 gap-3 rounded-xl text-sm"
            disabled={answer.pending}
            onClick={() => {
              close();
              answer.pick(choice.value);
            }}
          >
            <Check size={16} aria-hidden="true" className={cn("shrink-0 text-primary", choice.value !== answer.picked && "invisible")} />
            <span className="min-w-0 truncate font-semibold">{choice.label}</span>
            {choice.detail ? <span className="ml-auto shrink-0 text-xs text-base-content/65">{choice.detail}</span> : null}
          </button>
        </li>
      ))}
    </>
  );
}

/** The button beside the members' tags, from a laptop up. */
export function RoomAnswerMenu({ answer }: { answer: RoomAnswer }) {
  return (
    <DropdownMenu
      trigger={
        <>
          Who answers with no tag
          <ChevronDown size={13} aria-hidden="true" />
        </>
      }
      triggerClassName="inline-flex h-7 items-center gap-1 rounded-full border border-base-content/[0.12] bg-base-100 px-2.5 text-xs font-medium text-base-content/80 hover:bg-base-content/[0.06]"
      ariaLabel="Who answers a message that tags nobody"
      width={300}
      align="start"
      menuClassName="rounded-2xl border border-base-content/[0.08] bg-base-100 p-1.5 shadow-soft"
    >
      {(close) => <RoomAnswerChoices answer={answer} close={close} />}
    </DropdownMenu>
  );
}

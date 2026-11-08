/**
 * What a person says to a mission — stop, continue, accept, answer, tell — and what the page then says back: a toast that
 * outlives the button, the daemon's own sentence when it refused (a 409: it ended meanwhile, it is not waiting for
 * that), and the mission read again either way, since the answer changes what it is.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import type { MissionVerb } from "@nouride/wire";
import { useToast } from "@/commons/components/ui/toast";

const DONE: Record<MissionVerb, string> = {
  stop: "Mission stopped",
  continue: "Mission goes on",
  accept: "Mission accepted",
  answer: "Answer sent",
  tell: "Told",
};

export function useMissionAct(id: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { verb: MissionVerb; text?: string }) => api.actOnMission(id, input.verb, input.text),
    // A tell says where the words went: into the turn at work, or kept for the next and what moves it (0.8.10). In the
    // page's words (0.8.23), `said` being the chat's, with its `/mission` commands.
    onSuccess: (answer, { verb }) => {
      const where = answer.plain ?? answer.said;
      return verb === "tell" && where ? toast.success(DONE.tell, where) : toast.success(DONE[verb]);
    },
    onError: (error, { verb }) => toast.error(`Could not ${verb} it`, error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["missions"] }),
  });
}

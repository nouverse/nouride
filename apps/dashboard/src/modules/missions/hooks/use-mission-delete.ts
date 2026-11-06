/**
 * An ended mission deleted (0.8.13), then the list: the page it was on is gone with it. The caller reads a refusal's
 * sentence itself — the daemon's 409 names work nobody committed in its folder, which a second, forced ask may lose.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { api } from "@/commons/lib/api";
import { useToast } from "@/commons/components/ui/toast";

export function useMissionDelete(id: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  return useMutation({
    mutationFn: (force: boolean) => api.deleteMission(id, force),
    onSuccess: async () => {
      toast.success("Mission deleted");
      await queryClient.invalidateQueries({ queryKey: ["missions"] });
      await navigate({ to: "/missions" });
    },
  });
}

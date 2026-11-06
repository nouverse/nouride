/**
 * Who this account is to the agents — the `[[people]]` entry it is linked to.
 *
 * An agent knows a signed-in account's name, but not that it is the same person who writes on
 * Telegram; this link is what makes it one person, with one memory. Linking is an admin's (the daemon
 * refuses anyone else): being linked to a person is being given their memory in a DM.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useToast } from "@/commons/components/ui/toast";
import { PersonPicker } from "@/commons/components/people/PersonPicker";

export function PersonCard({ admin, displayName }: { admin: boolean; displayName: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const self = useQuery({ queryKey: ["people-me"], queryFn: api.peopleMe });
  const link = useMutation({
    mutationFn: api.linkMe,
    onSuccess: async (result) => {
      toast.success(`Linked to ${result.person.name}`);
      await queryClient.invalidateQueries({ queryKey: ["people-me"] });
      await queryClient.invalidateQueries({ queryKey: ["people"] });
    },
  });
  const person = self.data?.person ?? null;

  return (
    <Card title="Who you are to the agents" description="Link this account to a person so agents know it's the same you on Telegram, WhatsApp and here.">
      <div className="space-y-3">
        {self.error ? <ErrorNote error={self.error} /> : null}
        <p className="flex items-center gap-2 text-sm">
          <UserRound size={15} className="text-base-content/50" />
          {person ? (
            <>
              <span className="font-medium">{person.name}</span>
              {person.key ? <span className="badge badge-sm badge-outline font-mono">{person.key}</span> : null}
            </>
          ) : (
            <span className="text-base-content/65">Not linked to anybody yet.</span>
          )}
        </p>
        {admin ? (
          <PersonPicker size="sm" label={person ? "Change" : "Link"} busy={link.isPending} suggestedName={person ? "" : displayName} onPick={(target) => link.mutate(target)} />
        ) : (
          <p className="text-base-content/65 text-xs">An admin links an account to a person.</p>
        )}
        {link.error ? <ErrorNote error={link.error} /> : null}
      </div>
    </Card>
  );
}

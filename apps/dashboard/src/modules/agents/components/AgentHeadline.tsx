/**
 * What this agent is for, said to its peers: one short line, the `Headline:` of its IDENTITY.md (0.7.18). Its peers read it
 * from their next message to decide whom to ask; the Agents list shows it.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { HeadlineField } from "@/commons/components/ui/HeadlineField";
import { useSaved } from "@/commons/hooks/use-saved";

export function AgentHeadline({ agent, editable }: { agent: AgentSummary; editable: boolean }) {
  const queryClient = useQueryClient();
  const saved = useSaved();
  const current = agent.headline ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [current]);
  const value = draft ?? current;

  const save = useMutation({
    mutationFn: (headline: string) => api.setAgentHeadline(agent.id, headline),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
      saved(result, `${agent.displayName || agent.id}'s headline saved`, "Its peers read it from their next message.");
    },
  });

  return (
    <Card title="Headline" description="What this agent is for, in one line. The other agents see it beside its name and use it to decide whom to ask.">
      <ErrorNote error={save.error} />
      {editable ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(value.trim());
          }}
        >
          <HeadlineField value={value} onChange={setDraft} placeholder="What to bring this agent" id={`headline-${agent.id}`} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={save.isPending || !value.trim() || value.trim() === current}>
            {save.isPending ? "Saving…" : "Save headline"}
          </button>
        </form>
      ) : (
        <p className="text-sm">{current || "No headline yet."}</p>
      )}
    </Card>
  );
}

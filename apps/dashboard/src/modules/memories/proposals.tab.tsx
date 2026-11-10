/**
 * What the nightly pass would change and did not — because a person should decide.
 *
 * The pass adds facts on its own when their person took part in the conversation. It proposes instead
 * for what is worse to get wrong (`docs/SPEC.md` §12.2): rewriting or removing a fact already
 * kept, a fact about someone who was not there, anything for shared knowledge, and every change when
 * `[memory] facts` is set to ask. Approving applies it only if the fact still says what it said when
 * proposed; otherwise the engine refuses and says so.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { Proposal } from "@nouride/wire";
import { useToast } from "@/commons/components/ui/toast";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ScrollCard } from "@/commons/components/ui/ScrollCard";
import { EpisodeView } from "./episode-view";
import { useNames } from "./names";
import { Leaving } from "@/commons/components/ui/OverPage";
import { ListLoading } from "@/commons/components/ui/Spinner";

const WHY: Record<Proposal["why"], string> = {
  shared: "Shared knowledge: every agent reads it, in every chat",
  review: "You approve every change",
};

function Change({ proposal }: { proposal: Proposal }) {
  const op = proposal.operation;
  if (op.op === "add") return <p className="text-sm"><span className="text-success font-semibold">+ </span>{op.text}{op.section ? <span className="text-base-content/65"> · {op.section}</span> : null}</p>;
  if (op.op === "remove") return <p className="text-sm line-through decoration-error/60"><span className="text-error font-semibold no-underline">− </span>{proposal.current ?? `fact ${op.n}`}</p>;
  return (
    <div className="space-y-0.5 text-sm">
      <p className="text-base-content/65 line-through">{proposal.current ?? `fact ${op.n}`}</p>
      <p><span className="text-info font-semibold">→ </span>{op.text}</p>
    </div>
  );
}

export function ProposalsTab({ editable }: { editable: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const nameOf = useNames();
  const [episode, setEpisode] = useState<string | null>(null);
  const proposals = useQuery({ queryKey: ["memory-proposals"], queryFn: api.memoryProposals });

  const decide = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: "approve" | "deny" }) => api.decideProposal(id, verb),
    onSuccess: async (result) => {
      toast.success(result.status === "applied" ? "Applied" : "Dismissed");
      await queryClient.invalidateQueries({ queryKey: ["memory-proposals"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-document"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-people"] });
      await queryClient.invalidateQueries({ queryKey: ["memory-changes"] });
    },
    onError: async (err) => {
      toast.error("Not applied", err);
      await queryClient.invalidateQueries({ queryKey: ["memory-proposals"] });
    },
  });

  const list = proposals.data?.proposals ?? [];

  return (
    <div className="space-y-4">
      {proposals.error ? <ErrorNote error={proposals.error} /> : null}
      {proposals.isLoading ? (
        <ListLoading />
      ) : list.length === 0 ? (
        <EmptyState pose="approved" title="Nothing waiting" description="Changes to facts already kept, facts about someone who wasn't there, and shared knowledge wait here for you." />
      ) : null}
      {list.length > 0 ? (
        <ScrollCard title={`${list.length} waiting`}>
          <ul className="divide-y divide-base-content/[0.06]">
            {list.map((proposal) => (
              <li key={proposal.id} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0 space-y-1">
                  <Change proposal={proposal} />
                  <p className="text-base-content/65 flex flex-wrap gap-x-2 text-xs">
                    <span className="badge badge-ghost badge-xs font-mono">{WHY[proposal.why]}</span>
                    <span>{proposal.subject === "shared" ? "Shared knowledge" : nameOf(proposal.subject)}</span>
                    <button type="button" className="link link-hover" onClick={() => setEpisode(proposal.episode)}>
                      {proposal.revisedAt ? `updated by a conversation on ${new Date(proposal.revisedAt).toLocaleDateString()}` : `from a conversation on ${new Date(proposal.createdAt).toLocaleDateString()}`}
                    </button>
                  </p>
                </div>
                {editable ? (
                  <div className="flex shrink-0 gap-1">
                    <button type="button" className="btn btn-success btn-xs gap-1 rounded-lg" disabled={decide.isPending} onClick={() => decide.mutate({ id: proposal.id, verb: "approve" })}>
                      <Check size={12} /> Apply
                    </button>
                    <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg" disabled={decide.isPending} onClick={() => decide.mutate({ id: proposal.id, verb: "deny" })}>
                      <X size={12} /> Dismiss
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </ScrollCard>
      ) : null}
      <Leaving value={episode}>{(id) => <EpisodeView id={id} editable={editable} nameOf={nameOf} onOpen={setEpisode} onClose={() => setEpisode(null)} />}</Leaving>
    </div>
  );
}

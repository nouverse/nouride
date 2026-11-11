/**
 * A change an agent suggested to this automation, over its steps: who suggests it, what it would do in a sentence,
 * Accept and Discard, and a switch between the steps as they run now and as they would be. Nothing changes until
 * Accept: the automation keeps running as it is while the suggestion waits.
 *
 * Accepting turns the suggestion on, which gives this automation its shape and keeps its history; discarding deletes
 * the suggestion. Either way its card in the chat it was asked in says so.
 */

import { useMutation } from "@tanstack/react-query";
import type { AutomationSummary } from "@nouride/wire";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { useToast } from "@/commons/components/ui/toast";
import { useAgentFace } from "@/commons/hooks/use-agent-face";
import { api } from "@/commons/lib/api";
import { changeWords } from "../lib/suggested";
import { Segmented } from "./form-parts";

export type Side = "current" | "suggested";

export function SuggestedBanner({
  current,
  suggested,
  home,
  side,
  onSide,
  canAnswer,
  held,
  onAnswered,
}: {
  current: AutomationSummary;
  suggested: AutomationSummary;
  /** The server's own time zone, for how a changed start is said. */
  home: string;
  side: Side;
  onSide: (side: Side) => void;
  canAnswer: boolean;
  /** Why it cannot be answered now: changes of the person's own wait to be saved first. */
  held: string | null;
  onAnswered: () => void;
}) {
  const toast = useToast();
  const by = suggested.proposal?.by ?? suggested.agentId;
  const face = useAgentFace(by);
  const name = face?.name ?? by;
  const accept = useMutation({
    mutationFn: () => api.cronAction(suggested.id, "enable"),
    onSuccess: () => {
      toast.success(`You accepted ${name}'s change`, current.name);
      onAnswered();
    },
    onError: (error) => toast.error("Could not accept the change", error),
  });
  const discard = useMutation({
    mutationFn: () => api.cronDelete(suggested.id),
    onSuccess: () => {
      toast.info(`You discarded ${name}'s change`, current.name);
      onAnswered();
    },
    onError: (error) => toast.error("Could not discard the change", error),
  });
  const busy = accept.isPending || discard.isPending;

  return (
    <section aria-label="Suggested change" className="space-y-3 rounded-[22px] border border-accent/25 bg-accent/[0.08] p-4 animate-fade sm:px-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {face?.look ? <AgentAvatar look={face.look} name={name} size="sm" className="bg-base-100" /> : null}
        <div className="min-w-0 flex-[1_1_16rem]">
          <p className="font-bold text-accent">{name} suggests a change</p>
          <p className="text-sm text-base-content/85 [overflow-wrap:anywhere]">{changeWords(current, suggested, home)} Nothing changes until you accept it.</p>
        </div>
        {canAnswer ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || held !== null} title={held ?? undefined} onClick={() => accept.mutate()}>
              Accept
            </button>
            <button type="button" className="btn btn-ghost btn-sm border border-accent/30 text-accent" disabled={busy || held !== null} title={held ?? undefined} onClick={() => discard.mutate()}>
              Discard
            </button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          options={[
            { value: "current", label: "Current" },
            { value: "suggested", label: "Suggested" },
          ]}
          value={side}
          onChange={(next) => onSide(next as Side)}
        />
        {held ? <p className="text-xs text-base-content/70">{held}</p> : null}
      </div>
    </section>
  );
}

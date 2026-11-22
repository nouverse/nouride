/**
 * What skill learning holds and what it did lately: the answer to "why did it learn nothing".
 *
 * A new kind of work is held the first time it is seen and written as a skill when it comes back, or the third time
 * it is seen. Until this panel a held one was a row nobody could see, and a look that wrote nothing left a line in a
 * log: the page showed an empty queue, which reads as a feature that is off. Here each held kind of work is named,
 * with how often it was seen and whether the next sighting writes it, and can be written now or forgotten; under
 * it, the last things learning did or decided not to.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sprout } from "lucide-react";
import type { LearningEvent, SeenWork } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { ago } from "@/commons/lib/format";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ListCard } from "@/commons/components/ui/ListCard";
import { ListLoading } from "@/commons/components/ui/Spinner";

/** A kind of work's name as words: `website-feature-development` reads "Website feature development". */
const asWords = (name: string): string => name.replace(/-/g, " ").replace(/^./, (first) => first.toUpperCase());

/** What one thing learning did says, in the page's words. */
export function eventSaid(event: LearningEvent): string {
  const skill = event.skill ? asWords(event.skill) : "";
  const why = event.why ? `: ${event.why}` : "";
  if (event.kind === "nothing") return `Looked, and found nothing to write down${why}`;
  if (event.kind === "held") return `Saw a new kind of work once, and is waiting for it to come back: ${skill}`;
  if (event.kind === "refused") return `Wrote a draft for ${skill || "a skill"} and it was not kept${why}`;
  if (event.kind === "drafted") return `Wrote a draft, waiting on you: ${skill}`;
  if (event.kind === "written") return `Added a skill: ${skill}`;
  return `Improved a skill: ${skill}`;
}

export function SeenPanel({ editable, agentName }: { editable: boolean; agentName: (id: string) => string }) {
  const seen = useQuery({ queryKey: ["skill-seen"], queryFn: api.skillSeen, retry: false });

  if (seen.isPending) return <ListLoading />;
  const held = seen.data?.seen ?? [];
  const recent = seen.data?.recent ?? [];

  return (
    <ListCard
      title={held.length === 0 ? "Seen, not a skill yet" : `${held.length} seen, not a skill yet`}
      description="A new kind of work becomes a skill when it comes back: in another conversation, in the same chat after a few hours, or the third time it is seen. You can have one written now."
    >
      <ErrorNote error={seen.error} />
      {held.length === 0 ? (
        <EmptyState icon={Sprout} title="Nothing held" description="When an agent does a new kind of work, it shows here until the work comes back." />
      ) : (
        <ul className="divide-base-content/10 divide-y">
          {held.map((work) => (
            <SeenRow key={work.name} work={work} editable={editable} agentName={agentName} />
          ))}
        </ul>
      )}

      {recent.length > 0 ? (
        <div className="border-base-content/10 mt-4 border-t pt-3">
          <p className="mb-2 text-xs text-base-content/65">What learning did lately</p>
          <ul className="space-y-1.5">
            {recent.map((event, index) => (
              <li key={`${event.at}-${index}`} className="text-xs leading-relaxed">
                <span className="font-medium">{event.agentId ? agentName(event.agentId) : "The weekly review"}</span>
                <span className="text-base-content/65"> · {ago(event.at)} · </span>
                <span className="break-words">{eventSaid(event)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ListCard>
  );
}

function SeenRow({ work, editable, agentName }: { work: SeenWork; editable: boolean; agentName: (id: string) => string }) {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["skill-seen"] });
    await queryClient.invalidateQueries({ queryKey: ["skill-drafts"] });
    await queryClient.invalidateQueries({ queryKey: ["skill-catalog"] });
  };
  const write = useMutation({ mutationFn: () => api.writeSeenSkill(work.name), onSuccess: refresh });
  const forget = useMutation({ mutationFn: () => api.forgetSeenSkill(work.name), onSuccess: refresh });
  const busy = write.isPending || forget.isPending;

  return (
    <li className="py-3">
      {/* On a phone the buttons go under the words: beside them, a long "Use when" line was a column three words wide. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="font-medium break-words">{asWords(work.name)}</p>
          {/* An agent's "Use when" line runs to a paragraph: three lines of it here, all of it on hover and in the draft. */}
          <p className="mt-0.5 line-clamp-3 text-sm break-words text-base-content/75" title={work.description}>
            {work.description}
          </p>
          <p className="mt-1 text-xs text-base-content/65">
            {agentName(work.agentId)} · seen {work.sightings === 1 ? "once" : `${work.sightings} times`} · last {ago(work.lastSeenAt)}
          </p>
          {work.writtenNext ? <p className="mt-1 text-xs text-base-content/65">It becomes a skill the next time this work is seen.</p> : null}
          {!work.canWrite ? (
            <p className="mt-1 text-xs text-base-content/65">The conversation it was seen in is gone. It is written when the work comes back.</p>
          ) : null}
        </div>
        {editable ? (
          <div className="flex shrink-0 gap-2">
            {work.canWrite ? (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => write.mutate()}>
                {write.isPending ? "Writing…" : "Write it now"}
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => forget.mutate()}>
              Forget
            </button>
          </div>
        ) : null}
      </div>
      {write.isPending ? <p className="mt-2 text-xs text-base-content/65">The agent is writing it from that conversation. This takes up to a minute.</p> : null}
      <ErrorNote error={write.error ?? forget.error} />
    </li>
  );
}

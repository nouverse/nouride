/**
 * An agent's side of a conversation: its own cat on the left, and beside it a column with its name, its steps and its
 * answer. The same row as a person's (`PersonMessage`): the face the same size, the same gap,
 * so a group reads in one rhythm — person, agent, person.
 *
 * The cat is back beside the reply. It was taken out when every agent shared one mascot and the picture said only "an
 * agent"; each agent now wears its own Office look, so the face says which agent before the name is read, and the
 * name in its colour tells three voices in a room apart at a glance.
 *
 * Only the orchestrator's cat is ringed, in its colour: the one a message that names nobody goes to, marked as the
 * signed-off mockup marks it. A ring on every cat said nothing, and a charcoal one sat heavy on the light theme.
 */

import type { CSSProperties, ReactNode } from "react";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { TagsInMarkdown } from "@/commons/components/chat/AgentTag";
import { useAgentFace } from "@/commons/hooks/use-agent-face";

/** The face's place in a row, a person's and an agent's alike: smaller on a phone, where the column needs the width. */
export const FACE_GAP = "gap-2 sm:gap-3";

export function AgentReply({
  agentId,
  aside,
  motion = "",
  children,
}: {
  /** Absent for a message from before turns were kept, which never said whose it was: the column keeps its place. */
  agentId?: string | undefined;
  /** Beside the name: the stop for a turn at work. */
  aside?: ReactNode;
  /** How it arrives (`useMotionList`). */
  motion?: string;
  children: ReactNode;
}) {
  const face = useAgentFace(agentId);
  return (
    <div
      className={`group flex w-full items-start ${FACE_GAP} origin-top-left ${motion}`}
      data-agent={agentId}
      style={face?.tint ? ({ "--agent-tint": face.tint } as CSSProperties) : undefined}
    >
      {face?.look ? (
        // The name says who beside it; the cat is the picture of the same thing, not a second label to read out.
        <span aria-hidden="true" className="shrink-0">
          <AgentAvatar look={face.look} name="" size="xs" className={`${face.orchestrator ? "ring-2 ring-[color:var(--agent-tint)] " : ""}max-sm:size-7 max-sm:rounded-[9px]`} />
        </span>
      ) : (
        <span aria-hidden="true" className="size-7 shrink-0 sm:size-8" />
      )}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        {face || aside ? (
          <div className="flex min-h-5 max-w-full items-center gap-2">
            {face ? <span className="truncate font-display text-[13px] font-medium text-[color:var(--agent-tint,var(--color-base-content))]">{face.name}</span> : null}
            {aside}
          </div>
        ) : null}
        {/* Its answer's tags of agents in their colours, as in a person's words. */}
        <TagsInMarkdown>{children}</TagsInMarkdown>
      </div>
    </div>
  );
}

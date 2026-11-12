/**
 * One automation in the list, as a card that opens its page: its name, how it starts, a small drawing of its steps,
 * its agent, the state it is in, and how its last run went. The whole card is the link (its name's, stretched over
 * it); the switch that turns it on and off, and a proposal's two answers, stand over the link and take their own press.
 *
 * One the reader only reads (it reports to a chat of theirs, and is another person's) says whose it is where its
 * switch would stand, and offers nothing that changes it. It opens as any other.
 */

import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { AutomationSummary } from "@nouride/wire";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { ProposalBar } from "@/commons/components/jobs/ProposalBar";
import { LIFTS } from "@/commons/components/ui/CardGrid";
import { Lit } from "@/commons/components/ui/Lit";
import { Tag } from "@/commons/components/ui/Tag";
import { useToast } from "@/commons/components/ui/toast";
import { useAgentFace } from "@/commons/hooks/use-agent-face";
import { ENTER, type Motion } from "@/commons/hooks/use-motion-list";
import { api } from "@/commons/lib/api";
import { readsOnly, whoseWords } from "@/commons/lib/by-person";
import { cn } from "@/commons/lib/utils";
import { stepsOf } from "../lib/draft";
import { lastRunLine, previewOf, stateOf } from "../lib/list";
import { whenWords, type Tone } from "../lib/runs";
import { startWords } from "../lib/trigger";
import { KIND, START, stepLine } from "../lib/words";
import { TONES } from "./StepRun";

const DOT: Record<Tone, string> = { done: "bg-success", failed: "bg-error", quiet: "bg-base-content/30", working: "bg-success animate-pulse", needs: "bg-accent animate-pulse" };

/**
 * The steps as a row of their kinds' icons joined by a line: at most six, then how many more. One that does a single
 * thing says what, beside its icon: the start of its message, or its command.
 */
function StepsPreview({ automation }: { automation: AutomationSummary }) {
  const { kinds, more } = previewOf(automation);
  const count = kinds.length + more;
  const [only] = count === 1 ? stepsOf(automation.payload) : [];
  return (
    <ol aria-label={count === 1 ? "1 step" : `${count} steps`} className="flex min-w-0 flex-1 list-none items-center">
      {kinds.map((kind, at) => {
        const { icon: Icon, label, tile } = KIND[kind];
        return (
          <li key={at} title={label} className={cn("flex items-center", only && "min-w-0 gap-2")}>
            {at > 0 ? <span aria-hidden="true" className="h-0.5 w-2.5 bg-base-content/15 sm:w-3.5" /> : null}
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-full", tile)}>
              <Icon size={13} aria-hidden="true" />
              <span className="sr-only">{label}</span>
            </span>
            {only ? <span className={cn("min-w-0 truncate text-sm text-base-content/80", only.kind === "command" && "font-mono text-xs")}>{stepLine(only)}</span> : null}
          </li>
        );
      })}
      {more > 0 ? (
        <li className="flex items-center">
          <span aria-hidden="true" className="h-0.5 w-2.5 bg-base-content/15 sm:w-3.5" />
          <span className="rounded-full bg-base-content/[0.06] px-2 py-1 font-mono text-xs text-base-content/70">+{more}</span>
        </li>
      ) : null}
    </ol>
  );
}

export function AutomationRow({
  automation,
  home,
  agentName,
  writable,
  admin,
  motion = "",
  onChanged,
}: {
  automation: AutomationSummary;
  /** The server's own time zone. */
  home: string;
  agentName: (id: string) => string;
  writable: boolean;
  admin: boolean;
  /** How the list draws it (`useMotionList`); one that arrives is lit too. */
  motion?: Motion;
  onChanged: () => void;
}) {
  const toast = useToast();
  const face = useAgentFace(automation.agentId);
  const { icon: Icon, tile } = START[automation.start];
  const state = stateOf(automation, agentName);
  const last = lastRunLine(automation);
  const only = readsOnly(automation);
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.cronAction(automation.id, on ? "enable" : "disable"),
    onError: (error, on) => toast.error(`Could not turn ${automation.name} ${on ? "on" : "off"}`, error),
    onSettled: onChanged,
  });

  return (
    <article data-automation={automation.id} className={cn("relative flex flex-col gap-3.5 rounded-[22px] border border-base-content/[0.08] bg-base-100 p-4 shadow-soft hover:border-base-content/20 sm:p-5", LIFTS, motion)}>
      <Lit state={`${state.word} ${automation.lastRun?.status ?? ""}`} arrived={motion === ENTER} />
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className={cn("grid size-11 shrink-0 place-items-center rounded-[14px]", tile)}>
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-snug text-base-content [overflow-wrap:anywhere]">
            <Link to="/automations/$id" params={{ id: automation.id }} className="outline-none after:absolute after:inset-0 after:rounded-[22px] focus-visible:after:ring-2 focus-visible:after:ring-secondary/50">
              {automation.name}
            </Link>
          </h2>
          <p className="text-sm text-base-content/65 [overflow-wrap:anywhere]">Starts {startWords(automation.trigger, home)}</p>
        </div>
        {only ? (
          <Tag className="relative z-[1] mt-1 shrink-0" title="You can read this one, not change it">
            {whoseWords(automation)}
          </Tag>
        ) : automation.proposal ? null : (
          <input
            type="checkbox"
            role="switch"
            className="toggle toggle-success toggle-sm relative z-[1] mt-1 shrink-0"
            aria-label={`${automation.name} is ${automation.enabled ? "on" : "paused"}`}
            checked={automation.enabled}
            disabled={!writable || toggle.isPending}
            onChange={(event) => toggle.mutate(event.target.checked)}
          />
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <StepsPreview automation={automation} />
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-base-content/70">
          {face?.look ? <AgentAvatar look={face.look} name={face.name} size="xxs" /> : null}
          {face?.name ?? automation.agentId}
        </span>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-base-content/[0.08] pt-3 text-xs text-base-content/70">
        <span data-state={state.tone} className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 font-bold", TONES[state.tone])}>
          {state.word}
        </span>
        {automation.proposal && !only ? (
          <span className="relative z-[1]">
            <ProposalBar job={automation} canAnswer={automation.start === "webhook" ? admin : writable} onAnswered={onChanged} />
          </span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
            {last ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[last.tone])} />
                {last.words}
              </span>
            ) : (
              <span>Has not run yet</span>
            )}
            {automation.start === "scheduled" && automation.enabled && automation.nextRunAt ? <span>Next: {whenWords(automation.nextRunAt).replace(/^Today /, "today ").replace(/^Tomorrow /, "tomorrow ")}</span> : null}
          </span>
        )}
      </footer>
    </article>
  );
}

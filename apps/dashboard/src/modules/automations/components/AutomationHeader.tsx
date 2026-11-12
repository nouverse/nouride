/**
 * The head of an automation's page: the way back to the list, its name (written where it stands), how it starts and
 * where it reports in a line, and what a person does with the whole of it: turn it on or off, run it now, delete it.
 * One an agent proposed is turned on or discarded here instead; it has never run, so it has no switch and no Run now.
 * And the button that asks the orchestrator, as the list has: for a change to this automation, or for a new one on the
 * page that makes one. It opens the chat over the page with the request written, and sends nothing.
 *
 * One the reader only reads has none of these: a line under its name says whose it is and why it is on their page.
 */

import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Ellipsis, Play, Trash2 } from "lucide-react";
import type { AutomationSummary, RunNowOutcome } from "@nouride/wire";
import { AskAgentButton } from "@/commons/components/agents/AskAgentButton";
import { automationAsk, PAGE_ASKS } from "@/commons/components/agents/page-asks";
import { ProposalBar } from "@/commons/components/jobs/ProposalBar";
import { ReadOnlyNote } from "@/commons/components/people/ReadOnlyNote";
import { useConfirm } from "@/commons/components/ui/confirm";
import { Details } from "@/commons/components/ui/Details";
import { DropdownMenu } from "@/commons/components/ui/DropdownMenu";
import { InlineTitle } from "@/commons/components/ui/InlineTitle";
import { Tag } from "@/commons/components/ui/Tag";
import { useToast } from "@/commons/components/ui/toast";
import { api } from "@/commons/lib/api";
import { readsOnly } from "@/commons/lib/by-person";
import { runOutcomeToast } from "@/commons/lib/run-outcome";
import { cn } from "@/commons/lib/utils";
import type { Draft } from "../lib/draft";
import { START } from "../lib/words";
import { startOf } from "./StartCard";

/** What is done with a running automation as a whole: its switch, Run now, and Delete behind a menu. */
function Controls({
  automation,
  writable,
  dirty,
  onChanged,
  onRan,
  onGone,
}: {
  automation: AutomationSummary;
  writable: boolean;
  dirty: boolean;
  onChanged: () => void;
  onRan: (outcome: RunNowOutcome) => void;
  onGone: () => void;
}) {
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const { name } = automation;
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.cronAction(automation.id, on ? "enable" : "disable"),
    onError: (error, on) => toast.error(`Could not turn ${name} ${on ? "on" : "off"}`, error),
    onSettled: onChanged,
  });
  // Answered within ten seconds: with how it ended, a refusal, or that it is still going, which the page then follows.
  const run = useMutation({
    mutationFn: () => api.cronRun(automation.id),
    onSuccess: ({ outcome }) => {
      toast.show(runOutcomeToast(name, outcome));
      onRan(outcome);
    },
    onError: (error) => toast.error(`${name} did not start`, error),
    onSettled: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => api.cronDelete(automation.id),
    onSuccess: onGone,
    onError: (error) => toast.error(`Could not delete ${name}`, error),
  });

  return (
    <div className="flex flex-wrap items-center gap-3">
      {dialog}
      {automation.failStreak > 0 ? <span className="rounded-full bg-error/10 px-2.5 py-0.5 text-xs font-bold text-error">Failing</span> : null}
      <label className="flex cursor-pointer items-center gap-2">
        <span className={cn("text-sm font-semibold", automation.enabled ? "text-success" : "text-base-content/65")}>{automation.enabled ? "On" : "Paused"}</span>
        <input
          type="checkbox"
          role="switch"
          className="toggle toggle-success"
          aria-label={`${name} is ${automation.enabled ? "on" : "paused"}`}
          checked={automation.enabled}
          disabled={!writable || toggle.isPending}
          onChange={(event) => toggle.mutate(event.target.checked)}
        />
      </label>
      <button type="button" className="btn btn-sm gap-1.5 border-base-content/15 bg-base-100" disabled={!writable || run.isPending || dirty} title={dirty ? "Save or discard your changes first" : undefined} onClick={() => run.mutate()}>
        {run.isPending ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : <Play size={13} aria-hidden="true" className="fill-current" />}
        Run now
      </button>
      {writable ? (
        <DropdownMenu
          trigger={<Ellipsis size={16} aria-hidden="true" />}
          triggerClassName="btn btn-ghost btn-square btn-sm text-base-content/65 hover:text-base-content"
          ariaLabel={`More for ${name}`}
          width={208}
          menuClassName="rounded-2xl border border-base-content/[0.08] bg-base-100 p-1.5 shadow-soft"
        >
          {(close) => (
            <li>
              <button
                type="button"
                className="min-h-10 gap-3 rounded-xl text-sm text-error"
                disabled={remove.isPending}
                onClick={async () => {
                  close();
                  const yes = await ask({
                    title: `Delete "${name}"?`,
                    body: automation.start === "webhook" ? "Its address stops working, and its runs go with it. Pause it instead to keep both." : "It stops running, and its runs go with it. Pause it instead to keep them.",
                    confirmLabel: "Delete",
                  });
                  if (yes) remove.mutate();
                }}
              >
                <Trash2 size={15} aria-hidden="true" /> Delete
              </button>
            </li>
          )}
        </DropdownMenu>
      ) : null}
    </div>
  );
}

export function AutomationHeader({
  automation,
  draft,
  home,
  reports,
  agentName,
  canName,
  writable,
  admin,
  dirty,
  onName,
  onChanged,
  onRan,
  onGone,
}: {
  /** As it is saved; none for one being made. */
  automation: AutomationSummary | null;
  draft: Draft;
  home: string;
  /** The chat it reports to, in words; none while it has none or stays quiet. */
  reports: string | null;
  agentName: (id: string) => string;
  canName: boolean;
  writable: boolean;
  admin: boolean;
  /** Changes wait to be saved: Run now would run what is saved, not what is on the page. */
  dirty: boolean;
  onName: (name: string) => void;
  onChanged: () => void;
  onRan: (outcome: RunNowOutcome) => void;
  /** It was deleted or discarded: there is no page to stay on. */
  onGone: () => void;
}) {
  const { icon: Icon, tile } = START[draft.start];
  const proposal = automation?.proposal;
  const only = automation !== null && readsOnly(automation);

  return (
    <header className="space-y-3">
      <Link to="/automations" className="btn btn-ghost btn-xs -ml-2 gap-1.5 text-base-content/70">
        <ArrowLeft size={13} aria-hidden="true" /> Automations
      </Link>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span aria-hidden="true" className={cn("grid size-12 shrink-0 place-items-center rounded-[14px] max-sm:hidden", tile)}>
          <Icon size={22} />
        </span>
        <div className="min-w-0 flex-[1_1_16rem]">
          <InlineTitle value={draft.name} onChange={onName} label="Name" placeholder="Name this automation" readOnly={!canName} />
          <p className="text-sm text-base-content/65 [overflow-wrap:anywhere]">
            Starts {startOf(draft, home)}.{reports ? ` Reports to ${reports}.` : ""}
          </p>
        </div>

        {only ? null : <AskAgentButton {...(automation ? automationAsk(automation.name) : PAGE_ASKS.automations)} variant="soft" />}
        {only ? null : proposal && automation ? (
          <div className="flex flex-wrap items-center gap-2">
            <Tag tone="needs">Suggested by {agentName(proposal.by)}</Tag>
            <ProposalBar job={automation} canAnswer={automation.start === "webhook" ? admin : writable} onAnswered={(on) => (on ? onChanged() : onGone())} />
          </div>
        ) : automation ? (
          <Controls automation={automation} writable={writable} dirty={dirty} onChanged={onChanged} onRan={onRan} onGone={onGone} />
        ) : null}
      </div>

      {only && automation ? <ReadOnlyNote thing={automation} /> : null}
      {proposal ? (
        <p className="text-sm text-base-content/70">
          It stays off until somebody turns it on.
          {proposal.replaces ? (
            <>
              {" "}
              It is a change to an automation that runs now:{" "}
              <Link className="link" to="/automations/$id" params={{ id: proposal.replaces }}>
                open that one
              </Link>{" "}
              to see both side by side.
            </>
          ) : null}
        </p>
      ) : null}
      {automation && automation.enabled && automation.failStreak > 0 ? (
        <p role="status" className="rounded-[14px] bg-error/10 px-3 py-2 text-sm text-error">
          {automation.failStreak === 1 ? "Its last run failed." : `Its last ${automation.failStreak} runs failed.`} Last run shows which step, and why.
        </p>
      ) : null}
      {automation && !automation.enabled && automation.disabledReason ? (
        <div className="rounded-[14px] bg-warning/10 px-3 py-2 text-sm text-warning">
          <p>{only ? "It was turned off after it kept failing." : "It was turned off after it kept failing. Turn it on to try again."}</p>
          <Details>
            <p>{automation.disabledReason}</p>
          </Details>
        </div>
      ) : null}
    </header>
  );
}

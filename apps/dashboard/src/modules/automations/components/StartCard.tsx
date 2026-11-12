/**
 * How an automation starts, the flow's first card: at a time, when its address is called, or when a person presses Run
 * now. Closed it says the start in words; "Change" opens its fields in place.
 *
 * A time and a start by hand can be changed for each other. A webhook stays a webhook once made: its address is what
 * everything that calls it knows it by, so it is chosen when the automation is made, by an admin, and its card then
 * holds the address, whether a call from outside can arrive, and how to call it.
 */

import { useState } from "react";
import type { AutomationStart, AutomationSummary } from "@nouride/wire";
import { cn } from "@/commons/lib/utils";
import type { Draft } from "../lib/draft";
import { describeDraft } from "../lib/trigger";
import { START } from "../lib/words";
import { Choice } from "./form-parts";
import { HookAddress } from "./Reach";
import { TriggerFields } from "./TriggerFields";

const CHOICES: { start: AutomationStart; hint: string }[] = [
  { start: "scheduled", hint: "At a time: every so often, at a time of day, or once." },
  { start: "manual", hint: "Only when you press Run now, or ask an agent to run it." },
  { start: "webhook", hint: "When another app calls its address: a failed build, a new order, an alert." },
];

/** A draft's start in words, after "It starts". */
export function startOf(draft: Pick<Draft, "start" | "trigger">, home: string): string {
  if (draft.start === "manual") return "when you press Run now";
  return draft.start === "webhook" ? "when its address is called" : describeDraft(draft.trigger, home);
}

export function StartCard({
  draft,
  automation,
  home,
  editable,
  writable,
  admin,
  note,
  missing,
  set,
  onChanged,
}: {
  draft: Draft;
  /** The automation as it is saved; none for one being made. */
  automation: AutomationSummary | null;
  /** The server's own time zone. */
  home: string;
  /** Its fields can be opened: not over a run, and not for an account that only looks. */
  editable: boolean;
  /** The account may change automations: a webhook's test is its to send, whatever the page is showing. */
  writable: boolean;
  admin: boolean;
  /** A line under the start, over a run: when that run began. */
  note?: string | undefined;
  /** What a save still lacks here. */
  missing?: string | undefined;
  set: (patch: Partial<Draft>) => void;
  onChanged: () => void;
}) {
  const fresh = automation === null;
  const [open, setOpen] = useState(fresh);
  const { icon: Icon, tile } = START[draft.start];
  const hook = automation?.hook;
  const shown = editable && open;

  return (
    <section aria-label="Start" className={cn("rounded-[22px] border border-base-content/[0.08] bg-base-100 shadow-soft", missing && "border-error/40")}>
      <div className="flex items-center gap-3 p-3.5 sm:p-4">
        <span aria-hidden="true" className={cn("grid size-10 shrink-0 place-items-center rounded-[14px]", tile)}>
          <Icon size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-secondary">Start</p>
          <p className="font-semibold text-base-content first-letter:uppercase [overflow-wrap:anywhere]">{startOf(draft, home)}</p>
          {note ? <p className="text-xs text-base-content/65">{note}</p> : null}
          {missing ? <p className="text-xs font-medium text-error">{missing}</p> : null}
        </div>
        {editable ? (
          <button type="button" className="btn btn-ghost btn-sm font-bold text-secondary" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
            {open ? "Done" : "Change"}
          </button>
        ) : null}
      </div>

      {shown || hook ? (
        <div className="space-y-4 border-t border-base-content/[0.08] p-3.5 sm:p-4">
          {shown && (fresh || draft.start !== "webhook") ? (
            <div role="radiogroup" aria-label="How it starts" className={cn("grid grid-cols-1 gap-2", fresh ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
              {CHOICES.filter((choice) => fresh || choice.start !== "webhook").map(({ start, hint }) => (
                <Choice
                  key={start}
                  selected={draft.start === start}
                  label={START[start].label}
                  hint={start === "webhook" && !admin ? "Only an admin can make one: its address takes calls from outside." : hint}
                  icon={START[start].icon}
                  disabled={start === "webhook" && !admin}
                  onClick={() => set({ start })}
                />
              ))}
            </div>
          ) : null}
          {shown && draft.start === "scheduled" ? <TriggerFields trigger={draft.trigger} onChange={(patch) => set({ trigger: { ...draft.trigger, ...patch } })} keepAfterRun={fresh ? draft.keepAfterRun : null} onKeepAfterRun={(keepAfterRun) => set({ keepAfterRun })} home={home} /> : null}
          {shown && draft.start === "manual" ? <p className="text-sm text-base-content/75">It runs when you press Run now on this page, or ask an agent to run it. Nothing starts it on its own.</p> : null}
          {shown && draft.start === "webhook" && fresh ? <p className="text-sm text-base-content/75">Its address is made when you save. Whatever calls that address starts it, and what was sent is handed to the first step that reads it.</p> : null}
          {shown && draft.start === "webhook" && !fresh ? <p className="text-xs text-base-content/65">A webhook stays a webhook: its address is what everything that calls it knows it by.</p> : null}
          {automation && hook && !automation.proposal ? <HookAddress automation={{ ...automation, hook }} canEdit={writable} admin={admin} onChanged={onChanged} /> : null}
        </div>
      ) : null}
    </section>
  );
}

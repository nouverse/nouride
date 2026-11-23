/**
 * How an automation starts, the canvas's first box: at a time, when its address is called, or when a person presses Run
 * now. The box says the start in words; a press opens its fields beside the canvas, or in the box on a phone.
 *
 * A new automation opens with the box closed, saying "Pick when it runs": it opened on three large choices, four tabs
 * and an explanation, before there was a step.
 *
 * A time and a start by hand can be changed for each other. A webhook stays a webhook once made: its address is what
 * everything that calls it knows it by, so it is chosen when the automation is made, by an admin, and its fields then
 * hold the address, whether a call from outside can arrive, and how to call it.
 */

import type { ReactNode } from "react";
import type { AutomationStart, AutomationSummary } from "@nouride/wire";
import type { Draft } from "../lib/draft";
import { describeDraft, triggerBody } from "../lib/trigger";
import { START } from "../lib/words";
import { Choice, FieldsFrame } from "./form-parts";
import { HookAddress } from "./Reach";
import { StepBox } from "./StepBox";
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

/** Whether a start still lacks its time: a schedule nobody has filled in. */
const unset = (draft: Pick<Draft, "start" | "trigger">): boolean => draft.start === "scheduled" && Object.keys(triggerBody(draft.trigger)).length === 0;

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function WhenBox({
  draft,
  home,
  open,
  onPress,
  note,
  missing,
  children,
}: {
  draft: Draft;
  /** The server's own time zone. */
  home: string;
  open: boolean;
  /** A press on the box; none where its fields cannot be opened: over a run, or for an account that only looks. */
  onPress?: (() => void) | undefined;
  /** In place of what kind of start it is, over a run: when that run began. */
  note?: string | undefined;
  /** What a save still lacks here. */
  missing?: string | undefined;
  /** Its fields, in the box, where there is no room beside the canvas. */
  children?: ReactNode;
}) {
  const { icon, tile, label } = START[draft.start];
  return (
    <section aria-label="Start">
      <StepBox
        pill
        icon={icon}
        tile={tile}
        title={unset(draft) ? "Pick when it runs" : capital(startOf(draft, home))}
        line={missing ?? note ?? label}
        state={missing ? "lacking" : open ? "open" : undefined}
        onPress={onPress}
        pressLabel={onPress ? `${open ? "Close" : "Change"} how it starts` : undefined}
        expanded={onPress ? open : undefined}
      >
        {children}
      </StepBox>
    </section>
  );
}

export function StartFields({
  draft,
  automation,
  home,
  writable,
  admin,
  set,
  onChanged,
  onDone,
}: {
  draft: Draft;
  /** The automation as it is saved; none for one being made. */
  automation: AutomationSummary | null;
  home: string;
  /** The account may change automations: a webhook's test is its to send. */
  writable: boolean;
  admin: boolean;
  set: (patch: Partial<Draft>) => void;
  onChanged: () => void;
  onDone: () => void;
}) {
  const fresh = automation === null;
  const hook = automation?.hook;
  return (
    <FieldsFrame
      mark={{ "data-start-fields": "" }}
      head={
        <>
          <p className="font-mono text-xs font-semibold tracking-wider text-base-content/65 uppercase">Start</p>
          <h2 className="mt-0.5 text-lg text-base-content">When it runs</h2>
        </>
      }
      foot={
        <div className="flex justify-end">
          <button type="button" className="btn btn-primary btn-sm rounded-xl px-5" onClick={onDone}>
            Done
          </button>
        </div>
      }
    >
      {fresh || draft.start !== "webhook" ? (
        <div role="radiogroup" aria-label="How it starts" className="grid grid-cols-1 gap-2">
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
      {draft.start === "scheduled" ? <TriggerFields trigger={draft.trigger} onChange={(patch) => set({ trigger: { ...draft.trigger, ...patch } })} keepAfterRun={fresh ? draft.keepAfterRun : null} onKeepAfterRun={(keepAfterRun) => set({ keepAfterRun })} home={home} /> : null}
      {draft.start === "manual" ? <p className="text-sm text-base-content/75">It runs when you press Run now on this page, or ask an agent to run it. Nothing starts it on its own.</p> : null}
      {draft.start === "webhook" && fresh ? <p className="text-sm text-base-content/75">Its address is made when you save. Whatever calls that address starts it, and what was sent is handed to the first step that reads it.</p> : null}
      {draft.start === "webhook" && !fresh ? <p className="text-xs text-base-content/65">A webhook stays a webhook: its address is what everything that calls it knows it by.</p> : null}
      {automation && hook && !automation.proposal ? <HookAddress automation={{ ...automation, hook }} canEdit={writable} admin={admin} onChanged={onChanged} /> : null}
    </FieldsFrame>
  );
}

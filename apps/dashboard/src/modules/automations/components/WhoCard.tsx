/**
 * Who runs an automation and where it reports, the flow's last card: the agent, the chat that is told how each run
 * went, and whether it is told at all. The last step's words are the run's, and this is where they go.
 *
 * The agent is chosen when the automation is made and stays: the page has no way to hand one over, and a change that
 * named another agent would. A mission always tells its chat when it is done or needs someone, so an automation with
 * one cannot stay quiet.
 *
 * Two switches make it a watch: tell once and turn itself off, and tell at once whatever the hour. The first is not
 * offered where it tells nobody, which could never turn it off. Both are said in the card's own line where they are
 * on, for a reader who cannot open its fields.
 */

import { useState } from "react";
import type { GatewayInstance } from "@nouride/wire";
import { AgentAvatar } from "@/commons/components/agents/AgentAvatar";
import { ChatPicker } from "@/commons/components/jobs/ChatPicker";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ToggleRow } from "@/commons/components/ui/ToggleRow";
import { Field } from "@/commons/components/ui/ui";
import { useAgentFace } from "@/commons/hooks/use-agent-face";
import { useKnownChats } from "@/commons/hooks/use-known-chats";
import { cn } from "@/commons/lib/utils";
import { useQuietHours } from "../hooks/use-quiet-hours";
import { deliveryOf, savesAsList, sessionOf, withMark, type Draft } from "../lib/draft";
import { ONCE_HINT, atOnceHint, hoursWords, marksWords } from "../lib/watch";
import type { AgentChoice } from "./KindFields";

const REMEMBERS: { value: Draft["session"]; label: string }[] = [
  { value: "fresh", label: "Nothing: each run starts clean" },
  { value: "isolated", label: "Its own notes from earlier runs" },
  { value: "chat", label: "What was said in its chat" },
];

export function WhoCard({
  draft,
  fresh,
  editable,
  agents,
  gateways,
  missing,
  set,
}: {
  draft: Draft;
  /** Being made: the agent can still be chosen. */
  fresh: boolean;
  editable: boolean;
  agents: readonly AgentChoice[];
  gateways: GatewayInstance[];
  /** What a save still lacks here. */
  missing?: string | undefined;
  set: (patch: Partial<Draft>) => void;
}) {
  const [open, setOpen] = useState(fresh);
  const face = useAgentFace(draft.agentId);
  const { labelOf } = useKnownChats();
  const delivery = deliveryOf(draft);
  const mission = draft.steps.some((step) => step.kind === "mission");
  // Where it reports is its own chat unless it was told to report elsewhere, which the page shows and keeps.
  const [gatewayId, chatId] = [delivery.gatewayId ?? draft.gatewayId, delivery.chatId ?? draft.chatId.trim()];
  const chat = chatId ? (labelOf(gatewayId, chatId) ?? chatId) : null;
  const name = face?.name ?? (draft.agentId || "An agent");
  const says = delivery.mode === "none" ? "stays quiet: each run is kept, and nothing is sent." : delivery.mode === "webhook" ? "sends each run's result to another app." : chat ? `tells ${chat} how each run went.` : "tells a chat how each run went.";
  const shown = editable && open;
  const marks = marksWords(delivery);
  // What the hours are is said under the switch that overrides them: asked only while that switch is on the page.
  const quiet = useQuietHours(shown);

  return (
    <section aria-label="Who and where" className={cn("rounded-[22px] border border-base-content/[0.08] bg-base-100 shadow-soft", missing && "border-error/40")}>
      <div className="flex items-center gap-3 p-3.5 sm:p-4">
        {face?.look ? <AgentAvatar look={face.look} name={name} size="sm" /> : <span aria-hidden="true" className="size-10 shrink-0 rounded-[12px] bg-secondary/10" />}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-secondary">Who and where</p>
          <p className="font-semibold text-base-content [overflow-wrap:anywhere]">
            {name} runs it and {says}
          </p>
          {marks.length > 0 ? (
            <p data-marks className="text-sm text-base-content/75">
              {marks.join(" ")}
            </p>
          ) : null}
          {missing ? <p className="text-xs font-medium text-error">{missing}</p> : null}
        </div>
        {editable ? (
          <button type="button" className="btn btn-ghost btn-sm font-bold text-secondary" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
            {open ? "Done" : "Change"}
          </button>
        ) : null}
      </div>

      {shown ? (
        <div className="space-y-4 border-t border-base-content/[0.08] p-3.5 sm:p-4">
          <Field label="Agent" hint={fresh ? "Whose skills and tools it runs with." : "Chosen when it was made. To hand it to another agent, make a new one."}>
            <SearchSelect label="Agent" align="start" className="w-full" disabled={!fresh} options={agents.map((agent) => ({ value: agent.id, label: agent.name }))} value={draft.agentId} placeholder={draft.agentId} onChange={(agentId) => set({ agentId })} />
          </Field>
          <ChatPicker gateways={gateways} gatewayId={draft.gatewayId} onGateway={(gatewayId) => set({ gatewayId })} chatId={draft.chatId} onChat={(chatId) => set({ chatId })} />
          {delivery.mode === "webhook" ? (
            <p className="text-xs text-base-content/65">It was set up to send each run's result to another app, and stays that way.</p>
          ) : (
            <ToggleRow
              label="Tell that chat how each run went"
              hint={mission ? "A mission tells its chat when it is done or needs someone, so this stays on." : "Off: each run is still kept under Recent runs, and nothing is sent."}
              checked={delivery.mode === "announce"}
              disabled={mission}
              onChange={(tells) => set({ delivery: { ...draft.delivery, mode: tells ? "announce" : "none" } })}
            />
          )}
          {delivery.mode !== "none" ? <ToggleRow label="Tell me once, then turn off" hint={ONCE_HINT} checked={draft.delivery.once === true} onChange={(on) => set({ delivery: withMark(draft.delivery, "once", on) })} /> : null}
          <ToggleRow
            label="Tell me at once, even in quiet hours"
            hint={atOnceHint(quiet.data ? hoursWords(quiet.data) : undefined, delivery.mode === "announce")}
            checked={draft.delivery.atOnce === true}
            onChange={(on) => set({ delivery: withMark(draft.delivery, "atOnce", on) })}
          />
          <Field label="Between runs it remembers" hint="Remembering costs a little more each run. Something that reports gains nothing from yesterday's report.">
            <SearchSelect
              label="Between runs it remembers"
              align="start"
              className="w-full"
              width={300}
              // With more than one step each step hands its words to the next, so the chat's own history is not read.
              options={REMEMBERS.filter((choice) => choice.value !== "chat" || !savesAsList(draft))}
              value={sessionOf(draft)}
              onChange={(session) => set({ session })}
            />
          </Field>
        </div>
      ) : null}
    </section>
  );
}

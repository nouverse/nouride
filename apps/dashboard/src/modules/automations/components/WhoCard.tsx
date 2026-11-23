/**
 * Where an automation's results go, the canvas's last box: the chat that is told how each run went, or that it stays
 * quiet. The last step's words are the run's, and this is where they go. Its fields hold the rest of who and where:
 * the agent that runs it, whether a chat is told at all, the marks that make it a watch, and what it keeps between runs.
 *
 * Who and where was the last card, under every step, and said "Reports to 1" where the chat had no name the page
 * knew: a chat with no name is said as a chat on its app.
 *
 * The agent is chosen when the automation is made and stays: the page has no way to hand one over, and a change that
 * named another agent would. A mission always tells its chat when it is done or needs someone, so an automation with
 * one cannot stay quiet.
 *
 * Three marks make it a watch: tell once and turn itself off, stop by itself after a time, and tell at once whatever
 * the hour. The first is not offered where it tells nobody, which could never turn it off; the second only for one that
 * runs again and again at a time. Each is said in the box where it is on, for a reader who cannot open its fields.
 */

import { AgentSelect } from "@/commons/components/agents/AgentSelect";
import type { ReactNode } from "react";
import { Send, VolumeX } from "lucide-react";
import type { GatewayInstance } from "@nouride/wire";
import { ChatPicker } from "@/commons/components/jobs/ChatPicker";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { ToggleRow } from "@/commons/components/ui/ToggleRow";
import { Field } from "@/commons/components/ui/ui";
import { useKnownChats } from "@/commons/hooks/use-known-chats";
import { platformName } from "@/commons/lib/platform";
import { useQuietHours } from "../hooks/use-quiet-hours";
import { deliveryOf, onAClock, savesAsList, sessionOf, withLasts, withMark, type Draft } from "../lib/draft";
import { LASTS_HINT, ONCE_HINT, atOnceHint, hoursWords, lastsChoices, marksWords } from "../lib/watch";
import { FieldsFrame } from "./form-parts";
import type { AgentChoice } from "./KindFields";
import { StepBox } from "./StepBox";

const REMEMBERS: { value: Draft["session"]; label: string }[] = [
  { value: "fresh", label: "Nothing: each run starts clean" },
  { value: "isolated", label: "Its own notes from earlier runs" },
  { value: "chat", label: "What was said in its chat" },
];

/** The chat app a connection is on, by what a person calls it. */
const appOf = (gatewayId: string): string => platformName(gatewayId.split(":")[0] ?? gatewayId);

/** Where a draft's results go, in a title and a line: the app, then the chat by its name, or as a chat on that app. */
function resultsWords(draft: Draft, labelOf: (gatewayId: string, chatId: string) => string | undefined): { title: string; line: string; quiet: boolean } {
  const delivery = deliveryOf(draft);
  if (delivery.mode === "none") return { title: "Results stay here", line: "Each run is kept, and nothing is sent.", quiet: true };
  if (delivery.mode === "webhook") return { title: "Results go to another app", line: "Each run's result is sent on as it was set up.", quiet: false };
  const [gatewayId, chatId] = [delivery.gatewayId ?? draft.gatewayId, delivery.chatId ?? draft.chatId.trim()];
  if (!gatewayId || !chatId) return { title: "Pick where results go", line: "The chat that is told how each run went.", quiet: false };
  const app = appOf(gatewayId);
  return { title: `Results go to ${app}`, line: labelOf(gatewayId, chatId) ?? `A chat on ${app}`, quiet: false };
}

/** The same after "runs it", for the page's head: "sends to Telegram, the team's group", "tells nobody". None while no chat is picked. */
export function reportsWords(draft: Draft, labelOf: (gatewayId: string, chatId: string) => string | undefined): string | null {
  const delivery = deliveryOf(draft);
  if (delivery.mode === "none") return "tells nobody";
  if (delivery.mode === "webhook") return "sends to another app";
  const [gatewayId, chatId] = [delivery.gatewayId ?? draft.gatewayId, delivery.chatId ?? draft.chatId.trim()];
  if (!gatewayId || !chatId) return null;
  const named = labelOf(gatewayId, chatId);
  return `sends to ${appOf(gatewayId)}${named ? `, ${named}` : ""}`;
}

export function ResultsBox({
  draft,
  open,
  onPress,
  missing,
  children,
}: {
  draft: Draft;
  open: boolean;
  /** A press on the box; none where its fields cannot be opened. */
  onPress?: (() => void) | undefined;
  /** What a save still lacks here. */
  missing?: string | undefined;
  /** Its fields, in the box, where there is no room beside the canvas. */
  children?: ReactNode;
}) {
  const { labelOf } = useKnownChats();
  const words = resultsWords(draft, labelOf);
  const marks = marksWords(deliveryOf(draft));
  return (
    <section aria-label="Who and where">
      <StepBox
        pill
        icon={words.quiet ? VolumeX : Send}
        tile={words.quiet ? "bg-base-content/[0.07] text-base-content/80" : "bg-success/15 text-success"}
        title={words.title}
        line={missing ?? words.line}
        state={missing ? "lacking" : open ? "open" : undefined}
        onPress={onPress}
        pressLabel={onPress ? `${open ? "Close" : "Change"} where its results go` : undefined}
        expanded={onPress ? open : undefined}
        strip={
          marks.length > 0 ? (
            <p data-marks className="border-t border-dashed border-base-content/15 px-4 py-2 text-[13px] leading-snug text-base-content/75">
              {marks.join(" ")}
            </p>
          ) : null
        }
      >
        {children}
      </StepBox>
    </section>
  );
}

export function ResultsFields({
  draft,
  fresh,
  agents,
  gateways,
  set,
  onDone,
}: {
  draft: Draft;
  /** Being made: the agent can still be chosen. */
  fresh: boolean;
  agents: readonly AgentChoice[];
  gateways: GatewayInstance[];
  set: (patch: Partial<Draft>) => void;
  onDone: () => void;
}) {
  const delivery = deliveryOf(draft);
  const mission = draft.steps.some((step) => step.kind === "mission");
  // What the hours are is said under the switch that overrides them: asked only while that switch is on the page.
  const quiet = useQuietHours(true);
  return (
    <FieldsFrame
      mark={{ "data-results-fields": "" }}
      head={
        <>
          <p className="font-mono text-xs font-semibold tracking-wider text-base-content/65 uppercase">Results</p>
          <h2 className="mt-0.5 text-lg text-base-content">Who runs it, and where it reports</h2>
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
      <Field label="Agent" hint={fresh ? "Whose skills and tools it runs with." : "Chosen when it was made. To hand it to another agent, make a new one."}>
        <AgentSelect label="Agent" disabled={!fresh} picks={agents.map((agent) => ({ value: agent.id, name: agent.name, look: agent.look }))} value={draft.agentId} placeholder={draft.agentId} onChange={(agentId) => set({ agentId })} />
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
      {/* Only for one that runs again and again at a time: nothing else has a clock to stop on. */}
      {onAClock(draft) ? (
        <Field label="Stop by itself after" hint={LASTS_HINT}>
          <SearchSelect
            label="Stop by itself after"
            align="start"
            className="w-full"
            options={lastsChoices(draft.delivery.lasts)}
            value={draft.delivery.lasts === undefined ? "" : String(draft.delivery.lasts)}
            onChange={(next) => set({ delivery: withLasts(draft.delivery, next ? Number(next) : undefined) })}
          />
        </Field>
      ) : null}
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
    </FieldsFrame>
  );
}

/**
 * Opening an agent to everyone: the fourth answer on its Access card (`AgentAccessMode`), and what it shows under the
 * choices.
 *
 * An open agent answers anyone who finds it, on its owner's account. So the answer says what it means before it is
 * taken: where people will reach it, what it may say, the few things it can do while it is open, and the most it may
 * use in a day. The two limits have no default: an agent is not opened without numbers its admin chose. One with notes
 * of its own takes a second yes, since it may say what they hold. Only an admin opens one; closing is anyone's who may
 * change the agent. The orchestrator and an agent on a coding tool are never opened, and the choice says why.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Globe } from "lucide-react";
import type { AgentOpen, AgentSummary } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { connectionSaid } from "@/commons/lib/platform";
import { canWrite, isAdmin, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

/** What the choice says of itself where an agent may take it. */
export const OPEN_MEANS = "Anyone who finds it is answered with no code, like a shop's front desk. It answers from what you opened to everyone under Knowledge, and nothing else.";

/** Why an agent is never opened, in the page's words. */
export const NEVER: Record<NonNullable<AgentOpen["never"]>, string> = {
  orchestrator: "This is the main agent, the one that looks after this server, so it is never opened to everyone. Make another agent for the public, and open that one.",
  cli: "This agent works through a coding tool that brings tools of its own, and those cannot be taken away. So it is never opened to everyone. Open an agent that answers on a model instead.",
};

/** Where strangers would reach it, as one sentence. */
export function reachedOn(connections: readonly string[]): string {
  if (connections.length === 0) return "It has no connection of its own yet, so nobody can reach it. Give it one on its Connections tab first.";
  return `Anyone who finds it can write to it on ${connections.map(connectionSaid).join(", ")}, with no code for you to approve.`;
}

/** A whole number of 1 or more, as typed; null for anything else. */
export function limitTyped(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** Today against the limit, in one line. */
export function todaySaid(today: NonNullable<AgentOpen["today"]>, maxDailyTokens: number): string {
  const tokens = `${today.tokens.toLocaleString("en-US")} of ${maxDailyTokens.toLocaleString("en-US")} tokens used today${today.estimated ? " (part of it counted by Nouride, as an estimate)" : ""}`; // plain-words-ok: tokens, the unit a model's use is billed in, as the spend limits name it
  const people = today.people === 0 ? "nobody has written yet" : `${today.people} ${today.people === 1 ? "person has" : "people have"} written, ${today.messages} ${today.messages === 1 ? "message" : "messages"} answered`;
  return `${tokens}; ${people}.`;
}

/**
 * The form: what opening means, the two numbers, the closing sentence, and the second yes for an agent with notes.
 * It holds what is typed and sends it; the numbers of the last time the agent was open are offered again.
 */
function OpenForm({ agent, open, onClose }: { agent: AgentSummary; open: AgentOpen; onClose: () => void }) {
  const queryClient = useQueryClient();
  const saved = useSaved();
  const isOpen = agent.access === "open";
  const name = agent.displayName || agent.id;
  const [tokens, setTokens] = useState(open.limits ? String(open.limits.maxDailyTokens) : "");
  const [messages, setMessages] = useState(open.limits ? String(open.limits.maxDailyMessagesPerPerson) : "");
  const [closedReply, setClosedReply] = useState(open.limits?.closedReply ?? "");
  const [knowsNotes, setKnowsNotes] = useState(false);
  const maxDailyTokens = limitTyped(tokens);
  const maxDailyMessagesPerPerson = limitTyped(messages);
  // Asked when it is opened: an agent open already was opened past this question.
  const needsNotes = open.notes && !isOpen;
  const save = useMutation({
    mutationFn: () =>
      api.openAgent(agent.id, {
        maxDailyTokens: maxDailyTokens ?? 0,
        maxDailyMessagesPerPerson: maxDailyMessagesPerPerson ?? 0,
        ...(closedReply.trim() ? { closedReply: closedReply.trim() } : {}),
        ...(knowsNotes ? { knowsItsNotes: true } : {}),
      }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
      saved(result, isOpen ? `${name}'s daily limits saved` : `${name} is open to everyone`, isOpen ? "They hold from the next message." : "It answers anyone who writes to it, up to the limits you set.");
      onClose();
    },
  });
  const busy = save.isPending;
  const ready = maxDailyTokens !== null && maxDailyMessagesPerPerson !== null && (!needsNotes || knowsNotes);
  const number = (label: string, value: string, set: (text: string) => void, valid: boolean) => (
    <label className="block">
      <span className="mb-1 block text-xs opacity-70">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        className={`input input-sm w-44 tabular-nums ${value !== "" && !valid ? "input-error" : ""}`}
        value={value}
        placeholder="A number you choose"
        disabled={busy}
        onChange={(event) => set(event.target.value)}
      />
    </label>
  );

  return (
    <div className="mt-4 space-y-4">
      {!isOpen ? (
        <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-base-content/80">
          <li>{reachedOn(open.connections)}</li>
          <li>It may say whatever its persona files and its notes hold. Read them as a stranger would.</li>
          <li>While it is open it can only search and read what you opened to everyone under Knowledge, read a file someone sends it, and send a file from that knowledge. Its other tools are switched off, whatever its Tools list says.</li>
          <li>It remembers nothing a chat tells it, and knows nothing about you or the people you let in.</li>
        </ul>
      ) : null}

      <div className="flex flex-wrap items-start gap-4">
        {number("Most tokens it may use in a day", tokens, setTokens, maxDailyTokens !== null) /* plain-words-ok: tokens, the unit a model's use is billed in, as the spend limits name it */}
        {number("Most messages one person may send it in a day", messages, setMessages, maxDailyMessagesPerPerson !== null)}
      </div>
      <p className="text-xs text-base-content/65">
        Both are yours to choose, and there is no starting value: it answers on your account. When the first is used up for the day it tells people it is closed until tomorrow, and you are told once. A person past their own messages is told once, too.
      </p>

      <label className="block">
        <span className="mb-1 block text-xs opacity-70">What people are told when the day's limit is used up (optional)</span>
        {/* Two lines, so the sentence said when this is left empty is read whole on a phone. */}
        <textarea
          rows={2}
          className="textarea textarea-sm w-full leading-snug"
          value={closedReply}
          placeholder={`${name} has answered all it can for today. Please write again tomorrow.`}
          disabled={busy}
          onChange={(event) => setClosedReply(event.target.value)}
        />
      </label>

      {needsNotes ? (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-warning/40 bg-warning/5 p-3">
          <input type="checkbox" className="checkbox checkbox-sm checkbox-warning mt-0.5" checked={knowsNotes} disabled={busy} onChange={(event) => setKnowsNotes(event.target.checked)} />
          <span className="text-xs leading-relaxed">
            <span className="font-semibold">{name} has notes of its own.</span> Once it is open it may say what they hold to anyone who asks. I have read them on its{" "}
            <Link to="/agents/$agentId" params={{ agentId: agent.id }} className="link">
              Files tab
            </Link>
            , and nothing there is private. An agent made new for the public is the safer choice.
          </span>
        </label>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm btn-primary" disabled={!ready || busy} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : isOpen ? "Save limits" : "Open to everyone"}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
      <ErrorNote error={save.error} />
    </div>
  );
}

/**
 * Under the choices: the form while opening is being chosen or its limits changed, and where an open agent is reached
 * with what it used today. Nothing for a closed agent nobody is opening: the choices say that.
 */
export function OpenDetails({ agent, open, choosing, onDone }: { agent: AgentSummary; open: AgentOpen; choosing: boolean; onDone: () => void }) {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const queryClient = useQueryClient();
  const saved = useSaved();
  const isOpen = agent.access === "open";
  const name = agent.displayName || agent.id;
  const [editing, setEditing] = useState(false);
  const close = useMutation({
    mutationFn: () => api.closeAgent(agent.id),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["status"] });
      saved(result, `${name} is closed to new people`, "Only the people you let in can write to it. Its limits are kept for the next time.");
    },
  });
  const done = () => {
    setEditing(false);
    onDone();
  };

  if ((choosing && !isOpen) || editing) {
    return (
      <div className="mt-4 border-t border-base-content/10" data-open-form>
        <OpenForm agent={agent} open={open} onClose={done} />
      </div>
    );
  }
  if (!isOpen) return null;

  return (
    <div className="mt-4 border-t border-base-content/10 pt-4" data-open-now>
      <p className="flex items-start gap-2 text-sm leading-relaxed">
        <Globe size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        <span>
          <span className="font-semibold">Open.</span> {reachedOn(open.connections)}
          {open.today && open.limits ? <span className="text-base-content/65 mt-1 block text-xs">{todaySaid(open.today, open.limits.maxDailyTokens)}</span> : null}
        </span>
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {admin ? (
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            Change its limits
          </button>
        ) : null}
        {/* An admin closes it by taking another answer above. Those answers are an admin's, so an operator has this. */}
        {!admin && canWrite(me.data ?? null) ? (
          <button type="button" className="btn btn-sm btn-primary" disabled={close.isPending} onClick={() => close.mutate()}>
            {close.isPending ? "Closing…" : "Close it"}
          </button>
        ) : null}
      </div>
      {admin ? <p className="text-base-content/65 mt-3 text-xs">Taking another answer above closes it. Its limits are kept for the next time.</p> : null}
      <ErrorNote error={close.error} />
    </div>
  );
}

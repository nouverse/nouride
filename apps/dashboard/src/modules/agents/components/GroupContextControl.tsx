/**
 * How far back agents read a group they were not addressed in — one setting for the **whole daemon**.
 *
 * It sits on the Agents index beside the pairing switch, and for the same reason: `[agents]
 * group_context_messages` is daemon-wide, so a control for it inside Nouva's page would silently
 * change what Nero and every other bot reads too. A connection can still override it on its own
 * Connections page, and that field says what it is overriding.
 *
 * A number and not a switch, because the operator has two questions and they are not the same one:
 * *should* my agents follow the room, and *how far back*. Zero answers the first, which is why the
 * copy states what zero does rather than leaving it as a boundary value nobody guesses.
 *
 * Kept as a string in state, not a number: a half-deleted field parses to `NaN` or, worse, to 0 —
 * which is the off position, so clearing the box to retype it would read as "stop reading the room".
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Ear } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { NoSettingsFile } from "@/commons/components/ui/NoSettingsFile";
import { useSaved } from "@/commons/hooks/use-saved";

const MAX = 100;

export function GroupContextControl() {
  const me = useMe();
  const groupContext = useQuery({
    queryKey: ["group-context"],
    queryFn: api.groupContext,
    retry: false,
  });
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<string | null>(null);

  // Reset the draft whenever the daemon reports a different value — another operator's change, or our
  // own save landing. Without this the box keeps showing what was typed here and stops agreeing with
  // the thing it is meant to display.
  useEffect(() => {
    setDraft(null);
  }, [groupContext.data?.messages]);

  const announce = useSaved();
  const save = useMutation({
    mutationFn: (messages: number) => api.setGroupContext(messages),
    onSuccess: (answer, messages) => {
      announce(answer, messages === 0 ? "Group context is off" : `Group context: the last ${messages} messages`);
      return queryClient.invalidateQueries({ queryKey: ["group-context"] });
    },
  });

  // A daemon with no config file to write gets no control rather than a dead one.
  if (groupContext.error || !groupContext.data) return null;

  const saved = groupContext.data.messages;
  const value = draft ?? String(saved);
  const parsed = Number.parseInt(value, 10);
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX;
  const editable = groupContext.data.editable !== false;
  const writable = canWrite(me.data ?? null);
  const dirty = valid && parsed !== saved;

  return (
    <div className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-5 shadow-soft space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-bold text-sm tracking-tight text-base-content flex items-center gap-2">
            <Ear size={15} className={saved === 0 ? "text-base-content/40" : "text-info"} />
            Follow group conversations
            <span className="badge badge-xs badge-ghost font-semibold font-mono">all agents</span>
          </p>
          <p className="text-base-content/65 text-sm mt-1 max-w-prose">
            {saved === 0
              ? "Off. In a group an agent only sees the message that tagged it, so “@agent ini” arrives without the exchange it points at."
              : `Recent messages replayed when an agent is tagged in a group, so it can follow what was being said. Unaddressed chatter still starts nothing: it is remembered, not answered.`}
          </p>
          <p className="text-base-content/65 text-xs mt-1.5">
            Everything said in a room becomes context for the agents in it, including from senders you
            have not approved; they still cannot start a turn or reach a tool. A single connection can
            override this on its Connections page.
          </p>
          {!editable && <NoSettingsFile keys={["[agents] group_context_messages"]} />}
        </div>

        <div className="flex items-center gap-2">
          <label className="input input-sm rounded-xl flex items-center gap-2 w-40">
            <input
              type="number"
              min={0}
              max={MAX}
              step={1}
              className="grow text-sm"
              aria-label="Messages replayed"
              value={value}
              disabled={!writable || !editable || save.isPending}
              onChange={(event) => setDraft(event.target.value)}
            />
            <span className="text-base-content/65 text-xs whitespace-nowrap">messages</span>
          </label>
          <button
            type="button"
            className="btn btn-primary btn-sm rounded-xl shadow-xs active:scale-95 transition-all"
            disabled={!writable || !editable || !dirty || save.isPending}
            onClick={() => save.mutate(parsed)}
          >
            {save.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
            Save
          </button>
        </div>
      </div>

      {!valid && (
        <div role="alert" className="alert alert-warning alert-soft text-sm">
          <span>Enter a whole number between 0 (off) and {MAX}.</span>
        </div>
      )}

      <ErrorNote error={save.error} />
    </div>
  );
}

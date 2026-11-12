/**
 * The quiet hours, on the Automations page: one setting for every automation on the server, said in a line under the
 * page's head. Between the two times what automations would say to a chat is kept, and sent as one message when they
 * end.
 *
 * Anyone reads the line while hours are set, since it is why a run's words have not arrived yet. An admin sets them:
 * two times, or both left empty for none. It narrows nothing in the list under it, and is drawn so: a line of words
 * with one quiet button, apart from the search and the dropdowns.
 */

import { useState } from "react";
import { Moon } from "lucide-react";
import { ErrorNote } from "@/commons/components/ui/ui";
import { isAdmin, useMe } from "@/commons/lib/session";
import { useQuietHours, useSetQuietHours } from "../hooks/use-quiet-hours";
import { hoursProblem, hoursWords, keptWords, otherClock } from "../lib/watch";

const TIME = "input input-sm w-32 tabular-nums";
const LABEL = "mb-1 block text-xs text-base-content/70";

export function QuietHours() {
  const me = useMe();
  const quiet = useQuietHours();
  const save = useSetQuietHours();
  // The two times as they are being typed; none while the line is all there is.
  const [typed, setTyped] = useState<{ from: string; to: string } | null>(null);

  // No answer: still on its way, or a server older than the setting. Nothing is said of hours nobody can name.
  const policy = quiet.data;
  if (!policy) return null;
  const hours = hoursWords(policy);
  const kept = keptWords(policy);
  const canSet = isAdmin(me.data ?? null) && policy.editable;
  if (!hours && !canSet) return null;

  const held = { from: policy.from ?? "", to: policy.to ?? "" };
  const problem = typed ? hoursProblem(typed.from, typed.to) : null;
  const same = typed !== null && typed.from === held.from && typed.to === held.to;
  const close = () => {
    save.reset();
    setTyped(null);
  };

  return (
    <section aria-label="Quiet hours" className="space-y-3">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-base-content/70">
        <Moon size={15} aria-hidden="true" className="shrink-0 text-base-content/55" />
        <span data-quiet-hours>{hours ? `Quiet hours: ${hours}${otherClock(policy.timeZone) ? ", in this server's time" : ""}` : "Quiet hours are not set."}</span>
        {kept ? (
          <span data-quiet-kept className="rounded-full bg-info/10 px-2 py-0.5 text-xs font-medium text-info">
            {kept}
          </span>
        ) : null}
        {canSet && !typed ? (
          <button type="button" className="btn btn-ghost btn-xs font-bold text-secondary" onClick={() => setTyped(held)}>
            {hours ? "Change" : "Set"}
          </button>
        ) : null}
      </p>

      {canSet && typed ? (
        <div className="max-w-xl space-y-3 rounded-[18px] border border-base-content/[0.08] bg-base-100 p-3.5 shadow-soft sm:p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label>
              <span className={LABEL}>From</span>
              <input type="time" className={TIME} value={typed.from} onChange={(event) => setTyped({ ...typed, from: event.target.value })} />
            </label>
            <label>
              <span className={LABEL}>To</span>
              <input type="time" className={TIME} value={typed.to} onChange={(event) => setTyped({ ...typed, to: event.target.value })} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-sm border-base-content/15 bg-base-100"
                disabled={save.isPending || problem !== null || same}
                onClick={() => save.mutate(typed.from && typed.to ? typed : null, { onSuccess: () => setTyped(null) })}
              >
                {save.isPending ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
                Save
              </button>
              {typed.from || typed.to ? (
                <button type="button" className="btn btn-ghost btn-sm" disabled={save.isPending} onClick={() => setTyped({ from: "", to: "" })}>
                  Clear
                </button>
              ) : null}
              <button type="button" className="btn btn-ghost btn-sm" disabled={save.isPending} onClick={close}>
                Cancel
              </button>
            </div>
          </div>
          {problem ? (
            <p role="alert" className="text-xs font-medium text-error">
              {problem}
            </p>
          ) : (
            <p className="text-xs text-base-content/65">
              {typed.from && typed.to
                ? "Between these times, in this server's time, what automations would say to a chat is kept, and sent as one message when they end."
                : "No quiet hours: automations tell their chats at any hour."}
            </p>
          )}
          <ErrorNote error={save.error} />
        </div>
      ) : null}
    </section>
  );
}

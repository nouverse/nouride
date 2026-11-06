/**
 * How long one reply may take, for every agent that does not say otherwise.
 *
 * The clock's half of `ToolBudgetControl`, and its own card rather than a second field on that one:
 * they are different questions in different units. An agent can spend its clock waiting inside
 * three calls, or spend its round-trips on twenty that each return instantly, and the fix for one is
 * not the fix for the other.
 *
 * The cost named here is not money, which is why the wording differs from its neighbour. The queue
 * is per chat, so this number is how long the *next* person to message waits behind one slow turn —
 * and past the queue's own timeout their message is not delayed, it is dropped. That ceiling comes
 * from the daemon rather than being assumed, because it is configurable too.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Timer } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { useSaved } from "@/commons/hooks/use-saved";

export function TurnBudgetControl() {
  const me = useMe();
  const policy = useQuery({ queryKey: ["turn-seconds"], queryFn: api.turnSecondsPolicy, retry: false });
  const queryClient = useQueryClient();
  const saved = useSaved();

  const [draft, setDraft] = useState<string | null>(null);
  // Cleared whenever the daemon reports a different value — another operator's change, or our own.
  useEffect(() => {
    setDraft(null);
  }, [policy.data?.turnSeconds]);

  const save = useMutation({
    mutationFn: (value: number) => api.setTurnSeconds(value),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["turn-seconds"] });
      void queryClient.invalidateQueries({ queryKey: ["status"] });
      saved(
        result,
        `Turn budget set to ${result.turnSeconds}s`,
        "Live from the next turn.",
      );
    },
  });

  const data = policy.data;
  const current = data?.turnSeconds;
  const value = draft ?? (current === undefined ? "" : String(current));
  const parsed = Number(value);
  const writable = canWrite(me.data ?? null) && (data?.editable ?? false);

  const outOfRange =
    value !== "" && (!Number.isInteger(parsed) || parsed < (data?.min ?? 30) || parsed > (data?.max ?? 3600));
  // Half the queue's timeout: past that, one long turn is most of the window the next message has.
  const crowdsTheQueue =
    Number.isInteger(parsed) && data !== undefined && parsed > data.queueSeconds / 2;

  return (
    <Card
      title="Turn budget per reply"
      description="How long an agent may take answering one message, tool calls included, before it is asked to wrap up with what it has."
    >
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className="text-xs opacity-70 mb-1 flex items-center gap-1.5">
            <Timer size={12} /> Seconds
          </span>
          <input
            type="number"
            className={`input input-sm w-36 tabular-nums ${outOfRange ? "input-error" : ""}`}
            min={data?.min}
            max={data?.max}
            value={value}
            disabled={!writable || policy.isLoading}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={!writable || save.isPending || outOfRange || value === "" || parsed === current}
          onClick={() => save.mutate(parsed)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        {draft !== null && parsed !== current && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDraft(null)}>
            Cancel
          </button>
        )}
      </div>

      <p className="text-xs text-base-content/65 mt-3">
        Allowed {data?.min ?? 30}–{data?.max ?? 3600} seconds. The default of 300 covers a turn that
        reads a few files and runs something; anything genuinely slower belongs in a background job,
        which does not hold the chat.
      </p>
      {crowdsTheQueue && !outOfRange && (
        <p className="text-xs text-warning mt-1">
          The queue is per chat, and drops anything waiting past {data?.queueSeconds}s. At {parsed}s,
          a second message arriving mid-turn spends most of that window waiting.
        </p>
      )}
      <p className="text-xs text-base-content/65 mt-2">
        Agents can override this in their own settings; ones that do not, follow this number.
      </p>
      <ErrorNote error={save.error ?? policy.error} />
    </Card>
  );
}

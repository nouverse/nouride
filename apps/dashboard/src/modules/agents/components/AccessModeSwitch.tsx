/**
 * Pairing on or off — the **default** for every agent.
 *
 * It lives on the Agents index rather than inside an agent, because `[security.access] mode` is what
 * every agent follows. An agent can decide for itself on its own Access page (`[agent] access`,
 * `AgentAccessMode`); this card says so, so the two are never mistaken for one switch.
 *
 * The question it asks is the one an operator actually has — "can strangers still reach my bots?" —
 * so it is a switch with two positions, not a picker with three. On is `pair`: a stranger gets a code
 * and waits for approval. Off is `allowlist`: a stranger is dropped at the gate, before the router,
 * the queue or any model call, while everyone already paired keeps talking. `open` is not a position;
 * it is a posture boot warns about, surfaced here as a warning when it is in force.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Lock, Shield } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { NoSettingsFile } from "@/commons/components/ui/NoSettingsFile";
import { useSaved } from "@/commons/hooks/use-saved";

export function AccessModeSwitch() {
  const me = useMe();
  const access = useQuery({
    queryKey: ["access"],
    queryFn: api.access,
    refetchInterval: 15_000,
    retry: false,
  });
  const queryClient = useQueryClient();

  const saved = useSaved();
  const setMode = useMutation({
    mutationFn: (mode: "open" | "allowlist" | "pair") => api.setAccessMode(mode),
    onSuccess: (answer, mode) => {
      saved(answer, `Access mode: ${mode}`);
      return queryClient.invalidateQueries({ queryKey: ["access"] });
    },
  });

  // A daemon with no access store, or one we cannot reach, gets no switch at all rather than a dead
  // one: the per-agent Access page is where that condition is explained.
  if (access.error || !access.data) return null;

  const mode = access.data.mode;
  // `open` reads as on: it admits new senders too, just without asking anyone first.
  const pairingOn = mode !== "allowlist";
  // Older daemons do not report this field; assume they can edit rather than showing a dead switch.
  const editable = access.data.editable !== false;
  const writable = canWrite(me.data ?? null);
  const pending = access.data.senders.filter((sender) => sender.status === "pending").length;

  return (
    <div className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-5 shadow-soft space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-bold text-sm tracking-tight text-base-content flex items-center gap-2">
            {pairingOn ? <Shield size={15} className="text-info" /> : <Lock size={15} className="text-success" />}
            Accept new senders
            <span className="badge badge-xs badge-ghost font-semibold font-mono">default</span>
          </p>
          <p className="text-base-content/65 text-sm mt-1 max-w-prose">
            {pairingOn
              ? "A stranger who messages any bot gets a pairing code and waits for approval on the Access page."
              : "Locked. Only senders you already approved are answered; anyone else is dropped before it reaches an agent."}
          </p>
          <p className="text-base-content/65 text-xs mt-1">Each agent follows this unless its Access page says otherwise.</p>
          {pending > 0 && (
            <p className="text-warning text-xs mt-1.5 font-medium">
              {pending} sender{pending === 1 ? "" : "s"} waiting:{" "}
              <Link to="/access" className="link">
                approve on the Access page
              </Link>
              .
            </p>
          )}
          {!editable && <NoSettingsFile keys={["[security.access] mode"]} />}
        </div>

        <input
          type="checkbox"
          role="switch"
          aria-label="Accept new senders"
          className="toggle toggle-primary"
          checked={pairingOn}
          disabled={!writable || !editable || setMode.isPending}
          onChange={(event) => setMode.mutate(event.target.checked ? "pair" : "allowlist")}
        />
      </div>

      {mode === "open" && (
        <div role="alert" className="alert alert-warning alert-soft text-sm">
          <AlertTriangle size={16} />
          <span>
            Access mode is <b>open</b>: every sender is admitted with no pairing at all. Turning the switch on requires
            pairing instead.
          </span>
        </div>
      )}

      <ErrorNote error={setMode.error} />
    </div>
  );
}

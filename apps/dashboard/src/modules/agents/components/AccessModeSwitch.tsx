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
 * the queue or any model call, while everyone already paired keeps talking. Open to everyone is not a
 * position of this switch: no install is. One agent may be, from its own Access page (`OpenToEveryone`),
 * and the card says where.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOpenConnections } from "@/commons/hooks/use-open-connections";
import { Link } from "@tanstack/react-router";
import { Lock, Shield } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { NoSettingsFile } from "@/commons/components/ui/NoSettingsFile";
import { useSaved } from "@/commons/hooks/use-saved";

export function AccessModeSwitch() {
  const me = useMe();
  const access = useQuery({
    queryKey: ["access"],
    queryFn: () => api.access(),
    refetchInterval: 15_000,
    retry: false,
  });
  const queryClient = useQueryClient();

  const saved = useSaved();
  const setMode = useMutation({
    mutationFn: (mode: "allowlist" | "pair") => api.setAccessMode(mode),
    onSuccess: (answer, mode) => {
      saved(answer, `Access mode: ${mode}`);
      return queryClient.invalidateQueries({ queryKey: ["access"] });
    },
  });

  const openConnections = useOpenConnections();

  // A daemon with no access store, or one we cannot reach, gets no switch at all rather than a dead
  // one: the per-agent Access page is where that condition is explained.
  if (access.error || !access.data) return null;

  const pairingOn = access.data.mode !== "allowlist";
  // Older daemons do not report this field; assume they can edit rather than showing a dead switch.
  const editable = access.data.editable !== false;
  const writable = canWrite(me.data ?? null);
  // As the Access page counts them: an open agent's requests are not there to approve. Counted once it is known whose
  // they are, as Home's count is: before that, an open agent's would be counted for a moment.
  const pending =
    openConnections.known || openConnections.failed ? access.data.senders.filter((sender) => sender.status === "pending" && !openConnections.onOpen(sender.gatewayId)).length : 0;

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
          <p className="text-base-content/65 text-xs mt-1">Each agent follows this unless its Access page says otherwise. To let anyone write to one agent with no code, open that agent to everyone there.</p>
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

        {/* The label is what a finger presses: the switch alone is shorter than one. */}
        <label className="flex min-h-8 cursor-pointer items-center">
          <input
            type="checkbox"
            role="switch"
            aria-label="Accept new senders"
            className="toggle toggle-primary"
            checked={pairingOn}
            disabled={!writable || !editable || setMode.isPending}
            onChange={(event) => setMode.mutate(event.target.checked ? "pair" : "allowlist")}
          />
        </label>
      </div>

      <ErrorNote error={setMode.error} />
    </div>
  );
}

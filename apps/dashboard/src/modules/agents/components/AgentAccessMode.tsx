/**
 * Whether this agent's connections take new senders — its own answer, or the daemon's.
 *
 * `[agent] access`: `follow` defers to the switch on Agents → Settings, `pair` and `allowlist` decide
 * for this agent's connections whatever that switch says. Read at the gate by the connection's owner,
 * so it covers every platform this agent is connected on. Admin only, like the daemon-wide switch.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Card, ErrorNote } from "@/commons/components/ui/ui";

type Access = NonNullable<AgentSummary["access"]>;

export function AgentAccessMode({ agent }: { agent: AgentSummary }) {
  const me = useMe();
  const global = useQuery({ queryKey: ["access"], queryFn: api.access, retry: false });
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (access: Access) => api.setAgentAccess(agent.id, access),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });
  const current: Access = agent.access ?? "follow";
  const globalOn = global.data ? global.data.mode !== "allowlist" : null;
  const options: { value: Access; label: string; detail: string }[] = [
    { value: "follow", label: `Follow the default${globalOn === null ? "" : ` (${globalOn ? "on" : "off"})`}`, detail: "Whatever Agents → Settings says for every agent." },
    { value: "pair", label: "On", detail: "A stranger gets a pairing code and waits for your approval on the Access page." },
    { value: "allowlist", label: "Off", detail: "Only senders you already approved; anyone else is ignored." },
  ];
  const admin = isAdmin(me.data ?? null);

  return (
    <Card title="Accept new senders" description="Whether someone new who messages this agent can ask to be let in.">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-3 transition-colors ${
              current === option.value ? "border-primary bg-primary/5" : "border-base-content/10 hover:border-base-content/25"
            } ${!admin || save.isPending ? "pointer-events-none text-base-content/65" : ""}`}
          >
            <span className="flex items-center gap-2">
              <input type="radio" name={`access-${agent.id}`} className="radio radio-primary radio-xs" checked={current === option.value} disabled={!admin || save.isPending} onChange={() => save.mutate(option.value)} />
              <span className="text-sm font-semibold">{option.label}</span>
            </span>
            <span className="text-base-content/65 text-xs leading-relaxed">{option.detail}</span>
          </label>
        ))}
      </div>
      {!admin ? <p className="text-base-content/65 mt-3 text-xs">Only an admin can change who may reach an agent.</p> : null}
      <ErrorNote error={save.error} />
    </Card>
  );
}

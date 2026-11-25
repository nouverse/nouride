/**
 * Who may write to this agent: one question, so one card, with four answers.
 *
 * `[agent] access`: `follow` defers to the switch on Agents → Settings, `pair` and `allowlist` decide for this agent's
 * connections whatever that switch says, and `open` answers anyone with no code. The fourth is among the other three,
 * not a card of its own: apart, a person read two cards to learn one thing, and the first showed nothing chosen while
 * the agent was open. It is the one answer taken in two steps, since it asks what a day of it may cost: picking it
 * shows that form under the answers (`OpenToEveryone`), and nothing is saved until the form is.
 * Read at the gate by the connection's owner, so it covers every platform this agent is connected on. Admin only, like
 * the daemon-wide switch.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/commons/lib/api";
import type { AgentSummary } from "@nouride/wire";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { NEVER, OPEN_MEANS, OpenDetails } from "./OpenToEveryone";

type Access = NonNullable<AgentSummary["access"]>;
/** What one press saves. Open to everyone is saved by its form, with its two limits. */
type Asks = Exclude<Access, "open">;

export function AgentAccessMode({ agent }: { agent: AgentSummary }) {
  const me = useMe();
  const global = useQuery({ queryKey: ["access"], queryFn: () => api.access(), retry: false });
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (access: Asks) => api.setAgentAccess(agent.id, access),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["status"] }),
  });
  // Open picked and its form not yet saved or put away: shown as the answer being taken, and saved nowhere.
  const [choosingOpen, setChoosingOpen] = useState(false);
  const current: Access = agent.access ?? "follow";
  const asksFirst = global.data ? global.data.mode !== "allowlist" : null;
  // An older daemon says nothing of opening: three answers.
  const open = agent.open;
  const options: { value: Access; label: string; detail: string; never?: boolean }[] = [
    // Which answer the default is now goes in the line under the name: in the name it broke onto a second line.
    { value: "follow", label: "Follow the default", detail: `Whatever Agents → Settings says for every agent${asksFirst === null ? "." : `: ${asksFirst ? "ask first" : "approved only"}, as it is now.`}` },
    { value: "pair", label: "Ask first", detail: "Someone new gets a pairing code and waits for your approval on the Access page." },
    { value: "allowlist", label: "Approved only", detail: "Only the people you already let in can write to it. Anyone else is ignored." },
    ...(open ? [{ value: "open" as const, label: "Open to everyone", detail: open.never ? NEVER[open.never] : OPEN_MEANS, never: Boolean(open.never) }] : []),
  ];
  const admin = isAdmin(me.data ?? null);
  const picked: Access = choosingOpen ? "open" : current;
  const take = (value: Access) => {
    if (value === "open") return setChoosingOpen(true);
    setChoosingOpen(false);
    save.mutate(value);
  };

  return (
    <Card title="Who can write to this agent" description="One answer, for every connection this agent has.">
      <div className={`grid grid-cols-1 gap-2 sm:grid-cols-2 ${open ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}>
        {options.map((option) => {
          const off = !admin || save.isPending || option.never === true;
          return (
            <label
              key={option.value}
              data-access-answer={option.value}
              className={`flex cursor-pointer flex-col gap-1 rounded-xl border p-3 transition-colors ${
                picked === option.value ? "border-primary bg-primary/5" : "border-base-content/10 hover:border-base-content/25"
              } ${off ? "pointer-events-none text-base-content/65" : ""}`}
            >
              <span className="flex items-center gap-2">
                <input type="radio" name={`access-${agent.id}`} className="radio radio-primary radio-xs" checked={picked === option.value} disabled={off} onChange={() => take(option.value)} />
                <span className="text-sm font-semibold">{option.label}</span>
              </span>
              <span className="text-base-content/65 text-xs leading-relaxed">{option.detail}</span>
            </label>
          );
        })}
      </div>
      {open && !open.never ? <OpenDetails agent={agent} open={open} choosing={choosingOpen} onDone={() => setChoosingOpen(false)} /> : null}
      {!admin ? <p className="text-base-content/65 mt-3 text-xs">Only an admin can change who may write to an agent.</p> : null}
      <ErrorNote error={save.error} />
    </Card>
  );
}

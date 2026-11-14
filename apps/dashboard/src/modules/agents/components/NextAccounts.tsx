/**
 * Where an agent goes on when its account reaches its limit: the accounts after its first, in the order it moves
 * through them. A turn failed on an account's limit and the person moved the chat back by hand, with another account
 * signed in beside it. Only for a coding CLI whose accounts are signed in once for every agent.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import type { AgentCli } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { accountList, addable } from "@/commons/lib/next-accounts";
import { Card, ErrorNote } from "@/commons/components/ui/ui";

export function NextAccounts({ agentId, agentName, data, admin, onSaved }: { agentId: string; agentName: string; data: AgentCli; admin: boolean; onSaved: () => Promise<void> }) {
  const accounts = useQuery({ queryKey: ["cli-accounts"], queryFn: () => api.cliAccounts(), staleTime: 60_000, retry: false });
  const cli = accounts.data?.clis.find((entry) => entry.id === data.cli);
  const saved = (data.accounts ?? [data.profile]).slice(1);
  const [next, setNext] = useState<string[]>(saved);
  const [pick, setPick] = useState("");
  useEffect(() => setNext(saved), [saved.join(",")]);
  const save = useMutation({ mutationFn: () => api.setAgentCli(agentId, { profile: accountList(data.profile, next) }), onSuccess: onSaved });
  // One sign-in per agent: there is no other account to start its CLI with.
  if (!cli?.shared) return null;
  const more = addable(cli.accounts, [data.profile, ...next]);
  const changed = next.join(",") !== saved.join(",");

  return (
    <Card title="When its account reaches its limit" description={`${agentName} starts on ${data.profile}. When that account reaches its limit, it goes on with the next one below, and its conversation goes on with it.`}>
      <div className="space-y-3 text-sm" data-next-accounts>
        {data.on ? <p className="text-info text-xs">{agentName} is on {data.on} now.</p> : null}
        {next.length > 0 ? (
          <ol className="flex flex-wrap gap-2">
            {next.map((name, index) => (
              <li key={name} className="flex items-center gap-1.5 rounded-lg border border-base-content/10 px-2 py-1 text-xs">
                <span className="text-base-content/65">{index + 1}.</span>
                <span className="font-mono font-semibold">{name}</span>
                <button type="button" className="btn btn-ghost btn-xs btn-circle" disabled={!admin} onClick={() => setNext(next.filter((entry) => entry !== name))} aria-label={`Remove ${name}`}>
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-base-content/65 text-xs">None yet: at its limit, {agentName} stops until the limit ends.</p>
        )}
        {more.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <select className="select select-sm rounded-xl w-48" value={pick} onChange={(event) => setPick(event.target.value)} disabled={!admin} aria-label="An account to go on with">
              <option value="">Pick an account</option>
              {more.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <button type="button" className="btn btn-ghost btn-sm gap-1" disabled={!admin || !pick} onClick={() => { setNext([...next, pick]); setPick(""); }}>
              <Plus size={14} aria-hidden="true" /> Add
            </button>
          </div>
        ) : next.length === 0 ? (
          <p className="text-base-content/65 text-xs">There is no other signed-in account yet. Add one on the Models page.</p>
        ) : null}
        <div className="flex items-center gap-3">
          <button type="button" className="btn btn-primary btn-sm active:scale-95" disabled={!admin || !changed || save.isPending} onClick={() => save.mutate()}>Save</button>
          {save.isSuccess && !changed ? <span className="text-success text-xs">Saved.</span> : null}
        </div>
        <ErrorNote error={save.error} />
      </div>
    </Card>
  );
}

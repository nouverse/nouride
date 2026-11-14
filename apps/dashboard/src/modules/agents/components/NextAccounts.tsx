/**
 * Where an agent goes on when its account reaches its limit: the accounts after its first, in the order it moves
 * through them. A turn failed on an account's limit and the person moved the chat back by hand, with another account
 * signed in beside it. Only for a coding CLI whose accounts are signed in once for every agent.
 *
 * And whether it moves on before the limit: where its CLI says how much of an account is used, a switch and the share
 * at which it goes on with the next account, once the message it is answering is done. Off unless switched on.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import type { AgentCli } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { accountList, addable, MOVE_AT_DEFAULT, moveAtOf } from "@/commons/lib/next-accounts";
import { Card, ErrorNote } from "@/commons/components/ui/ui";

export function NextAccounts({ agentId, agentName, data, admin, onSaved }: { agentId: string; agentName: string; data: AgentCli; admin: boolean; onSaved: () => Promise<void> }) {
  const accounts = useQuery({ queryKey: ["cli-accounts"], queryFn: () => api.cliAccounts(), staleTime: 60_000, retry: false });
  const cli = accounts.data?.clis.find((entry) => entry.id === data.cli);
  const saved = (data.accounts ?? [data.profile]).slice(1);
  const [next, setNext] = useState<string[]>(saved);
  const [pick, setPick] = useState("");
  useEffect(() => setNext(saved), [saved.join(",")]);
  // Moving on early: off, or the percent typed. What is typed is kept as text, so a half-typed figure is not rewritten.
  const [early, setEarly] = useState<string | null>(data.moveAt === undefined ? null : String(data.moveAt));
  useEffect(() => setEarly(data.moveAt === undefined ? null : String(data.moveAt)), [data.moveAt]);
  const moveAt = early === null ? null : moveAtOf(early);
  const earlyChanged = (early === null ? undefined : (moveAt ?? undefined)) !== data.moveAt;
  const save = useMutation({
    mutationFn: () => api.setAgentCli(agentId, { profile: accountList(data.profile, next), ...(earlyChanged ? { move_at: moveAt } : {}) }),
    onSuccess: onSaved,
  });
  // One sign-in per agent: there is no other account to start its CLI with.
  if (!cli?.shared) return null;
  const more = addable(cli.accounts, [data.profile, ...next]);
  // A figure that is not a percent from 1 to 99 is not saved: Save waits for one.
  const typedWrong = early !== null && moveAt === null;
  const changed = next.join(",") !== saved.join(",") || earlyChanged;

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
          <p className="text-base-content/65 text-xs">None yet: at its limit, Nouride's own model for {agentName} answers until the limit ends.</p>
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
        {data.saysUse && next.length > 0 ? (
          <div className="space-y-1.5 border-t border-base-content/10 pt-3" data-move-early>
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="toggle toggle-sm toggle-primary" checked={early !== null} disabled={!admin} onChange={(event) => setEarly(event.target.checked ? String(data.moveAt ?? MOVE_AT_DEFAULT) : null)} />
              <span className="font-medium">Move on before the limit</span>
            </label>
            {early !== null ? (
              <label className="flex flex-wrap items-center gap-2 text-xs">
                <span>Go on with the next account once</span>
                <input type="text" inputMode="numeric" className={`input input-sm w-16 rounded-xl text-center ${typedWrong ? "input-error" : ""}`} value={early} disabled={!admin} onChange={(event) => setEarly(event.target.value)} aria-label="Percent of a limit used" />
                <span>% of a limit is used.</span>
              </label>
            ) : null}
            <p className="text-base-content/65 text-xs">
              {early !== null
                ? `${agentName} finishes the message it is answering, then goes on with the next account. Nothing is cut off or sent twice.`
                : `Off: ${agentName} goes on with the next account only when a message is refused, and that message is sent again.`}
            </p>
            {typedWrong ? <p className="text-error text-xs">Type a whole number from 1 to 99.</p> : null}
          </div>
        ) : null}
        <div className="flex items-center gap-3">
          <button type="button" className="btn btn-primary btn-sm active:scale-95" disabled={!admin || !changed || typedWrong || save.isPending} onClick={() => save.mutate()}>Save</button>
          {save.isSuccess && !changed ? <span className="text-success text-xs">Saved.</span> : null}
        </div>
        <ErrorNote error={save.error} />
      </div>
    </Card>
  );
}

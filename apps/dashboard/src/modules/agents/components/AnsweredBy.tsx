/**
 * Who answers a new agent (0.8.1): a model, through Nouride's profiles, or a coding CLI this box has — one choice on the
 * New Agent form, where external agents had a form of their own the owner found hard to follow. A CLI that is not
 * installed is shown with how to install it; a box with no room for a CLI's session says so and offers none.
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { Cpu, Terminal } from "lucide-react";
import { api } from "@/commons/lib/api";
import { cliLabel } from "@/commons/lib/api.external-agents";
import { Field } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";

const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MiB`;

export function AnsweredBy({ value, onChange }: { value: string | null; onChange: (cli: string | null) => void }) {
  const scan = useQuery({ queryKey: ["external-clis"], queryFn: () => api.externalClis(), staleTime: 60_000, retry: false });
  const clis = scan.data?.clis ?? [];
  const missing = clis.filter((cli) => !cli.installed);
  const option = (key: string, selected: boolean, disabled: boolean, onClick: () => void, icon: React.ReactNode, label: string, detail: string) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-xl border p-2.5 text-left transition-all disabled:opacity-60 ${selected ? "border-primary/40 bg-primary/10" : "border-base-content/[0.08] hover:bg-base-200/60"}`}
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold">{icon} {label}</span>
      <span className="mt-0.5 block text-[11px] leading-snug text-base-content/65">{detail}</span>
    </button>
  );

  return (
    <Field label="Answered by" hint="A model through Nouride, or a coding CLI on this server that answers with its own model and sign-in.">
      <div className="space-y-2">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {option("model", value === null, false, () => onChange(null), <Cpu size={13} aria-hidden="true" />, "A model", "Nouride's profiles, with fallbacks.")}
          {clis
            .filter((cli) => cli.installed)
            .map((cli) => option(cli.id, value === cli.id, false, () => onChange(cli.id), <Terminal size={13} aria-hidden="true" />, cliLabel(cli), "Installed. Signs in after it is made."))}
        </div>
        {scan.data?.room && !scan.data.room.enough ? (
          <p className="text-warning text-xs">
            Not enough memory for a coding CLI on this server: the agents' commands may use {mib(scan.data.room.bytes)}, and one coding CLI needs at least {mib(scan.data.room.needs)}.
          </p>
        ) : null}
        {missing.length > 0 ? (
          <div className="space-y-1 text-xs">
            <p className="text-base-content/65">
              Not set up on this server yet: {missing.map(cliLabel).join(", ")}. The Models page, under Coding CLIs, can ask for one.
            </p>
            <Details>
              <ul className="text-base-content/70 space-y-1">
                {missing.map((cli) => (
                  <li key={cli.id} className="break-all"><span className="font-semibold">{cliLabel(cli)}</span>: {cli.install}</li>
                ))}
              </ul>
            </Details>
          </div>
        ) : null}
        {/* A daemon with no external agents answers the scan with an error: then a model is the only choice, said by nothing. */}
      </div>
    </Field>
  );
}

/**
 * Which account a CLI answers with: one of the CLI's accounts, with whether each is signed in. Accounts are added and
 * signed in on the Models page, which the field links to — the owner: not here too.
 */
export function AccountPicker({ cli, value, onChange }: { cli: string; value: string; onChange: (account: string) => void }) {
  const accounts = useQuery({ queryKey: ["cli-accounts"], queryFn: () => api.cliAccounts(), staleTime: 60_000, retry: false });
  const row = accounts.data?.clis.find((entry) => entry.id === cli);
  // The account an agent starts on where none is added yet.
  const known = row?.accounts.length ? row.accounts : [{ name: "default", signedIn: row?.shared ? false : null, agents: [] }];
  useEffect(() => {
    if (!known.some((account) => account.name === value)) onChange(known[0]!.name);
  }, [known, value, onChange]);
  const state = (account: (typeof known)[number]) =>
    account.signedIn === true ? "signed in" : account.signedIn === false ? (account.agents.length > 0 && account.agents.every((agent) => agent.signedIn) ? "its agents signed in" : "not signed in yet") : "signs in per agent";
  return (
    <Field label="Account" hint={row?.shared ? `Agents on one account share its ${row.name} sign-in and its limits.` : "Each agent on an account signs in once, on its Brain tab."}>
      <div className="flex flex-wrap items-center gap-3">
        <select className="select select-sm rounded-xl" value={value} onChange={(event) => onChange(event.target.value)}>
          {known.map((account) => (
            <option key={account.name} value={account.name}>{account.name} ({state(account)})</option>
          ))}
        </select>
        <Link to="/models" search={{ tab: "clis" }} className="link link-primary text-xs">Add or sign in an account</Link>
        {accounts.isPending ? <span className="loading loading-spinner loading-xs text-primary opacity-60" /> : null}
      </div>
    </Field>
  );
}

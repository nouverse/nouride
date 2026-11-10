/**
 * Coding CLIs on the Models page (0.8.1): each CLI this install knows, whether this box has it, and its accounts — the
 * sign-ins external agents answer with — with the agents on each and whether each can answer. Where sign-ins are
 * managed, apart from which account an agent uses (its Brain tab): mixed together, they were hard to follow.
 *
 * One rule for a person to learn: green answers, amber needs a sign-in, with the button beside it. A CLI that signs an
 * account in once (Claude Code) has the button on the account; any other has it on each agent, on its Brain tab.
 *
 * In plain words (0.8.19): the people who read this are not technical. A CLI that is not there yet is one line and a
 * button that asks the orchestrator to set it up, in a chat message the person sends; how it works (ACP, the registry,
 * the adapters) and the install command are under Details, for whoever runs the server.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, ExternalLink, Info, KeyRound, LogIn, Plus, RefreshCw, Terminal, Trash2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import { cliLabel } from "@/commons/lib/api.external-agents";
import type { CliAccountsView, CliAccountView } from "@nouride/wire";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { CliSignIn } from "@/commons/components/agents/CliSignIn";
import { AskAgentButton } from "@/commons/components/agents/AskAgentButton";
import { CliStanding } from "@/commons/components/agents/CliStanding";
import { Details } from "@/commons/components/ui/Details";
import { isAdmin, useMe } from "@/commons/lib/session";
import { byInstaller, setUpMessage } from "@/commons/lib/set-up";
import { ListLoading } from "@/commons/components/ui/Spinner";

const ACCOUNT_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
/**
 * Where a person checks the route for themselves: the protocol, its registry, and the two adapters the built-in rows
 * start — each listed in the registry with its CLI's maker among its authors (Anthropic, OpenAI).
 */
const OFFICIAL = [
  { label: "Agent Client Protocol", href: "https://agentclientprotocol.com" },
  { label: "ACP registry", href: "https://agentclientprotocol.com/registry" }, // plain-words-ok: a link shown under Details
  { label: "claude-agent-acp", href: "https://github.com/agentclientprotocol/claude-agent-acp" }, // plain-words-ok: a link shown under Details
  { label: "codex-acp", href: "https://github.com/agentclientprotocol/codex-acp" }, // plain-words-ok: a link shown under Details
];

export function CodingClis() {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const queryClient = useQueryClient();
  // The daemon asks each CLI on each account's agents — seconds — so the answer is kept a minute here.
  const accounts = useQuery({ queryKey: ["cli-accounts"], queryFn: () => api.cliAccounts(), staleTime: 60_000, retry: false });
  const recheck = useMutation({ mutationFn: () => api.cliAccounts(true), onSuccess: (answer) => queryClient.setQueryData(["cli-accounts"], answer) });
  const clis = accounts.data?.clis ?? [];

  return (
    <div className="space-y-4">
      <div className="alert bg-info/10 border border-info/30 text-base-content/80 rounded-xl p-3 text-sm">
        <Info size={16} className="text-info shrink-0" aria-hidden="true" />
        <div className="space-y-2">
          <p>
            Some agents work inside Claude Code or Codex, signed in with your own account. Nouride uses your subscription the
            way its maker allows: it never pretends to be the app or shares your login with another program.
          </p>
          <Details>
            <p>
              An external agent runs inside the real coding CLI: Claude Code, Codex, or a CLI you add. The CLI is installed on
              this box and signed in with its own login. Nouride talks to it over the Agent Client Protocol (ACP), using the
              official adapters from the ACP registry. Zed and JetBrains use the same adapters, made with Anthropic and OpenAI.
              Nouride does not turn your subscription into an API.
            </p>
            <p className="flex flex-wrap gap-x-3 gap-y-1">
              {OFFICIAL.map((link) => (
                <a key={link.href} href={link.href} target="_blank" rel="noreferrer noopener" className="link link-hover inline-flex items-center gap-1 text-xs">
                  {link.label} <ExternalLink size={11} aria-hidden="true" />
                </a>
              ))}
            </p>
          </Details>
        </div>
      </div>
      <div className="flex justify-end">
        <button type="button" className="btn btn-ghost btn-sm gap-1" disabled={accounts.isFetching || recheck.isPending} onClick={() => recheck.mutate()}>
          <RefreshCw size={14} className={accounts.isFetching || recheck.isPending ? "animate-spin" : ""} aria-hidden="true" /> Check again
        </button>
      </div>
      {accounts.isPending ? (
        <ListLoading count={2} />
      ) : clis.length === 0 ? (
        <Card><EmptyState pose="coding" title="No coding CLIs on this server" /></Card>
      ) : (
        clis.map((cli) => <CliCard key={cli.id} cli={cli} admin={admin} onChanged={() => void queryClient.invalidateQueries({ queryKey: ["cli-accounts"] })} onRecheck={() => recheck.mutate()} />)
      )}
      <ErrorNote error={accounts.error ?? recheck.error} />
    </div>
  );
}

function CliCard({ cli, admin, onChanged, onRecheck }: { cli: CliAccountsView; admin: boolean; onChanged: () => void; onRecheck: () => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [signing, setSigning] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async (account: string) => {
      await api.addCliAccount(cli.id, account);
      if (cli.shared) await api.startAccountLogin(cli.id, account);
      return account;
    },
    onSuccess: (account) => {
      setAdding(false);
      setName("");
      if (cli.shared) setSigning(account);
      onChanged();
    },
  });
  const nameOk = ACCOUNT_NAME.test(name) && !cli.accounts.some((account) => account.name === name);

  return (
    <Card
      title={cliLabel(cli)}
      description={cli.shared ? "Each account is signed in once, here, and every agent on it answers with it." : `Each agent on an account signs in once, on its own Brain tab: ${cli.name} has no sign-in to share.`}
    >
      <div className="space-y-3 text-sm">
        {cli.installed ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Terminal size={16} className="text-base-content/60" aria-hidden="true" />
              {/* No version here: what the scan reads is the ACP adapter's (claude-agent-acp 0.95), not the CLI's own (Claude
                  Code 2.x). Its standing says it in words, the numbers under its Details (0.8.24). */}
              <span className="badge badge-sm badge-ghost font-mono">installed</span>
            </div>
            <CliStanding name={cli.name} cli={cli.id} pkg={cli.package} version={cli.version} standing={cli.standing} />
          </div>
        ) : (
          <div className="space-y-2">
            <p className="flex items-center gap-2">
              <Terminal size={16} className="text-base-content/60 shrink-0" aria-hidden="true" /> {cli.name} is not set up on this server yet.
            </p>
            {/* The orchestrator installs with a package manager, as `tools run` does; one that installs otherwise is for
                whoever runs the server, and the page says so rather than asking for what cannot be done. */}
            {byInstaller(cli.install) ? (
              <AskAgentButton task="to set it up" message={setUpMessage(cli.name)} />
            ) : (
              <p className="text-base-content/70 text-xs">Whoever runs this server needs to set this up.</p>
            )}
            <Details>
              <p className="break-all font-mono">{cli.install}</p>
            </Details>
          </div>
        )}
        {cli.loginNote && cli.installed ? <p className="text-base-content/65 text-xs">{cli.loginNote}</p> : null}

        {cli.accounts.length > 0 ? (
          <ul className="divide-y divide-base-content/10 rounded-xl border border-base-content/10">
            {cli.accounts.map((account) => (
              <AccountRow key={account.name} cli={cli} account={account} admin={admin} signing={signing === account.name} onSignIn={() => setSigning(account.name)} onChanged={onChanged} />
            ))}
          </ul>
        ) : (
          <p className="text-base-content/65 text-xs">No account yet.</p>
        )}

        {signing ? <AccountSignIn cli={cli} account={signing} admin={admin} onEnded={() => { setSigning(null); onRecheck(); }} /> : null}

        {cli.installed && cli.canLogin ? (
          adding ? (
            <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (nameOk) add.mutate(name); }}>
              <input className="input input-sm font-mono rounded-xl w-48" value={name} placeholder="e.g. team" onChange={(event) => setName(event.target.value.toLowerCase())} autoFocus />
              <button type="submit" className="btn btn-primary btn-sm gap-1" disabled={!nameOk || add.isPending}>
                {cli.shared ? <><LogIn size={14} aria-hidden="true" /> Add and sign in</> : <><Plus size={14} aria-hidden="true" /> Add</>}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setAdding(false); setName(""); }}>Cancel</button>
              <p className="text-base-content/65 w-full text-xs">A name for you to tell accounts apart: lowercase letters, digits and dashes.</p>
            </form>
          ) : (
            <button type="button" className="btn btn-ghost btn-sm gap-1" disabled={!admin || signing !== null} onClick={() => setAdding(true)}>
              <Plus size={14} aria-hidden="true" /> Add an account
            </button>
          )
        ) : null}
        <ErrorNote error={add.error} />
      </div>
    </Card>
  );
}

function AccountRow({ cli, account, admin, signing, onSignIn, onChanged }: { cli: CliAccountsView; account: CliAccountView; admin: boolean; signing: boolean; onSignIn: () => void; onChanged: () => void }) {
  const start = useMutation({ mutationFn: () => api.startAccountLogin(cli.id, account.name), onSuccess: onSignIn });
  const remove = useMutation({ mutationFn: () => api.removeCliAccount(cli.id, account.name), onSuccess: onChanged });
  return (
    <li className="space-y-2 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-sm font-semibold">{account.name}</span>
        {account.signedIn === true ? (
          <Ok text="Signed in" />
        ) : account.signedIn === false && account.agents.length > 0 && account.agents.every((agent) => agent.signedIn) ? (
          // Its agents signed in on their own before accounts were shared (0.8.1, the live box): they answer.
          <span className="text-base-content/65 text-xs">Each agent signed in on its own. Sign in here once to share one sign-in</span>
        ) : account.signedIn === false ? (
          <Amber text="Not signed in" />
        ) : (
          <span className="text-base-content/65 text-xs">One sign-in per agent</span>
        )}
        {account.agents.length > 1 ? <span className="text-base-content/65 text-xs">(its agents share its limits)</span> : null}
        <span className="ml-auto flex gap-2">
          {cli.shared && cli.installed && !signing ? (
            <button type="button" className={`btn btn-xs gap-1 ${account.signedIn ? "btn-ghost" : "btn-primary"}`} disabled={!admin || start.isPending} onClick={() => start.mutate()}>
              <LogIn size={13} aria-hidden="true" /> {account.signedIn ? "Sign in again" : "Sign in"}
            </button>
          ) : null}
          {account.agents.length === 0 ? (
            <button type="button" className="btn btn-ghost btn-xs gap-1" disabled={!admin || remove.isPending} onClick={() => remove.mutate()} aria-label={`Remove the account ${account.name}`}>
              <Trash2 size={13} aria-hidden="true" />
            </button>
          ) : null}
        </span>
      </div>
      {account.agents.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {account.agents.map((agent) => (
            <li key={agent.id} className="flex items-center gap-1.5 rounded-lg border border-base-content/10 px-2 py-1 text-xs">
              {agent.signedIn ? <CheckCircle2 size={13} className="text-success" aria-label="answers" /> : <KeyRound size={13} className="text-warning" aria-label="cannot answer" />}
              <span>{agent.name}</span>
              {!agent.signedIn && !cli.shared ? (
                <Link to="/agents/$agentId/cli" params={{ agentId: agent.id }} className="link link-primary">Sign in</Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-base-content/65 text-xs">No agent uses it yet. Pick it on an agent's Brain tab, or when you make one.</p>
      )}
      <ErrorNote error={start.error ?? remove.error} />
    </li>
  );
}

/** A shared account's sign-in, polled while it runs; when it ends, the accounts are asked again. */
function AccountSignIn({ cli, account, admin, onEnded }: { cli: CliAccountsView; account: string; admin: boolean; onEnded: () => void }) {
  const queryClient = useQueryClient();
  const key = ["cli-account-login", cli.id, account];
  const login = useQuery({ queryKey: key, queryFn: () => api.accountLogin(cli.id, account), refetchInterval: (query) => (query.state.data?.login?.running === false ? false : 1_500) });
  const running = login.data?.login?.running ?? true;
  const was = useRef(running);
  useEffect(() => {
    if (was.current && !running) onEnded();
    was.current = running;
  }, [running, onEnded]);
  if (!login.data?.login) return null;
  return (
    <CliSignIn
      what={`account ${account}`}
      cliName={cli.name}
      admin={admin}
      login={login.data.login}
      answer={(text) => api.answerAccountLogin(cli.id, account, text)}
      stop={() => api.stopAccountLogin(cli.id, account)}
      onChanged={() => void queryClient.invalidateQueries({ queryKey: key })}
    />
  );
}

const Ok = ({ text }: { text: string }) => <span className="text-success flex items-center gap-1 text-xs"><CheckCircle2 size={14} aria-hidden="true" /> {text}</span>;
const Amber = ({ text }: { text: string }) => <span className="text-warning flex items-center gap-1 text-xs"><KeyRound size={14} aria-hidden="true" /> {text}</span>;

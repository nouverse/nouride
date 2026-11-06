/**
 * An external agent's account on its Brain tab (0.8.1): the accounts of its CLI — its own sign-ins and the ones added
 * on the Models page — each with whether it is signed in (the daemon asks the CLI) and which one the agent answers
 * with; a sign-in for each, and the way to add one, on the Models page. On the live box the tab showed a lone
 * "Sign in" whatever the state, and a "Profile" text field nobody could read.
 */

import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, KeyRound, LogIn, Plus, RefreshCw } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { CliLoginView, CliProfile } from "@/commons/lib/api.external-agents";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { CliSignIn } from "@/commons/components/ui/CliSignIn";

export interface CliProfilesProps {
  agentId: string;
  agentName: string;
  cliName: string;
  admin: boolean;
  /** Whether Nouride can run this CLI's sign-in here, and why not. */
  canLogin: boolean;
  loginNote?: string | undefined;
  login: CliLoginView | null;
  /** The daemon's answer; undefined while it asks the CLI. */
  answer: { profiles: CliProfile[]; separate: boolean } | undefined;
  checking: boolean;
  error: unknown;
  /** Ask the CLI again rather than take the last answer. */
  onRecheck: () => void;
  /** A sign-in started, answered or stopped, or the profile in use changed. */
  onChanged: () => void;
}

export function CliProfiles(props: CliProfilesProps) {
  const { agentId, agentName, cliName, admin, canLogin, login, answer } = props;
  const start = useMutation({ mutationFn: (profile: string) => api.startCliLogin(agentId, profile), onSuccess: props.onChanged });
  const use = useMutation({ mutationFn: (profile: string) => api.setAgentCli(agentId, { profile }), onSuccess: props.onChanged });
  const profiles = answer?.profiles ?? [];
  const inUse = profiles.find((profile) => profile.inUse);
  const signingIn = login?.running ? login.profile : undefined;

  return (
    <Card title="Account" description={`The ${cliName} account ${agentName} answers with is marked In use. Accounts are added on the Models page, under Coding CLIs.`}>
      <div className="space-y-4 text-sm">
        {inUse?.signedIn === false ? (
          <div className="alert alert-warning bg-warning/10 border border-warning/30 text-warning rounded-xl p-3 text-xs">
            <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
            <span>{agentName} cannot answer with {cliName} until its account {inUse.name} is signed in; its own model answers meanwhile.</span>
          </div>
        ) : null}
        {!canLogin ? <p className="text-base-content/70 text-xs">{props.loginNote ?? `${cliName} has no sign-in Nouride can run here.`}</p> : null}

        {props.checking && !answer ? (
          <p className="text-base-content/65 flex items-center gap-2 text-xs">
            <span className="loading loading-spinner loading-xs" aria-hidden="true" /> Asking {cliName} which profiles are signed in…
          </p>
        ) : (
          <ul className="divide-y divide-base-content/10 rounded-xl border border-base-content/10">
            {profiles.map((profile) => (
              <li key={profile.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                <span className="font-mono text-sm font-semibold">{profile.name}</span>
                {profile.inUse ? <span className="badge badge-sm badge-primary badge-soft font-mono">In use</span> : null}
                <ProfileState profile={profile} />
                <span className="ml-auto flex flex-wrap gap-2">
                  {!profile.inUse ? (
                    <button type="button" className="btn btn-ghost btn-xs" disabled={!admin || use.isPending} onClick={() => use.mutate(profile.name)}>
                      Use for {agentName}
                    </button>
                  ) : null}
                  {canLogin && signingIn !== profile.name ? (
                    <button type="button" className={`btn btn-xs gap-1 ${profile.signedIn ? "btn-ghost" : "btn-primary"}`} disabled={!admin || Boolean(signingIn) || start.isPending} onClick={() => start.mutate(profile.name)}>
                      <LogIn size={13} aria-hidden="true" /> {profile.signedIn ? "Sign in again" : "Sign in"}
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Link to="/models" search={{ tab: "clis" }} className="btn btn-ghost btn-sm gap-1">
            <Plus size={14} aria-hidden="true" /> Add an account
          </Link>
          <button type="button" className="btn btn-ghost btn-sm gap-1" disabled={props.checking} onClick={props.onRecheck}>
            <RefreshCw size={14} className={props.checking ? "animate-spin" : ""} aria-hidden="true" /> Check again
          </button>
        </div>


        {login ? (
          <CliSignIn
            what={`account ${login.profile ?? inUse?.name ?? "default"}`}
            cliName={cliName}
            admin={admin}
            login={login}
            answer={(text) => api.answerCliLogin(agentId, text)}
            stop={() => api.stopCliLogin(agentId)}
            onChanged={props.onChanged}
            done={login.profile && login.profile !== inUse?.name ? <button type="button" className="btn btn-primary btn-xs" disabled={!admin} onClick={() => use.mutate(login.profile!)}>Use it</button> : undefined}
          />
        ) : null}
        <ErrorNote error={props.error ?? start.error ?? use.error} />
      </div>
    </Card>
  );
}

function ProfileState({ profile }: { profile: CliProfile }) {
  if (profile.signedIn) return <span className="text-success flex items-center gap-1 text-xs"><CheckCircle2 size={14} aria-hidden="true" /> Signed in</span>;
  if (profile.signedIn === false) return <span className="text-warning flex items-center gap-1 text-xs"><KeyRound size={14} aria-hidden="true" /> Not signed in</span>;
  return <span className="text-error text-xs">{profile.reason ?? "Could not ask it"}</span>;
}

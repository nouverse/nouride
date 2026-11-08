/**
 * An external agent's coding CLI (0.8.1, EXTERNAL_AGENTS §5.7): which CLI answers it and whether it can, its profiles —
 * each a sign-in run on the box as the agent, the link and code shown here and the answer typed here — and how it runs:
 * the model from what the CLI offers, and what it may do without asking. Who it is comes from its persona pack, on the
 * Files tab like any agent's: the daemon writes it into the CLI's own instruction file.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Terminal } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { AgentCli, CliPreset } from "@/commons/lib/api.external-agents";
import { isAdmin, useMe } from "@/commons/lib/session";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";
import { Combobox } from "@/commons/components/ui/Combobox";
import { AskAgentButton } from "@/commons/components/ui/AskAgentButton";
import { CliStanding } from "@/commons/components/ui/CliStanding";
import { Details } from "@/commons/components/ui/Details";
import { byInstaller, setUpMessage } from "@/commons/lib/set-up";
import { CliProfiles } from "./components/CliProfiles";
import AgentModelPage from "./model.page";

const PRESETS: { id: CliPreset; label: string; summary: string }[] = [
  { id: "folder", label: "Free in its folder", summary: "Works without asking inside its own folder. Where agents are not their own users, this asks as Risky does." },
  { id: "risky", label: "Ask when risky", summary: "Asks before what changes things outside a read or an edit." },
  { id: "all", label: "Ask for everything", summary: "Asks before every action it takes." },
];

export default function AgentCliPage({ agentId }: { agentId: string }) {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const queryClient = useQueryClient();
  // Polled while a sign-in runs, so what its terminal prints arrives as it prints it.
  const cli = useQuery({
    queryKey: ["agent-cli", agentId],
    queryFn: () => api.agentCli(agentId),
    refetchInterval: (query) => (query.state.data?.login?.running ? 1_500 : false),
  });
  const scan = useQuery({ queryKey: ["external-clis"], queryFn: () => api.externalClis(), staleTime: 60_000 });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  // The daemon asks the CLI on each profile — seconds, a CLI started for it — so the answer is kept a minute here.
  const profiles = useQuery({ queryKey: ["agent-cli-profiles", agentId], queryFn: () => api.agentCliProfiles(agentId), staleTime: 60_000, retry: false });
  const recheck = useMutation({
    mutationFn: () => api.agentCliProfiles(agentId, true),
    onSuccess: (answer) => queryClient.setQueryData(["agent-cli-profiles", agentId], answer),
  });
  const row = scan.data?.clis.find((entry) => entry.id === cli.data?.cli);

  // A sign-in that just ended changed what a profile is: asked again, not taken from the last answer.
  const signingIn = cli.data?.login?.running ?? false;
  const was = useRef(signingIn);
  const askAgain = recheck.mutate;
  useEffect(() => {
    if (was.current && !signingIn) askAgain();
    was.current = signingIn;
  }, [signingIn, askAgain]);

  if (cli.isPending) return <span className="loading loading-spinner loading-md text-primary opacity-60" />;
  if (cli.error || !cli.data) return <ErrorNote error={cli.error} />;
  const data = cli.data;
  const cliName = row?.name ?? data.cli;
  const agentName = status.data?.agents.find((agent) => agent.id === agentId)?.displayName ?? agentId;
  const changed = async () => {
    await queryClient.invalidateQueries({ queryKey: ["agent-cli", agentId] });
    await queryClient.invalidateQueries({ queryKey: ["agent-cli-profiles", agentId] });
  };
  const signedOut = profiles.data?.profiles.some((profile) => profile.inUse && profile.signedIn === false);

  return (
    <div className="space-y-6">
      <p className="text-base-content/65 max-w-2xl text-sm leading-relaxed">
        {cliName} answers {agentName}, running on this server as {agentName}. It reads {agentName}'s files from the
        Files tab and uses Nouride's tools (chat, memory, missions). To get it working, sign in its account below; then
        talk to {agentName} like any agent.
      </p>

      <Card title="Coding CLI">
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Terminal size={16} className="text-base-content/60" aria-hidden="true" />
            <span className="font-semibold">{cliName}</span>
            {row?.installed ? (
              // No version: the scan reads the ACP adapter's, not the CLI's own (Coding CLIs on the Models page says why).
              <span className="badge badge-sm badge-ghost font-mono">installed</span>
            ) : row ? (
              <span className="badge badge-sm badge-warning font-mono">not installed</span>
            ) : null}
          </div>
          {row?.installed ? <CliStanding name={cliName} pkg={row.package} version={row.version} standing={row.standing} /> : null}
          {/* Not there yet: asked of the orchestrator where it can install it, else whoever runs the server (0.8.19). */}
          {row && !row.installed ? (
            <div className="space-y-2">
              <p className="text-base-content/70 text-xs">{cliName} is not set up on this server yet.</p>
              {byInstaller(row.install) ? (
                <AskAgentButton task="to set it up" message={setUpMessage(cliName)} />
              ) : (
                <p className="text-base-content/70 text-xs">Whoever runs this server needs to set this up.</p>
              )}
            </div>
          ) : null}
          {row ? (
            <Details>
              <p className="font-mono">{row.command}</p>
              {!row.installed ? <p className="break-all font-mono">{row.install}</p> : null}
            </Details>
          ) : null}
          {/* Not signed in is said on the profile it is about, below; anything else here. */}
          {/* In the page's words (0.8.23): why is its CLI's own, an install command or a process's error, under Details. */}
          {data.unavailable && !signedOut ? (
            <div className="alert alert-warning bg-warning/10 border border-warning/30 text-warning rounded-xl p-3 text-xs">
              <AlertTriangle size={16} className="shrink-0" aria-hidden="true" />
              {data.plain ? (
                <div className="min-w-0 space-y-1">
                  <span>{data.plain}</span>
                  <Details>
                    <p className="break-words">{data.unavailable}</p>
                  </Details>
                </div>
              ) : (
                <span>{data.unavailable}</span>
              )}
            </div>
          ) : null}
        </div>
      </Card>

      <CliProfiles
        agentId={agentId}
        agentName={agentName}
        cliName={cliName}
        admin={admin}
        canLogin={row?.login ?? true}
        loginNote={row?.loginNote}
        login={data.login}
        answer={profiles.data}
        checking={profiles.isFetching || recheck.isPending}
        error={profiles.error ?? recheck.error}
        onRecheck={() => recheck.mutate()}
        onChanged={changed}
      />

      <Settings agentId={agentId} data={data} cliName={cliName} models={profiles.data?.models ?? data.models ?? []} admin={admin} onSaved={async () => {
        await queryClient.invalidateQueries({ queryKey: ["agent-cli", agentId] });
        await queryClient.invalidateQueries({ queryKey: ["status"] });
      }} />

      {/* The model of Nouride's own work around it — and of a turn the CLI cannot answer — folded: it is not what answers. */}
      <details className="rounded-2xl border border-base-content/10 p-4">
        <summary className="cursor-pointer text-sm font-semibold">Nouride's own model for {agentName}</summary>
        <div className="mt-4">
          <AgentModelPage agentId={agentId} />
        </div>
      </details>
    </div>
  );
}

function Settings({ agentId, data, cliName, models, admin, onSaved }: { agentId: string; data: AgentCli; cliName: string; models: { value: string; name?: string }[]; admin: boolean; onSaved: () => Promise<void> }) {
  const [permissions, setPermissions] = useState<CliPreset>(data.permissions);
  const [model, setModel] = useState(data.model ?? "");
  const [effort, setEffort] = useState(ownEffort(data));
  useEffect(() => {
    setPermissions(data.permissions);
    setModel(data.model ?? "");
    setEffort(ownEffort(data));
  }, [data.permissions, data.model, data.effort, data.effortDefault]);
  // Its effort only when it changed: unchanged, a save of the model leaves `[llm]` as it was.
  const save = useMutation({ mutationFn: () => api.setAgentCli(agentId, { permissions, model, ...(effort !== ownEffort(data) ? { effort } : {}) }), onSuccess: onSaved });

  return (
    <Card title="How it runs">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
        <Field label="Model" hint={models.length > 0 ? `One ${cliName} offers, or another name it takes. Empty: ${cliName}'s own default.` : `${cliName} lists its models here once a profile is signed in. Empty: its own default.`}>
          <Combobox
            options={models.map((entry) => entry.value)}
            describe={(value) => models.find((entry) => entry.value === value)?.name}
            value={model}
            onChange={setModel}
            disabled={!admin}
            placeholder={`${cliName}'s default`}
          />
        </Field>
        <Effort data={data} cliName={cliName} value={effort} onChange={setEffort} disabled={!admin} />
        <Field label="What it may do without asking" hint={`Each is ${cliName}'s own mode. What it asks comes to you as an approval, in chat or here.`}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {PRESETS.map((preset) => (
              <label key={preset.id} className={`rounded-xl border p-3 cursor-pointer transition-colors ${permissions === preset.id ? "border-primary bg-primary/5" : "border-base-content/10"}`}>
                <input type="radio" className="radio radio-sm radio-primary mr-2" name="preset" checked={permissions === preset.id} onChange={() => setPermissions(preset.id)} disabled={!admin} />
                <span className="text-sm font-semibold">{preset.label}</span>
                <p className="text-base-content/65 mt-1 text-xs">{preset.summary}</p>
              </label>
            ))}
          </div>
        </Field>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-primary btn-sm active:scale-95" disabled={!admin || save.isPending}>Save</button>
          {save.isSuccess ? <span className="text-success text-xs">Saved.</span> : null}
        </div>
        <ErrorNote error={save.error} />
      </form>
    </Card>
  );
}

/** Its own `[llm] effort`, or "default" where it follows the install's — the same value either way. */
function ownEffort(data: Pick<AgentCli, "effort" | "effortDefault">): string {
  return data.effort === null || data.effort === data.effortDefault ? "default" : data.effort;
}

/**
 * The effort it thinks with: the agent's one `[llm] effort` (or `[llm.defaults] effort`), set on the CLI where the model
 * it is on offers that value, its own kept where not. Chosen here (0.8.7) — it was shown and could not be changed — with
 * what the CLI offers, and the level it is on, beside each choice.
 */
function Effort({ data, cliName, value, onChange, disabled }: { data: AgentCli; cliName: string; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const offered = data.efforts.some((entry) => entry.value === data.effort);
  const current = data.efforts.find((entry) => entry.current)?.value;
  const hint = data.efforts.length === 0
    ? `${cliName} lists its efforts after a turn, where its model offers any; until then the one chosen is tried.`
    : data.effort === null
      ? `No effort is set for it: ${cliName} keeps its own.`
      : offered
        ? `Its effort is ${data.effort}, set on ${cliName}.`
        : `Its effort is ${data.effort}, which this model does not offer: ${cliName} keeps its own.`;
  const choices = ["default", ...data.effortChoices];
  return (
    <Field label="Effort" hint={hint}>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Effort">
        {choices.map((choice) => {
          const unoffered = choice !== "default" && data.efforts.length > 0 && !data.efforts.some((entry) => entry.value === choice);
          const label = choice === "default" ? `Default${data.effortDefault ? ` (${data.effortDefault})` : ""}` : choice;
          return (
            <button
              key={choice}
              type="button"
              role="radio"
              aria-checked={value === choice}
              disabled={disabled}
              onClick={() => onChange(choice)}
              title={unoffered ? `${cliName} does not offer this for its model: it keeps its own` : current === choice ? `${cliName} is on this now` : undefined}
              className={`btn btn-xs rounded-lg font-mono ${value === choice ? "btn-primary" : "btn-ghost border border-base-content/10"} ${unoffered ? "opacity-60" : ""}`}
            >
              {label}
              {current === choice ? " ·" : ""}
            </button>
          );
        })}
      </div>
    </Field>
  );
}

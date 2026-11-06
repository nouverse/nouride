/**
 * One server of the install's MCP library: how it runs, its credential and login, and — the point of the page — which
 * agents use it, each a switch. On for an agent connects it there at once; off stops it.
 */

import { Spinner } from "@/commons/components/ui/Spinner";
import { AgentName, useOrchestrator, useOrchestratorFirst } from "@/commons/components/ui/AgentName";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { KeyRound, Trash2, Users } from "lucide-react";
import { api, type McpLibraryServer } from "@/commons/lib/api";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useSaved } from "@/commons/hooks/use-saved";
import { McpServerForm } from "@/commons/components/mcp/McpServerForm";
import { McpServerLogin } from "@/commons/components/mcp/McpServerLogin";

/** How an agent's chip says it is doing: on and up, on and waiting for a login, on and not up (yet), or off. */
function agentState(agent: McpLibraryServer["agents"][number]): "connected" | "login" | "down" | "off" {
  if (!agent.on) return "off";
  if (agent.needsLogin) return "login";
  return agent.connected ? "connected" : "down";
}

const DOT: Record<ReturnType<typeof agentState>, string> = {
  connected: "bg-success",
  login: "bg-warning",
  down: "bg-error",
  off: "bg-base-content/25",
};

export function LibraryServerCard({ server, admin, onChanged }: { server: McpLibraryServer; admin: boolean; onChanged: () => void }) {
  const orchestrator = useOrchestrator();
  const users = useOrchestratorFirst(server.agents, (agent) => agent.id);
  const [editing, setEditing] = useState(false);
  const saved = useSaved();
  const { ask, dialog } = useConfirm();
  const used = server.agents.filter((agent) => agent.on);

  const toggle = useMutation({
    mutationFn: ({ agent, on }: { agent: string; on: boolean }) => api.setAgentMcp(agent, server.name, { on }),
    onSuccess: (answer, { agent, on }) => {
      saved(answer, `${server.name} ${on ? "on" : "off"} for ${agent}`);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteLibraryServer(server.name),
    onSuccess: (answer) => {
      saved(answer, `${server.name} removed`);
      onChanged();
    },
  });

  const runs = server.transport === "stdio" ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") : (server.url ?? "");
  return (
    <Card
      title={server.name}
      description={server.transport === "stdio" ? "Runs on this server, once for each agent that uses it" : "Reached over the internet"}
      actions={
        <div className="flex items-center gap-2">
          {server.perAgent && (
            <span className="badge badge-ghost badge-sm font-mono gap-1" title="Each agent brings its own key">
              <KeyRound size={11} aria-hidden="true" /> per agent
            </span>
          )}
          <span className="badge badge-ghost badge-sm font-mono gap-1" title="Agents that use it">
            <Users size={11} aria-hidden="true" /> {used.length}
          </span>
          {admin && (
            <>
              <button type="button" className="btn btn-ghost btn-xs rounded-lg font-medium hover:bg-base-200" onClick={() => setEditing((v) => !v)}>
                {editing ? "Cancel" : "Edit"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-xs rounded-lg text-error hover:bg-error/10"
                aria-label={`Remove ${server.name}`}
                onClick={async () => {
                  const yes = await ask({
                    title: `Remove ${server.name}?`,
                    body: `It leaves the library${used.length ? ` and ${used.map((agent) => agent.id).join(", ")}, which lose its tools` : ""}. Its logins are deleted.`,
                    confirmLabel: "Remove",
                  });
                  if (yes) remove.mutate();
                }}
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      }
    >
      {editing ? (
        <McpServerForm
          existing={server}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      ) : (
        <div className="space-y-3">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
            <Detail label="Key">{credentialLine(server)}</Detail>
            {server.transport !== "stdio" && !server.perAgent && !server.hasCredential ? (
              <McpServerLogin scope={{ library: true }} server={server} onChanged={onChanged} />
            ) : null}
          </dl>
          {/* How it is reached, for whoever runs the server (0.8.19). */}
          <Details>
            <p className="break-all font-mono">
              {server.transport}: {runs || "—"}
            </p>
          </Details>
          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 font-mono">Used by</p>
            <div className="flex flex-wrap gap-2">
              {users.map((agent) => {
                const state = agentState(agent);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    aria-pressed={agent.on}
                    disabled={!admin || toggle.isPending}
                    title={agent.on ? `On for ${agent.id}${agent.own ? ", with its own key" : ""}. Click to switch off.` : `Off for ${agent.id}. Click to switch on.`}
                    className={`btn btn-xs rounded-lg font-mono gap-1.5 ${agent.on ? "btn-primary btn-soft" : "btn-ghost border border-base-content/15 text-base-content/65"}`}
                    onClick={() => toggle.mutate({ agent: agent.id, on: !agent.on })}
                  >
                    {toggle.isPending && toggle.variables?.agent === agent.id ? (
                      <Spinner className="size-2.5" />
                    ) : (
                      <span className={`inline-block size-1.5 rounded-full ${DOT[state]}`} aria-hidden="true" />
                    )}
                    <AgentName id={agent.id} orchestrator={orchestrator} size={10} />
                    {agent.on && agent.own ? <KeyRound size={10} aria-label="its own key" /> : null}
                    {state === "connected" && agent.tools ? <span className="opacity-70">· {agent.tools} tools</span> : null}
                  </button>
                );
              })}
            </div>
            {used.length === 0 ? <p className="text-xs text-base-content/65">On for no agent yet. Pick one above.</p> : null}
          </div>
        </div>
      )}
      <ErrorNote error={toggle.error ?? remove.error} />
      {dialog}
    </Card>
  );
}

/** What the library's credential is, in words. */
function credentialLine(server: McpLibraryServer): string {
  if (server.perAgent) return "None shared: each agent brings its own";
  if (server.transport === "stdio") {
    if (server.envSecrets.length === 0) return "None";
    return server.envSecrets.map((entry) => `${entry.name}${entry.set ? "" : " (not set)"}`).join(", ");
  }
  if (server.hasCredential) return "Saved: one for every agent";
  if (server.login) return "Its login: one for every agent, renewed by itself";
  return "None: logs in, or is called without one";
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="p-3 rounded-xl bg-base-200/40 border border-base-content/[0.05]">
      <dt className="text-[11px] font-bold uppercase tracking-wider text-base-content/65 mb-1 font-mono">{label}</dt>
      <dd className="font-mono text-xs text-base-content font-medium break-all">{children}</dd>
    </div>
  );
}

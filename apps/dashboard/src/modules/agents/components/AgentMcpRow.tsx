/**
 * One library server on an agent's MCP tab: its switch, how it is doing when on, and the credential this agent
 * uses — the library's, or its own (a token, variables, or a login of its own).
 */

import { Spinner } from "@/commons/components/ui/Spinner";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, type AgentMcpCredential, type McpServer } from "@/commons/lib/api";
import { ErrorNote, StatusDot } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { formatBytes } from "@/commons/lib/format";
import { useSaved } from "@/commons/hooks/use-saved";
import { McpServerLogin } from "@/commons/components/mcp/McpServerLogin";
import { AgentMcpTools } from "./AgentMcpTools";
import { McpSecretEnv, secretEnvPayload, secretEnvProblem, secretEnvRows, type SecretEnvRow } from "@/commons/components/mcp/McpSecretEnv";

export function AgentMcpRow({ agentId, server, admin, onChanged }: { agentId: string; server: McpServer; admin: boolean; onChanged: () => void }) {
  const saved = useSaved();
  const remote = server.transport !== "stdio";
  const [own, setOwn] = useState(server.credential === "own");
  const [token, setToken] = useState("");
  const [login, setLogin] = useState(server.loginAs === "own");
  const [rows, setRows] = useState<SecretEnvRow[]>(secretEnvRows(server));

  const change = useMutation({
    mutationFn: (body: { on?: boolean; credential?: AgentMcpCredential }) => api.setAgentMcp(agentId, server.name, body),
    onSuccess: (answer, body) => {
      saved(answer, body.on === undefined ? `${server.name}'s credential for ${agentId}` : `${server.name} ${body.on ? "on" : "off"} for ${agentId}`);
      setToken("");
      onChanged();
    },
  });

  const ownCredential = (): AgentMcpCredential =>
    remote ? { ...(token.trim() ? { token: token.trim() } : {}), login } : { envSecrets: secretEnvPayload(rows) };
  const envProblem = !remote && own ? secretEnvProblem(rows) : null;

  return (
    <div className="rounded-2xl border border-base-content/[0.08] bg-base-100/80 p-4 shadow-xs space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="checkbox"
          className="toggle toggle-primary toggle-sm"
          aria-label={`${server.name} for ${agentId}`}
          checked={Boolean(server.on)}
          disabled={!admin || change.isPending}
          onChange={(event) => change.mutate({ on: event.target.checked })}
        />
        {change.isPending ? <Spinner className="text-primary" /> : null}
        <div className="min-w-0 grow">
          <p className="font-semibold text-sm">{server.name}</p>
          {/* Its address or the command that starts it: for whoever runs the server (0.8.19). */}
          <Details>
            <p className="break-all font-mono">{remote ? server.url : [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")}</p>
          </Details>
        </div>
        {server.on ? (
          server.needsLogin ? (
            <span className="badge badge-warning badge-sm font-semibold font-mono">needs login</span>
          ) : (
            <>
              <StatusDot status={server.running ? (server.connected ? "connected" : "dead") : null} />
              {server.connected ? (
                <span className="badge badge-primary badge-sm font-semibold font-mono">
                  {server.toolsTotal === undefined ? `${server.tools} tools` : `${server.tools} of ${server.toolsTotal} tools`}
                </span>
              ) : null}
              {server.connected && server.schemaBytes !== undefined ? (
                <span className="badge badge-ghost badge-sm font-mono" title="Sent with every request this agent makes">
                  {formatBytes(server.schemaBytes)} per request
                </span>
              ) : null}
            </>
          )
        ) : null}
      </div>

      {server.on ? (
        <div className="space-y-3 border-t border-base-content/[0.06] pt-3">
          <AgentMcpTools agentId={agentId} server={server} admin={admin} onChanged={onChanged} />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono uppercase tracking-wider text-[11px] font-bold text-base-content/65">Credential</span>
            {(["library", "own"] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={own === (choice === "own")}
                disabled={!admin || (server.perAgent === true && choice === "library")}
                className={`btn btn-xs rounded-lg ${own === (choice === "own") ? "btn-primary btn-soft" : "btn-ghost border border-base-content/15"}`}
                onClick={() => {
                  setOwn(choice === "own");
                  if (choice === "library" && server.credential === "own") change.mutate({ credential: "library" });
                }}
              >
                {choice === "library" ? "The library's" : "Its own"}
              </button>
            ))}
            {server.perAgent ? <span className="text-base-content/65">Each agent brings its own for this connector.</span> : null}
          </div>

          {own && admin ? (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                change.mutate({ credential: ownCredential() });
              }}
            >
              {remote ? (
                <>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input type="checkbox" className="checkbox checkbox-sm" checked={login} onChange={(event) => setLogin(event.target.checked)} />
                    Signs in on its own. Connect below once saved
                  </label>
                  {!login ? (
                    <input
                      className="input input-sm w-full rounded-lg font-mono"
                      type="password"
                      autoComplete="off"
                      placeholder={server.hasCredential ? "A key is stored. Paste one to replace it" : "Its own key"}
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                    />
                  ) : null}
                </>
              ) : (
                <McpSecretEnv rows={rows} onChange={setRows} />
              )}
              {envProblem && rows.length > 0 ? <p className="text-xs text-warning">{envProblem}</p> : null}
              <button type="submit" className="btn btn-primary btn-xs rounded-lg" disabled={change.isPending || Boolean(envProblem)}>
                Save its credential
              </button>
            </form>
          ) : null}

          {remote && !server.hasCredential ? (
            <McpServerLogin scope={server.loginAs === "own" ? { agentId } : { library: true }} server={server} onChanged={onChanged} />
          ) : null}
        </div>
      ) : null}
      <ErrorNote error={change.error} />
    </div>
  );
}

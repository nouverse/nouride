/**
 * Integrations — Nouride used from other tools: Claude Code, Cursor, an editor, over MCP at `/mcp`.
 *
 * The inbound direction only. The outbound one — MCP servers an agent here uses — is that agent's
 * MCP tab, and the two are kept apart on purpose: both are "MCP", and one page for both
 * would read as the same thing.
 *
 * An admin's page: a token is a new way into what is kept about a person. Each belongs to one person,
 * names the agents it reaches and its scopes, and sees what that person would see talking to them.
 * Its value is shown once, when it is made, and while it is on screen the client snippets carry it,
 * so connecting is a copy and a paste.
 */

import { AgentName, useOrchestrator, useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { McpScope } from "@nouride/wire";
import { isAdmin, useMe } from "@/commons/lib/session";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";
import { ToggleRow } from "@/commons/components/ui/ToggleRow";
import { Card, EmptyState, ErrorNote, Field, PageHeader } from "@/commons/components/ui/ui";
import { CopyButton } from "@/commons/components/ui/CopyButton";
import { Details } from "@/commons/components/ui/Details";
import { McpClients, RecallTip } from "./clients";
import { useSaved } from "@/commons/hooks/use-saved";
import { PAGE_ASKS } from "@/commons/components/agents/page-asks";

/** Each scope as a person reads it. The engine's `modules/mcp-server/scopes.ts` is the rule. */
const SCOPES: { value: McpScope; label: string; hint: string }[] = [
  { value: "memory", label: "Read memory", hint: "Search and read past conversations and what is known about people." },
  { value: "personas", label: "Read who the agents are", hint: "Who each agent is: its identity and soul." },
  { value: "memory:write", label: "Save conversations", hint: "Save the points of a conversation as a transcript. It is filed in the nightly pass." },
];
const SCOPE_BADGE: Record<McpScope, string> = { memory: "memory", personas: "personas", "memory:write": "saves" };

function Tokens() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const server = useQuery({ queryKey: ["mcp-server"], queryFn: api.mcpServer });
  const known = useQuery({ queryKey: ["memory-people"], queryFn: api.memoryPeople });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const people = (known.data?.people ?? []).flatMap((p) => (p.key ? [{ key: p.key, name: p.name }] : []));
  const orchestrator = useOrchestrator();
  const agents = useOrchestratorFirst(status.data?.agents.map((agent) => agent.id) ?? [], (id) => id);
  const [person, setPerson] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<McpScope[]>(["memory", "personas"]);
  const [made, setMade] = useState<{ value: string; label: string } | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["mcp-server"] });
  const saved = useSaved();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.setMcpServerEnabled(enabled),
    onSuccess: (answer, enabled) => {
      saved(answer, `Access for other apps is ${enabled ? "on" : "off"}`);
      return refresh();
    },
  });
  const create = useMutation({
    mutationFn: () => api.createMcpToken({ person: person || people[0]?.key || "", agents: chosen, label, scopes }),
    onSuccess: async (result) => {
      setMade({ value: result.value, label: result.token.label });
      setLabel("");
      setChosen([]);
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeMcpToken(id),
    onSuccess: async () => {
      toast.success("Key revoked");
      await refresh();
    },
  });

  const askRevoke = async (id: string, name: string) => {
    if (await confirm.ask({ title: `Revoke ${name}?`, body: "The client using it loses access at once. Make another to reconnect it.", confirmLabel: "Revoke" })) revoke.mutate(id);
  };
  const pick = (id: string, on: boolean) => setChosen(on ? [...chosen, id] : chosen.filter((a) => a !== id));
  const scope = (value: McpScope, on: boolean) => setScopes(on ? [...scopes, value] : scopes.filter((s) => s !== value));
  const enabled = server.data?.enabled ?? false;
  const url = `${window.location.origin}/mcp`;
  const list = server.data?.tokens ?? [];

  return (
    <div className="space-y-4">
      <Card title="Access for other apps" description="Other apps reach Nouride at this address, with a key you make below.">
        <div className="space-y-4">
          <ToggleRow
            label="Let other apps connect"
            hint="When off, every key is refused and the address answers as if it did not exist."
            checked={enabled}
            disabled={toggle.isPending || server.isLoading}
            onChange={(next) => toggle.mutate(next)}
          />
          <Field label="Address">
            <div className="flex items-center gap-2">
              <code className="bg-base-200/60 border-base-content/10 min-w-0 flex-1 truncate rounded-xl border px-3 py-2 font-mono text-xs">{url}</code>
              <CopyButton text={url} />
            </div>
          </Field>
          {toggle.error ? <ErrorNote error={toggle.error} /> : null}
          {/* How other apps reach it, for whoever sets one up by hand (0.8.19). */}
          <Details>
            <p>Nouride serves MCP over streamable HTTP at this address; each request carries a key as a bearer token.</p>
          </Details>
        </div>
      </Card>

      <Card title="Keys" description="One key per app. Each reaches only the agents and the things you pick, as the person it is for would see them.">
        <div className="space-y-5">
          {server.error ? <ErrorNote error={server.error} /> : null}
          {list.length > 0 ? (
            <ul className="divide-y divide-base-content/[0.06]">
              {list.map((token) => (
                <li key={token.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {token.label}
                      {token.scopes.map((s) => (
                        <span key={s} className="badge badge-ghost badge-xs font-mono">
                          {SCOPE_BADGE[s]}
                        </span>
                      ))}
                    </p>
                    <p className="text-base-content/65 text-xs">
                      {token.person} → {token.agents.join(", ")} · {token.lastUsedAt ? `used ${new Date(token.lastUsedAt).toLocaleString()}` : "never used"}
                      {/* When it stops working: 90 days for a new one, unless it was made to last. */}
                      {token.expiresAt === undefined
                        ? null
                        : token.expiresAt === null
                          ? " · never expires"
                          : token.expiresAt <= Date.now()
                            ? " · expired"
                            : ` · expires ${new Date(token.expiresAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  <button type="button" className="btn btn-ghost btn-xs rounded-lg" aria-label={`Revoke ${token.label}`} onClick={() => void askRevoke(token.id, token.label)}>
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-base-content/65 text-sm">No keys yet.</p>
          )}

          {made ? (
            <div role="alert" className="border-success/30 bg-success/10 flex items-start gap-3 rounded-2xl border p-4 text-sm">
              <div className="min-w-0 flex-1 space-y-1.5">
                <p className="text-success font-semibold">Copy the key for {made.label} now. It won't be shown again.</p>
                <div className="flex items-center gap-2">
                  <code className="bg-base-100/70 min-w-0 flex-1 break-all rounded-lg px-2 py-1 font-mono text-xs">{made.value}</code>
                  <CopyButton text={made.value} />
                </div>
                <p className="text-base-content/65 text-xs">The set-up below includes it until you close this.</p>
              </div>
              <button type="button" className="btn btn-ghost btn-xs shrink-0 rounded-lg" onClick={() => setMade(null)}>
                Done
              </button>
            </div>
          ) : null}

          <div className="border-base-content/[0.08] space-y-4 border-t pt-4">
            <p className="text-sm font-medium">Make a key</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="For">
                <select className="select select-sm w-full rounded-xl" value={person || people[0]?.key || ""} onChange={(event) => setPerson(event.target.value)}>
                  {people.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="App name">
                <input className="input input-sm w-full rounded-xl" placeholder="claude_code" /* plain-words-ok: an example of what this field takes */ value={label} onChange={(event) => setLabel(event.target.value)} />
              </Field>
            </div>
            {/* A group, not a Field: a <label> around buttons clicks the first of them from anywhere inside. */}
            <div role="group" aria-labelledby="mcp-agents" className="space-y-1.5">
              <span id="mcp-agents" className="text-base-content/85 block text-xs font-semibold uppercase tracking-wider font-mono">
                Agents
              </span>
              <div className="flex flex-wrap gap-1.5">
                {agents.map((id) => {
                  const on = chosen.includes(id);
                  return (
                    <button key={id} type="button" aria-pressed={on} className={`btn btn-xs rounded-full gap-1 ${on ? "btn-primary" : "btn-outline border-base-content/20"}`} onClick={() => pick(id, !on)}>
                      <AgentName id={id} orchestrator={orchestrator} size={10} />
                    </button>
                  );
                })}
                {agents.length > 1 ? (
                  <button type="button" className="btn btn-ghost btn-xs rounded-full" onClick={() => setChosen(chosen.length === agents.length ? [] : agents)}>
                    {chosen.length === agents.length ? "None" : "All"}
                  </button>
                ) : null}
              </div>
            </div>
            <div role="group" aria-labelledby="mcp-scopes" className="space-y-2">
              <span id="mcp-scopes" className="text-base-content/85 block text-xs font-semibold uppercase tracking-wider font-mono">
                What it may do
              </span>
              {SCOPES.map((option) => (
                <ToggleRow key={option.value} label={option.label} hint={option.hint} checked={scopes.includes(option.value)} onChange={(on) => scope(option.value, on)} />
              ))}
            </div>
            <button type="button" className="btn btn-primary btn-sm gap-1 rounded-xl" disabled={!label || chosen.length === 0 || scopes.length === 0 || create.isPending} onClick={() => create.mutate()}>
              <KeyRound size={14} /> Make a key
            </button>
            {create.error ? <ErrorNote error={create.error} /> : null}
          </div>
        </div>
      </Card>

      <Card title="Connect an app" description="Copy the set-up for your app.">
        <McpClients url={url} token={made?.value ?? null} name={made?.label || "nouride"} />
      </Card>
      <Card title="Make it a habit" description="Apps use Nouride only when their AI decides to. A line in the app's instructions makes looking things up and saving what was done a habit.">
        <RecallTip />
      </Card>
      {confirm.dialog}
    </div>
  );
}

export default function IntegrationsPage() {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  return (
    <div className="space-y-6">
      <PageHeader
        ask={PAGE_ASKS.integrations}
        title="Integrations"
        description="Let other AI apps, like Claude Code or Cursor, read your agents' memory and who they are."
      />
      {me.data && !admin ? (
        <EmptyState pose="security" title="Admins only" description="A key opens what is kept about a person, so only an admin can make one." />
      ) : admin ? (
        <Tokens />
      ) : null}
    </div>
  );
}

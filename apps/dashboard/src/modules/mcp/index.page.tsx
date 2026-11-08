/**
 * Configure → MCP (0.7.19): the install's MCP servers. Added once — by hand or from the catalog — and switched on per
 * agent, beside Skills because it is the same shape: one library, a switch for each agent. Each agent's MCP tab holds
 * only its switches and, when it needs one, its own credential.
 */

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plug, Plus } from "lucide-react";
import { api, type CatalogDraft } from "@/commons/lib/api";
import { isAdmin, useMe } from "@/commons/lib/session";
import { EmptyState, ErrorNote, PageHeader } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { FILL_PAGE, ScrollCard } from "@/commons/components/ui/ScrollCard";
import { useTextFilter } from "@/commons/lib/use-text-filter";
import { SegmentedTabs } from "@/commons/components/ui/SegmentedTabs";
import { McpExplore } from "@/commons/components/mcp/McpExplore";
import { McpServerForm } from "@/commons/components/mcp/McpServerForm";
import { LibraryServerCard } from "./components/LibraryServerCard";
import { ListLoading } from "@/commons/components/ui/Spinner";

export default function McpLibraryPage({ install, agent }: { install?: string; agent?: string }) {
  const me = useMe();
  const admin = isAdmin(me.data ?? null);
  const queryClient = useQueryClient();
  // Polled while a server is on and not up: a switch reloads the agent, which connects in the background. And, slower,
  // while one waits for a login, which finishes in another tab.
  const library = useQuery({
    queryKey: ["mcp-library"],
    queryFn: api.mcpLibrary,
    refetchInterval: (query) => {
      const servers = query.state.data?.servers ?? [];
      const on = servers.flatMap((server) => server.agents.filter((entry) => entry.on));
      return on.some((entry) => !entry.connected && !entry.needsLogin) ? 2_000 : servers.some((server) => server.needsLogin) || on.some((entry) => entry.needsLogin) ? 5_000 : false;
    },
  });
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
  const agents = (status.data?.agents ?? []).map((entry) => entry.id);

  const [tab, setTab] = useState<"installed" | "explore">(install ? "explore" : "installed");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<CatalogDraft | null>(null);
  const pick = useCallback((next: CatalogDraft) => {
    setDraft(next);
    setTab("installed");
  }, []);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["mcp-library"] });
    void queryClient.invalidateQueries({ queryKey: ["mcp"] });
  };
  const servers = library.data?.servers ?? [];
  const [filter, setFilter] = useState("");
  const visible = useTextFilter(servers, filter, (server) => [server.name, server.url ?? "", server.command ?? ""]);

  return (
    <div className={FILL_PAGE}>
      <PageHeader
        title="Connectors"
        description="Extra tools for your agents from other services, like GitHub or Notion. Add one once and switch it on for the agents that should have it; its key is shared unless an agent brings its own."
        actions={
          admin ? (
            <button type="button" className="btn btn-primary btn-sm rounded-xl gap-2 shadow-xs active:scale-95 transition-all" onClick={() => { setTab("installed"); setAdding(true); }}>
              <Plus size={16} /> Add connector
            </button>
          ) : null
        }
      />
      {library.data?.error ? (
        <div role="alert" className="alert alert-error bg-error/10 border border-error/30 text-error rounded-2xl p-4 text-sm">
          <div className="space-y-1">
            <p>The connectors' settings have a mistake, so no agent has them until it is fixed.</p>
            <Details>
              <p>agents/mcp.toml does not load: {library.data.error}</p>
            </Details>
          </div>
        </div>
      ) : null}
      <ErrorNote error={library.error} />

      <SegmentedTabs
        tabs={[
          { value: "installed" as const, label: "Installed", after: <span className="badge badge-xs badge-ghost font-mono">{servers.length}</span> },
          { value: "explore" as const, label: "Explore", title: "Connectors from the public catalog" },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === "explore" ? <McpExplore admin={admin} {...(install ? { install } : {})} onPick={pick} /> : null}

      {tab === "installed" && (adding || draft) ? (
        <McpServerForm
          // A new key per draft: the form takes what it starts with once.
          key={draft?.source ?? "by-hand"}
          {...(draft ? { draft } : {})}
          agents={agents}
          enable={agent ? [agent] : []}
          onClose={() => {
            setAdding(false);
            setDraft(null);
          }}
          onSaved={() => {
            setAdding(false);
            setDraft(null);
            refresh();
          }}
        />
      ) : null}

      {tab !== "installed" ? null : library.isPending ? (
        <ListLoading />
      ) : (
        // Scrolls inside its card, as Skills' lists do, so the tabs stay in reach however many servers there are.
        <ScrollCard
          fill
          title={`${servers.length} connector${servers.length === 1 ? "" : "s"} added`}
          {...(servers.length > 0 ? { search: { value: filter, onChange: setFilter, placeholder: "Filter connectors" } } : {})}
        >
          {servers.length === 0 ? (
            <EmptyState icon={Plug} title="No connectors yet" description="Find one in Explore, or add one by hand, then switch it on for the agents that should use it." />
          ) : visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-base-content/65">Nothing matches “{filter}”.</p>
          ) : (
            <div className="space-y-4">
              {visible.map((server) => (
                <LibraryServerCard key={server.name} server={server} admin={admin} onChanged={refresh} />
              ))}
            </div>
          )}
        </ScrollCard>
      )}
    </div>
  );
}

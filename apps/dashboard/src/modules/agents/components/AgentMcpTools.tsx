/**
 * Which of a server's tools one agent gets (0.7.21): "Tools: all" or "N of M", opening a checklist of the server's
 * tools — each with its one-line description and what it adds to every request — with Select all / none and Save.
 *
 * A server's whole tool list goes into every request the agent makes; leaving out what it never uses is the saving.
 * The sizes are the daemon's own measure of each tool's definition (`schemaBytes`), never an estimate made here.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { McpServer } from "@nouride/wire";
import { ErrorNote } from "@/commons/components/ui/ui";
import { ScrollArea } from "@/commons/components/ui/ScrollCard";
import { Spinner } from "@/commons/components/ui/Spinner";
import { formatBytes } from "@/commons/lib/format";
import { useSaved } from "@/commons/hooks/use-saved";

/** What the button says: all, or how many of how many — from the agent's page, before the list is fetched. */
function summary(server: McpServer): string {
  if (!server.chosenTools) return "all";
  return server.toolsTotal === undefined ? `${server.chosenTools.length} chosen` : `${server.tools} of ${server.toolsTotal}`;
}

export function AgentMcpTools({ agentId, server, admin, onChanged }: { agentId: string; server: McpServer; admin: boolean; onChanged: () => void }) {
  const saved = useSaved();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const list = useQuery({
    queryKey: ["mcp-tools", agentId, server.name],
    queryFn: () => api.agentMcpTools(agentId, server.name),
    enabled: open && server.connected,
  });
  const tools = list.data?.tools ?? [];

  // The agent's choice as the daemon has it, taken in when the list arrives — and again after a save.
  useEffect(() => {
    if (list.data) setPicked(new Set(list.data.tools.filter((tool) => tool.on).map((tool) => tool.name)));
  }, [list.data]);

  const save = useMutation({
    mutationFn: (names: string[] | null) => api.setAgentMcp(agentId, server.name, { tools: names }),
    onSuccess: (answer, names) => {
      saved(answer, names === null ? `${agentId} has every tool of ${server.name}` : `${agentId} has ${names.length} of ${server.name}'s tools`);
      void list.refetch();
      onChanged();
    },
  });

  const bytes = useMemo(() => {
    const on = tools.filter((tool) => picked?.has(tool.name));
    const sum = (rows: typeof tools) => rows.reduce((total, tool) => total + (tool.bytes ?? 0), 0);
    return { sent: sum(on), left: sum(tools.filter((tool) => !picked?.has(tool.name))) };
  }, [tools, picked]);

  const everything = picked !== null && tools.length > 0 && tools.every((tool) => picked.has(tool.name));
  const changed =
    picked !== null && list.data !== undefined && (list.data.all ? !everything : tools.some((tool) => tool.on !== picked.has(tool.name)) || everything);
  const toggle = (name: string, on: boolean) =>
    setPicked((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono uppercase tracking-wider text-[11px] font-bold text-base-content/65">Tools</span>
        <button
          type="button"
          className="btn btn-xs rounded-lg btn-ghost border border-base-content/15 gap-1"
          aria-expanded={open}
          disabled={!server.connected}
          title={server.connected ? "Choose which of its tools this agent gets" : "Its tools are listed once it is connected"}
          onClick={() => setOpen(!open)}
        >
          {summary(server)}
          {open ? <ChevronUp size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
        </button>
        {server.chosenTools && server.withheldBytes ? (
          <span className="text-base-content/65">{formatBytes(server.withheldBytes)} per request left out</span>
        ) : null}
        {server.unknownTools?.length ? (
          <span className="text-warning">Not offered by the connector: {server.unknownTools.join(", ")}</span>
        ) : null}
      </div>

      {open ? (
        <div className="rounded-xl border border-base-content/[0.08] p-3 space-y-2">
          {list.isPending ? (
            <div className="flex justify-center py-4">
              <Spinner className="text-primary" />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button type="button" className="btn btn-xs btn-ghost rounded-lg" disabled={!admin} onClick={() => setPicked(new Set(tools.map((tool) => tool.name)))}>
                  Select all
                </button>
                <button type="button" className="btn btn-xs btn-ghost rounded-lg" disabled={!admin} onClick={() => setPicked(new Set())}>
                  Select none
                </button>
                <span className="grow text-base-content/65 text-right">
                  {picked?.size ?? 0} of {tools.length} · {formatBytes(bytes.sent)} per request
                  {bytes.left > 0 ? ` · ${formatBytes(bytes.left)} left out` : ""}
                </span>
              </div>
              <ScrollArea maxHeight="max-h-80">
                <ul className="divide-y divide-base-content/[0.06]">
                  {tools.map((tool) => (
                    <li key={tool.name}>
                      <label className="flex items-start gap-2 py-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-sm mt-0.5"
                          checked={picked?.has(tool.name) ?? false}
                          disabled={!admin}
                          onChange={(event) => toggle(tool.name, event.target.checked)}
                        />
                        <span className="min-w-0 grow">
                          <span className="block font-mono text-xs">{tool.name}</span>
                          {tool.description ? <span className="block truncate text-xs text-base-content/65">{tool.description}</span> : null}
                        </span>
                        {tool.bytes !== undefined ? <span className="shrink-0 font-mono text-[11px] text-base-content/65">{formatBytes(tool.bytes)}</span> : null}
                      </label>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
              {admin ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-primary btn-xs rounded-lg"
                    disabled={!changed || save.isPending || picked?.size === 0}
                    // Every tool chosen is "all": a tool the server adds later comes to the agent too.
                    onClick={() => save.mutate(everything ? null : tools.filter((tool) => picked?.has(tool.name)).map((tool) => tool.name))}
                  >
                    Save
                  </button>
                  {save.isPending ? <Spinner className="text-primary" /> : null}
                  {picked?.size === 0 ? <span className="text-xs text-base-content/65">Keep one at least, or switch the connector off.</span> : null}
                </div>
              ) : null}
            </>
          )}
          <ErrorNote error={list.error ?? save.error} />
        </div>
      ) : null}
    </div>
  );
}

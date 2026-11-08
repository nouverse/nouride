/**
 * Each agent's own notes — `MEMORY.md` in its persona: how it works, its conventions, what it is in
 * the middle of. Written by the agent itself; the nightly pass never touches it.
 *
 * Editable here, by an operator, through the same route as the Files tab on an agent's page: the lock
 * the agent's own `memory_write` takes, the version before kept as a backup, a reload, an audit row.
 * The save names the text it started from, so a note the agent kept while this was open is not lost
 * to it.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { NotebookText } from "lucide-react";
import { api } from "@/commons/lib/api";
import { NotesModal } from "@/commons/components/ui/NotesModal";
import { EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { ScrollCard } from "@/commons/components/ui/ScrollCard";
import { OrchestratorBadge, useOrchestrator, useOrchestratorFirst } from "@/commons/components/agents/AgentName";
import { Leaving } from "@/commons/components/ui/OverPage";

function NoteView({ id, editable, onClose }: { id: string; editable: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const note = useQuery({ queryKey: ["memory-agent-note", id], queryFn: () => api.agentNote(id) });
  const name = note.data?.name ?? id;
  return (
    <NotesModal
      title={`${name}'s notes`}
      description={`What ${name} keeps for itself: how it works, its habits, what it is in the middle of. It reads these every time it answers. What it learns about a person belongs in that person's profile, not here.`}
      content={note.data?.content}
      error={note.error}
      editable={editable}
      placeholder={"## Conventions\n- …"}
      onSave={async (text, opened) => {
        await api.writeFile(id, "MEMORY.md", text, opened);
        // The Files tab on the agent's page reads the same file.
        for (const key of [["memory-agent-note", id], ["memory-agent-notes"], ["files", id], ["file", id, "MEMORY.md"]]) {
          await queryClient.invalidateQueries({ queryKey: key });
        }
      }}
      onReload={() => void note.refetch()}
      onClose={onClose}
    />
  );
}

export function NotesTab({ editable }: { editable: boolean }) {
  const notes = useQuery({ queryKey: ["memory-agent-notes"], queryFn: api.agentNotes });
  const [open, setOpen] = useState<string | null>(null);
  const orchestrator = useOrchestrator();
  const list = useOrchestratorFirst(notes.data?.agents ?? [], (agent) => agent.id);
  return (
    <div className="space-y-4">
      {notes.error ? <ErrorNote error={notes.error} /> : null}
      <ScrollCard title="Agent notes" description="What each agent keeps for itself. Part of who it is, and never changed by the nightly pass.">
        {list.length === 0 && !notes.isLoading ? (
          <EmptyState icon={NotebookText} title="No agents" description="Each agent's notes show up here." />
        ) : (
          <ul className="divide-base-content/[0.06] divide-y">
            {list.map((agent) => (
              <li key={agent.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {agent.name}
                    {agent.id === orchestrator ? <OrchestratorBadge /> : null}
                  </p>
                  <p className="text-base-content/65 text-xs">{agent.updatedAt ? `${(agent.bytes / 1024).toFixed(1)} KB · updated ${new Date(agent.updatedAt).toLocaleString()}` : "No notes yet"}</p>
                </div>
                {agent.updatedAt || editable ? (
                  <button type="button" className="btn btn-ghost btn-xs gap-1 rounded-lg" onClick={() => setOpen(agent.id)}>
                    <NotebookText size={12} /> {agent.updatedAt ? "Notes" : "Add notes"}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </ScrollCard>
      <Leaving value={open}>{(id) => <NoteView id={id} editable={editable} onClose={() => setOpen(null)} />}</Leaving>
    </div>
  );
}

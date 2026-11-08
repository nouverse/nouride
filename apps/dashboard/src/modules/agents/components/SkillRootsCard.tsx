/**
 * The project folders an agent takes skills from (0.8.24), each with the skills it brings, added and removed here by an
 * admin. Before, the list was a line of the agent's settings file, changed by hand on its Files tab or on the server.
 * The server checks a folder before it saves it and saves it as the Files tab does, the agent reloaded at once.
 *
 * Said before a folder is added: a project's skills are instructions the agent follows, so a folder is a trust decision,
 * not a place to read from.
 */

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, Plus, Trash2, TriangleAlert } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { SkillRoot } from "@nouride/wire";
import { Card, ErrorNote } from "@/commons/components/ui/ui";
import { Details } from "@/commons/components/ui/Details";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useSaved } from "@/commons/hooks/use-saved";

export function SkillRootsCard({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const roots = useQuery({ queryKey: ["skill-roots", agentId], queryFn: () => api.skillRoots(agentId), retry: false });
  const [path, setPath] = useState("");
  const saved = useSaved();
  const { ask, dialog } = useConfirm();

  // The skills list above carries what the folders bring, so both are read again.
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["skill-roots", agentId] });
    await queryClient.invalidateQueries({ queryKey: ["agent-skills", agentId] });
  };
  const add = useMutation({
    mutationFn: (folder: string) => api.addSkillRoot(agentId, folder),
    onSuccess: async (answer) => {
      saved(answer, `${agentId} takes skills from ${answer.path}`, answer.skills.length > 0 ? `It brings ${answer.skills.join(", ")}` : "It brings none yet");
      setPath("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (folder: string) => api.removeSkillRoot(agentId, folder),
    onSuccess: async (answer) => {
      saved(answer, `${agentId} no longer takes skills from ${answer.path}`);
      await refresh();
    },
  });

  const editable = roots.data?.editable === true;
  const list = roots.data?.roots ?? [];

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (path.trim()) add.mutate(path.trim());
  }

  async function removeRoot(root: SkillRoot): Promise<void> {
    const yes = await ask({
      title: "Stop taking skills from this folder?",
      body: `${agentId} stops reading the skills in ${root.path} from its next message. The folder itself is not touched.`,
      confirmLabel: "Remove",
    });
    if (yes) remove.mutate(root.path);
  }

  return (
    <Card
      title="Project folders"
      description="Folders whose skills this agent takes as its own. Add only a project you trust: its skills become instructions the agent follows."
    >
      <div className="space-y-4">
        <ErrorNote error={roots.error ?? add.error ?? remove.error} />
        {roots.isPending ? null : list.length === 0 ? (
          <p className="text-sm text-base-content/65">No project folders yet.</p>
        ) : (
          <ul className="divide-base-content/10 divide-y" aria-label="Project folders">
            {list.map((root) => (
              <li key={root.path} className="flex items-start gap-3 py-3">
                <FolderGit2 size={16} className="mt-0.5 shrink-0 opacity-50" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm [overflow-wrap:anywhere]">{root.path}</span>
                    {!root.readable ? (
                      <span className="badge badge-warning badge-sm shrink-0 gap-1 font-mono" title="The server cannot open this folder now, so none of its skills reach the agent.">
                        <TriangleAlert size={11} />
                        cannot be opened
                      </span>
                    ) : null}
                  </div>
                  {root.skills.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {root.skills.map((skill) => (
                        <span key={skill.name} className="badge badge-ghost badge-sm font-mono" title={skill.description || undefined}>
                          {skill.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-base-content/65">No skills there yet.</p>
                  )}
                </div>
                {editable ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs shrink-0 rounded-lg text-error hover:bg-error/10"
                    disabled={remove.isPending}
                    onClick={() => void removeRoot(root)}
                    aria-label={`Remove ${root.path}`}
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {editable ? (
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={submit}>
            <input
              type="text"
              className="input input-sm w-full rounded-xl font-mono"
              placeholder="/home/you/projects/app"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              aria-label="Project folder to add"
            />
            <button type="submit" className="btn btn-primary btn-sm shrink-0 gap-1.5 rounded-xl" disabled={add.isPending || !path.trim()}>
              <Plus size={14} /> Add folder
            </button>
          </form>
        ) : roots.data ? (
          <p className="text-xs text-base-content/65">Only an admin can change these.</p>
        ) : null}

        <Details>
          <p>
            A project keeps its skills in <code>.agents/skills</code>, a folder for each with its <code>SKILL.md</code>. Give the
            project&apos;s own folder on this server, the one that holds <code>.agents</code>. A skill added there later reaches the
            agent from its next message, with nothing to save here.
          </p>
        </Details>
      </div>
      {dialog}
    </Card>
  );
}

/**
 * Editing the files that decide who an agent is. Only this agent's — nothing daemon-wide.
 *
 * The daemon's own `config.toml` used to hang off the bottom of this list, and being here is what
 * made it look like one of Nouva's files rather than the file every agent runs under. It now lives
 * on the daemon-wide settings page, in `DaemonConfigEditor`, next to the forms that write into it.
 *
 * The read error is rendered rather than only the write error, which is a habit this component
 * earned: the daemon config was resolving to a path that did not exist, the read answered `""`, and
 * this drew a blank textarea with a working Save button. A wrong answer and an empty file looked
 * identical for as long as the feature existed.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FileCode, FileText, Save } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, EmptyState, ErrorNote } from "@/commons/components/ui/ui";
import { EditPreviewSwitch, MarkdownArea, type MarkdownMode } from "@/commons/components/ui/MarkdownEditor";
import { TextLoading } from "@/commons/components/ui/Skeleton";

export function FileEditor({ agent, editable }: { agent: string; editable: boolean }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // A file opens as it reads, Preview first: it is read far more often than written, and Edit is
  // one click away. Each file opened starts there again.
  const [mode, setMode] = useState<MarkdownMode>("preview");

  const files = useQuery({ queryKey: ["files", agent], queryFn: () => api.agentFiles(agent) });

  useEffect(() => setSelected(null), [agent]);

  const content = useQuery({
    queryKey: ["file", agent, selected],
    queryFn: () => api.readFile(agent, selected as string),
    enabled: Boolean(selected),
  });

  useEffect(() => {
    if (content.data) setDraft(content.data.content);
  }, [content.data]);

  const save = useMutation({
    // What was opened goes with it: the agent writes its own MEMORY.md, and a tab left open would otherwise put
    // back what it had before — refused with a 409 instead.
    mutationFn: ({ name, text }: { name: string; text: string }) => api.writeFile(agent, name, text, content.data?.content),
    onSuccess: async (_, { name, text }) => {
      // What was saved is what the file now holds. Left at what was opened, the editor stayed dirty after a save and
      // the next one went out with a stale base and met the 409 above. By the name the save was for, not the one
      // selected when it lands.
      queryClient.setQueryData(["file", agent, name], { content: text });
      await queryClient.invalidateQueries({ queryKey: ["files", agent] });
      await queryClient.invalidateQueries({ queryKey: ["status"] });
    },
  });

  const dirty = content.data ? draft !== content.data.content : false;
  const markdown = Boolean(selected) && selected?.endsWith(".md");

  return (
    <Card
      title="Files"
      description="The files that make this agent: who it is, how it works, and its own settings."
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_1fr]">
        {/* Left File Navigator */}
        <nav className="space-y-1 bg-base-200/40 p-2 rounded-2xl border border-base-content/[0.06] h-fit">
          <p className="text-[10px] font-bold uppercase tracking-wider text-base-content/65 px-2 py-1 font-mono">
            Files ({files.data?.files?.length ?? 0})
          </p>

          {(files.data?.files ?? []).map((file) => (
            <button
              key={file.name}
              type="button"
              onClick={() => {
                setSelected(file.name);
                setMode("preview");
              }}
              className={`flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-xs font-semibold transition-all active:scale-95 ${
                selected === file.name
                  ? "bg-primary text-primary-content shadow-xs"
                  : "hover:bg-base-200 text-base-content/75 hover:text-base-content"
              }`}
            >
              {file.name.endsWith(".md") ? (
                <FileText size={14} className="shrink-0 opacity-80" />
              ) : (
                <FileCode size={14} className="shrink-0 opacity-80" />
              )}
              <span className="truncate">{file.name}</span>
            </button>
          ))}
        </nav>

        {/* Right Editor / Preview Viewport */}
        <div className="min-w-0 space-y-3">
          {!selected ? (
            <EmptyState icon={FileText} title="Choose a file to edit or inspect" description="Select any file from the navigator on the left." />
          ) : content.isPending ? (
            <TextLoading lines={12} className="py-3" />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 bg-base-200/50 p-2.5 rounded-xl border border-base-content/[0.06]">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-mono text-xs font-bold text-base-content px-2 py-1 rounded-md bg-base-100 border border-base-content/10">
                    {selected}
                  </span>
                  {dirty && <span className="badge badge-warning badge-sm font-semibold font-mono">Unsaved changes</span>}
                </div>

                <div className="flex items-center gap-2">
                  {markdown && <EditPreviewSwitch mode={mode} onChange={setMode} />}

                  <button
                    type="button"
                    className="btn btn-primary btn-sm rounded-xl gap-1.5 shadow-xs active:scale-95 transition-all"
                    disabled={!editable || !dirty || save.isPending}
                    onClick={() => save.mutate({ name: selected, text: draft })}
                  >
                    {save.isPending ? (
                      <span className="loading loading-spinner loading-xs" />
                    ) : (
                      <Save size={14} />
                    )}
                    Save File
                  </button>
                </div>
              </div>

              {/* Edit and Preview one height, each scrolling inside it, as Write a document's are: the preview grew with
                  the file and moved the page under the switch. */}
              <MarkdownArea
                mode={markdown ? mode : "edit"}
                className="h-[26rem] overflow-auto"
                value={draft}
                // Held while a save is on its way: the saved text becomes the draft when it lands.
                readOnly={!editable || save.isPending}
                onChange={setDraft}
              />

              {!editable && (
                <p className="text-base-content/65 text-xs italic">
                  Read-only session: you do not have permission to write changes to this file.
                </p>
              )}
              {/* The read, not just the write. A failed read used to draw an empty textarea. */}
              <ErrorNote error={content.error ?? save.error} />
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

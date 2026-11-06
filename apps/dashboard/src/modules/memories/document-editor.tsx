/**
 * One memory document — a person's profile, or the household's shared knowledge — open for reading
 * and editing, with its history beside it.
 *
 * Three things this has to get right, because the engine enforces them and a screen that pretended
 * otherwise would mislead:
 *
 * - **An edit names the text it started from.** The nightly pass files facts; a tab left open since
 *   the afternoon would otherwise overwrite them. The engine refuses (409) and this says so, with a
 *   reload, rather than retrying over the top.
 * - **Every change keeps the version before it.** So the history is a list to look at, and restoring
 *   an old version is putting its text back in the editor — reviewed, then saved like any edit —
 *   rather than a second, blind mechanism.
 *
 * There is no delete here: a profile goes with its person (Forget, on the People tab), and shared
 * knowledge is emptied by editing it.
 *
 * And one it got wrong once: a new document opened on Read, showing "Empty", and closing it dropped
 * whatever was typed without a word. A document that does not exist yet opens on Edit with its
 * frontmatter and a first topic filled in, and closing with unsaved text asks.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Eye, History, Pencil, RotateCcw, Save, X } from "lucide-react";
import { api } from "@/commons/lib/api";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";
import { ErrorNote } from "@/commons/components/ui/ui";
import { Markdown } from "@/commons/components/ui/Markdown";
import { overPage } from "@/commons/components/ui/OverPage";

/** `2026-09-25T14-05-00-123Z` → a date a person reads. */
function versionDate(version: string): string {
  const iso = version.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1T$2:$3:$4.$5Z");
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? version : date.toLocaleString();
}

/** What a new document starts as: frontmatter the graph reads, and a first topic to write under. */
function starter(subject: string, title: string): string {
  const front = subject === "shared" ? "---\ntype: shared\n---" : `---\ntype: person\nname: ${JSON.stringify(title)}\n---`;
  return `${front}\n\n## Notes\n- `;
}

export function DocumentEditor({
  subject,
  title,
  editable,
  onClose,
}: {
  /** A person key, or `shared`. */
  subject: string;
  title: string;
  editable: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [viewing, setViewing] = useState<string | null>(null);

  const doc = useQuery({ queryKey: ["memory-document", subject], queryFn: () => api.memoryDocument(subject) });

  const version = useQuery({
    queryKey: ["memory-document-version", subject, viewing],
    queryFn: () => api.memoryDocumentVersion(subject, viewing as string),
    enabled: Boolean(viewing),
  });

  useEffect(() => setDraft(null), [doc.data?.content]);

  // A document that does not exist yet starts on Edit, with its frontmatter and a first topic. After
  // the reset above, so the reset does not undo it.
  const fresh = doc.data !== undefined && !doc.data.exists;
  useEffect(() => {
    if (!fresh || !editable) return;
    setMode("edit");
    setDraft((before) => before ?? starter(subject, title));
  }, [fresh, editable, subject, title]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["memory-document", subject] });
    await queryClient.invalidateQueries({ queryKey: ["memory-people"] });
  };

  const opened = doc.data?.content ?? "";
  const text = draft ?? opened;
  const dirty = draft !== null && draft !== opened;

  const save = useMutation({
    mutationFn: () => api.writeMemoryDocument(subject, text, opened),
    onSuccess: async (result) => {
      toast.success(result.status === "written" ? "Saved" : "Nothing changed");
      await refresh();
    },
  });
  const undo = useMutation({
    mutationFn: () => api.undoMemoryDocument(subject),
    onSuccess: async (result) => {
      if (result.restored) toast.success("Stepped back one version");
      else toast.info("Nothing to undo");
      await refresh();
    },
  });
  const close = async () => {
    if (dirty && !(await confirm.ask({ title: "Discard your changes?", body: "What you typed has not been saved.", confirmLabel: "Discard" }))) return;
    onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        if (dirty && !save.isPending) save.mutate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save]);

  return overPage(
    <div className="modal modal-open" role="dialog" aria-label={title}>
      <div className="modal-box max-w-5xl rounded-2xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{title}</h3>
            <p className="text-base-content/65 truncate font-mono text-xs">{doc.data?.path ?? ""}</p>
          </div>
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" aria-label="Close" onClick={() => void close()}>
            <X size={16} />
          </button>
        </div>

        {doc.error ? <ErrorNote error={doc.error} /> : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_220px]">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div role="tablist" className="tabs tabs-box tabs-sm w-fit">
                <button type="button" role="tab" className={`tab gap-1 ${mode === "preview" ? "tab-active" : ""}`} onClick={() => setMode("preview")}>
                  <Eye size={14} /> Read
                </button>
                {editable ? (
                  <button type="button" role="tab" className={`tab gap-1 ${mode === "edit" ? "tab-active" : ""}`} onClick={() => setMode("edit")}>
                    <Pencil size={14} /> Edit
                  </button>
                ) : null}
              </div>
              <div className="grow" />
              {editable && dirty ? (
                <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={() => setDraft(null)}>
                  Discard
                </button>
              ) : null}
              {editable ? (
                <button type="button" className="btn btn-primary btn-sm gap-1 rounded-xl" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                  <Save size={14} /> {save.isPending ? "Saving…" : "Save"}
                </button>
              ) : null}
            </div>

            {mode === "edit" && editable ? (
              <textarea
                className="textarea h-[50vh] w-full rounded-xl font-mono text-sm"
                value={text}
                spellCheck={false}
                aria-label="Document text"
                placeholder="- One fact per line."
                onChange={(event) => setDraft(event.target.value)}
              />
            ) : (
              <div className="bg-base-200/40 max-h-[50vh] min-h-32 overflow-auto rounded-xl p-4 text-sm">
                {text.trim() ? <Markdown source={text} /> : <p className="text-base-content/65">Empty.</p>}
              </div>
            )}

            {save.error ? (
              <div className="space-y-2">
                <ErrorNote error={save.error} />
                <button type="button" className="btn btn-ghost btn-xs rounded-lg" onClick={() => void refresh()}>
                  Reload the current text
                </button>
              </div>
            ) : null}
          </div>

          <aside className="bg-base-200/40 h-fit space-y-2 rounded-2xl border border-base-content/[0.06] p-3">
            <p className="text-base-content/65 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider font-mono">
              <History size={12} /> History
            </p>
            {(doc.data?.versions.length ?? 0) === 0 ? (
              <p className="text-base-content/65 text-xs">No earlier versions.</p>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-auto">
                {doc.data?.versions.map((v) => (
                  <li key={v}>
                    <button
                      type="button"
                      className={`btn btn-ghost btn-xs w-full justify-start rounded-lg font-normal ${viewing === v ? "btn-active" : ""}`}
                      onClick={() => setViewing(viewing === v ? null : v)}
                    >
                      {versionDate(v)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {editable && (doc.data?.versions.length ?? 0) > 0 ? (
              <div className="flex flex-col gap-1 pt-1">
                <button type="button" className="btn btn-ghost btn-xs justify-start gap-1 rounded-lg" disabled={undo.isPending} onClick={() => undo.mutate()}>
                  <RotateCcw size={12} /> Undo last change
                </button>
              </div>
            ) : null}
          </aside>
        </div>

        {viewing ? (
          <div className="mt-4 space-y-2 rounded-2xl border border-base-content/[0.08] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">As it was on {versionDate(viewing)}</p>
              {editable && version.data ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs rounded-lg"
                  onClick={() => {
                    setDraft(version.data.content);
                    setMode("edit");
                    setViewing(null);
                  }}
                >
                  Put this back in the editor
                </button>
              ) : null}
            </div>
            {version.error ? <ErrorNote error={version.error} /> : null}
            <pre className="bg-base-200/60 max-h-48 overflow-auto rounded-xl p-3 text-xs whitespace-pre-wrap">{version.data?.content ?? "…"}</pre>
          </div>
        ) : null}
        {confirm.dialog}
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={() => void close()} />
    </div>
  );
}

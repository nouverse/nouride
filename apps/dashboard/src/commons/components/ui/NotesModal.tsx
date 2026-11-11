/**
 * Markdown notes in a dialog, to read and to edit — the one dialog for notes anywhere in the dashboard:
 * a person's notes, on People and in Memory, and each agent's own MEMORY.md.
 *
 * It was three surfaces that disagreed: a read-only view in Memory, a textarea inside the People form,
 * and a table cell that printed a page of markdown into a row. One component, so Edit, Preview, Save
 * and "discard your changes?" behave the same wherever notes are.
 *
 * Two things it has to get right:
 *
 * - **An edit names the text it started from.** `onSave` is handed it and the caller sends it on, so
 *   notes changed meanwhile — an agent writes its own MEMORY.md — are refused (409) rather than
 *   overwritten. Nothing typed is ever replaced by a refetch either; the saved text is taken in only
 *   while there is nothing unsaved, and otherwise when the operator asks for it.
 * - **Closing with unsaved text asks**, from the X, the backdrop and Escape alike.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Eye, Pencil, Save, X } from "lucide-react";
import { useConfirm } from "./confirm";
import { useToast } from "./toast";
import { ErrorNote } from "./ui";
import { Markdown } from "./Markdown";
import { overPage } from "./OverPage";
import { TextLoading } from "@/commons/components/ui/Skeleton";

export function NotesModal({
  title,
  description,
  content,
  error,
  editable,
  placeholder,
  onSave,
  onReload,
  onClose,
}: {
  title: string;
  /** What these notes are, and who reads them. */
  description?: ReactNode;
  /** The saved text; `undefined` while it loads. */
  content: string | undefined;
  /** Why it could not be loaded. */
  error?: unknown;
  editable: boolean;
  placeholder?: string;
  /**
   * Write `text`. `opened` is what the edit started from, for the caller to send as a precondition.
   * Resolves to the text as it was stored when the store changes it — People trims notes — so the
   * next save names what is really there.
   */
  onSave: (text: string, opened: string) => Promise<string | void>;
  /** Fetch the saved text again — offered when a save is refused because it changed meanwhile. */
  onReload?: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [opened, setOpened] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  /** While "discard?" is open, Escape belongs to it. */
  const asking = useRef(false);

  const text = draft ?? opened ?? "";
  const dirty = draft !== null && draft !== opened;

  useEffect(() => {
    if (content === undefined || dirty) return;
    // Nothing written yet opens on Edit: there is nothing to preview, and the point is to write.
    if (opened === null && editable && !content.trim()) setMode("edit");
    setOpened(content);
    setDraft(null);
    // Only the saved text arriving decides this; `dirty` and `opened` are read as they are then.
  }, [content]);

  const save = async () => {
    if (!dirty || saving || opened === null) return;
    setSaving(true);
    setFailure(null);
    try {
      const stored = await onSave(text, opened);
      setOpened(typeof stored === "string" ? stored : text);
      setDraft(null);
      toast.success("Saved");
    } catch (err) {
      setFailure(err);
    } finally {
      setSaving(false);
    }
  };

  const reload = () => {
    setDraft(null);
    setFailure(null);
    if (content !== undefined) setOpened(content);
    onReload?.();
  };

  const close = async () => {
    if (asking.current) return;
    if (dirty) {
      asking.current = true;
      const discard = await confirm.ask({ title: "Discard your changes?", body: "What you typed has not been saved.", confirmLabel: "Discard" });
      asking.current = false;
      if (!discard) return;
    }
    onClose();
  };

  // Read through a ref, so the listener is added once and still calls today's `save` and `close`.
  const keys = useRef({ save, close });
  keys.current = { save, close };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void keys.current.save();
      } else if (event.key === "Escape" && !asking.current) {
        // Taken, or the browser treats this same key press as a close request for the "discard?"
        // question it is about to open, and answers it before anyone has read it.
        event.preventDefault();
        void keys.current.close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return overPage(
    <div className="modal modal-open" role="dialog" aria-label={title}>
      <div className="modal-box flex max-h-[90dvh] max-w-3xl flex-col gap-3 rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-0.5">
            <h3 className="truncate font-semibold">{title}</h3>
            {description ? <p className="text-base-content/65 text-xs">{description}</p> : null}
          </div>
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" aria-label="Close" onClick={() => void close()}>
            <X size={16} />
          </button>
        </div>

        <ErrorNote error={error} />

        {editable ? (
          <div role="tablist" className="tabs tabs-box tabs-sm w-fit">
            <button type="button" role="tab" aria-selected={mode === "edit"} className={`tab gap-1 ${mode === "edit" ? "tab-active" : ""}`} onClick={() => setMode("edit")}>
              <Pencil size={14} /> Edit
            </button>
            <button type="button" role="tab" aria-selected={mode === "preview"} className={`tab gap-1 ${mode === "preview" ? "tab-active" : ""}`} onClick={() => setMode("preview")}>
              <Eye size={14} /> Preview
            </button>
          </div>
        ) : null}

        {content === undefined ? (
          error ? null : (
            <TextLoading lines={10} className="py-3" />
          )
        ) : mode === "edit" && editable ? (
          <textarea
            className="textarea h-[55dvh] w-full rounded-xl font-mono text-sm"
            value={text}
            spellCheck={false}
            aria-label="Notes"
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <div className="bg-base-200/40 max-h-[55dvh] min-h-40 overflow-auto overscroll-contain rounded-xl p-4 text-sm">
            {text.trim() ? <Markdown source={text} /> : <p className="text-base-content/65">Nothing written yet.</p>}
          </div>
        )}

        {failure ? (
          <div className="space-y-2">
            <ErrorNote error={failure} />
            {onReload ? (
              <button type="button" className="btn btn-ghost btn-xs rounded-lg" onClick={reload}>
                Reload the saved text (drops what you typed)
              </button>
            ) : null}
          </div>
        ) : null}

        {editable ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base-content/65 text-xs">{dirty ? "Unsaved changes" : "Markdown"}</span>
            <div className="grow" />
            {dirty ? (
              <button type="button" className="btn btn-ghost btn-sm rounded-xl" disabled={saving} onClick={() => setDraft(null)}>
                Discard
              </button>
            ) : null}
            <button type="button" className="btn btn-primary btn-sm gap-1 rounded-xl" disabled={!dirty || saving} onClick={() => void save()}>
              <Save size={14} /> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : null}
        {confirm.dialog}
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={() => void close()} />
    </div>
  );
}

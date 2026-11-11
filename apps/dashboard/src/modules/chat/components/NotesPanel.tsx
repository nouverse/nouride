/**
 * The agent's work notes for this conversation, in a drawer on the right (`Drawer`) — History's twin on the other side.
 *
 * The agent reads these at every step, so a wrong fact in them is repeated until somebody takes it out: the panel shows
 * each task with the plan kept under it, and an operator can correct the whole file in place. Read again when a turn
 * ends (`use-notes.ts`) — never while somebody is typing over it: an edit is a draft of its own, and the saved text
 * arriving underneath it only earns a line saying so.
 *
 * Kept mounted while closed, like the history drawer, so closing it mid-edit loses nothing; the page keys it by
 * conversation, so another conversation starts clean.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, Pencil, Save } from "lucide-react";
import { api } from "@/commons/lib/api";
import type { WorkNotes } from "@nouride/wire";
import { ago } from "@/commons/lib/format";
import { Drawer, DrawerHead } from "@/commons/components/ui/Drawer";
import { Markdown } from "@/commons/components/ui/Markdown";
import { Spinner } from "@/commons/components/ui/Spinner";
import { useToast } from "@/commons/components/ui/toast";
import { ErrorNote } from "@/commons/components/ui/ui";
import { notesKey } from "@/commons/hooks/use-notes";
import { withPlans } from "@/commons/lib/notes";
import { PlanSteps } from "@/commons/components/chat/PlanSteps";

export function NotesPanel({
  open,
  sessionId,
  notes,
  error,
  editable,
  onClose,
}: {
  open: boolean;
  sessionId: string;
  notes: WorkNotes;
  /** A read again that failed — the notes last read stay on screen under it. */
  error: unknown;
  /** Operators and up: the route refuses an edit from anyone else. */
  editable: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  /** The text being edited; null while reading. */
  const [draft, setDraft] = useState<string | null>(null);
  /** The saved text the edit started from — to say when the agent wrote over it meanwhile. */
  const [opened, setOpened] = useState("");

  const save = useMutation({
    mutationFn: (text: string) => api.saveNotes(sessionId, text),
    onSuccess: (saved) => {
      queryClient.setQueryData<WorkNotes>(notesKey(sessionId), (before) => (before ? { ...before, ...saved } : before));
      // The plan goes with a task an edit took out, and only the daemon knows that: read the rest of it again.
      void queryClient.invalidateQueries({ queryKey: notesKey(sessionId) });
      setDraft(null);
      toast.success("Saved");
    },
  });

  const editing = draft !== null;
  const dirty = editing && draft !== opened;
  const startEdit = () => {
    save.reset();
    setOpened(notes.text);
    setDraft(notes.text);
  };
  const cancel = () => {
    save.reset();
    setDraft(null);
  };
  const submit = () => {
    if (draft !== null && dirty && !save.isPending) save.mutate(draft);
  };

  const count = notes.tasks.length;
  return (
    <Drawer open={open} onClose={onClose} side="right" label="Work notes">
      <div className="shrink-0 border-b border-base-content/[0.08] pb-2">
        <DrawerHead
          title={
            <>
              Work notes
              {count > 0 && <span className="ml-1.5 text-base text-base-content/65">{count}</span>}
            </>
          }
          closeLabel="Close work notes"
          onClose={onClose}
        >
          {editable && !editing ? (
            <button type="button" className="btn btn-ghost btn-sm h-9 rounded-[12px] gap-1 text-base-content/70 hover:text-base-content max-sm:h-11" onClick={startEdit}>
              <Pencil size={14} aria-hidden="true" /> Edit
            </button>
          ) : null}
        </DrawerHead>
        <p className="px-4 text-xs text-base-content/65">The agent reads these at every step of this conversation.</p>
      </div>

      {editing ? (
        <div className="flex-1 min-h-0 flex flex-col gap-2 p-3">
          {notes.text !== opened ? (
            <p role="status" className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-base-content">
              The agent wrote to these since you started. Saving replaces what it wrote.
            </p>
          ) : null}
          <textarea
            className="textarea flex-1 min-h-48 w-full rounded-xl font-mono text-xs leading-relaxed"
            value={draft}
            spellCheck={false}
            aria-label="Work notes as markdown, a ## heading per task"
            placeholder={"## What the work is\n\nThe goal, what is done, what is next."}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                submit();
              }
            }}
          />
          {/* The daemon's own sentence — over the size the notes hold, or a credential's value in them. */}
          <ErrorNote error={save.error} />
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-base-content/65">{dirty ? "Unsaved changes" : "Markdown, a ## heading per task"}</span>
            <div className="grow" />
            <button type="button" className="btn btn-ghost btn-sm rounded-xl" disabled={save.isPending} onClick={cancel}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm gap-1 rounded-xl" disabled={!dirty || save.isPending} onClick={submit}>
              {save.isPending ? <Spinner /> : <Save size={14} aria-hidden="true" />} Save
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 space-y-3">
          <ErrorNote error={error} />
          {notes.setAside && notes.setAside.titles.length > 0 ? (
            <p className="flex items-start gap-2 rounded-xl border border-base-content/[0.06] bg-base-200/50 px-3 py-2 text-xs text-base-content/75">
              <Archive size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                Set aside {ago(notes.setAside.at)}, untouched for two weeks: {notes.setAside.titles.join(", ")}.
              </span>
            </p>
          ) : null}
          {count === 0 && !notes.plan ? (
            <p className="px-1 py-6 text-center text-sm text-base-content/65">The agent writes notes here as it works on long tasks.</p>
          ) : (
            withPlans(notes.tasks, notes.plan).map(({ task, plan }, index) => (
              <section key={`${index}:${task.title}`} aria-label={task.title} className="rounded-xl border border-base-content/[0.06] bg-base-200/40 p-3 space-y-2">
                <h3 className="text-sm font-semibold text-base-content [overflow-wrap:anywhere]">{task.title}</h3>
                {task.body ? (
                  // A task's own headings — Goal, Done, Next — read as labels under its title, not as titles of their own.
                  <div className="text-[13px] leading-relaxed text-base-content/85 min-w-0 [overflow-wrap:anywhere] space-y-1.5 [&_:is(h1,h2,h3,h4,h5,h6)]:pt-1 [&_:is(h1,h2,h3,h4,h5,h6)]:font-mono [&_:is(h1,h2,h3,h4,h5,h6)]:text-[11px] [&_:is(h1,h2,h3,h4,h5,h6)]:uppercase [&_:is(h1,h2,h3,h4,h5,h6)]:tracking-wider [&_:is(h1,h2,h3,h4,h5,h6)]:text-base-content/65">
                    <Markdown source={task.body} />
                  </div>
                ) : null}
                {plan ? <PlanSteps plan={plan} /> : null}
              </section>
            ))
          )}
        </div>
      )}
    </Drawer>
  );
}

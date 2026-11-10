/**
 * A skill's support files, in the row that is already open.
 *
 * Split from `pool.list.tsx` when that file crossed its 400-line cap, and the pair moves together
 * because it is one interaction: the list decides what may be opened and the body decides what may
 * be written, and both answers come from the same classification the daemon sends down.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api } from "@/commons/lib/api";
import { ErrorNote } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";
import { TextLoading } from "@/commons/components/ui/Skeleton";

/**
 * What a skill ships beside its body.
 *
 * A flat list rather than a tree, and only when there is something to list. Measured on the live
 * pool: 14 of 23 skills ship support files and 9 ship none, so a tree widget would put a disclosure
 * arrow in front of a single file for most of them — and paths are one directory deep by
 * construction, so a tree expresses nothing a list does not.
 *
 * `referenced` is the column that makes it worth having. **1.2MB of a 1.7MB pool** turned out to be
 * PNG screenshots in `x-twitter-poster/tools/` that nothing pointed at, left behind by an agent's
 * runs, with no surface anywhere that could show them and nothing that could delete them.
 *
 * Markdown gets an editor; a script gets a viewer. The boundary is provenance rather than danger — a
 * `SKILL.md` reading `curl … | sh` is exactly as dangerous, because the agent holds `exec` either
 * way. What is special about a script is that it was shipped *because it ran and worked*, and one
 * edited in a browser has by construction never run.
 */
export function SkillFiles({ name, editable }: { name: string; editable: boolean }) {
  const queryClient = useQueryClient();
  const listing = useQuery({ queryKey: ["skill-files", name], queryFn: () => api.skillFiles(name), retry: false });
  const [open, setOpen] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();

  const remove = useMutation({
    mutationFn: (path: string) => api.deleteSkillFile(name, path),
    onSuccess: async (result) => {
      setOpen(null);
      await queryClient.invalidateQueries({ queryKey: ["skill-files", name] });
      if (result.wasReferenced) {
        // Said afterwards rather than blocked beforehand: a pointer to a file that is gone is worse
        // than a file nothing points at, and the fix is to remove both — in either order.
        await ask({
          title: "Removed, and the body still points at it",
          body: `${result.path} is gone, but the skill's text still mentions it. Edit the text above to drop that line, or an agent will look for a file that is not there.`,
          confirmLabel: "Got it",
          danger: false,
        });
      }
    },
  });

  if (listing.isPending || !listing.data || listing.data.files.length === 0) return null;

  return (
    <div className="mt-3 ml-10 space-y-1">
      <p className="text-xs font-medium text-base-content/65">
        Ships {listing.data.files.length} file{listing.data.files.length === 1 ? "" : "s"}
      </p>
      <ErrorNote error={remove.error} />
      <ul className="divide-base-content/5 divide-y">
        {listing.data.files.map((file) => (
          <li key={file.path} className="py-1.5">
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                className="link link-hover font-mono"
                onClick={() => setOpen(open === file.path ? null : file.path)}
                disabled={file.kind === "binary"}
                title={file.kind === "binary" ? "Binary: listed and deleted, not read" : "Open"}
              >
                {file.path}
              </button>
              <span className="badge badge-ghost badge-xs font-mono">{file.kind}</span>
              <span className="text-base-content/65">{(file.bytes / 1024).toFixed(1)} KB</span>
              {file.referenced ? null : (
                <span className="badge badge-warning badge-xs font-mono" title="Nothing in the skill's text points at this">
                  unreferenced
                </span>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-xs text-error ml-auto"
                disabled={!editable || remove.isPending}
                onClick={async () => {
                  const ok = await ask({
                    title: `Delete ${file.path}?`,
                    body: file.referenced
                      ? "The skill's text points at this file. Deleting it leaves the text pointing at nothing until you edit it too."
                      : "Nothing in the skill's text points at it.",
                    confirmLabel: "Delete",
                  });
                  if (ok) remove.mutate(file.path);
                }}
                aria-label={`Delete ${file.path}`}
              >
                <Trash2 size={12} />
              </button>
            </div>
            {open === file.path ? <SkillFileBody name={name} path={file.path} editable={editable && file.editable} /> : null}
          </li>
        ))}
      </ul>
      {dialog}
    </div>
  );
}

/** One support file, in a text box when it may be replaced and a `<pre>` when it may not. */
function SkillFileBody({ name, path, editable }: { name: string; path: string; editable: boolean }) {
  const queryClient = useQueryClient();
  const file = useQuery({ queryKey: ["skill-file", name, path], queryFn: () => api.skillFile(name, path), retry: false });
  const [text, setText] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (next: string) => api.saveSkillFile(name, path, next),
    onSuccess: async () => {
      setText(null);
      await queryClient.invalidateQueries({ queryKey: ["skill-file", name, path] });
      await queryClient.invalidateQueries({ queryKey: ["skill-files", name] });
    },
  });

  if (file.isPending) return <TextLoading lines={5} className="mt-2" />;
  if (file.error) return <div className="mt-1"><ErrorNote error={file.error} /></div>;

  const value = text ?? file.data?.source ?? "";
  if (!editable) {
    return (
      <>
        <pre className="bg-base-200/60 mt-1 max-h-72 overflow-auto rounded-lg p-2 text-xs whitespace-pre-wrap">
          {file.data?.source}
        </pre>
        <p className="mt-1 text-xs text-base-content/65">
          Shipped because it ran and worked. A version edited here has never run, so it can be read
          and deleted but not rewritten. Let an agent attach one it has executed.
        </p>
      </>
    );
  }
  return (
    <div className="mt-1 space-y-1">
      <ErrorNote error={save.error} />
      <textarea
        className="textarea bg-base-200/60 h-64 w-full font-mono text-xs"
        value={value}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        aria-label={path}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-primary btn-xs"
          disabled={text === null || save.isPending || !value.trim()}
          onClick={() => save.mutate(value)}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost btn-xs" disabled={text === null} onClick={() => setText(null)}>
          Revert
        </button>
      </div>
    </div>
  );
}


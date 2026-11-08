/**
 * The daemon's own `config.toml`, as text.
 *
 * It used to sit in the per-agent Files tab, under Nouva's IDENTITY.md and SOUL.md, which is where
 * the report landed: "agak aneh daemon config ditaruh di situ". It is not that agent's file — it is
 * the file every agent runs under, so editing it from one agent's page implied a scope it never had.
 * Here it is the last card on the daemon-wide settings page, which is exactly what it is.
 *
 * Last, and closed, because everything above it is the same settings with a form in front: a number
 * input cannot produce a config the daemon refuses to boot from, and this can. It is the escape
 * hatch for the settings that have no card yet, not the way to change the ones that do.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileCode, Save } from "lucide-react";
import { api } from "@/commons/lib/api";
import { canWrite, useMe } from "@/commons/lib/session";
import { ErrorNote } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";
import { useToast } from "@/commons/components/ui/toast";
import { RestartNeeded } from "@/commons/components/box/RestartNeeded";
import { Details } from "@/commons/components/ui/Details";
import { useSaved } from "@/commons/hooks/use-saved";
import { useRestartsFinished } from "@/commons/lib/restart";

export function DaemonConfigEditor() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  const announce = useSaved();
  const [waiting, setWaiting] = useState(false);
  const restarts = useRestartsFinished();
  useEffect(() => setWaiting(false), [restarts]);

  // Not fetched until it is opened: a 5 KB file nobody asked to see is a request on every visit to
  // this page, and the card above it is the one most people came for.
  const file = useQuery({ queryKey: ["config"], queryFn: api.readConfig, enabled: open });

  useEffect(() => {
    setDraft(null);
  }, [file.data]);

  const save = useMutation({
    // What was opened goes with it: a file changed since is refused, not overwritten.
    mutationFn: (content: string) => api.writeConfig(content, file.data?.content),
    onSuccess: (answer) => {
      void queryClient.invalidateQueries({ queryKey: ["config"] });
      // A whole file may move the data directory or a gateway's token, which the daemon reads at boot: it answers that a
      // restart is needed, and the Restart button is offered here and above the page until one happens.
      announce(answer, "The settings file");
      setWaiting(true);
    },
    // Not read again here: that would replace the draft with the file, and the error says to reload first —
    // the draft stays until then, to be copied.
    onError: (error: unknown) => toast.error("Could not save the settings file", error),
  });

  const saved = file.data?.content ?? "";
  const value = draft ?? saved;
  const dirty = file.isSuccess && value !== saved;
  /** Admin, not operator: `POST /config` refuses anything less, and a disabled button says why. */
  const writable = canWrite(me.data ?? null) && me.data?.role === "admin";
  const missing = file.isSuccess && saved === "";

  async function handleSave() {
    const confirmed = await ask({
      title: "Save the settings file?",
      body: (
        <>
          It is checked first, so a file Nouride could not start with is refused rather than saved,
          and one changed since you opened it is not overwritten. It takes effect after a restart.
          The five versions before it are kept.
        </>
      ),
      confirmLabel: "Save",
    });
    if (confirmed) save.mutate(value);
  }

  return (
    <div className="rounded-[22px] border border-base-content/[0.08] bg-base-100 p-5 shadow-soft space-y-4">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-4 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="min-w-0">
          <p className="font-bold text-sm tracking-tight text-base-content flex items-center gap-2">
            <FileCode size={15} className="text-warning" />
            Settings file
            <span className="badge badge-xs badge-ghost font-semibold font-mono">every agent</span>
          </p>
          <p className="text-base-content/65 text-sm mt-1 max-w-prose">
            For whoever runs the server: the file every setting on this page comes from, edited as
            text. Use it only for a setting that has no form here yet.
          </p>
        </div>
        <span className="btn btn-ghost btn-sm rounded-xl gap-1 shrink-0">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {open ? "Hide" : "Edit"}
        </span>
      </button>

      {open && (
        <div className="space-y-3">
          {file.isPending ? (
            <div className="flex justify-center py-10">
              <span className="loading loading-spinner loading-md text-primary opacity-60" />
            </div>
          ) : (
            <>
              <textarea
                className="textarea min-h-[24rem] w-full rounded-2xl bg-base-100/90 p-4 font-mono text-xs leading-relaxed focus:ring-2 focus:ring-primary/20"
                value={value}
                readOnly={!writable}
                spellCheck={false}
                aria-label="Settings file"
                onChange={(event) => setDraft(event.target.value)}
              />

              {missing && (
                <p className="text-warning/80 text-xs">
                  There is no settings file yet, so Nouride runs on its defaults. Saving makes one.
                </p>
              )}
              {!writable && (
                <p className="text-base-content/65 text-xs">
                  Admins only: this file decides who may reach Nouride and what every agent may run.
                </p>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn btn-primary btn-sm rounded-xl gap-1.5 shadow-xs active:scale-95 transition-all"
                  disabled={!writable || !dirty || save.isPending}
                  onClick={() => void handleSave()}
                >
                  {save.isPending ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    <Save size={14} />
                  )}
                  Save
                </button>
                {dirty && (
                  <span className="badge badge-warning badge-sm font-semibold font-mono">Unsaved changes</span>
                )}
              </div>
            </>
          )}

          {file.data?.path && (
            <Details>
              <p className="break-all font-mono">config.toml at {file.data.path}</p>
            </Details>
          )}

          {waiting && <RestartNeeded>the settings file is read when Nouride starts</RestartNeeded>}

          {/* The read as well as the write: a failed read used to draw an empty box. */}
          <ErrorNote error={file.error ?? save.error} />
        </div>
      )}
      {dialog}
    </div>
  );
}

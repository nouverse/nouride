/**
 * The backup password, on the page (0.8.19; 0.8.18 set it from the command line only). With one set, the weekly backups
 * include the secrets, locked with it, and it is the way back from a lost key or a moved server. In plain words: the
 * people who read this page are not technical (the owner, 2026-11-05).
 *
 * The password goes once to the daemon, which keeps only what can lock (`config/sealed-secrets.ts`): it is never
 * stored, never sent back, never shown again. Asked twice, at least twelve characters, and an admin's to set.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Archive, LockKeyhole } from "lucide-react";
import { api } from "@/commons/lib/api";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";

const LEAST = 12;

export function BackupPasswordCard({ sealed, admin, onTurnOff }: { sealed: boolean | undefined; admin: boolean; onTurnOff: () => Promise<boolean> }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState("");
  const [again, setAgain] = useState("");
  const [said, setSaid] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (password: string | null) => api.backupPassword(password),
    onSuccess: (result, password) => {
      setOpen(false);
      setFirst("");
      setAgain("");
      setSaid(
        password === null
          ? "Turned off. Backups from now on do not include your secrets; earlier ones keep theirs."
          : result.skipped
            ? "Backup password set. The backup drive is not connected right now, so the first backup with your secrets is taken once it is."
            : "Backup password set. A backup with your secrets in it was taken just now.",
      );
      void queryClient.invalidateQueries({ queryKey: ["secrets"] });
    },
  });

  // A daemon before 0.8.18 does not say: nothing to show.
  if (sealed === undefined) return null;
  const problem = first && first.length < LEAST ? `At least ${LEAST} characters.` : again && again !== first ? "The two do not match." : null;
  const ready = first.length >= LEAST && again === first && !save.isPending;

  return (
    <Card
      title="Backup password"
      description={
        sealed
          ? "Your weekly backups include your secrets, locked with this password. If this server is ever lost, it brings them back."
          : "Without one, your backups do not include your secrets: if this server is lost, every secret has to be entered again."
      }
      actions={
        admin && !open ? (
          <div className="flex items-center gap-1">
            <button type="button" className="btn btn-primary btn-xs rounded-lg gap-1.5" onClick={() => setOpen(true)}>
              <LockKeyhole size={13} aria-hidden="true" /> {sealed ? "Change it" : "Set a backup password"}
            </button>
            {sealed ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs rounded-lg"
                disabled={save.isPending}
                onClick={async () => {
                  if (await onTurnOff()) save.mutate(null);
                }}
              >
                Turn off
              </button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {open ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) save.mutate(first);
          }}
        >
          <p className="flex items-start gap-2 rounded-xl bg-warning/10 p-3 text-xs text-base-content/80">
            <Archive size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <span>
              Keep this password somewhere safe, like a password manager. Without it the backup of your secrets cannot be
              opened, and nobody can recover it for you.
            </span>
          </p>
          <Field label="Backup password">
            <input type="password" className="input w-full rounded-xl text-sm" autoComplete="new-password" autoFocus value={first} onChange={(event) => setFirst(event.target.value)} />
          </Field>
          <Field label="The same password again">
            <input type="password" className="input w-full rounded-xl text-sm" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} />
          </Field>
          {problem ? <p className="text-xs text-error">{problem}</p> : null}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-sm rounded-xl" disabled={!ready}>
              Save backup password
            </button>
          </div>
        </form>
      ) : null}
      {said ? <p className="text-xs text-base-content/70">{said}</p> : null}
      {!admin ? <p className="text-xs text-base-content/65">Only an admin can change this.</p> : null}
      <ErrorNote error={save.error} />
    </Card>
  );
}

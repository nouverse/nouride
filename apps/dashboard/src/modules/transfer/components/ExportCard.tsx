/**
 * Making the file: what it will hold and how large is said before it is made, with the two things a person decides
 * (the agents' own folders, which can be large, and the secrets, which travel only locked with a password typed here);
 * then how far it is while it is made; then the file to download, kept until it is removed or the next one is made.
 *
 * The password is asked twice and goes once to the daemon, which keeps none of it. Without one the file holds no
 * secret, and the card says so before the button is pressed.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Download, FileArchive, Loader2, Trash2 } from "lucide-react";
import type { TransferState } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { formatBytes } from "@/commons/lib/format";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";
import { PasswordInput } from "@/commons/components/ui/PasswordInput";
import { count, holdsLines, NEVER_IN_IT } from "@/commons/lib/transfer-words";

const LEAST = 12;

/** The browser's own download of the file: nothing of it passes through the page's memory. */
function save(href: string, name: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function ExportCard({ state }: { state: TransferState }) {
  const queryClient = useQueryClient();
  const [folders, setFolders] = useState(false);
  const [wanted, setSecrets] = useState(true);
  const [first, setFirst] = useState("");
  const [again, setAgain] = useState("");
  const plan = useQuery({ queryKey: ["transfer", "plan", folders], queryFn: () => api.exportPlan(folders) });
  // With no secret kept here there is nothing to lock, and no password to ask for.
  const none = plan.data?.secrets === 0;
  const secrets = wanted && !none;
  const refresh = (next: TransferState) => queryClient.setQueryData(["transfer"], next);
  const make = useMutation({
    mutationFn: () => api.startExport({ password: secrets ? first : null, folders }),
    onSuccess: (next) => {
      setFirst("");
      setAgain("");
      refresh(next);
    },
  });
  const drop = useMutation({ mutationFn: api.dropExport, onSuccess: refresh });

  const made = state.export;
  const working = made.state === "working";
  const problem = !secrets ? null : first && first.length < LEAST ? `At least ${LEAST} characters.` : again && again !== first ? "The two do not match." : null;
  const ready = !working && !make.isPending && (!secrets || (first.length >= LEAST && again === first));
  const done = working && made.total ? Math.min(100, Math.round(((made.done?.bytes ?? 0) / Math.max(1, made.total)) * 100)) : 0;

  return (
    <Card title="Take this Nouride to another machine" description="One file with everything in it. Make it here, carry it over, and bring it in on the other machine.">
      <div className="space-y-4" data-export>
        <div className="space-y-2 text-sm">
          <p className="font-semibold text-base-content">The file will hold</p>
          {plan.data ? (
            <ul className="list-disc space-y-1 pl-5 text-base-content/80" data-export-holds>
              {holdsLines(plan.data.parts, plan.data.database).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="text-base-content/65">Counting…</p>
          )}
          {plan.data ? <p className="text-xs text-base-content/65">About {formatBytes(plan.data.bytes)} before it is packed, usually less after.</p> : null}
          <p className="text-xs text-base-content/65">{NEVER_IN_IT}</p>
        </div>

        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
          <input type="checkbox" className="checkbox checkbox-sm mt-0.5" checked={folders} disabled={working} onChange={(event) => setFolders(event.target.checked)} />
          <span>
            The agents' own folders
            <span className="block text-xs text-base-content/65">
              {plan.data ? `${count(plan.data.folders.files, "file")}, ${formatBytes(plan.data.folders.bytes)}. ` : ""}What they work in. Files that hold a sign-in or a key are left out.
            </span>
          </span>
        </label>

        {none ? null : (
          <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm">
            <input type="checkbox" className="checkbox checkbox-sm mt-0.5" checked={secrets} disabled={working} onChange={(event) => setSecrets(event.target.checked)} />
            <span>
              The secrets{plan.data ? ` (${plan.data.secrets})` : ""}, locked with a password
              <span className="block text-xs text-base-content/65">The other machine asks for this password. It is kept nowhere: without it the secrets in the file cannot be opened.</span>
            </span>
          </label>
        )}

        {none ? (
          <p className="text-xs text-base-content/65" data-none-kept>
            No secrets are kept here, so none go into the file.
          </p>
        ) : secrets ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Password for the secrets">
              <PasswordInput className="input w-full rounded-xl text-sm" autoComplete="new-password" value={first} disabled={working} onChange={(event) => setFirst(event.target.value)} />
            </Field>
            <Field label="The same password again">
              <PasswordInput className="input w-full rounded-xl text-sm" autoComplete="new-password" value={again} disabled={working} onChange={(event) => setAgain(event.target.value)} />
            </Field>
          </div>
        ) : (
          <p className="rounded-xl bg-warning/10 p-3 text-xs text-base-content/80" data-no-secrets>
            No secrets go into this file. On the other machine each one is entered again on Secrets, and the connections and models that need one wait until then.
          </p>
        )}
        {problem ? <p className="text-xs text-error">{problem}</p> : null}

        <p className="text-xs text-base-content/65">Apart from the secrets the file is not locked: it holds every chat and memory. Keep it as you would keep those.</p>

        {working ? (
          <div className="space-y-1.5" data-export-working>
            <progress className="progress progress-primary w-full" value={done} max={100} aria-label="Making the file" />
            <p className="text-xs text-base-content/65">
              Making the file: {count(made.done?.files ?? 0, "file")}, {formatBytes(made.done?.bytes ?? 0)} of about {formatBytes(made.total ?? 0)}.
            </p>
          </div>
        ) : (
          <button type="button" className="btn btn-primary btn-sm gap-2 rounded-xl" disabled={!ready} onClick={() => make.mutate()}>
            {make.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FileArchive size={14} aria-hidden="true" />} Make the file
          </button>
        )}
        {made.state === "failed" ? <p className="text-sm text-error">The file could not be made. {made.error}</p> : null}
        <ErrorNote error={make.error} />

        {made.state === "ready" && made.name ? (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-base-content/[0.08] bg-base-100 p-3" data-export-ready>
            <FileArchive size={18} className="shrink-0 text-base-content/65" aria-hidden="true" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate font-mono text-[13px] text-base-content" title={made.name}>
                {made.name}
              </p>
              <p className="text-xs text-base-content/65">
                {formatBytes(made.bytes ?? 0)}
                {made.secrets === undefined ? "" : made.secrets ? " · with the secrets, locked" : " · no secrets"}
                {made.folders ? " · with the agents' folders" : ""}
              </p>
            </div>
            <button type="button" className="btn btn-primary btn-sm gap-2 rounded-xl" onClick={() => save(api.exportDownload, made.name ?? "nouride-export.tar.gz")}>
              <Download size={14} aria-hidden="true" /> Download
            </button>
            <button type="button" className="btn btn-ghost btn-sm gap-2 rounded-xl" disabled={drop.isPending} onClick={() => drop.mutate()}>
              <Trash2 size={14} aria-hidden="true" /> Remove it from here
            </button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Bringing a file in: picked, sent in pieces with how far it is, opened (with its password where it holds secrets),
 * and shown beside what is here now, before anything is replaced. Then the question in layers, as deleting an agent
 * asks: what goes, the word typed, ten seconds on the button. Nouride then restarts and comes back as the other
 * install: everyone signs in again with its accounts.
 *
 * On the Settings page and, for a new install, on the setup's first page: the same card.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import type { ImportChecked, TransferState } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { ApiError } from "@/commons/lib/api.client";
import { formatBytes } from "@/commons/lib/format";
import { restartThrough } from "@/commons/lib/restart";
import { Card, ErrorNote, Field } from "@/commons/components/ui/ui";
import { useConfirm } from "@/commons/components/ui/confirm";
import { PasswordInput } from "@/commons/components/ui/PasswordInput";
import { count, holdsLines, NEVER_IN_IT } from "@/commons/lib/transfer-words";

/** A piece of the file as it is sent: under what one request may carry, large enough to be few. */
const PIECE = 8 * 1024 * 1024;

/** The word typed to confirm, and how long the button then waits. */
const WORD = "replace";
const WAIT_SECONDS = 10;

/** `file` sent a piece at a time, `onSent` told how much has arrived after each. */
async function send(file: Blob, onSent: (bytes: number) => void): Promise<void> {
  for (let at = 0; at < file.size || at === 0; at += PIECE) {
    const { bytes } = await api.importPiece(at, file.slice(at, at + PIECE));
    onSent(bytes);
    if (file.size === 0) break;
  }
}

/** A file that was opened: what it holds, beside what it replaces, and the button that asks. */
function CheckedFile({ checked, busy, error, onReplace }: { checked: ImportChecked; busy: boolean; error: unknown; onReplace: () => void }) {
  return (
    <div className="space-y-3 rounded-2xl border border-base-content/[0.08] bg-base-100 p-4 text-sm" data-import-checked>
      <p className="font-semibold text-base-content">
        This file was made by Nouride {checked.version} on {new Date(checked.madeAt).toLocaleDateString()}. It holds
      </p>
      <ul className="list-disc space-y-1 pl-5 text-base-content/80" data-import-holds>
        <li>{checked.agents.length > 0 ? `${count(checked.agents.length, "agent")}: ${checked.agents.join(", ")}` : "No agents"}</li>
        {holdsLines(checked.parts, checked.database).map((line) => (
          <li key={line}>{line}</li>
        ))}
        <li>{checked.secrets === null ? "No secrets: each is entered again on Secrets after" : `${count(checked.secrets, "secret")}, opened with the password`}</li>
      </ul>
      <p className="text-xs text-base-content/65">{NEVER_IN_IT} The coding CLIs are signed in again after.</p>
      <p className="text-base-content/80">
        It replaces everything this Nouride holds{checked.here.agents.length > 0 ? ` (${count(checked.here.agents.length, "agent")}: ${checked.here.agents.join(", ")})` : ""}. Afterwards its connections and automations wait until you press Go live.
      </p>
      <button type="button" className="btn btn-error btn-sm rounded-xl" disabled={busy} onClick={onReplace}>
        Replace everything here
      </button>
      <ErrorNote error={error} />
    </div>
  );
}

export function ImportCard({ state, title = "Bring a Nouride in from another machine" }: { state: TransferState | undefined; title?: string }) {
  const queryClient = useQueryClient();
  const { ask, dialog } = useConfirm();
  const picker = useRef<HTMLInputElement>(null);
  const [sent, setSent] = useState<{ bytes: number; of: number } | null>(null);
  const [checked, setChecked] = useState<ImportChecked | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [waiting, setWaiting] = useState(false);

  const open = useMutation({
    mutationFn: async (given?: string) => await api.checkImport(given),
    onSuccess: (found) => {
      setChecked(found);
      setNeedsPassword(false);
      setPassword("");
    },
    // Refused for its password alone: the field is shown, and the first asking, which had none to give, says nothing.
    onError: (error) => setNeedsPassword(error instanceof ApiError && error.status === 422),
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      setChecked(null);
      setNeedsPassword(false);
      setSent({ bytes: 0, of: file.size });
      await send(file, (bytes) => setSent({ bytes, of: file.size }));
    },
    onSuccess: () => open.mutate(undefined),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["transfer"] }),
  });
  const apply = useMutation({
    mutationFn: async () => {
      if (!checked) return;
      const sure = await ask({
        title: "Replace everything here?",
        body: (
          <div className="space-y-3">
            <p>This cannot be undone from here. These are replaced by what the file holds:</p>
            <ul className="list-disc space-y-1 pl-5" data-what-goes>
              <li>{checked.here.agents.length > 0 ? `${count(checked.here.agents.length, "agent")}: ${checked.here.agents.join(", ")}` : "The agents"}</li>
              <li>Every chat, memory, mission and automation</li>
              <li>The accounts that sign in here, and {count(checked.here.people, "person", "people")}</li>
              <li>Every secret</li>
            </ul>
            <p>Nothing is merged. What is here now is kept in a folder on this machine.</p>
          </div>
        ),
        typed: WORD,
        waitSeconds: WAIT_SECONDS,
        confirmLabel: "Replace everything",
        cancelLabel: "Keep what is here",
      });
      if (!sure) return;
      await restartThrough(async () => {
        const done = await api.applyImport(WORD);
        setChecked(null);
        setSent(null);
        setWaiting(!done.restarting);
        return done.restarting ? { waiting: false, note: "" } : null;
      });
      void queryClient.invalidateQueries({ queryKey: ["transfer"] });
    },
  });
  const cancel = useMutation({
    mutationFn: api.cancelImport,
    onSuccess: (next) => {
      setChecked(null);
      setSent(null);
      setWaiting(false);
      queryClient.setQueryData(["transfer"], next);
    },
  });

  const busy = upload.isPending || open.isPending;
  const staged = state?.staged || waiting;
  const refused = open.error && !(needsPassword && !open.variables) ? open.error : null;

  return (
    <Card title={title} description="Pick the file made on the other machine. Nothing here is replaced until you have seen what it holds and said so.">
      {dialog}
      <div className="space-y-4" data-import>
        {staged ? (
          <div className="space-y-3 rounded-2xl bg-warning/10 p-4 text-sm" data-import-staged>
            <p className="font-semibold text-base-content">The file is ready, and goes in when Nouride restarts.</p>
            <p className="text-base-content/80">
              {state?.restarts ? "Nouride is restarting now. This page comes back by itself, and asks you to sign in with the other machine's accounts." : "Nothing on this server starts Nouride again by itself. Whoever runs the server restarts it, and the file goes in then."}
            </p>
            <button type="button" className="btn btn-ghost btn-sm rounded-xl" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              Take it back
            </button>
          </div>
        ) : (
          <>
            <input
              ref={picker}
              type="file"
              accept=".gz,.tgz,application/gzip"
              className="hidden"
              aria-label="The file made on the other machine"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) upload.mutate(file);
              }}
            />
            <button type="button" className="btn btn-sm gap-2 rounded-xl" disabled={busy} onClick={() => picker.current?.click()}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <FileUp size={14} aria-hidden="true" />} {checked || sent ? "Pick another file" : "Pick the file"}
            </button>

            {upload.isPending && sent ? (
              <div className="space-y-1.5" data-import-sending>
                <progress className="progress progress-primary w-full" value={sent.bytes} max={Math.max(1, sent.of)} aria-label="Sending the file" />
                <p className="text-xs text-base-content/65">
                  Sending the file: {formatBytes(sent.bytes)} of {formatBytes(sent.of)}.
                </p>
              </div>
            ) : null}
            {open.isPending ? <p className="text-xs text-base-content/65">Opening the file…</p> : null}

            {needsPassword ? (
              <form
                className="space-y-3"
                data-import-password
                onSubmit={(event) => {
                  event.preventDefault();
                  if (password) open.mutate(password);
                }}
              >
                <Field label="The password typed when the file was made" hint="It opens the secrets in the file.">
                  <PasswordInput className="input w-full rounded-xl text-sm" autoComplete="off" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
                </Field>
                <button type="submit" className="btn btn-primary btn-sm rounded-xl" disabled={!password || open.isPending}>
                  Open the file
                </button>
              </form>
            ) : null}
            <ErrorNote error={upload.error ?? refused} />

            {checked ? <CheckedFile checked={checked} busy={apply.isPending} error={apply.error} onReplace={() => apply.mutate()} /> : null}
          </>
        )}
        {state?.failed ? (
          <p className="rounded-xl bg-error/10 p-3 text-sm text-base-content" data-import-failed>
            The last file did not go in{state.failed.restored ? ", and everything here was put back as it was" : ", and not everything could be put back: what was here is kept in a folder on this machine"}. {state.failed.error}
          </p>
        ) : null}
      </div>
    </Card>
  );
}

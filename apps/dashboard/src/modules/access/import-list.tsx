/**
 * "Let in a list": a whole list of people let in ahead, from the Approved tab, for an admin.
 *
 * A business answering its own contacts has their numbers in a spreadsheet. Letting them in was a command on the
 * server, one file at a time, which the person who holds that spreadsheet does not run. Here the list is pasted or
 * picked as a file, checked first (how many are new, in already, blocked, said twice, unreadable, and nothing
 * written), and let in with a second press. The daemon reads the lines, as it does for the command: there is one
 * reader of a list, and it is not in the browser.
 *
 * The press that lets them in is offered only for the list as it was checked: a letter changed, or another
 * connection chosen, asks for a new check.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { FileUp, ListPlus, X } from "lucide-react";
import type { AccessImported, GatewayInstance } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { Leaving, overPage } from "@/commons/components/ui/OverPage";
import { SearchSelect } from "@/commons/components/ui/SearchSelect";
import { useToast } from "@/commons/components/ui/toast";
import { ErrorNote } from "@/commons/components/ui/ui";
import { HOW_TO_WRITE, checkSaid, letInSaid } from "./import-words";
import { BUTTON } from "./sender-line";

export function ImportList({ gateways: all }: { gateways: readonly GatewayInstance[] }) {
  const [open, setOpen] = useState(false);
  // The connections that run now: one switched off, or added since the last restart, takes no list yet.
  const gateways = all.filter((one) => one.enabled && one.status !== null);
  return (
    <>
      <button type="button" className={BUTTON.plain} disabled={gateways.length === 0} onClick={() => setOpen(true)} title="Let in many people at once, from a list">
        <ListPlus size={13} aria-hidden="true" /> Let in a list
      </button>
      <Leaving value={open}>{() => <ImportBox gateways={gateways} onClose={() => setOpen(false)} />}</Leaving>
    </>
  );
}

function ImportBox({ gateways, onClose }: { gateways: readonly GatewayInstance[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [gateway, setGateway] = useState(gateways[0]?.id ?? "");
  const [text, setText] = useState("");
  /** The last check, with the list and the connection it was of. */
  const [checked, setChecked] = useState<{ gateway: string; text: string; result: AccessImported } | null>(null);
  const how = HOW_TO_WRITE[gateways.find((one) => one.id === gateway)?.platform ?? "whatsapp"];
  const current = checked && checked.gateway === gateway && checked.text === text ? checked.result : null;

  const check = useMutation({
    mutationFn: () => api.importSenders({ gateway, text, dryRun: true }),
    onSuccess: (result) => setChecked({ gateway, text, result }),
  });
  const letIn = useMutation({
    mutationFn: () => api.importSenders({ gateway, text, dryRun: false }),
    onSuccess: async (result) => {
      toast.success(letInSaid(result));
      await queryClient.invalidateQueries({ queryKey: ["access"] });
      await queryClient.invalidateQueries({ queryKey: ["access-history"] });
      onClose();
    },
  });

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  const busy = check.isPending || letIn.isPending;
  return overPage(
    <div className="modal modal-open" role="dialog" aria-label="Let in a list">
      <form
        className="modal-box flex max-h-[90dvh] max-w-lg flex-col gap-4 overflow-y-auto rounded-[26px] p-5 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (current && current.added > 0) letIn.mutate();
          else if (text.trim() && gateway) check.mutate();
        }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="font-display text-xl font-medium tracking-tight">Let in a list</h2>
            <p className="text-sm leading-relaxed text-base-content/70">People on the list are answered when they write, without a pairing code. You can revoke or block any of them afterwards, like anybody approved.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-square size-11 rounded-xl sm:size-9" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
          <span>Where they will write</span>
          <SearchSelect label="Connection" options={gateways.map((one) => ({ value: one.id, label: one.id }))} value={gateway} onChange={setGateway} width={260} align="end" />
        </div>

        <label className="flex flex-col gap-1.5 text-sm font-semibold">
          The list
          <span className="text-xs font-normal leading-relaxed text-base-content/70">{how.line} A list saved from a spreadsheet works as it is.</span>
          <textarea
            className="textarea min-h-40 w-full rounded-[14px] font-mono text-base leading-relaxed sm:text-sm"
            placeholder={how.example}
            value={text}
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div className="-mt-2 flex flex-wrap items-center gap-2">
          <input
            ref={file}
            type="file"
            accept=".txt,.csv,text/plain,text/csv"
            className="hidden"
            aria-label="A file holding the list"
            onChange={async (event) => {
              const picked = event.target.files?.[0];
              // Cleared, so the same file picked again is read again.
              event.target.value = "";
              if (picked) setText(await picked.text());
            }}
          />
          <button type="button" className="btn btn-ghost btn-sm min-h-11 gap-1.5 rounded-xl sm:min-h-8" onClick={() => file.current?.click()}>
            <FileUp size={14} aria-hidden="true" /> Choose a file
          </button>
        </div>

        <ErrorNote error={check.error ?? letIn.error} />
        {current ? (
          <ul className="space-y-1 rounded-xl bg-base-content/[0.04] px-3 py-2.5 text-sm" data-import-check>
            {checkSaid(current).map((line, index) => (
              <li key={line} className={index === 0 ? "font-semibold" : "text-base-content/75"}>
                {line}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" className="btn btn-ghost rounded-[14px]" onClick={onClose}>
            Cancel
          </button>
          {current && current.added > 0 ? (
            <button type="submit" className="btn btn-primary rounded-[14px]" disabled={busy}>
              {letIn.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
              Let {current.added.toLocaleString("en-US")} in
            </button>
          ) : (
            <button type="submit" className="btn btn-primary rounded-[14px]" disabled={busy || !text.trim() || !gateway}>
              {check.isPending ? <span className="loading loading-spinner loading-xs" /> : null}
              Check the list
            </button>
          )}
        </div>
      </form>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>,
  );
}

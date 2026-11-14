/**
 * What an admin does with a file in System's Files beyond reading it: keep a copy of it, and delete what agents and
 * chats left behind.
 *
 * A copy is asked about first and fetched second. The daemon refuses a file in whose words it would mask something,
 * and a refused download is a failed one in the browser's own list, with no sentence: asked first, the page says why.
 * A delete is weighed first, so its question names how many files and how much of the disk would go, and the daemon
 * says there, before anything is asked, that a mission or a job is still working in it.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SystemFileEntry } from "@nouride/wire";
import { api } from "@/commons/lib/api";
import { useConfirm } from "@/commons/components/ui/confirm";
import { deleteWords } from "./words";

/** The browser's own download of `href`, saved as `name`: nothing of it passes through the page's memory. */
function save(href: string, name: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function useFileActions(onDeleted: (entry: SystemFileEntry) => void) {
  const confirm = useConfirm();
  const client = useQueryClient();
  /** The one file being asked about or deleted, and which: its button turns while it is. */
  const [busy, setBusy] = useState<{ path: string; doing: "download" | "delete" } | null>(null);
  const [failed, setFailed] = useState<{ path: string; error: unknown } | null>(null);

  const run = async (entry: SystemFileEntry, doing: "download" | "delete", work: () => Promise<void>) => {
    setFailed(null);
    setBusy({ path: entry.path, doing });
    try {
      await work();
    } catch (error) {
      setFailed({ path: entry.path, error });
    } finally {
      setBusy(null);
    }
  };

  return {
    busy,
    failed,
    dialog: confirm.dialog,
    download: (entry: SystemFileEntry) =>
      run(entry, "download", async () => {
        await api.systemDownloadCheck(entry.path);
        save(api.systemDownload(entry.path), entry.name);
      }),
    remove: (entry: SystemFileEntry) =>
      run(entry, "delete", async () => {
        const weight = await api.systemWeigh(entry.path);
        if (!(await confirm.ask({ title: `Delete ${entry.name}?`, body: `${deleteWords(weight)} This cannot be undone.`, confirmLabel: "Delete" }))) return;
        await api.systemDelete(entry.path);
        await client.invalidateQueries({ queryKey: ["system", "files"] });
        client.removeQueries({ queryKey: ["system", "file", entry.path] });
        onDeleted(entry);
      }),
  };
}

export type FileActions = ReturnType<typeof useFileActions>;

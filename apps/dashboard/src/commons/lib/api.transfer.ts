/** Export and import (`modules/transfer`): this install as one file, and one brought in. An admin's, every call. */

import type { ExportPlan, ImportChecked, ImportReport, TransferState } from "@nouride/wire";
import { control, post, request } from "./api.client";

export const transferApi = {
  transfer: () => request<TransferState>(`${control}/transfer`),
  /** What a file would hold and how large, before it is made. */
  exportPlan: () => request<ExportPlan>(`${control}/transfer/plan`),
  /** `password` null: a file that holds no secrets, which the page says before it asks. */
  startExport: (input: { password: string | null; folders: boolean }) =>
    post<TransferState>(`${control}/transfer/export`, input.password === null ? { secrets: false, folders: input.folders } : { passphrase: input.password, folders: input.folders }),
  /** Where the browser downloads the last file made from. */
  exportDownload: `${control}/transfer/export/download`,
  dropExport: () => request<TransferState>(`${control}/transfer/export`, { method: "DELETE" }),
  /** One piece of a file for import, at the place the last one ended; 0 begins a new file. How much has arrived. */
  importPiece: (at: number, piece: Blob) =>
    request<{ bytes: number }>(`${control}/transfer/import/upload?at=${at}`, { method: "POST", body: piece, headers: { "content-type": "application/octet-stream" }, timeoutMs: 120_000 }),
  /** The uploaded file opened: what it holds beside what is here. Refused with 422 where it needs its password. */
  checkImport: (password?: string) => post<ImportChecked>(`${control}/transfer/import/check`, password ? { passphrase: password } : {}, { timeoutMs: 300_000 }),
  /** The checked file left ready, with the word that confirms it; `restarting` where Nouride restarts itself to take it. */
  applyImport: (confirm: string) => post<{ restarting: boolean }>(`${control}/transfer/import/apply`, { confirm }),
  cancelImport: () => request<TransferState>(`${control}/transfer/import`, { method: "DELETE" }),
  goLive: () => post<{ report: ImportReport; restarting: boolean; restart: boolean }>(`${control}/transfer/live`, {}),
  putImportAway: () => request<TransferState>(`${control}/transfer/imported`, { method: "DELETE" }),
};
